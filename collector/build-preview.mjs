// widget/imweb-widget.html 을 감싸 docs/index.html(GitHub Pages 미리보기 페이지)을 만든다.
//   node collector/build-preview.mjs            → data/events.json 사용
//   node collector/build-preview.mjs --demo     → 샘플 데이터
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const widget = await readFile(join(ROOT, 'widget', 'imweb-widget.html'), 'utf8');
const url = process.argv.includes('--demo') ? '' : 'data/events.json';
const body = widget.replace(/data-data-url="[^"]*"/, `data-data-url="${url}"`);
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>전국 문화생활</title><style>body{margin:0;background:#fff}</style></head>
<body>
${body}
</body></html>
`;
await mkdir(join(ROOT, 'docs'), { recursive: true });
await writeFile(join(ROOT, 'docs', 'index.html'), html);
await writeFile(join(ROOT, 'docs', '.nojekyll'), '');
console.log('docs/index.html 생성', url ? `(데이터: ${url})` : '(샘플 데이터)');
