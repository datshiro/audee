// The code_mapping page and chat notice: summary first, then the three copy-ready blocks. Summary text is model text,
// so it is defanged, clipped and escaped; the blocks are code, so they are escaped only and keep their exact bytes.
import { createHash } from 'node:crypto';
import { defang } from './defang.js';
import { ANSWER_PAGE_ATTRIBUTES, ANSWER_PAGE_ELEMENTS, answerPageStyle, answerPageVisibleTexts, checkPage, clip, escapeHTML, maxNoteChars, maxNotes, type MappingResult, preEscape } from './html.js';

const t = (s: string, n: number): string => escapeHTML(clip(defang(s), n));

// The page's only script. It may hold no "<" or ">", and any change to it changes the hash the CSP allows.
export const MAPPING_COPY_SCRIPT =
  "document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button[data-copy]');if(!b)return;" +
  "var el=document.getElementById(b.getAttribute('data-copy'));if(!el)return;" +
  "function sel(){var r=document.createRange();r.selectNodeContents(el);var s=window.getSelection();s.removeAllRanges();s.addRange(r);b.textContent='\\u0110\\u00e3 ch\\u1ecdn, nh\\u1ea5n Ctrl/Cmd+C';}" +
  "if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(el.textContent).then(function(){b.textContent='\\u0110\\u00e3 copy';},sel);}else{sel();}});";

export const mappingPageCSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(MAPPING_COPY_SCRIPT, 'utf8').digest('base64')}'`;

const MAPPING_PAGE_RULES = {
  elements: new Set([...ANSWER_PAGE_ELEMENTS, 'pre', 'button']),
  attributes: new Set([...ANSWER_PAGE_ATTRIBUTES, 'id', 'data-copy']),
  csp: mappingPageCSP,
  script: MAPPING_COPY_SCRIPT,
};

// The reason a mapping page fails the check, or undefined when it passes.
export function checkMappingPage(html: string): string | undefined {
  return checkPage(html, MAPPING_PAGE_RULES);
}

// What a reader sees, for the secret check: the script is not shown.
export function mappingPageVisibleTexts(html: string): string[] {
  return answerPageVisibleTexts(html.replace(`<script>${MAPPING_COPY_SCRIPT}</script>`, ''));
}

const STYLE = `${answerPageStyle}
h2{font-size:20px;margin:28px 0 8px}
.po{border:1px solid var(--line);padding:4px 16px 12px;margin:16px 0}
.blk{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:28px 0 8px}
.blk h2{margin:0}
button{font:inherit;font-size:14px;padding:4px 12px;border:1px solid var(--line);border-radius:6px;background:var(--code);color:var(--fg);cursor:pointer}
pre{white-space:pre-wrap;word-break:break-all;font:13px/1.5 ui-monospace,Menlo,monospace}`;

const list = (items: string[] | undefined): string =>
  (items ?? []).length === 0 ? '<p>Không có.</p>' : `<ul>${(items ?? []).slice(0, maxNotes).map((s) => `<li>${t(s, maxNoteChars)}</li>`).join('')}</ul>`;

const block = (id: string, title: string, value: string): string =>
  `<div class="blk"><h2>${title}</h2><button data-copy="${id}">Copy</button></div>\n<pre id="${id}">\n${preEscape(value)}</pre>`; // a browser drops one newline after <pre>: this one, not the value's

export function mappingPage(request: string, res: MappingResult): string {
  const notes = (res.notes ?? []).length > 0 ? `<h3>Ghi chú</h3>${list(res.notes)}` : '';
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${mappingPageCSP}">
<title>Code mapping</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header><h1>Code mapping</h1><p>Bạn kiểm tra lại trước khi tạo EventSource nhé.</p></header>
<blockquote>${t(request, 4000)}</blockquote>
<section class="po"><h2>Tóm tắt</h2>
<p><strong>Probe:</strong> ${t(res.probeSummary ?? '', maxNoteChars)}</p>
<p><strong>Identity:</strong> ${t(res.identityVerdict ?? '', maxNoteChars)}</p>
<h3>Giả định</h3>${list(res.assumptions)}
<h3>Cần xác nhận</h3>${list(res.toConfirm)}
${notes}</section>
${block('codeMapping', 'codeMapping', JSON.stringify(res.codeMapping ?? ''))}
${block('supportedOutputFields', 'supportedOutputFields', JSON.stringify(res.supportedOutputFields ?? [], null, 2))}
${block('sampleMessage', 'sampleMessage', res.sampleMessage ?? '')}
</main>
<script>${MAPPING_COPY_SCRIPT}</script>
</body>
</html>
`;
}

export const mappingNotice = (res: MappingResult): string =>
  '🤖 <b>Code mapping xong</b>, mình gửi trong file, bạn kiểm tra lại trước khi tạo EventSource nhé:' +
  `<br>${t(res.probeSummary ?? '', maxNoteChars)}<br>${t(res.identityVerdict ?? '', maxNoteChars)}`;

// Same UTC stamp as kbAnswerFileName.
export function mappingFileName(messageId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `codemapping-${messageId}-${stamp}.html`;
}

// Every string the page shows, plus the request, for the secret check before rendering.
export function mappingTexts(request: string, res: MappingResult): string[] {
  return [request, res.codeMapping ?? '', res.sampleMessage ?? '', JSON.stringify(res.supportedOutputFields ?? []), res.probeSummary ?? '', res.identityVerdict ?? '', ...(res.assumptions ?? []), ...(res.toConfirm ?? []), ...(res.notes ?? [])];
}
