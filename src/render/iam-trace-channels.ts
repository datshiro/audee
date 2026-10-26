// The subscription check: the channel message-delivery published to against the channels the player's SDK sessions
// subscribed to. audee compares them itself from the traced points; the model only copies channel names. Only points
// seen in a log line count, so a guessed channel never decides the verdict.
import { CHANNEL_KINDS, type CheckedPoint, ictTime } from '../capability/iam-trace-schema.js';

export type ChannelVerdict = 'match' | 'game' | 'mismatch' | 'no_publish' | 'no_subscribe';
export type ChannelCheck = { verdict: ChannelVerdict; published: string[]; subscribed: string[]; publishedGames: string[]; subscribedGames: string[] };

// role:<game>:<userId>:<roleId>:<env> and user:<game>:<userId>: the game is the second segment.
export const gameOf = (channel: string): string => channel.split(':')[1] ?? '';

const unique = (items: string[]): string[] => [...new Set(items.filter((x) => x !== ''))];

export const isChannelPoint = (p: CheckedPoint): boolean => CHANNEL_KINDS.includes(p.kind);

export function checkChannels(points: CheckedPoint[]): ChannelCheck {
  const seen = (kind: string): string[] => unique(points.filter((p) => p.kind === kind && p.state === 'seen').map((p) => p.channel));
  const published = seen('publish');
  const subscribed = seen('subscribe');
  const publishedGames = unique(published.map(gameOf));
  const subscribedGames = unique(subscribed.map(gameOf));
  const base = { published, subscribed, publishedGames, subscribedGames };
  if (published.length === 0) return { verdict: 'no_publish', ...base };
  if (subscribed.length === 0) return { verdict: 'no_subscribe', ...base };
  if (published.some((c) => subscribed.includes(c))) return { verdict: 'match', ...base };
  const sharesGame = publishedGames.length === 0 || subscribedGames.length === 0 || publishedGames.some((g) => subscribedGames.includes(g));
  return { verdict: sharesGame ? 'mismatch' : 'game', ...base };
}

// Raw text: the page escapes it.
export function channelVerdictText(c: ChannelCheck): string {
  switch (c.verdict) {
    case 'match':
      return 'Có phiên SDK subscribe đúng kênh mà message được publish.';
    case 'game':
      return `Lệch game: message được publish lên game ${c.publishedGames.join(', ')} nhưng các phiên SDK của user chỉ subscribe game ${c.subscribedGames.join(', ')}; không phiên nào subscribe kênh đã publish.`;
    case 'mismatch':
      return c.publishedGames.length > 0 && c.subscribedGames.length > 0
        ? 'Không phiên SDK nào subscribe đúng kênh mà message được publish (cùng game nhưng khác kênh).'
        : 'Không phiên SDK nào subscribe đúng kênh mà message được publish; không xác định được game từ tên kênh.';
    case 'no_publish':
      return 'Không ghi nhận dòng message-delivery publish message lên kênh nào, nên chưa so được với các kênh SDK subscribe.';
    case 'no_subscribe':
      return 'Không ghi nhận phiên SDK subscribe nào của user trong khoảng đã tra; thiếu log không chứng minh user chưa subscribe.';
  }
}

export type PathOutcome = 'ok' | 'block' | 'unknown';
export type DeliveryPath = { name: string; detail: string; outcome: PathOutcome; result: string; resultDetail: string };
export type DeliveryPaths = { message: string[]; paths: DeliveryPath[]; question?: string };

// How the message could reach the SDK, and what the logs let audee say about each way. The three ways come from the
// message-delivery code (see PATHS_SOURCE); only the game and channel comparisons are read from the logs.
const NO_LINES = 'Thiếu dòng log publish hoặc subscribe';
const UNKNOWN_LABEL = 'Chưa kiểm tra được';

const msOf = (p: CheckedPoint): number | undefined => ictTime(p.time)?.ms;
// The game and role stay readable; a name with no ":" is shown whole. The space before the ellipsis keeps the cut text
// apart from the next text in the page's plain-text reading.
const channelPrefix = (channel: string): string => (channel.includes(':') ? `${channel.split(':').slice(0, 2).join(':')} …` : channel);

// A time with no sub-second part may be off by up to a second; a pair closer than that is not ordered.
function order(sub: number, pub: number): 'before' | 'after' | 'unsure' {
  const slack = sub % 1000 !== 0 && pub % 1000 !== 0 ? 0 : 1000;
  if (sub < pub - slack) return 'before';
  return sub > pub + slack ? 'after' : 'unsure';
}

// The popup is published once per send, so it reaches the SDK only through a subscribe to the same channel made before
// that publish. Pairs are per channel; any point without a time, or a pair too close to order, leaves it unknown.
function popupPath(points: CheckedPoint[], c: ChannelCheck): DeliveryPath {
  const base = { name: '1. Popup realtime', detail: c.published[0] !== undefined ? `publish 1 lần lên ${channelPrefix(c.published[0])}` : 'publish 1 lần lên kênh của message' };
  if (c.verdict === 'game') return { ...base, outcome: 'block', result: 'Không ai nhận', resultDetail: `SDK chỉ subscribe game ${c.subscribedGames.join(', ')}` };
  if (c.verdict === 'mismatch') return { ...base, outcome: 'block', result: 'Không ai nhận', resultDetail: 'Không phiên nào subscribe đúng kênh' };
  if (c.verdict !== 'match') return { ...base, outcome: 'unknown', result: UNKNOWN_LABEL, resultDetail: NO_LINES };
  const shared = c.published.filter((ch) => c.subscribed.includes(ch));
  const seen = (kind: string, ch: string): CheckedPoint[] => points.filter((p) => p.kind === kind && p.state === 'seen' && p.channel === ch);
  const pairs = shared.flatMap((ch) => seen('publish', ch).flatMap((pub) => seen('subscribe', ch).map((sub) => [msOf(sub), msOf(pub)] as const)));
  if (pairs.some(([sub, pub]) => sub === undefined || pub === undefined)) return { ...base, outcome: 'unknown', result: UNKNOWN_LABEL, resultDetail: 'Chưa rõ thứ tự giờ publish và subscribe' };
  const orders = (pairs as Array<readonly [number, number]>).map(([sub, pub]) => order(sub, pub));
  if (orders.includes('before')) return { ...base, outcome: 'ok', result: 'Có thể nhận', resultDetail: 'Có phiên subscribe đúng kênh trước khi publish' };
  if (orders.includes('unsure')) return { ...base, outcome: 'unknown', result: UNKNOWN_LABEL, resultDetail: 'Giờ subscribe và publish quá gần nhau để xếp thứ tự' };
  return { ...base, outcome: 'block', result: 'Không ai nhận', resultDetail: 'Không thấy subscribe đúng kênh trước khi publish trong các dòng đã ghi nhận; popup chỉ publish 1 lần' };
}

export function deliveryPaths(points: CheckedPoint[], c: ChannelCheck): DeliveryPaths {
  const firstPublish = points.filter((p) => p.kind === 'publish' && p.state === 'seen').map((p) => ({ p, ms: msOf(p) })).filter((x): x is { p: CheckedPoint; ms: number } => x.ms !== undefined).sort((a, b) => a.ms - b.ms)[0];
  const message = [
    'Message đã tạo',
    firstPublish !== undefined ? `${ictTime(firstPublish.p.time)?.text.replace(/\.\d+$/u, '') ?? ''} ICT` : 'giờ publish chưa ghi nhận',
    c.publishedGames.length > 0 ? `gameId ${c.publishedGames.join(', ')}` : 'gameId chưa ghi nhận',
    c.subscribedGames.length > 0 ? `SDK user: ${c.subscribedGames.join(', ')}` : 'SDK user: chưa ghi nhận',
  ];
  const replay: DeliveryPath = { name: '2. Replay khi kết nối lại', detail: 'chỉ message không phải App Inbox', outcome: 'unknown', result: UNKNOWN_LABEL, resultDetail: 'Chưa biết message có phải App Inbox không' };
  const inbox: DeliveryPath =
    c.verdict === 'game'
      ? { name: '3. App Inbox', detail: 'lọc theo gameId của phiên SDK', outcome: 'block', result: 'Không khớp gameId', resultDetail: `Game SDK ${c.subscribedGames.join(', ')} ≠ game message ${c.publishedGames.join(', ')} (suy từ kênh subscribe)` }
      : { name: '3. App Inbox', detail: 'lọc theo gameId của phiên SDK', outcome: 'unknown', result: UNKNOWN_LABEL, resultDetail: c.verdict === 'no_publish' || c.verdict === 'no_subscribe' ? NO_LINES : c.publishedGames.length > 0 && c.subscribedGames.length > 0 ? 'Cùng game; chưa kiểm tra lời gọi inbox' : 'Chưa xác định được game từ tên kênh; chưa kiểm tra lời gọi inbox' };
  const question = c.verdict === 'game' ? `Câu cần hỏi team game/SDK: vì sao message được publish lên game ${c.publishedGames.join(', ')} nhưng SDK của user lại init bằng game ${c.subscribedGames.join(', ')}?` : undefined;
  return { message, paths: [popupPath(points, c), replay, inbox], ...(question !== undefined ? { question } : {}) };
}

export const OTHER_CASES = [
  'Inbox gọi thiếu hoặc sai roleId/serverId.',
  'Request inbox có tham số category: message có category=[] nên bị loại.',
  'Lọc status=read, hoặc message nằm ở trang sau (limit mặc định 10).',
  'Lỗi modifier khi đọc inbox: message bị bỏ nhưng API vẫn trả 200.',
  'Subscribe hoặc inbox bị 403 vì lệch zone.',
  'Quá expiresAt của message.',
];
export const OTHER_CASES_NOTE = 'countryCode, hl, content.type, priority và frequencyCap không tham gia filter ở đường nào.';
export const PATHS_SOURCE = 'Ba đường và các trường hợp trên lấy từ tài liệu tham chiếu (đối chiếu code message-delivery origin/main 333014b), audee không kiểm lại code; từ log audee chỉ so game và kênh.';
