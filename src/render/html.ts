import MarkdownIt from 'markdown-it';
import { defang, defangAll } from './defang.js';
import { leaksSecret } from './secrets.js';
import { runeLength, runeSlice } from './text.js';

// ciel/detect.go:49 escapeHTML (Go html.EscapeString)
export function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;');
}

// ciel/mapping.go:195 preEscaper: inside <pre>, quotes need no escaping.
export function preEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ciel/actions.go:328-340
export const queuedReply = '👀 <b>Mình đang review.</b> Có gì mình sẽ báo nhé.';
export const failedReply = '❌ <b>Review MR này bị lỗi.</b> Mình sẽ xem lại.';
// The reason is model text going to the chat: hidden if it looks like a secret, links defanged, length capped.
function safeReason(reason: string, knownSecrets: string[]): string {
  if (reason.trim() === '' || leaksSecret([reason], knownSecrets)) return '';
  return escapeHTML(runeSlice(defang(reason), maxNoteChars));
}
function withReason(head: string, reason: string, knownSecrets: string[]): string {
  const safe = safeReason(reason, knownSecrets);
  return safe === '' ? head : `${head}: ${safe}`;
}
export function reviewApprovedReply(reason: string, knownSecrets: string[]): string {
  return withReason('✅ <b>MR sẵn sàng merge</b>, mình đã approve', reason, knownSecrets);
}
export function reviewReadyWaitReply(why: string, knownSecrets: string[]): string {
  return withReason('✅ <b>MR sẵn sàng merge</b>, chờ Đạt approve', why, knownSecrets);
}
export function reviewBlockedReply(reason: string, knownSecrets: string[], posted: boolean): string {
  return withReason('⛔ <b>MR chưa merge được</b>', reason, knownSecrets) + (posted ? '. Xem comment trên MR.' : '.');
}
export function reviewUnreviewableReply(reason: string, knownSecrets: string[]): string {
  return withReason('⚠️ <b>Chưa đánh giá được MR</b>', reason, knownSecrets);
}
export const recentReply = '🔁 <b>Đã được nhờ review trong 10 phút qua</b>, nên mình không review lại.';
export const mappingQueuedReply = '👀 <b>Đang làm code mapping.</b> Xong mình sẽ gửi nhé.';
export const mappingFailedReply = '❌ <b>Code mapping bị lỗi.</b> Mình sẽ xem lại.';

// ciel/mapping.go:174-181
export const mappingMissingReply = '<b>Mình cần thêm thông tin để làm code mapping:</b>';
export const mappingWithheldReply = '❌ <b>Kết quả code mapping có thể chứa thông tin bí mật nên mình không gửi.</b> Mình sẽ xem lại.';
export const maxReplyChars = 20000;
export const maxNoteChars = 300;
export const maxNotes = 10;

// ciel/kbquery.go:345-359
export const maxKBQueryAnswer = 12000;
export const kbQueryQueuedReply = '👀 <b>Đang tra KB.</b> Có câu trả lời mình sẽ gửi nhé.';
export const kbQueryFailedReply = '❌ <b>Tra KB bị lỗi.</b> Mình sẽ xem lại.';
export const kbQueryEmptyReply = 'Bạn ghi câu hỏi sau <b>kb_query</b> nhé, ví dụ: kb_query past segment hoạt động thế nào?';
export const kbQueryMissingReply = '<b>Mình cần bạn nói rõ hơn để tra KB:</b>';
export const kbQueryDoneReply = '🤖 <b>Trả lời tự động từ KB</b>, bạn kiểm tra lại trước khi dùng nhé:';
export const kbQueryWithheldReply = '❌ <b>Câu trả lời từ KB có thể chứa thông tin bí mật nên mình không gửi.</b> Mình sẽ xem lại.';
export const kbQueryFileReply = '🤖 <b>Trả lời tự động từ KB</b>, mình gửi trong file, bạn kiểm tra lại trước khi dùng nhé:';
export const maxKBTopicWords = 20;
// The topic is model text going to the chat: defanged, escaped, at most maxKBTopicWords words.
export function kbTopicLine(topic: string | undefined, question: string): string {
  const words = (s: string): string[] => s.trim().split(/\s+/).filter((w) => w !== '');
  const t = words(topic ?? '');
  const chosen = t.length > 0 && t.length <= maxKBTopicWords ? t.join(' ') : clipWords(words(question));
  return chosen === '' ? '' : `<br><i>Về: ${escapeHTML(runeSlice(defang(chosen), maxNoteChars))}</i>`;
}
function clipWords(w: string[]): string {
  return w.length <= maxKBTopicWords ? w.join(' ') : w.slice(0, maxKBTopicWords).join(' ') + '…';
}
export const kbQueryNotKnownReply = '🤖 <b>Mình chưa tìm thấy nguồn đáng tin trong KB hay code cho câu này</b>, nên mình không trả lời để tránh nói sai.';
export function kbRemovedLine(n: number): string {
  return n === 0 ? '' : `<br>Đã bỏ ${n} ý chưa kiểm chứng được trong code hoặc KB.`;
}
export function kbConfluenceLine(dates: string[]): string {
  return dates.length === 0 ? '' : `<br>Một phần câu trả lời dựa trên bản sao Confluence đồng bộ ngày ${dates.join(', ')}; nội dung gốc có thể đã đổi.`;
}
export const kbQueryPendingReply = 'Bạn đang có một câu hỏi <b>kb_query</b> chưa xong, đợi có câu trả lời rồi hỏi tiếp nhé.';
export const kbQueryClipped = '… (câu trả lời dài hơn, đã cắt bớt; hỏi hẹp lại để xem chi tiết)';
export const maxKBQuerySources = maxNotes;
export const maxKBQuerySourceChar = 200;

// audee: read-only capabilities other than kb_query (mcp_read, such as Grafana)
export const readQueuedReply = '👀 <b>Đang tra cứu.</b> Có câu trả lời mình sẽ gửi nhé.';
export const readFailedReply = '❌ <b>Tra cứu bị lỗi.</b> Mình sẽ xem lại.';

// audee: iam_trace
export const iamTraceQueuedReply = '👀 <b>Đang trace IAM.</b> Xong mình sẽ gửi timeline nhé.';
export const iamTraceFailedReply = '❌ <b>Trace IAM bị lỗi.</b> Mình sẽ xem lại.';
export const iamTraceWithheldReply = '❌ <b>Kết quả trace IAM có thể chứa thông tin bí mật nên mình không gửi.</b> Mình sẽ xem lại.';
export const iamTraceUsageReply = 'Gửi <b>iam_trace</b> kèm campaignId, journeyId hoặc link campaign/journey, các userId/roleId (tối đa 5) và thời điểm nếu có, viết tự nhiên cũng được, ví dụ: iam_trace campaign 1234 user u1, role r2 lúc 9h sáng nay.';
export function iamTraceMissingReply(missing: string[]): string {
  return '<b>Mình cần thêm thông tin để trace IAM:</b>' + noteList(defangAll(missing)) + iamTraceUsageReply;
}
// The reply to a trigger word with nothing after it.
export function emptyText(kind: string): string {
  return kind === 'iam_trace' ? iamTraceUsageReply : kbQueryEmptyReply;
}

// audee additions
export function deniedText(capability: string): string {
  return `Bạn chưa được cấp quyền dùng <b>${escapeHTML(capability)}</b>. Hãy nhờ Đạt cấp quyền nhé.`;
}

// A kind with no capability in the config: the owner has to enable it.
export function unavailableText(capability: string): string {
  return `<b>${escapeHTML(capability)}</b> chưa được bật. Hãy báo Đạt nhé.`;
}

// The requester already has as many requests waiting as allowed.
export function pendingText(kind: string): string {
  if (kind === 'kb_query') return kbQueryPendingReply;
  return 'Bạn đang có yêu cầu chưa xong, đợi xong rồi gửi tiếp nhé.';
}

export function busyText(): string {
  return 'Hàng đợi đang đầy, bạn thử lại sau ít phút nhé.';
}

// ciel/actions.go:200-220, keyed by the job kind
export function queuedText(kind: string): string {
  if (kind === 'review') return queuedReply;
  if (kind === 'kb_query') return kbQueryQueuedReply;
  if (kind === 'code_mapping') return mappingQueuedReply;
  if (kind === 'iam_trace') return iamTraceQueuedReply;
  return readQueuedReply;
}

export function failedText(kind: string): string {
  if (kind === 'review') return failedReply;
  if (kind === 'kb_query') return kbQueryFailedReply;
  if (kind === 'code_mapping') return mappingFailedReply;
  if (kind === 'iam_trace') return iamTraceFailedReply;
  return readFailedReply;
}

// ciel/actions.go:389-404
export function replyHTML(text: string, ...mrUrls: string[]): string {
  let out = text;
  for (const u of mrUrls) out += `<br><a href="${escapeHTML(u)}">${escapeHTML(u)}</a>`;
  return out;
}

export function firstLine(s: string): string {
  const trimmed = s.trim();
  const i = trimmed.indexOf('\n');
  return i >= 0 ? trimmed.slice(0, i) : trimmed;
}

// ciel/kbquery.go:400-405
export function clip(s: string, n: number): string {
  return runeLength(s) > n ? runeSlice(s, n) + '…' : s;
}

// ciel/mapping.go:197-211
export function noteList(items: string[]): string {
  let out = '<ul>';
  for (const [i, s] of items.entries()) {
    if (i === maxNotes) break;
    out += '<li>' + escapeHTML(clip(s, maxNoteChars)) + '</li>';
  }
  return out + '</ul>';
}

export type MappingResult = {
  status: string;
  codeMapping?: string;
  sampleMessage?: string;
  supportedOutputFields?: unknown[];
  probeSummary?: string;
  identityVerdict?: string;
  assumptions?: string[];
  toConfirm?: string[];
  notes?: string[];
  missing?: string[];
};

export type KbQueryResult = {
  status: string;
  answer?: string;
  sources?: string[];
  notes?: string[];
  missing?: string[];
  topic?: string;
};

// ciel/kbquery.go:361-373 kbQueryReplyHTML: [html, clipped]
export function kbQueryReplyHTML(res: KbQueryResult): [string, boolean] {
  if (res.status === 'need_input') return [kbQueryMissingReply + noteList(defangAll(res.missing ?? [])), false];
  const clipped = clipSources(res.sources ?? []);
  const sources = clipped.length > 0 ? '<b>Nguồn:</b>' + noteList(clipped) : '';
  // Escaping grows the sources too, so the answer gets what the rest of the reply leaves.
  const budget = Math.min(maxKBQueryAnswer, maxReplyChars - runeLength(kbQueryDoneReply + '<pre></pre>' + sources));
  const [answer, wasClipped] = fitAnswer(res.answer ?? '', budget);
  return [kbQueryDoneReply + '<pre>' + answer + '</pre>' + sources, wasClipped];
}

// The page is opened from OneDrive by colleagues: raw HTML is escaped and links and images stay plain text, so
// nothing the model wrote can run, load or be clicked. Entities and backslash escapes stay literal, so the text
// a reader sees is the text the secret check read.
const answerMarkdown = new MarkdownIt({ html: false, linkify: false }).disable(['link', 'image', 'autolink', 'entity', 'escape']);
export const maxKBAnswerFileChars = 50000;

export function kbAnswerHTML(answer: string): string {
  return answerMarkdown.render(defang(answer));
}

// What a reader of the rendered answer sees, for the secret check: Markdown can split a "key: value" pair or a token
// with emphasis or code tags, so tags are dropped both with nothing (one token) and with a space, table cells as pairs.
export function kbAnswerVisibleTexts(html: string): string[] {
  const text = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;|&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const strip = (s: string) => text(s.replace(/<[^>]*>/g, ''));
  const cells = html.replace(/<\/t[dh]>\s*<t[dh][^>]*>/g, ': ');
  return [strip(html), text(cells.replace(/<[^>]*>/g, ' ')), ...headedCells(html).map(strip)];
}

// "<header>: <cell>" for every body cell of every table, so a value is read beside the column that names it.
function headedCells(html: string): string[] {
  const out: string[] = [];
  for (const [, table = ''] of html.matchAll(/<table>([\s\S]*?)<\/table>/g)) {
    const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, r = '']) => [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, c = '']) => c));
    const [head = [], ...body] = rows;
    for (const row of body) row.forEach((cell, i) => out.push(`${head[i] ?? ''}: ${cell}`));
  }
  return out;
}

// The product answer page comes from kb-mcp render-answer, a binary audee does not build. The check reads the page
// strictly, so anything a browser could read differently is refused: a lone doctype, one <head> with the fixed CSP
// meta, one stylesheet that loads nothing, and otherwise only well-formed tags with the renderer's own elements and
// attributes. Escaped text holds no raw "<" or ">". Reasons are fixed words, never page content.
export const answerPageCSP = "default-src 'none'; style-src 'unsafe-inline'";
export const ANSWER_PAGE_ELEMENTS: ReadonlySet<string> = new Set('html head meta title style body main header section div p span strong ol ul li table thead tbody tr th td small footer blockquote h1 h2 h3 svg g rect polygon path text tspan'.split(' '));
export const ANSWER_PAGE_ATTRIBUTES: ReadonlySet<string> = new Set('class lang charset name content http-equiv viewBox x y width height rx points d role aria-hidden'.split(' '));
export const maxAnswerPageBytes = 2 * 1024 * 1024;
// HTML whitespace only: JS \s also matches NBSP and friends, which a browser reads as text or part of a tag name.
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[\t\n\f\r ]+[a-zA-Z][-a-zA-Z:]*(?:="[^"<>]*")?)*)[\t\n\f\r ]*(\/?)>/g;
const ATTR = /[\t\n\f\r ]+([a-zA-Z][-a-zA-Z:]*)(?:="([^"<>]*)")?/g;
// A browser drops a CSP meta that is not in <head>, and anything but whitespace or another meta before it ends <head>.
const HEAD_BEFORE_CSP = /^[\t\n\f\r ]*<html(?:[\t\n\f\r ][^<>]*)?>[\t\n\f\r ]*<head>(?:[\t\n\f\r ]*<meta[\t\n\f\r ][^<>]*>)*[\t\n\f\r ]*$/i;

// The rules a page is checked against. script, when set, is the one script the page may carry, byte for byte.
export type PageRules = { elements: ReadonlySet<string>; attributes: ReadonlySet<string>; csp: string; script?: string };
const ANSWER_PAGE_RULES: PageRules = { elements: ANSWER_PAGE_ELEMENTS, attributes: ANSWER_PAGE_ATTRIBUTES, csp: answerPageCSP };

// The reason a page fails the check, or undefined when it passes.
export function checkAnswerPage(html: string): string | undefined {
  return checkPage(html, ANSWER_PAGE_RULES);
}

export function checkPage(html: string, rules: PageRules): string | undefined {
  if (Buffer.byteLength(html) > maxAnswerPageBytes) return 'page too large';
  if (!/^<!doctype html>/i.test(html)) return 'markup';
  const opens = html.match(/<style/gi) ?? [];
  const closes = html.match(/<\/style/gi) ?? [];
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (opens.length !== 1 || closes.length !== 1 || style === null) return 'stylesheet';
  if (/url\(|image-set\(|src\(|@import|expression\(|\\|<|>/i.test(style[1] ?? '')) return 'stylesheet';
  let markup = html.replace(/^<!doctype html>/i, '').replace(style[0], '<style></style>');
  if (rules.script !== undefined) {
    const block = `<script>${rules.script}</script>`;
    const scriptOpens = markup.match(/<script/gi) ?? [];
    const scriptCloses = markup.match(/<\/script/gi) ?? [];
    if (scriptOpens.length !== 1 || scriptCloses.length !== 1 || !markup.includes(block)) return 'script';
    markup = markup.replace(block, '');
  }
  let csp = 0;
  let cspAt = -1;
  let charset = 0;
  let charsetAt = -1;
  for (const m of markup.matchAll(TAG)) {
    const name = (m[2] ?? '').toLowerCase();
    if (!rules.elements.has(name)) return 'element';
    const attrs = new Map<string, string>();
    for (const [, attr = '', value = ''] of (m[3] ?? '').matchAll(ATTR)) {
      if (!rules.attributes.has(attr) || attrs.has(attr.toLowerCase())) return 'attribute';
      attrs.set(attr.toLowerCase(), value);
    }
    if (attrs.has('charset')) {
      if (name !== 'meta' || attrs.get('charset')?.toLowerCase() !== 'utf-8') return 'attribute';
      charset++;
      charsetAt = m.index ?? -1;
    }
    if (attrs.has('http-equiv')) {
      if (name !== 'meta' || attrs.get('http-equiv')?.toLowerCase() !== 'content-security-policy') return 'csp';
      const content = (attrs.get('content') ?? '').replaceAll('&#39;', "'");
      if (content !== rules.csp) return 'csp';
      csp++;
      cspAt = m.index ?? -1;
    }
  }
  if (/[<>]/.test(markup.replace(TAG, ''))) return 'markup';
  if (csp !== 1 || !HEAD_BEFORE_CSP.test(markup.slice(0, cspAt))) return 'csp';
  // Without a declared charset the browser sniffs one, which can read the page differently from this check.
  if (charset !== 1 || charsetAt > cspAt) return 'attribute';
  return undefined;
}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

// Every entity decoded, numeric ones included, so an encoded value reads as it shows.
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

// What a reader of the product page sees, for the secret check: titles and SVG labels included, the stylesheet left
// out, tags dropped with nothing and with a space, table cells as pairs.
export function answerPageVisibleTexts(html: string): string[] {
  const body = html.replace(/<style>[\s\S]*?<\/style>/gi, '');
  const strip = (s: string, sep: string) => decodeEntities(s.replace(/<[^>]*>/g, sep));
  const cells = body.replace(/<\/t[dh]>\s*<t[dh][^>]*>/g, ': ');
  return [strip(body, ''), strip(cells, ' '), ...headedCells(body).map((c) => strip(c, ''))];
}

export const answerPageStyle =`:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--code:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--code:#151b23}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px}
header p{color:var(--muted);margin:0 0 12px}
blockquote{margin:0 0 24px;padding:8px 16px;border-left:4px solid var(--line);color:var(--muted);white-space:pre-wrap}
pre{background:var(--code);padding:12px;border-radius:6px;overflow-x:auto}
code{background:var(--code);padding:0 4px;border-radius:4px;font-size:90%}
pre code{padding:0;background:none}
table{border-collapse:collapse;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:6px 12px}
footer{margin-top:32px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}`;

export function kbAnswerPage(question: string, res: KbQueryResult): string {
  const sources = clipSources(res.sources ?? []);
  const sourceList = sources.length > 0 ? '<footer><b>Nguồn:</b><ul>' + sources.map((s) => `<li>${escapeHTML(s)}</li>`).join('') + '</ul></footer>' : '';
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Trả lời từ KB</title>
<style>${answerPageStyle}</style>
</head>
<body>
<main>
<header><h1>Trả lời tự động từ KB</h1><p>Bạn kiểm tra lại trước khi dùng nhé.</p></header>
<blockquote>${escapeHTML(question)}</blockquote>
${kbAnswerHTML(res.answer ?? '')}
${sourceList}
</main>
</body>
</html>
`;
}

// Same stamp as the code mapping file: UTC yyyymmdd-hhmmss.
export function kbAnswerFileName(messageId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `kb-answer-${messageId}-${stamp}.html`;
}

// ciel/kbquery.go:376-388
export function fitAnswer(answer: string, limit: number): [string, boolean] {
  let html = preEscape(defang(answer));
  if (runeLength(html) <= limit) return [html, false];
  for (let n = runeLength(answer); ; n = Math.floor((n * 9) / 10)) {
    html = preEscape(defang(runeSlice(answer, n) + '\n' + kbQueryClipped));
    if (runeLength(html) <= limit || n === 0) return [html, true];
  }
}

// ciel/kbquery.go:390-398
export function clipSources(sources: string[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    if (out.length === maxKBQuerySources) break;
    out.push(defang(clip(s, maxKBQuerySourceChar)));
  }
  return out;
}
