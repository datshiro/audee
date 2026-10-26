import { describe, expect, it } from 'vitest';
import type { CheckedPoint } from '../../src/capability/iam-trace-schema.js';
import { channelVerdictText, checkChannels, deliveryPaths, gameOf } from '../../src/render/iam-trace-channels.js';

const pt = (kind: 'publish' | 'subscribe', channel: string, state: CheckedPoint['state'] = 'seen'): CheckedPoint => ({
  kind, label: kind, journey: '', outcome: 'info', channel, time: '', source_field: '_time', evidence: state === 'seen' ? 'line' : '', why: state === 'inferred' ? 'w' : '', state, ref: 'r', check: 'unverified',
});

describe('gameOf', () => {
  it('reads the second segment of a channel name', () => {
    expect(gameOf('role:gamea:U1:R1:env')).toBe('gamea');
    expect(gameOf('user:gameb:U1')).toBe('gameb');
    expect(gameOf('plain')).toBe('');
  });
});

describe('checkChannels', () => {
  it('matches when a subscribed channel is the published one', () => {
    const c = checkChannels([pt('publish', 'role:gamea:U1:R1:env'), pt('subscribe', 'user:gamea:U1'), pt('subscribe', 'role:gamea:U1:R1:env')]);
    expect(c.verdict).toBe('match');
    expect(channelVerdictText(c)).toContain('đúng kênh');
  });

  it('reports a game mismatch when no subscribed game is the published game', () => {
    const c = checkChannels([pt('publish', 'role:gamea:U1:R1:env'), pt('subscribe', 'role:gameb:U1:R1:env'), pt('subscribe', 'user:gameb:U1')]);
    expect(c).toMatchObject({ verdict: 'game', publishedGames: ['gamea'], subscribedGames: ['gameb'] });
    expect(channelVerdictText(c)).toBe('Lệch game: message được publish lên game gamea nhưng các phiên SDK của user chỉ subscribe game gameb; không phiên nào subscribe kênh đã publish.');
  });

  it('reports a plain mismatch inside one game', () => {
    expect(checkChannels([pt('publish', 'role:gamea:U1:R1:env'), pt('subscribe', 'role:gamea:U1:R2:env')]).verdict).toBe('mismatch');
  });

  it('does not claim the same game when a game cannot be read from a channel name', () => {
    const c = checkChannels([pt('publish', 'broadcast'), pt('subscribe', 'role:gameb:U1:R1:env')]);
    expect(c.verdict).toBe('mismatch');
    expect(channelVerdictText(c)).toContain('không xác định được game');
    expect(channelVerdictText(c)).not.toContain('cùng game');
  });

  it('says what is missing and never turns silence into a verdict', () => {
    expect(checkChannels([pt('subscribe', 'user:gamea:U1')]).verdict).toBe('no_publish');
    expect(checkChannels([]).verdict).toBe('no_publish');
    const none = checkChannels([pt('publish', 'role:gamea:U1:R1:env'), pt('subscribe', '', 'not_recorded')]);
    expect(none.verdict).toBe('no_subscribe');
    expect(channelVerdictText(none)).toContain('thiếu log không chứng minh');
  });

  it('ignores points that were only inferred', () => {
    expect(checkChannels([pt('publish', 'role:gamea:U1:R1:env', 'inferred'), pt('subscribe', 'user:gamea:U1')]).verdict).toBe('no_publish');
    expect(checkChannels([pt('publish', 'role:gamea:U1:R1:env'), pt('subscribe', 'role:gamea:U1:R1:env', 'inferred')]).verdict).toBe('no_subscribe');
  });
});

describe('deliveryPaths', () => {
  const at = (p: CheckedPoint, time: string): CheckedPoint => ({ ...p, time });
  const paths = (points: CheckedPoint[]) => deliveryPaths(points, checkChannels(points));

  it('blocks popup and inbox on a game mismatch and asks the game team why', () => {
    const d = paths([at(pt('publish', 'role:gamea:U1:R1:env'), '2026-10-25T03:28:15.500Z'), pt('subscribe', 'role:gameb:U1:R1:env')]);
    expect(d.message).toEqual(['Message đã tạo', '25/10 10:28:15 ICT', 'gameId gamea', 'SDK user: gameb']);
    expect(d.paths.map((p) => [p.name, p.outcome])).toEqual([['1. Popup realtime', 'block'], ['2. Replay khi kết nối lại', 'unknown'], ['3. App Inbox', 'block']]);
    expect(d.paths[2]?.resultDetail).toBe('Game SDK gameb ≠ game message gamea (suy từ kênh subscribe)');
    expect(d.question).toBe('Câu cần hỏi team game/SDK: vì sao message được publish lên game gamea nhưng SDK của user lại init bằng game gameb?');
  });

  it('lets the popup through only when a matching subscribe came before the publish', () => {
    const channel = 'role:gamea:U1:R1:env';
    const before = paths([at(pt('publish', channel), '2026-10-25T03:00:10Z'), at(pt('subscribe', channel), '2026-10-25T03:00:00Z')]);
    expect(before.paths[0]).toMatchObject({ outcome: 'ok', result: 'Có thể nhận' });
    expect(before.paths[2]?.outcome).toBe('unknown');
    expect(before.question).toBeUndefined();
    const after = paths([at(pt('publish', channel), '2026-10-25T03:00:10Z'), at(pt('subscribe', channel), '2026-10-25T04:00:00Z')]);
    expect(after.paths[0]).toMatchObject({ outcome: 'block', resultDetail: 'Không thấy subscribe đúng kênh trước khi publish trong các dòng đã ghi nhận; popup chỉ publish 1 lần' });
    const noTimes = paths([pt('publish', channel), pt('subscribe', channel)]);
    expect(noTimes.paths[0]?.outcome).toBe('unknown');
  });

  it('pairs publish and subscribe per channel, so a later republish cannot hide an earlier subscribe', () => {
    const r = 'role:gamea:U1:R1:env';
    const twice = paths([at(pt('publish', r), '2026-10-25T03:00:00.100Z'), at(pt('subscribe', r), '2026-10-25T03:05:00.200Z'), at(pt('publish', r), '2026-10-25T03:10:00.300Z')]);
    expect(twice.paths[0]?.outcome).toBe('ok');
    const other = paths([at(pt('publish', 'user:gamea:U1'), '2026-10-25T03:00:00.100Z'), at(pt('publish', r), '2026-10-25T03:10:00.300Z'), at(pt('subscribe', r), '2026-10-25T03:05:00.200Z')]);
    expect(other.paths[0]?.outcome).toBe('ok');
  });

  it('leaves the popup unknown when a relevant publish has no time or two times are too close to order', () => {
    const r = 'role:gamea:U1:R1:env';
    expect(paths([at(pt('publish', r), '2026-10-25T03:00:00.100Z'), pt('publish', r), at(pt('subscribe', r), '2026-10-25T03:05:00.200Z')]).paths[0]?.outcome).toBe('unknown');
    expect(paths([at(pt('publish', r), '2026-10-25T03:00:00Z'), at(pt('subscribe', r), '2026-10-25T03:00:00.400Z')]).paths[0]?.outcome).toBe('unknown');
    expect(paths([at(pt('publish', r), '1761363495'), at(pt('subscribe', r), '1761363495500')]).paths[0]?.outcome).toBe('unknown');
    expect(paths([at(pt('publish', r), '2026-10-25T03:00:00.100Z'), at(pt('subscribe', r), '2026-10-25T03:00:00.400Z')]).paths[0]?.outcome).toBe('block');
  });

  it('does not say the game is the same when no game can be read from the channel names', () => {
    const d = paths([pt('publish', 'msgchan'), pt('subscribe', 'role:gameb:U1:R1:env')]);
    expect(d.paths[2]?.resultDetail).toBe('Chưa xác định được game từ tên kênh; chưa kiểm tra lời gọi inbox');
    expect(d.paths[0]?.detail).toBe('publish 1 lần lên msgchan');
    const same = paths([pt('publish', 'role:gamea:U1:R1:env'), pt('subscribe', 'role:gamea:U1:R2:env')]);
    expect(same.paths[2]?.resultDetail).toBe('Cùng game; chưa kiểm tra lời gọi inbox');
    expect(same.paths[0]?.detail).toBe('publish 1 lần lên role:gamea …');
  });

  it('is all unknown when the logs lack a publish or a subscribe line', () => {
    for (const d of [paths([]), paths([pt('subscribe', 'user:gamea:U1')]), paths([pt('publish', 'role:gamea:U1:R1:env')])]) {
      expect(d.paths.map((p) => p.outcome)).toEqual(['unknown', 'unknown', 'unknown']);
      expect(d.question).toBeUndefined();
    }
    expect(paths([]).message).toEqual(['Message đã tạo', 'giờ publish chưa ghi nhận', 'gameId chưa ghi nhận', 'SDK user: chưa ghi nhận']);
  });
});
