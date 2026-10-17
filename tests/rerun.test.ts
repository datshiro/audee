import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Job } from '../src/queue/job.js';
import { rerun } from '../src/rerun.js';
import { loadState } from '../src/state/state.js';
import { rerunDir } from '../src/teams/watcher.js';
import { testConfig } from './helpers/test-config.js';

const MR_PATTERN = 'https://gitlab\\.example\\.com/[^\\s"\'<>]+/-/merge_requests/\\d+';
const MR = 'https://gitlab.example.com/g/p/-/merge_requests/12';

describe('rerun', () => {
  it('TestRerunRejectsBadTarget', () => {
    const cfg = testConfig({ teams: { mrUrlPattern: MR_PATTERN } });
    expect(() => rerun(cfg, 'https://evil.example/x/-/merge_requests/1')).toThrow('neither an MR URL matching mr_url_pattern nor a Teams message id');
    expect(() => rerun(cfg, '123')).toThrow('neither an MR URL');
    expect(() => rerun(cfg, MR)).toThrow(`no request for ${MR} in audee's history`);
    const state = loadState(cfg.data_dir);
    state.recordRequest({ kind: 'review', channel: 'teams', chatId: '19:a@thread.v2', principal: 'teams:kha', requesterName: 'kha', mrUrl: MR, requestedAt: new Date().toISOString() });
    expect(() => rerun(cfg, '1791513774214')).toThrow('no request for 1791513774214');
    expect(existsSync(rerunDir(cfg.data_dir)) ? readdirSync(rerunDir(cfg.data_dir)) : []).toEqual([]); // nothing was queued
  });

  it('TestRerunWritesRequest', () => {
    const cfg = testConfig({ teams: { mrUrlPattern: MR_PATTERN } });
    const state = loadState(cfg.data_dir);
    const review: Job = { kind: 'review', channel: 'teams', chatId: '19:a@thread.v2', principal: 'teams:kha', requesterName: 'kha', mrUrl: MR, requestedAt: new Date().toISOString() };
    const mapping: Job = { kind: 'code_mapping', channel: 'teams', chatId: '19:b@thread.v2', principal: 'teams:linh', requesterName: 'linh', messageId: '1791513774214', input: 'sample', requestedAt: new Date().toISOString() };
    state.recordRequest(review);
    state.recordRequest(mapping);
    expect(rerun(cfg, MR)).toEqual(review);
    expect(rerun(cfg, '1791513774214')).toEqual(mapping);
    const files = readdirSync(rerunDir(cfg.data_dir));
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.json') && !f.startsWith('.'))).toBe(true);
    const written = files.map((f) => JSON.parse(readFileSync(join(rerunDir(cfg.data_dir), f), 'utf8')) as Job);
    expect(written).toEqual(expect.arrayContaining([review, mapping]));
  });
});
