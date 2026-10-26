// The iam_trace timeline page and chat notice, built by audee from the merged trace: no model HTML, every model
// string defanged, clipped and escaped, and only the markup checkAnswerPage allows.
import { type CheckedPoint, ictTime, type IamTraceRequest, type MergedTrace, type PointKind, type PointState, rowOf, type TraceResult } from '../capability/iam-trace-schema.js';
import { strings } from '../capability/kb-answer.js';
import { defang } from './defang.js';
import { answerPageCSP, answerPageStyle, clip, escapeHTML, maxNoteChars, maxNotes } from './html.js';

const t = (s: string, n: number): string => escapeHTML(clip(defang(s), n));

const STATE_VI: Record<PointState, string> = { seen: 'ghi nhận', inferred: 'suy ra', not_recorded: 'không ghi nhận' };
const CHECK_VI: Record<CheckedPoint['check'], string> = { confirmed: ' · đã kiểm chứng', corrected: ' · đã sửa khi kiểm chứng', unverified: ' · chưa kiểm chứng' };
const KIND_VI: Record<PointKind, string> = {
  trigger: 'Trigger',
  wait_end: 'Hết wait',
  check_call: 'Gọi kiểm tra',
  condition: 'Kết quả điều kiện',
  frequency: 'Frequency check',
  send: 'Gửi IAM',
  delivered: 'Client ack',
  sdk_event: 'SDK tracking',
  inbox: 'App Inbox',
};
// The merge's reasons are fixed English words; any other value is shown as the generic phrase, never as given.
const REASON_VI = new Map([
  ['verifier checked no point', 'phiên kiểm chứng không kiểm lại được mốc nào'],
  ['verifier changed most points', 'phiên kiểm chứng sửa quá nửa số mốc nên các chỉnh sửa không được áp dụng'],
]);
const reasonText = (reason: string): string => REASON_VI.get(reason) ?? 'kết quả kiểm chứng không dùng được';

const STYLE = `${answerPageStyle}
:root{--srv:#0969da;--cli:#8250df}
@media (prefers-color-scheme:dark){:root{--srv:#4493f8;--cli:#ab7df8}}
main{max-width:1100px}
.warn{color:var(--fg);font-weight:600}
section{margin:32px 0}
.row{display:flex;gap:12px;align-items:flex-start;margin:8px 0}
.lane{flex:0 0 56px;font-weight:600;color:var(--muted)}
ol.tl{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:0;padding:0}
ol.tl li{display:flex;flex-direction:column;min-width:120px;padding:2px 8px;border-left:4px solid var(--srv)}
ol.client li{border-left-color:var(--cli)}
li.inferred{border-left-style:dashed}
li.not_recorded{border-left-style:dotted;color:var(--muted)}
.t{font-size:14px;font-variant-numeric:tabular-nums}
.l{font-weight:600}
.ev{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Menlo,monospace;font-size:13px}
td small{display:block;color:var(--muted)}`;

function timeText(p: CheckedPoint): string {
  if (p.state === 'not_recorded') return '—';
  const ict = ictTime(p.time);
  if (ict === undefined) return '?';
  return (p.source_field === '_time' ? '≈ ' : '') + ict.text;
}

// Stable, so points at the same instant keep the model's order; unparseable times go last.
function byTime(points: CheckedPoint[]): CheckedPoint[] {
  const at = (p: CheckedPoint): number => ictTime(p.time)?.ms ?? Infinity;
  return [...points].sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
}

const label = (p: CheckedPoint): string => (p.label.trim() === '' ? KIND_VI[p.kind] : t(p.label, 80));
const status = (p: CheckedPoint): string => STATE_VI[p.state] + CHECK_VI[p.check];

function row(name: 'server' | 'client', lane: string, points: CheckedPoint[]): string {
  const items = points.map((p) => `<li class="${p.state}"><span class="t">${timeText(p)}</span><span class="l">${label(p)}${p.state === 'inferred' ? ' *' : ''}</span><small>${status(p)}</small></li>`);
  const list = items.length > 0 ? items.join('') : '<li class="not_recorded"><span class="l">không ghi nhận mốc nào</span></li>';
  return `<div class="row"><span class="lane">${lane}</span><ol class="tl ${name}">${list}</ol></div>`;
}

function tableRow(p: CheckedPoint): string {
  const why = p.state === 'inferred' && p.why.trim() !== '' ? `<small>Suy ra vì: ${t(p.why, 300)}</small>` : '';
  return `<tr><td>${KIND_VI[p.kind]}: ${label(p)}</td><td>${timeText(p)}</td><td>${t(p.source_field, 60)}</td><td>${status(p)}</td><td><div class="ev">${t(p.evidence, 600)}</div>${why}</td></tr>`;
}

function userSection(u: MergedTrace['users'][number]): string {
  const server = byTime(u.points.filter((p) => rowOf(p.kind) === 'server'));
  const client = byTime(u.points.filter((p) => rowOf(p.kind) === 'client'));
  return `<section><h2>${t(u.id, 64)} <small>userId ${t(u.user_id, 64) || '—'} · roleId ${t(u.role_id, 64) || '—'}</small></h2>
${row('server', 'Server', server)}
${row('client', 'Client', client)}
<table><thead><tr><th>Mốc</th><th>Giờ (ICT)</th><th>Trường</th><th>Trạng thái</th><th>Bằng chứng</th></tr></thead><tbody>${[...server, ...client].map(tableRow).join('')}</tbody></table></section>`;
}

function verifyLine(trace: MergedTrace): string {
  const c = trace.counts;
  if (trace.verified) return ` Đã kiểm chứng độc lập bằng một phiên truy vấn lại: ${c.confirmed} mốc khớp, ${c.corrected} mốc đã sửa, ${c.unverified} mốc chưa kiểm chứng.`;
  return ` Chưa kiểm chứng độc lập${trace.reason !== undefined ? `: ${reasonText(trace.reason)}` : ''}.`;
}

export function iamTracePage(req: IamTraceRequest, trace: MergedTrace): string {
  const filter = req.timeFilter !== undefined ? ' Bộ lọc thời gian _time chưa được xác minh trên kho log.' : '';
  const notes = trace.notes.slice(0, maxNotes).map((n) => `<li>${t(n, maxNoteChars)}</li>`).join('');
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${answerPageCSP}">
<title>Trace IAM</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header><h1>${t(trace.finding, 300) || 'Trace IAM'}</h1><p>IAM ${t(req.target, 64)} · ${t(req.window, 120)} · giờ ICT</p><p class="warn">Temporal không kiểm tra.${filter}${verifyLine(trace)}</p></header>
${trace.users.map(userSection).join('\n')}
<footer><h3>Ghi chú</h3><ul>${notes}<li>* suy ra: không có dòng log trực tiếp, suy từ bước chạy sau.</li><li>≈ ước lượng từ giờ kho log (_time): công cụ không trả về giờ trong dòng log, và giờ kho log có thể lệch so với lúc dòng log được ghi.</li><li>"Không ghi nhận" nghĩa là không tìm thấy dòng log trong khoảng đã tra.</li><li>Không gồm Temporal và các mốc nghiệp vụ của team khác.</li></ul></footer>
</main>
</body>
</html>
`;
}

export function iamTraceNotice(req: IamTraceRequest, trace: MergedTrace): string {
  const states: Record<PointState, number> = { seen: 0, inferred: 0, not_recorded: 0 };
  for (const u of trace.users) for (const p of u.points) states[p.state] += 1;
  const { corrected, unverified } = trace.counts;
  return (
    '🤖 <b>Trace IAM tự động</b>, timeline trong file, bạn kiểm tra lại trước khi dùng nhé:<br>' +
    t(trace.finding, 300) +
    `<br>${trace.users.length} user · ${states.seen} mốc ghi nhận · ${states.inferred} mốc suy ra · ${states.not_recorded} mốc không ghi nhận` +
    (corrected > 0 ? ` · ${corrected} mốc đã sửa khi kiểm chứng` : '') +
    (unverified > 0 ? ` · ${unverified} mốc chưa kiểm chứng` : '') +
    (trace.verified ? '' : ` · chưa kiểm chứng độc lập${trace.reason !== undefined ? ` (${reasonText(trace.reason)})` : ''}`) +
    `<br><i>Temporal không kiểm tra. Khoảng tra: ${t(req.window, 120)}.</i>`
  );
}

// Every string a trace holds, plus each point's label beside its evidence so a secret-named pair split across the two
// is still read as a pair. Accepts the raw trace so the capability can check it before any merge.
export function iamTraceTexts(trace: TraceResult | MergedTrace): string[] {
  const out = strings(trace);
  for (const u of trace.users) for (const p of u.points) out.push(`${p.label}: ${p.evidence}`);
  return out;
}

// Same UTC stamp as kbAnswerFileName.
export function iamTraceFileName(messageId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `iam-trace-${messageId}-${stamp}.html`;
}
