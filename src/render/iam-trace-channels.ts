// The subscription check: the channel message-delivery published to against the channels the player's SDK sessions
// subscribed to. audee compares them itself from the traced points; the model only copies channel names. Only points
// seen in a log line count, so a guessed channel never decides the verdict.
import { CHANNEL_KINDS, type CheckedPoint } from '../capability/iam-trace-schema.js';

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
      return 'Không phiên SDK nào subscribe đúng kênh mà message được publish (cùng game nhưng khác kênh).';
    case 'no_publish':
      return 'Không ghi nhận dòng message-delivery publish message lên kênh nào, nên chưa so được với các kênh SDK subscribe.';
    case 'no_subscribe':
      return 'Không ghi nhận phiên SDK subscribe nào của user trong khoảng đã tra; thiếu log không chứng minh user chưa subscribe.';
  }
}
