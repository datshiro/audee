// The PO summary of one player: a verdict, the steps in business words and who acts next. audee derives it only from
// seen points, in fixed Vietnamese; the only model text it copies is a step's label and result. Raw text: the page escapes.
import { type CheckedPoint, ictTime, type PointKind } from '../capability/iam-trace-schema.js';
import { checkChannels, missingChannelTexts } from './iam-trace-channels.js';
import { KIND_VI, type LayoutPlayer } from './iam-trace-layout.js';

export type VerdictKind = 'received' | 'sent_wrong_channel' | 'sent_no_client' | 'blocked' | 'unclear';
export type PoAction = { cause: string; owner: string; next: string };
export type PoSummary = { verdict: { kind: VerdictKind; text: string }; story: string[]; actions: PoAction[] };

export const PO_OWNERS_SOURCE = 'Bảng ai xử lý theo quyết định của owner ngày 28/10/2026; có thể đã thay đổi.';
export const PO_TIME_NOTE = 'Giờ là lúc kho log nhận dòng log, có thể trễ so với lúc việc thật sự xảy ra.';

const MAX_LANES = 3;
const MAX_NODES = 12;
const RESULT_KINDS = new Set<PointKind>(['check_call', 'condition', 'frequency']);
const PO_OWNER = 'PO hoặc operator của campaign';
const GAME_SDK = 'Team game / SDK';

const msOf = (p: CheckedPoint): number | undefined => ictTime(p.time)?.ms;
const clock = (p: CheckedPoint): string => ictTime(p.time)?.text.replace(/\.\d+$/u, '').slice(6) ?? '?';
const byTime = (points: CheckedPoint[]): CheckedPoint[] => [...points].sort((a, b) => (msOf(a) ?? Infinity) - (msOf(b) ?? Infinity));
const isInboxRead = (p: CheckedPoint): boolean => p.kind === 'inbox' && p.evidence.includes('/inbox/messages/read');
const isReceipt = (p: CheckedPoint): boolean => p.kind === 'delivered' || p.kind === 'sdk_event' || isInboxRead(p);
const isOpen = (p: CheckedPoint): boolean => (p.kind === 'sdk_event' && ['open', 'read'].includes(p.label.trim().toLowerCase())) || isInboxRead(p);

const STEP_PREFIXES: Array<[string, string]> = [
  ['enrichment', 'Tải dữ liệu người chơi'],
  ['validation', 'Kiểm tra điều kiện'],
  ['evaluate', 'Kiểm tra điều kiện'],
  ['cdp', 'Tra dữ liệu CDP'],
];
const FIXED_STEPS: Partial<Record<PointKind, string>> = {
  trigger: 'Người chơi phát sinh sự kiện kích hoạt',
  wait_end: 'Hết thời gian chờ',
  frequency: 'Kiểm tra tần suất gửi',
  send: 'Apollo gửi IAM',
  delivered: 'Game client xác nhận đã nhận',
};

export function businessStep(kind: PointKind, label: string): string {
  const fixed = FIXED_STEPS[kind];
  if (fixed !== undefined) return fixed;
  const name = label.trim();
  if (!RESULT_KINDS.has(kind) || name === '' || name === KIND_VI[kind]) return KIND_VI[kind];
  const lower = name.toLowerCase();
  const phrase = STEP_PREFIXES.find(([prefix]) => lower.startsWith(prefix))?.[1];
  if (phrase === undefined) return `Bước kiểm tra "${name}"`;
  const detail = name.split(':')[1]?.trim() ?? '';
  return detail !== '' ? `${phrase} (${detail})` : phrase;
}

function story(player: LayoutPlayer, receipt: CheckedPoint | undefined, open: CheckedPoint | undefined): string[] {
  const lines = player.journeys.slice(0, MAX_LANES).flatMap((lane) => {
    const nodes = lane.nodes.slice(0, MAX_NODES).map((n) => {
      const step = businessStep(n.kind, n.label);
      if (n.cls === 'missing') return `- Không ghi nhận bước ${step}`;
      const result = n.result !== undefined && RESULT_KINDS.has(n.kind) ? `: ${n.result}` : '';
      return `- ${n.time} ${step}${result}${n.cls === 'block' ? ' — bị chặn' : ''}${n.count > 1 ? ` (x${n.count})` : ''}${n.inferred ? ' (suy ra)' : ''}`;
    });
    const more = lane.nodes.length - MAX_NODES;
    return [`${lane.title}:`, ...nodes, ...(more > 0 ? [`- … và ${more} bước khác, xem Chi tiết kỹ thuật`] : [])];
  });
  const moreLanes = player.journeys.length - MAX_LANES;
  if (moreLanes > 0) lines.push(`… và ${moreLanes} journey khác, xem Chi tiết kỹ thuật`);
  lines.push(receipt !== undefined ? `Game client: nhận lúc ${clock(receipt)}${open !== undefined ? `, mở lúc ${clock(open)}` : ''}.` : 'Game client: chưa ghi nhận mốc nhận hay mở nào.');
  return lines;
}

export function poSummary(player: LayoutPlayer): PoSummary {
  const seen = byTime(player.points.filter((p) => p.state === 'seen'));
  // A send the line shows as rejected is a block, not a send.
  const send = seen.find((p) => p.kind === 'send' && p.outcome !== 'block');
  const sentMs = send !== undefined ? msOf(send) : undefined;
  // A receipt from before the send belongs to another message.
  const receipts = seen.filter((p) => isReceipt(p) && (sentMs === undefined || (msOf(p) ?? sentMs) >= sentMs));
  const receipt = receipts[0];
  const open = receipts.find(isOpen);
  const check = checkChannels(player.points);
  const blocks = seen.filter((p) => p.outcome === 'block');
  const block = blocks[0];

  let verdict: PoSummary['verdict'];
  if (send !== undefined && receipt !== undefined) {
    verdict = { kind: 'received', text: `Đã nhận: Apollo gửi lúc ${clock(send)}, game client nhận lúc ${clock(receipt)}${open !== undefined ? `, mở lúc ${clock(open)}` : ''}.` };
  } else if (send !== undefined && (check.verdict === 'game' || check.verdict === 'mismatch')) {
    verdict = { kind: 'sent_wrong_channel', text: `Apollo đã gửi lúc ${clock(send)}, nhưng game client đăng ký sai kênh nên popup không tới được người chơi; chưa ghi nhận phía game client.` };
  } else if (send !== undefined) {
    verdict = { kind: 'sent_no_client', text: `Apollo đã gửi lúc ${clock(send)}; chưa ghi nhận phía game client.` };
  } else if (block !== undefined) {
    const result = block.result.trim() !== '' ? `: ${block.result.trim()}` : '';
    const others = blocks.length > 1 ? ` Còn ${blocks.length - 1} lần chặn khác.` : '';
    verdict = { kind: 'blocked', text: `Bị chặn tại bước ${businessStep(block.kind, block.label)}${result}, lúc ${clock(block)}.${others}` };
  } else {
    const inferred = player.points.some((p) => p.kind === 'send' && p.state === 'inferred');
    verdict = { kind: 'unclear', text: inferred ? 'Chưa rõ: Apollo có thể đã gửi (suy ra) nhưng không có dòng log gửi trực tiếp.' : 'Chưa rõ: không ghi nhận bước Apollo gửi IAM trong khoảng đã tra.' };
  }

  const actions: PoAction[] = [];
  if (verdict.kind === 'blocked' && block !== undefined) {
    if (block.kind === 'send') actions.push({ cause: 'Apollo gửi IAM không thành công', owner: 'Apollo dev', next: 'Kiểm tra lỗi gửi ở message-delivery.' });
    else if (block.kind === 'frequency') actions.push({ cause: 'Vượt giới hạn tần suất gửi', owner: PO_OWNER, next: 'Kiểm tra cấu hình tần suất gửi của campaign.' });
    else actions.push({ cause: 'Người chơi không thỏa điều kiện của journey', owner: PO_OWNER, next: 'Kiểm tra lại điều kiện và cấu hình journey/campaign.' });
  }
  if (verdict.kind === 'sent_wrong_channel') actions.push({ cause: 'Game client đăng ký sai game hoặc sai kênh', owner: GAME_SDK, next: 'Kiểm tra game SDK khởi tạo đúng game và đăng ký đúng kênh.' });
  for (const cause of missingChannelTexts(check)) actions.push({ cause, owner: GAME_SDK, next: 'Kiểm tra SDK đăng ký đủ kênh real time và one time.' });
  if (verdict.kind === 'sent_no_client') actions.push({ cause: 'Apollo đã gửi nhưng chưa ghi nhận phía game client', owner: 'Team game', next: 'Kiểm tra game client có nhận và hiển thị IAM không.' });
  if (verdict.kind === 'unclear') actions.push({ cause: 'Log không đủ để kết luận', owner: 'Apollo dev', next: 'Tra lại với dd/mm hh:mm gần lúc gửi, hoặc tra log thủ công.' });

  return { verdict, story: story(player, receipt, open), actions: actions.filter((a, i) => actions.findIndex((b) => b.cause === a.cause) === i) };
}
