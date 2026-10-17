import { defang, defangAll } from './defang.js';
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
export const reviewedReply = '<b>Đã review xong MR này.</b> Bạn xem các comment trên MR để tự kiểm tra nhé.';
export const queuedReply = '👀 <b>Mình đang review.</b> Có gì mình sẽ báo nhé.';
export const failedReply = '❌ <b>Review MR này bị lỗi.</b> Mình sẽ xem lại.';
export const recentReply = '🔁 <b>Đã được nhờ review trong 30 phút qua</b>, nên mình không review lại.';
export const mappingQueuedReply = '👀 <b>Đang làm code mapping.</b> Xong mình sẽ gửi nhé.';
export const mappingFailedReply = '❌ <b>Code mapping bị lỗi.</b> Mình sẽ xem lại.';

// ciel/mapping.go:174-181
export const mappingMissingReply = '<b>Mình cần thêm thông tin để làm code mapping:</b>';
export const mappingDoneReply = '<b>Code mapping xong.</b> Bạn kiểm tra lại trước khi tạo EventSource nhé.';
export const mappingTooLongReply = '<b>Code mapping xong</b> nhưng quá dài để gửi trong chat, mình gửi file:';
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
export const kbQueryPendingReply = 'Bạn đang có một câu hỏi <b>kb_query</b> chưa xong, đợi có câu trả lời rồi hỏi tiếp nhé.';
export const kbQueryClipped = '… (câu trả lời dài hơn, đã cắt bớt; hỏi hẹp lại để xem chi tiết)';
export const maxKBQuerySources = maxNotes;
export const maxKBQuerySourceChar = 200;

// audee: read-only capabilities other than kb_query (mcp_read, such as Grafana)
export const readQueuedReply = '👀 <b>Đang tra cứu.</b> Có câu trả lời mình sẽ gửi nhé.';
export const readFailedReply = '❌ <b>Tra cứu bị lỗi.</b> Mình sẽ xem lại.';

// audee additions
export function deniedText(capability: string): string {
  return `Bạn chưa được cấp quyền dùng <b>${escapeHTML(capability)}</b>. Hãy nhờ Đạt cấp quyền nhé.`;
}

export function busyText(): string {
  return 'Hàng đợi đang đầy, bạn thử lại sau ít phút nhé.';
}

// ciel/actions.go:200-220, keyed by the job kind
export function queuedText(kind: string): string {
  if (kind === 'review') return queuedReply;
  if (kind === 'kb_query') return kbQueryQueuedReply;
  if (kind === 'code_mapping') return mappingQueuedReply;
  return readQueuedReply;
}

export function failedText(kind: string): string {
  if (kind === 'review') return failedReply;
  if (kind === 'kb_query') return kbQueryFailedReply;
  if (kind === 'code_mapping') return mappingFailedReply;
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

// ciel/mapping.go:186-194: JSON-quoted so the requester can paste codeMapping into an EventSource payload.
export function jsonString(s: string): string {
  return JSON.stringify(s);
}

export type MappingResult = {
  status: string;
  codeMapping?: string;
  sampleMessage?: string;
  supportedOutputFields?: unknown[];
  notes?: string[];
  missing?: string[];
};

// ciel/mapping.go:164-183 mappingReplyHTML: [html, fits]
export function mappingReplyHTML(res: MappingResult): [string, boolean] {
  if (res.status === 'need_input') return [mappingMissingReply + noteList(res.missing ?? []), true];
  const fields = JSON.stringify(res.supportedOutputFields ?? null, null, 2);
  let out = mappingDoneReply;
  for (const [name, value] of [['codeMapping', jsonString(res.codeMapping ?? '')], ['supportedOutputFields', fields]] as const) {
    out += `<br><b>${name}</b><pre>${preEscape(value)}</pre>`;
  }
  if (runeLength(out) > maxReplyChars) return [mappingTooLongReply, false];
  return [out, true];
}

export type KbQueryResult = {
  status: string;
  answer?: string;
  sources?: string[];
  notes?: string[];
  missing?: string[];
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
