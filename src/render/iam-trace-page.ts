// The iam_trace timeline page and chat notice, built by audee from the merged trace: no model HTML, every model
// string defanged, clipped and escaped, and only the markup checkAnswerPage allows.
import { type CheckedPoint, ictTime, type IamTraceRequest, type MergedTrace, type PointOutcome, type PointState, rowOf, type TraceResult } from '../capability/iam-trace-schema.js';
import { strings } from '../capability/kb-answer.js';
import { defang } from './defang.js';
import { answerPageCSP, answerPageStyle, clip, escapeHTML, maxNoteChars, maxNotes } from './html.js';
import { idTail, KIND_VI, type LayoutLane, type LayoutPlayer, layoutTrace } from './iam-trace-layout.js';
import { channelVerdictText, checkChannels, deliveryPaths, gameOf, isChannelPoint, OTHER_CASES, OTHER_CASES_NOTE, PATHS_SOURCE } from './iam-trace-channels.js';
import { laneSvg, pathsSvg, widthRules } from './iam-trace-svg.js';

const t = (s: string, n: number): string => escapeHTML(clip(defang(s), n));

export const IAM_TRACE_24H_BANNER = 'Đã tra 24 giờ gần nhất; thêm dd/mm hh:mm để tra ngày khác';

const STATE_VI: Record<PointState, string> = { seen: 'ghi nhận', inferred: 'suy ra', not_recorded: 'không ghi nhận' };
const OUTCOME_VI: Record<PointOutcome, string> = { pass: 'đạt', block: 'chặn', info: 'thông tin' };
const CHECK_VI: Record<CheckedPoint['check'], string> = { confirmed: ' · đã kiểm chứng', corrected: ' · đã sửa khi kiểm chứng', unverified: ' · chưa kiểm chứng' };
// The merge's reasons are fixed English words; any other value is shown as the generic phrase, never as given.
const REASON_VI = new Map([
  ['verifier checked no point', 'phiên kiểm chứng không kiểm lại được mốc nào'],
  ['verifier changed most points', 'phiên kiểm chứng sửa quá nửa số mốc nên các chỉnh sửa không được áp dụng'],
]);
const reasonText = (reason: string): string => REASON_VI.get(reason) ?? 'kết quả kiểm chứng không dùng được';

const STYLE = `${answerPageStyle}
:root{--blk:#2563eb;--cor:#c2410c;--gry:#6e7781;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--blk:#4f86e8;--cor:#e0703a;--gry:#8b949e;--ok:#3fb950}}
main{max-width:1100px}
h1{font-size:24px;line-height:1.3;margin:0 0 4px}
h2{font-size:20px;margin:32px 0 8px}
h3{font-size:16px;margin:20px 0 6px}
h3 small{font-weight:400;color:var(--muted)}
.warn{color:var(--fg);font-weight:600}
.banner{margin:12px 0;padding:8px 12px;border-left:4px solid var(--cor);background:var(--code);font-weight:600}
.finding{font-size:17px;margin:16px 0 4px}
.verdict{font-weight:600}
.ls{text-anchor:start}
.dt{font-size:11.5px;font-weight:400}
.mu{fill:var(--muted)}
.arw{fill:none;stroke:var(--gry);stroke-width:1.25}
.arh{fill:var(--gry)}
.pb{fill:none;stroke:var(--gry);stroke-width:1.25}
.mb{fill:var(--cor);fill-opacity:.12;stroke:var(--cor);stroke-width:2}
.ob-block{fill:var(--blk);fill-opacity:.12;stroke:var(--blk);stroke-width:2}
.ob-ok{fill:var(--ok);fill-opacity:.12;stroke:var(--ok);stroke-width:2}
.ob-unknown{fill:none;stroke:var(--gry);stroke-width:1.5;stroke-dasharray:3 3}
.wp{max-width:760px;min-width:600px}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;margin:8px 0 12px;font-size:14px}
.dot{display:inline-block;box-sizing:border-box;width:12px;height:12px;margin-right:6px;border-radius:50%;vertical-align:-1px}
.dot.b{background:var(--blk)}
.dot.c{border:3px solid var(--cor)}
.dot.s{background:var(--cor)}
.dot.o{background:var(--gry)}
.dot.m{border:2px dashed var(--gry)}
.dot.i{border:2px dashed var(--fg)}
.lane{margin:12px 0 20px}
.lh small{margin-left:8px;color:var(--muted)}
.scroll{overflow-x:auto;padding-bottom:4px}
svg{display:block;width:100%;height:auto}
.empty{margin:4px 0;color:var(--muted)}
.axis{fill:none;stroke:var(--line);stroke-width:2}
.nd{stroke-width:3}
.n-block{fill:var(--blk);stroke:var(--blk)}
.n-sent{fill:var(--cor);stroke:var(--cor)}
.n-check{fill:var(--bg);stroke:var(--cor)}
.n-other{fill:var(--gry);stroke:var(--gry)}
.n-missing{fill:none;stroke:var(--gry);stroke-width:2;stroke-dasharray:3 3}
.ring{fill:none;stroke:var(--fg);stroke-width:1.5;stroke-dasharray:3 3}
text{fill:var(--fg);text-anchor:middle;font:13px/1.2 -apple-system,"Segoe UI",Roboto,sans-serif}
.lb{font-weight:600}
.tm{font-variant-numeric:tabular-nums}
.sb{font-weight:600}
.nt{fill:var(--muted);font-size:12px}
.gp{fill:var(--muted);font-size:12px}
.ev{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Menlo,monospace;font-size:13px}
td small{display:block;color:var(--muted)}`;

function timeText(p: CheckedPoint): string {
  if (p.state === 'not_recorded') return '—';
  const ict = ictTime(p.time);
  if (ict === undefined) return '?';
  return ict.text + (p.source_field.trim() !== '' && p.source_field.trim() !== '_time' ? ' †' : '');
}

const label = (p: CheckedPoint): string => (p.label.trim() === '' ? KIND_VI[p.kind] : t(p.label, 80));
const status = (p: CheckedPoint): string => STATE_VI[p.state] + CHECK_VI[p.check];
const ids = (player: LayoutPlayer): string => player.ids.map((id) => t(id, 64)).join(' / ');

function laneHtml(lane: LayoutLane): string {
  const body = lane.nodes.length > 0 ? `<div class="scroll">${laneSvg(lane.nodes)}</div>` : '<p class="empty">không ghi nhận mốc nào</p>';
  return `<div class="lane"><div class="lh"><strong>${t(lane.title, 120)}</strong>${lane.sub !== '' ? `<small>${t(lane.sub, 40)}</small>` : ''}</div>${body}</div>`;
}

function playerHtml(player: LayoutPlayer): string {
  return `<h3>${ids(player)} <small>userId ${t(player.userId, 64) || '—'} · roleId ${t(player.roleId, 64) || '—'}</small></h3>
${[...player.journeys, player.client].map(laneHtml).join('\n')}`;
}

const LEGEND = [
  ['b', 'Bị chặn'],
  ['c', 'Kiểm tra điều kiện'],
  ['s', 'Apollo gửi IAM'],
  ['o', 'Mốc khác'],
  ['m', 'Không ghi nhận'],
  ['i', 'Suy ra (viền đứt, dấu *)'],
] as const;
const legend = `<p class="legend">${LEGEND.map(([k, text]) => `<span><span class="dot ${k}"></span>${text}</span>`).join('')}</p>`;

function channelSection(players: LayoutPlayer[]): string {
  const block = (pl: LayoutPlayer): string => {
    const points = pl.client.points.filter(isChannelPoint);
    const rows = points.map((p) => `<tr><td>${timeText(p)}</td><td>${KIND_VI[p.kind]}</td><td>${t(p.channel, 300) || '—'}</td><td>${t(gameOf(p.channel), 64) || '—'}</td><td>${status(p)}</td></tr>`);
    const table = rows.length > 0 ? `<table><thead><tr><th>Giờ (ICT)</th><th>Loại</th><th>Kênh</th><th>Game</th><th>Trạng thái</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '';
    const check = checkChannels(pl.points);
    const delivery = deliveryPaths(pl.points, check);
    const paths = `<div class="scroll">${pathsSvg(delivery)}</div><table><thead><tr><th>Đường message tới SDK</th><th>Kết quả</th><th>Chi tiết</th></tr></thead><tbody>${delivery.paths.map((path) => `<tr><td>${t(path.name, 60)}<small>${t(path.detail, 120)}</small></td><td>${t(path.result, 60)}</td><td>${t(path.resultDetail, 200)}</td></tr>`).join('')}</tbody></table>`;
    const question = delivery.question !== undefined ? `<p><strong>${t(delivery.question, 300)}</strong></p>` : '';
    return `${players.length > 1 ? `<h3>${ids(pl)}</h3>` : ''}<p class="verdict">${t(channelVerdictText(check), 400)}</p>${table}${paths}${question}`;
  };
  return `<section><h2>Kiểm tra kênh subscribe</h2>
<p>So kênh message-delivery publish message với các kênh mà SDK của user subscribe; audee tự so từ các dòng log đã ghi nhận.</p>
${players.map(block).join('\n')}
<h3>Các trường hợp khác làm message đã tạo mà không thấy</h3>
<ul>${OTHER_CASES.map((c) => `<li>${t(c, 200)}</li>`).join('')}</ul>
<p>${t(OTHER_CASES_NOTE, 200)}</p>
<p><small>${t(PATHS_SOURCE, 300)}</small></p></section>`;
}

function inferredSection(players: LayoutPlayer[]): string {
  const who = (player: LayoutPlayer): string => (players.length > 1 ? `${ids(player)}: ` : '');
  const inferred = players.flatMap((pl) => pl.points.filter((p) => p.state === 'inferred').map((p) => `<li>${who(pl)}<strong>${label(p)}</strong>: ${t(p.why, 300)}</li>`));
  const unknown = players.flatMap((pl) => pl.points.filter((p) => p.state === 'not_recorded').map((p) => `<li>${who(pl)}${label(p)}</li>`));
  return `<section><h2>Suy luận / chưa biết</h2>
<h3>Suy ra (dấu *)</h3>
${inferred.length > 0 ? `<ul>${inferred.join('')}</ul>` : '<p>Không có mốc nào phải suy ra.</p>'}
<h3>Không ghi nhận</h3>
${unknown.length > 0 ? `<ul>${unknown.join('')}</ul>` : '<p>Mọi mốc đều tìm thấy dòng log.</p>'}
<p>"Không ghi nhận" nghĩa là không tìm thấy dòng log trong khoảng đã tra, không có nghĩa là chưa xảy ra.</p></section>`;
}

function tableRow(p: CheckedPoint, player: LayoutPlayer, many: boolean): string {
  const where = [many ? ids(player) : '', p.channel !== '' ? `kênh ${t(p.channel, 200)}` : '', p.result.trim() !== '' ? `trả về: ${t(p.result, 60)}` : '', rowOf(p.kind) === 'server' && p.journey !== '' ? `Journey ${t(idTail(p.journey), 64)}` : '', `kết quả: ${OUTCOME_VI[p.outcome]}`].filter((x) => x !== '').join(' · ');
  const why = p.state === 'inferred' && p.why.trim() !== '' ? `<small>Suy ra vì: ${t(p.why, 300)}</small>` : '';
  return `<tr><td>${KIND_VI[p.kind]}: ${label(p)}<small>· ${where}</small></td><td>${timeText(p)}</td><td>${t(p.source_field, 60)}</td><td>${status(p)}</td><td><div class="ev">${t(p.evidence, 600)}</div>${why}</td></tr>`;
}

// Counted over the points the page shows: a point seen under both ids of one player counts once.
function tally(players: LayoutPlayer[]): MergedTrace['counts'] {
  const counts = { confirmed: 0, corrected: 0, unverified: 0 };
  for (const pl of players) for (const p of pl.points) counts[p.check] += 1;
  return counts;
}

function verifyLine(trace: MergedTrace, c: MergedTrace['counts']): string {
  trace = { ...trace, verified: trace.verified && c.confirmed + c.corrected > 0 };
  if (trace.verified) return ` Đã kiểm chứng độc lập bằng một phiên truy vấn lại: ${c.confirmed} mốc khớp, ${c.corrected} mốc đã sửa, ${c.unverified} mốc chưa kiểm chứng.`;
  return ` Chưa kiểm chứng độc lập${trace.reason !== undefined ? `: ${reasonText(trace.reason)}` : ''}.`;
}

export function iamTracePage(req: IamTraceRequest, trace: MergedTrace): string {
  const players = layoutTrace(req, trace);
  const filter = req.timeFilter !== undefined ? ' Bộ lọc thời gian _time chưa được xác minh trên kho log.' : '';
  const notes = trace.notes.slice(0, maxNotes).map((n) => `<li>${t(n, maxNoteChars)}</li>`).join('');
  const marked = players.some((pl) => pl.points.some((p) => timeText(p).endsWith(' †')));
  const counts = players.flatMap((pl) => [...pl.journeys, pl.client].map((l) => l.nodes.length));
  const banner = req.at === undefined ? `<p class="banner">${IAM_TRACE_24H_BANNER}</p>` : '';
  const conclusion = trace.conclusion.length > 0 ? `<ul>${trace.conclusion.map((c) => `<li>${t(c, 250)}</li>`).join('')}</ul>` : '';
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${answerPageCSP}">
<title>Trace IAM</title>
<style>${STYLE}
${widthRules(counts)}</style>
</head>
<body>
<main>
<header><h1>Trace IAM</h1><p>IAM ${t(req.target, 64)}${req.journey !== undefined ? ` · journey ${t(req.journey, 64)}` : ''} · ${t(req.window, 120)} · giờ ICT</p>${banner}<p class="warn">Temporal không kiểm tra.${filter}${verifyLine(trace, tally(players))}</p>
<p class="finding">${t(trace.finding, 300) || 'Không có kết luận.'}</p>${conclusion}</header>
<section><h2>Timeline</h2>
<p>Giờ ICT. Mỗi hàng là một journey; khoảng cách giữa các mốc không theo tỷ lệ, nhãn +… là thời gian từ mốc trước, xN là mốc lặp N lần.</p>
${legend}
${players.map(playerHtml).join('\n')}</section>
${channelSection(players)}
${inferredSection(players)}
<section><h2>Bằng chứng</h2>
<table><thead><tr><th>Mốc</th><th>Giờ (ICT)</th><th>Trường</th><th>Trạng thái</th><th>Bằng chứng</th></tr></thead><tbody>${players.flatMap((pl) => pl.points.map((p) => tableRow(p, pl, players.length > 1))).join('')}</tbody></table></section>
<footer><h3>Ghi chú</h3><ul>${notes}<li>Giờ là giờ kho log (_time), có thể lệch so với lúc dòng log được ghi.</li>${marked ? '<li>† giờ in trong nội dung dòng log, khác giờ kho log.</li>' : ''}<li>* suy ra: không có dòng log trực tiếp, suy từ bước chạy sau hoặc từ liên kết journey.</li><li>Không gồm Temporal và các mốc nghiệp vụ của team khác.</li></ul></footer>
</main>
</body>
</html>
`;
}

export function iamTraceNotice(req: IamTraceRequest, trace: MergedTrace): string {
  const players = layoutTrace(req, trace);
  const states: Record<PointState, number> = { seen: 0, inferred: 0, not_recorded: 0 };
  for (const pl of players) for (const p of pl.points) states[p.state] += 1;
  const { corrected, unverified } = tally(players);
  return (
    '🤖 <b>Trace IAM tự động</b>, timeline trong file, bạn kiểm tra lại trước khi dùng nhé:<br>' +
    t(trace.finding, 300) +
    `<br>${players.length} user · ${states.seen} mốc ghi nhận · ${states.inferred} mốc suy ra · ${states.not_recorded} mốc không ghi nhận` +
    (corrected > 0 ? ` · ${corrected} mốc đã sửa khi kiểm chứng` : '') +
    (unverified > 0 ? ` · ${unverified} mốc chưa kiểm chứng` : '') +
    (trace.verified ? '' : ` · chưa kiểm chứng độc lập${trace.reason !== undefined ? ` (${reasonText(trace.reason)})` : ''}`) +
    `<br><i>Temporal không kiểm tra. Khoảng tra: ${t(req.window, 120)}.</i>` +
    (req.at === undefined ? `<br><i>${IAM_TRACE_24H_BANNER}.</i>` : '')
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
