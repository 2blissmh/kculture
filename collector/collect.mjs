#!/usr/bin/env node
// 전국 문화생활 데이터 수집기
//  - 한국관광공사 TourAPI(KorService2) : 전국 축제·행사
//  - KOPIS 공연예술통합전산망           : 뮤지컬·연극·클래식·국악·무용·대중음악
//  - 서울 열린데이터광장 culturalEventInfo : 서울시 문화행사(전시·교육체험 포함)
// 결과: docs/data/events.json (위젯이 읽는 정적 파일, GitHub Pages로 무료 배포)
//
// 환경변수 (GitHub Secrets)
//   TOUR_API_KEY   공공데이터포털 일반 인증키 "Decoding" 값
//   KOPIS_API_KEY  KOPIS 서비스키
//   SEOUL_API_KEY  서울 열린데이터광장 인증키
//   키가 없는 출처는 건너뛴다.
//
// 무료 한도 보호: 상세정보(요금/연령/주소)는 실행마다 정해진 개수만 조회하고
// cache/enrich.json 에 누적 저장해서 다음 실행에 재사용한다.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normSido, sggFromAddr, normDate, https, genreFromKopis, genreFromSeoul,
  freeFrom, ageMinFrom, guessIO, strip, parseXmlItems, parseXmlFields, dedupeKey,
} from './normalize.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT, 'docs', 'data', 'events.json');
const CACHE_FILE = join(ROOT, 'cache', 'enrich.json');

const env = process.env;
const KEYS = { tour: env.TOUR_API_KEY, kopis: env.KOPIS_API_KEY, seoul: env.SEOUL_API_KEY };

// 수집 범위 / 한도 (필요 시 환경변수로 조정)
const DAYS_AHEAD = Number(env.DAYS_AHEAD || 120);          // 오늘부터 며칠 뒤 시작 행사까지
const TOUR_ENRICH_PER_RUN = Number(env.TOUR_ENRICH || 150); // TourAPI 개발계정 1,000건/일 → 6시간마다 150건
const KOPIS_ENRICH_PER_RUN = Number(env.KOPIS_ENRICH || 400);
const FACILITY_ENRICH_PER_RUN = Number(env.FACILITY_ENRICH || 150);

const today = new Date(Date.now() + 9 * 3600e3); // KST
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400e3);
const TODAY = ymd(today);
const UNTIL = ymd(addDays(today, DAYS_AHEAD));
const compact = (s) => s.replace(/-/g, '');

const log = (...a) => console.log('[collect]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { type = 'json', tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'kculture-collector/1.0' } });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (type === 'text') return text;
      try {
        return JSON.parse(text);
      } catch {
        // 공공데이터포털은 키 오류 시 XML 에러를 돌려준다
        throw new Error(`JSON 아님: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      }
    } catch (e) {
      lastErr = e;
      await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

/** 동시성 제한 map */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = undefined; }
    }
  }));
  return out;
}

const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);

// ---------------------------------------------------------------- TourAPI
const TOUR_BASE = 'https://apis.data.go.kr/B551011/KorService2';
function tourUrl(op, params) {
  const q = new URLSearchParams({
    serviceKey: KEYS.tour, MobileOS: 'ETC', MobileApp: 'KCulture', _type: 'json', ...params,
  });
  return `${TOUR_BASE}/${op}?${q}`;
}
function tourItems(json) {
  const body = json?.response?.body;
  if (!body) {
    const msg = json?.response?.header?.resultMsg || JSON.stringify(json).slice(0, 160);
    throw new Error(`TourAPI 응답 오류: ${msg}`);
  }
  return { items: asArray(body.items?.item), total: Number(body.totalCount || 0) };
}

async function collectTour(cache) {
  // 진행 중인 축제도 포함하도록 시작일 기준을 60일 앞당긴 뒤 종료일로 거른다
  const start = compact(ymd(addDays(today, -60)));
  const rows = 500;
  const raw = [];
  for (let page = 1; page <= 10; page++) {
    const { items, total } = tourItems(await get(tourUrl('searchFestival2', {
      numOfRows: rows, pageNo: page, arrange: 'A', eventStartDate: start,
    })));
    raw.push(...items);
    if (page * rows >= total || items.length === 0) break;
  }
  log(`TourAPI 축제 ${raw.length}건 수신`);

  const events = raw.map((it) => {
    const sd = normDate(it.eventstartdate);
    const ed = normDate(it.eventenddate) || sd;
    const addr = [it.addr1, it.addr2].filter(Boolean).join(' ').trim();
    const ex = cache.tour[it.contentid] || {};
    return {
      id: `t:${it.contentid}`, src: 'tour', cid: String(it.contentid),
      t: strip(it.title), g: 'festival', sd, ed,
      sido: normSido(it.addr1), sgg: sggFromAddr(it.addr1),
      pl: ex.place || '', ad: addr,
      img: https(it.firstimage || it.firstimage2),
      free: ex.free ?? null, fee: ex.fee || '', age: ex.age || '', am: ex.am ?? null,
      io: null,
      lat: Number(it.mapy) || null, lng: Number(it.mapx) || null,
      url: ex.url || `https://korean.visitkorea.or.kr/detail/fes_detail.do?cotid=${it.contentid}`,
      tel: it.tel || '',
    };
  }).filter((e) => e.sd && e.ed >= TODAY && e.sd <= UNTIL);

  // 요금/연령/장소 상세 보강 — 아직 캐시에 없는 것부터, 곧 열리는 순으로
  const todo = events.filter((e) => !cache.tour[e.cid])
    .sort((a, b) => a.sd.localeCompare(b.sd))
    .slice(0, TOUR_ENRICH_PER_RUN);
  await pool(todo, 4, async (e) => {
    const j = await get(tourUrl('detailIntro2', { contentId: e.cid, contentTypeId: 15 }));
    const it = tourItems(j).items[0] || {};
    const fee = strip(it.usetimefestival);
    const age = strip(it.agelimit);
    const homepage = (String(it.eventhomepage || '').match(/https?:\/\/[^\s"'<>]+/) || [])[0];
    cache.tour[e.cid] = {
      fee, age, free: freeFrom(fee), am: age ? ageMinFrom(age) : 0,
      place: strip(it.eventplace), url: homepage ? https(homepage) : undefined, at: TODAY,
    };
  });
  log(`TourAPI 상세 보강 ${todo.length}건`);

  for (const e of events) {
    const ex = cache.tour[e.cid];
    if (ex) Object.assign(e, { free: ex.free, fee: ex.fee, age: ex.age, am: ex.am, pl: ex.place || e.pl, url: ex.url || e.url });
    e.io = guessIO(e.pl || e.ad, e.g, e.t);
    delete e.cid;
  }
  return events;
}

// ---------------------------------------------------------------- KOPIS
const KOPIS_BASE = 'https://www.kopis.or.kr/openApi/restful';

async function collectKopis(cache) {
  // KOPIS 목록은 조회 기간을 짧게 나눠 요청 (기간 제한 대응), 결과는 mt20id로 중복 제거
  const byId = new Map();
  for (let w = 0; w * 30 < DAYS_AHEAD; w++) {
    const st = compact(ymd(addDays(today, w * 30)));
    const ed = compact(ymd(addDays(today, Math.min(DAYS_AHEAD, w * 30 + 30))));
    for (let page = 1; page <= 60; page++) {
      const q = new URLSearchParams({ service: KEYS.kopis, stdate: st, eddate: ed, cpage: page, rows: 100 });
      const xml = await get(`${KOPIS_BASE}/pblprfr?${q}`, { type: 'text' });
      if (/<returncode>/.test(xml) && !/<db>/.test(xml)) throw new Error(`KOPIS 오류: ${strip(xml).slice(0, 120)}`);
      const items = parseXmlItems(xml, 'db');
      for (const it of items) byId.set(it.mt20id, it);
      if (items.length < 100) break;
    }
  }
  log(`KOPIS 공연 ${byId.size}건 수신`);

  const list = [...byId.values()];
  // 상세(가격/연령/공연장ID/예매링크) 보강
  const todo = list.filter((it) => !cache.kopis[it.mt20id]).slice(0, KOPIS_ENRICH_PER_RUN);
  await pool(todo, 5, async (it) => {
    const xml = await get(`${KOPIS_BASE}/pblprfr/${it.mt20id}?service=${encodeURIComponent(KEYS.kopis)}`, { type: 'text' });
    const d = parseXmlItems(xml, 'db')[0] || {};
    const relates = parseXmlItems(xml, 'relate').map((r) => r.relateurl).filter(Boolean);
    cache.kopis[it.mt20id] = {
      fee: strip(d.pcseguidance), age: strip(d.prfage), fac: d.mt10id || '',
      kid: d.child === 'Y', url: relates[0] ? https(relates[0]) : undefined, at: TODAY,
    };
  });
  log(`KOPIS 상세 보강 ${todo.length}건`);

  // 공연장 주소/좌표 보강 (시·군·구 필터용)
  const facs = [...new Set(Object.values(cache.kopis).map((x) => x.fac).filter((f) => f && !cache.fac[f]))]
    .slice(0, FACILITY_ENRICH_PER_RUN);
  await pool(facs, 5, async (fid) => {
    const xml = await get(`${KOPIS_BASE}/prfplc/${fid}?service=${encodeURIComponent(KEYS.kopis)}`, { type: 'text' });
    const d = parseXmlFields((xml.match(/<db>([\s\S]*?)<\/db>/) || [])[1] || '');
    cache.fac[fid] = { ad: strip(d.adres), lat: Number(d.la) || null, lng: Number(d.lo) || null };
  });
  log(`KOPIS 공연장 보강 ${facs.length}건`);

  return list.map((it) => {
    const ex = cache.kopis[it.mt20id] || {};
    const fac = cache.fac[ex.fac] || {};
    const g = genreFromKopis(it.genrenm);
    const am = ageMinFrom(ex.age);
    return {
      id: `k:${it.mt20id}`, src: 'kopis', t: strip(it.prfnm), g,
      sd: normDate(it.prfpdfrom), ed: normDate(it.prfpdto) || normDate(it.prfpdfrom),
      sido: normSido(fac.ad) || normSido(it.area), sgg: sggFromAddr(fac.ad),
      pl: strip(it.fcltynm), ad: fac.ad || '',
      img: https(it.poster),
      free: freeFrom(ex.fee), fee: ex.fee || '', age: ex.age || '', am: am ?? (ex.kid ? 0 : null),
      io: guessIO(it.fcltynm, g, it.prfnm),
      lat: fac.lat || null, lng: fac.lng || null,
      url: ex.url || `https://www.kopis.or.kr/por/db/pblprfr/pblprfrView.do?menuId=MNU_00020&mt20Id=${it.mt20id}`,
      tel: '',
    };
  }).filter((e) => e.sd && e.ed >= TODAY && e.sd <= UNTIL);
}

// ---------------------------------------------------------------- 서울시
async function collectSeoul() {
  // 서울 열린데이터광장은 http + 8088 포트만 제공. 한 번에 최대 1,000건
  const base = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(KEYS.seoul)}/json/culturalEventInfo`;
  const raw = [];
  let total = Infinity;
  const max = Number(env.SEOUL_MAX || 8000);
  for (let s = 1; s <= total && s <= max; s += 1000) {
    const j = await get(`${base}/${s}/${s + 999}/`);
    const body = j.culturalEventInfo;
    if (!body) throw new Error(`서울 API 오류: ${JSON.stringify(j.RESULT || j).slice(0, 120)}`);
    total = Number(body.list_total_count || 0);
    raw.push(...asArray(body.row));
  }
  log(`서울시 문화행사 ${raw.length}건 수신`);

  return raw.map((it) => {
    const g = genreFromSeoul(it.CODENAME);
    const fee = strip(it.USE_FEE);
    let free = it.IS_FREE === '무료' ? true : it.IS_FREE === '유료' ? false : freeFrom(fee);
    // 서울 API는 LAT/LOT 값이 뒤바뀐 경우가 있어 범위로 판별
    let a = Number(it.LAT) || null, b = Number(it.LOT) || null;
    if (a && a > 100) [a, b] = [b, a];
    const link = https(it.ORG_LINK || it.HMPG_ADDR);
    return {
      id: `s:${(it.HMPG_ADDR || '').match(/cultcode=(\d+)/)?.[1] || hash(it.TITLE + it.STRTDATE)}`,
      src: 'seoul', t: strip(it.TITLE), g,
      sd: normDate(it.STRTDATE), ed: normDate(it.END_DATE) || normDate(it.STRTDATE),
      sido: '서울', sgg: (it.GUNAME || '').trim(),
      pl: strip(it.PLACE), ad: '',
      img: https(it.MAIN_IMG),
      free, fee, age: strip(it.USE_TRGT), am: ageMinFrom(it.USE_TRGT),
      io: guessIO(it.PLACE, g, it.TITLE),
      lat: a, lng: b,
      url: link,
      tel: '',
    };
  }).filter((e) => e.sd && e.ed >= TODAY && e.sd <= UNTIL);
}

// ---------------------------------------------------------------- main
async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function main() {
  const cache = await readJson(CACHE_FILE, {});
  cache.tour ||= {}; cache.kopis ||= {}; cache.fac ||= {};
  const prev = await readJson(OUT_FILE, { events: [] });

  const sources = [
    ['tour', collectTour, '한국관광공사 TourAPI'],
    ['kopis', collectKopis, 'KOPIS'],
    ['seoul', collectSeoul, '서울 열린데이터광장'],
  ];
  const all = [];
  const meta = { sources: {} };
  for (const [key, fn, label] of sources) {
    if (!KEYS[key]) { log(`${label}: 키 없음 → 건너뜀`); continue; }
    try {
      const evs = await fn(cache);
      all.push(...evs);
      meta.sources[key] = { ok: true, count: evs.length };
    } catch (e) {
      // 한 출처가 실패하면 직전 수집분을 유지해 서비스가 비지 않게 한다
      const kept = prev.events.filter((x) => x.src === key && x.ed >= TODAY);
      all.push(...kept);
      meta.sources[key] = { ok: false, count: kept.length, error: String(e.message || e).slice(0, 200) };
      log(`${label} 실패 (이전 데이터 ${kept.length}건 유지):`, e.message);
    }
  }

  // 출처 간 중복 제거 (서울시 ↔ KOPIS 등): 이미지·요금 정보가 많은 쪽을 남김
  const score = (e) => (e.img ? 2 : 0) + (e.free !== null ? 1 : 0) + (e.am !== null ? 1 : 0) + (e.sgg ? 1 : 0);
  const map = new Map();
  for (const e of all) {
    const k = dedupeKey(e);
    const cur = map.get(k);
    if (!cur) map.set(k, e);
    else {
      const [win, lose] = score(e) > score(cur) ? [e, cur] : [cur, e];
      for (const f of ['img', 'fee', 'age', 'sgg', 'ad', 'lat', 'lng']) if (!win[f] && lose[f]) win[f] = lose[f];
      if (win.free === null) win.free = lose.free;
      if (win.am === null) win.am = lose.am;
      map.set(k, win);
    }
  }
  const events = [...map.values()].sort((a, b) => a.sd.localeCompare(b.sd) || a.t.localeCompare(b.t, 'ko'));

  // 캐시 정리: 지난 공연/축제 항목 제거로 파일 비대화 방지
  const alive = new Set(events.map((e) => e.id));
  for (const id of Object.keys(cache.tour)) if (!alive.has(`t:${id}`) && cache.tour[id].at < ymd(addDays(today, -30))) delete cache.tour[id];
  for (const id of Object.keys(cache.kopis)) if (!alive.has(`k:${id}`) && cache.kopis[id].at < ymd(addDays(today, -30))) delete cache.kopis[id];

  // null/빈 값 필드는 생략해 용량 절감
  const slim = events.map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== '' && v !== null && v !== undefined)));

  const out = {
    updated: new Date().toISOString(),
    range: { from: TODAY, to: UNTIL },
    count: slim.length,
    ...meta,
    events: slim,
  };
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out));
  await writeFile(CACHE_FILE, JSON.stringify(cache));
  log(`완료: ${slim.length}건 → docs/data/events.json`, JSON.stringify(meta.sources));
}

main().catch((e) => { console.error(e); process.exit(1); });
