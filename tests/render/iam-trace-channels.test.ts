import { describe, expect, it } from 'vitest';
import type { CheckedPoint } from '../../src/capability/iam-trace-schema.js';
import { channelVerdictText, checkChannels, gameOf } from '../../src/render/iam-trace-channels.js';

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
