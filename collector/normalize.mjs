// 공통 정규화 유틸 — 세 API의 서로 다른 필드를 하나의 이벤트 스키마로 맞춘다.
//
// 이벤트 스키마 (events.json 의 각 항목, 용량을 위해 짧은 키 사용)
//   id    고유 ID (출처 접두어 + 원본 ID)        예: "t:2612345", "k:PF250001", "s:154321"
//   src   출처  tour | kopis | seoul
//   t     제목
//   g     장르 키  festival|concert|musical|theater|classic|gugak|dance|exhibit|event|etc
//   sd/ed 시작/종료일 YYYY-MM-DD
//   sido  시·도 (짧은 이름: 서울, 경기 …)
//   sgg   시·군·구 (없으면 "")
//   pl    장소명,  ad 주소
//   img   대표 이미지(https)
//   free  true | false | null(모름)
//   fee   요금 원문,  age 관람연령 원문,  am 최소 관람 연령(숫자, 모르면 null)
//   io    in | out | null  (실내/야외 — 장소명 기반 추정)
//   lat/lng 좌표(있을 때만),  url 상세/예매 링크,  tel 문의처

export const SIDO = [
  ['서울', ['서울']],
  ['부산', ['부산']],
  ['대구', ['대구']],
  ['인천', ['인천']],
  ['광주', ['광주광역시', '광주시 ', '광주 ']],
  ['대전', ['대전']],
  ['울산', ['울산']],
  ['세종', ['세종']],
  ['경기', ['경기']],
  ['강원', ['강원']],
  ['충북', ['충북', '충청북도']],
  ['충남', ['충남', '충청남도']],
  ['전북', ['전북', '전라북도']],
  ['전남', ['전남', '전라남도']],
  ['경북', ['경북', '경상북도']],
  ['경남', ['경남', '경상남도']],
  ['제주', ['제주']],
];

/** 주소/지역 문자열에서 시·도 짧은 이름을 추출 */
export function normSido(s) {
  if (!s) return '';
  const str = String(s).trim() + ' ';
  // "경기도 광주시"는 경기로 — 광주광역시와 구분하기 위해 경기를 먼저 확인
  if (str.startsWith('경기')) return '경기';
  // 전남광주통합특별시: 옛 광주광역시 자치구면 광주, 나머지는 전남으로 나눠 기존 필터를 유지
  if (/^(전남광주|광주전남)/.test(str)) {
    const gu = str.trim().split(/\s+/)[1] || '';
    return /^(광주\s*)?(동구|서구|남구|북구|광산구)$/.test(gu) ? '광주' : str.trim().split(/\s+/).length > 1 ? '전남' : '';
  }
  for (const [name, keys] of SIDO) {
    if (keys.some((k) => str.startsWith(k))) return name;
  }
  // KOPIS area 값처럼 정확히 이름만 오는 경우
  for (const [name] of SIDO) if (str.trim() === name) return name;
  return '';
}

/** 지역이 '전남광주통합특별시'로만 와서 나눌 수 없을 때 제목·장소로 추정 */
const JEONNAM_CITY = /여수|순천|목포|나주|광양|담양|곡성|구례|고흥|보성|화순|장흥|강진|해남|영암|무안|함평|영광|장성|완도|진도|신안/;
export function guessGwangjuJeonnam(...texts) {
  const s = texts.filter(Boolean).join(' ');
  return JEONNAM_CITY.test(s) ? '전남' : '광주';
}

/** 주소에서 시·군·구 추출: "경기도 수원시 팔달구 …" → "수원시", 세종은 "" */
export function sggFromAddr(addr) {
  if (!addr) return '';
  const parts = String(addr).trim().split(/\s+/);
  if (parts.length < 2) return '';
  const p = parts[1];
  return /(시|군|구)$/.test(p) ? p : '';
}

/** 다양한 날짜 표기 → YYYY-MM-DD */
export function normDate(s) {
  if (!s) return '';
  const d = String(s).replace(/[^0-9]/g, '');
  if (d.length < 8) return '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export function https(url) {
  if (!url) return '';
  return String(url).trim().replace(/^http:\/\//i, 'https://');
}

const GENRE_KOPIS = [
  [/뮤지컬/, 'musical'],
  [/연극/, 'theater'],
  [/클래식|서양음악|오페라/, 'classic'],
  [/국악|한국음악/, 'gugak'],
  [/대중음악/, 'concert'],
  [/무용/, 'dance'],
];
export function genreFromKopis(genrenm) {
  for (const [re, g] of GENRE_KOPIS) if (re.test(genrenm || '')) return g;
  return 'etc'; // 복합, 서커스/마술 등
}

const GENRE_SEOUL = [
  [/^축제/, 'festival'],
  [/콘서트/, 'concert'],
  [/뮤지컬|오페라/, 'musical'],
  [/연극/, 'theater'],
  [/클래식|독주|독창/, 'classic'],
  [/국악/, 'gugak'],
  [/무용/, 'dance'],
  [/전시|미술/, 'exhibit'],
  [/교육|체험/, 'event'],
];
export function genreFromSeoul(codename) {
  for (const [re, g] of GENRE_SEOUL) if (re.test(codename || '')) return g;
  return 'etc';
}

const GENRE_CULTURE = [
  [/축제|행사/, 'festival'],
  [/뮤지컬|오페라/, 'musical'],
  [/연극/, 'theater'],
  [/클래식/, 'classic'],
  [/국악/, 'gugak'],
  [/무용|발레/, 'dance'],
  [/음악|콘서트/, 'concert'],
  [/전시|미술/, 'exhibit'],
  [/교육|체험/, 'event'],
];
export function genreFromCulture(realm) {
  for (const [re, g] of GENRE_CULTURE) if (re.test(realm || '')) return g;
  return 'etc'; // 아동/가족, 기타
}

const NUM_WON = /[0-9][0-9,]*\s*원/;
/** 요금 문구로 무료 여부 판정 */
export function freeFrom(text) {
  if (!text) return null;
  const s = String(text);
  if (NUM_WON.test(s) || /유료/.test(s)) return /전석\s*무료/.test(s) ? true : false;
  if (/무료|free/i.test(s)) return true;
  return null;
}

/** 관람연령 문구 → 최소 관람 연령(숫자) */
export function ageMinFrom(text) {
  if (text == null) return null;
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/청소년\s*관람\s*불가|성인|19세/.test(s)) return 19;
  let m = s.match(/(?:만\s*)?(\d{1,2})\s*세\s*이상/);
  if (m) return Number(m[1]);
  m = s.match(/(\d{1,2})\s*개월\s*이상/);
  if (m) return 0;
  m = s.match(/초등학생?\s*이상/);
  if (m) return 8;
  m = s.match(/중학생?\s*이상/);
  if (m) return 14;
  m = s.match(/고등학생?\s*이상/);
  if (m) return 17;
  if (/전체|전\s*연령|누구나|제한\s*없|연령\s*무관|관계\s*없|모든\s*연령|가족/.test(s)) return 0;
  return null;
}

const OUT_RE = /야외|공원|광장|해변|해수욕장|거리|일대|일원|강변|천변|호수|호수공원|숲|수목원|산림|둘레길|잔디|마을|시장|항구|포구|섬|한강|운동장|캠핑|들판|정원|축제장|해안/;
const IN_RE = /실내|극장|홀|아트센터|센터|미술관|박물관|갤러리|씨어터|시어터|소극장|회관|대극장|스테이지|스튜디오|도서관|문화원|아트스페이스|라운지|플랫폼|전시관|기념관|체육관|아레나|돔/;
/** 실내/야외 추정 (장소명 + 장르) */
export function guessIO(place, genre, title = '') {
  const s = `${place || ''} ${title || ''}`;
  if (/야외/.test(s)) return 'out';
  if (/실내/.test(s)) return 'in';
  if (IN_RE.test(place || '')) return 'in';
  if (OUT_RE.test(s)) return 'out';
  if (genre === 'festival') return 'out';
  if (['musical', 'theater', 'classic', 'gugak', 'dance', 'concert', 'exhibit'].includes(genre)) return 'in';
  return null;
}

export function strip(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** KOPIS XML(평평한 구조)용 초경량 파서 — 의존성 없이 <db> 단위로 필드 추출 */
export function parseXmlItems(xml, tag = 'db') {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(parseXmlFields(m[1]));
  return out;
}
export function parseXmlFields(block) {
  const obj = {};
  const re = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(block))) {
    const v = m[2].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
    if (obj[m[1]] === undefined) obj[m[1]] = v;
    else if (Array.isArray(obj[m[1]])) obj[m[1]].push(v);
    else obj[m[1]] = [obj[m[1]], v];
  }
  return obj;
}

/** 중복 판정용 키: 공백/특수문자 제거한 제목 + 시작일 */
export function dedupeKey(e) {
  const t = (e.t || '').replace(/^\s*(\[[^\]]*\]\s*)+/, '').replace(/[\s\[\]()<>〈〉《》「」『』"'“”‘’·,.:!?\-~]/g, '').toLowerCase();
  return `${t}|${e.sd}`;
}
