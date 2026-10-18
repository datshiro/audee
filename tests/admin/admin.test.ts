import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { Overview } from '../../src/admin/api-types.js';
import { applyOps, checkCandidate, ConfigProblems, writeConfig } from '../../src/admin/config-edit.js';
import { AdminServer, adminToken, type Live } from '../../src/admin/server.js';
import type { Capability } from '../../src/capability/types.js';
import { loadConfig } from '../../src/config/load.js';
import { eventsPath } from '../../src/events.js';
import { setNotify } from '../../src/notify.js';
import type { Job } from '../../src/queue/job.js';
import { Queue, type RunOutcome } from '../../src/queue/queue.js';
import { failedReply, unavailableText } from '../../src/render/html.js';
import { InterruptedError } from '../../src/runner/run.js';
import { serve } from '../../src/serve.js';
import { loadState } from '../../src/state/state.js';
import { Outbox } from '../../src/teams/outbox.js';
import { Watcher } from '../../src/teams/watcher.js';
import { testConfig, type TestConfigOptions } from '../helpers/test-config.js';

const CHAT = '19:abc@thread.v2';
const MR = 'https://gitlab.gt.vng.vn/g/p/-/merge_requests/7';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'audee-admin-'));
const tick = (): Promise<void> => sleep(10);

const reviewJob = (key = MR): Job => ({ kind: 'review', channel: 'teams', chatId: CHAT, principal: 'teams:p1', requesterName: 'p1', mrUrl: key, requestedAt: new Date().toISOString() });
const events = (dataDir: string): Array<Record<string, unknown>> => (existsSync(eventsPath(dataDir)) ? readFileSync(eventsPath(dataDir), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const replies = (outbox: Outbox): string[] => readdirSync(outbox.dir).map((n) => (JSON.parse(readFileSync(join(outbox.dir, n), 'utf8')) as { html: string }).html);

// A review capability that runs until its session is aborted, as runAgent does.
const blockingReview: Capability = (ctx) => new Promise((_, reject) => {
  ctx.signal.addEventListener('abort', () => reject(new InterruptedError()), { once: true });
});

function harness(o: TestConfigOptions = {}, review: Capability = blockingReview) {
  const cfg = testConfig(o);
  const state = loadState(cfg.data_dir);
  const outbox = new Outbox(tmp(), tmp());
  const watcher = new Watcher({ cfg, state, source: { scan: async () => 0 }, outbox, run: async () => { throw new Error('no session'); }, secrets: {}, capabilities: { review } });
  return { cfg, state, outbox, watcher };
}

describe('queue controls', () => {
  it('removes a queued job and forgets it in state', async () => {
    const cfg = testConfig({ heavy: 1 });
    const state = loadState(cfg.data_dir);
    const q = new Queue(cfg, state, (_job, signal) => new Promise<RunOutcome>((resolve) => signal.addEventListener('abort', () => resolve('interrupted'))));
    q.start();
    q.enqueue(reviewJob(MR + '1'));
    q.enqueue(reviewJob(MR + '2'));
    await tick();
    expect(q.cancel('review', MR + '2').result).toBe('removed');
    expect(state.pendingJobs().map((j) => j.mrUrl)).toEqual([MR + '1']);
    expect(q.cancel('review', 'nope').result).toBe('not_found');
    await q.stop();
    expect(state.pendingJobs().map((j) => j.mrUrl)).toEqual([MR + '1']); // a shutdown keeps the running job
  });

  it('a cancelled running job leaves state even when the runner reports interrupted', async () => {
    const cfg = testConfig();
    const state = loadState(cfg.data_dir);
    const q = new Queue(cfg, state, (_job, signal) => new Promise<RunOutcome>((resolve) => signal.addEventListener('abort', () => resolve('interrupted'))));
    q.start();
    q.enqueue(reviewJob());
    await tick();
    expect(q.cancel('review', MR).result).toBe('cancelled');
    await tick();
    expect(state.pendingJobs()).toEqual([]);
    expect(q.counts().running).toBe(0);
    await q.stop();
  });

  it('a paused queue holds jobs, survives a restart, and resumes', async () => {
    const cfg = testConfig();
    const state = loadState(cfg.data_dir);
    let started = 0;
    const q = new Queue(cfg, state, async () => { started++; return 'done'; });
    q.start();
    q.setPaused(true);
    q.enqueue(reviewJob());
    await tick();
    expect(started).toBe(0);
    expect(loadState(cfg.data_dir).paused).toBe(true);
    q.setPaused(false);
    await tick();
    expect(started).toBe(1);
    await q.stop();
  });
});

describe('watcher controls', () => {
  afterEach(() => setNotify(() => {}));

  it('cancelling a running review records a cancelled event and tells the requester', async () => {
    setNotify(() => {});
    const h = harness();
    h.watcher.queue.start();
    expect(h.watcher.queue.enqueue(reviewJob())).toBe('queued');
    await tick();
    expect(h.watcher.cancel('review', MR)).toBe('cancelled');
    await tick();
    expect(h.state.pendingJobs()).toEqual([]);
    expect(events(h.cfg.data_dir).at(-1)).toMatchObject({ kind: 'review', status: 'cancelled', reason: 'cancelled by owner', mr: MR });
    expect(replies(h.outbox).some((r) => r.includes(failedReply))).toBe(true);
    expect(h.state.startReview(MR, 60_000)).toBe(true); // the cooldown is lifted so it can be asked again
    await h.watcher.queue.stop();
  });

  it('cancelling a queued review records it, tells the requester and lifts the cooldown', async () => {
    setNotify(() => {});
    const h = harness({ heavy: 1 });
    h.watcher.queue.start();
    h.watcher.queue.enqueue(reviewJob(MR + '1'));
    h.watcher.queue.enqueue(reviewJob());
    await tick();
    expect(h.watcher.cancel('review', MR)).toBe('removed');
    expect(events(h.cfg.data_dir).at(-1)).toMatchObject({ kind: 'review', status: 'cancelled', mr: MR });
    expect(replies(h.outbox).some((r) => r.includes(failedReply))).toBe(true);
    expect(h.state.startReview(MR, 60_000)).toBe(true);
    await h.watcher.queue.stop();
  });

  it('a disabled capability answers "not enabled" and its queued jobs fail', async () => {
    const notes: string[] = [];
    setNotify((title, text) => { notes.push(`${title}: ${text}`); });
    const h = harness({}, async () => ({ event: { status: 'posted' } }));
    h.cfg.capabilities['review']!.enabled = false;
    const msg = { id: '1792145784403', messageType: 'message', createdDateTime: new Date().toISOString(), from: { user: { id: 'p1' } }, body: { contentType: 'text', content: MR } };
    h.watcher.act(CHAT, msg, h.cfg.people[1]!, { addressedToMe: true, intent: 'review_mr', mrUrls: [MR], summary: '' });
    expect(replies(h.outbox)).toContain(unavailableText('review'));
    expect(notes.some((n) => n.includes('disabled'))).toBe(true);
    expect(await h.watcher.runJob(reviewJob(), new AbortController().signal)).toBe('done');
    expect(events(h.cfg.data_dir).at(-1)).toMatchObject({ status: 'failed', reason: 'capability review is disabled' });
  });

  it('retry re-queues a recorded request past the cooldown, and refuses in shadow mode', () => {
    setNotify(() => {});
    const h = harness({ heavy: 1 });
    const job = reviewJob();
    h.state.recordRequest(job);
    expect(h.state.startReview(MR, 60_000)).toBe(true);
    expect(h.watcher.retry('review', MR)).toBe('queued');
    expect(() => h.watcher.retry('kb_query', MR)).toThrow(/no kb_query request/u);
    h.cfg.capabilities['review']!.enabled = false;
    expect(() => h.watcher.retry('review', MR)).toThrow(/not enabled/u);
    const shadow = harness({ teams: { shadow: true } });
    shadow.state.recordRequest(job);
    expect(() => shadow.watcher.retry('review', MR)).toThrow(/shadow mode/u);
  });
});

describe('config edits', () => {
  const YAML = `# top comment
data_dir: /tmp/x
capabilities:
  review: { profile: review, lane: heavy } # inline comment
`;

  it('keeps comments and changes only the given paths', () => {
    const out = applyOps(YAML, [{ path: ['capabilities', 'review', 'model'], value: 'claude-sonnet-5-5' }, { path: ['capabilities', 'review', 'enabled'], value: false }]);
    expect(out).toContain('# top comment');
    expect(out).toContain('# inline comment');
    expect(out).toContain('model: claude-sonnet-5-5');
    expect(applyOps(out, [{ path: ['capabilities', 'review'], delete: true }])).not.toContain('review');
  });

  it('rejects malformed ops', () => {
    expect(() => applyOps(YAML, [])).toThrow(ConfigProblems);
    expect(() => applyOps(YAML, [{ path: [] }])).toThrow(ConfigProblems);
    expect(() => applyOps(YAML, [{ path: ['a'] }])).toThrow(/needs a value or delete/u);
    expect(() => applyOps(YAML, [{ path: ['data_dir', 'x'], value: 1 }])).toThrow(ConfigProblems);
  });

  it('refuses a write tool on an mcp_read capability, a data_dir change and a failing doctor', async () => {
    const cfg = testConfig({ mcpRead: { name: 'grafana', trigger: 'grafana_query', mcp: ['grafana'], tools: ['query_prometheus'] } });
    const path = join(cfg.data_dir, 'config.yaml');
    const text = readFileSync(path, 'utf8');
    const ok = async () => [{ name: 'node', ok: true, detail: '' }];
    const granted = applyOps(text, [{ path: ['capabilities', 'grafana', 'tools'], value: ['query_prometheus', 'update_dashboard'] }]);
    await expect(checkCandidate(granted, cfg, [], ok)).rejects.toThrow(/update_dashboard" is not a read-only tool/u);
    await expect(checkCandidate(applyOps(text, [{ path: ['data_dir'], value: tmp() }]), cfg, [], ok)).rejects.toThrow(/data_dir/u);
    await expect(checkCandidate(applyOps(text, [{ path: ['admin'], value: { port: 9999 } }]), cfg, [], ok)).rejects.toThrow(/admin.port/u);
    await expect(checkCandidate(text, cfg, [], async () => [{ name: 'mcp servers', ok: false, detail: 'missing kb' }])).rejects.toThrow(/missing kb/u);
    const withoutGrafana = applyOps(text, [{ path: ['capabilities', 'grafana'], delete: true }]);
    const grafanaJob: Job = { kind: 'grafana', channel: 'teams', chatId: CHAT, principal: 'teams:p1', requesterName: 'p1', messageId: '1792145784403', input: 'q', requestedAt: '' };
    await expect(checkCandidate(withoutGrafana, cfg, [grafanaJob], ok)).rejects.toThrow(/grafana has saved jobs/u);
    await expect(checkCandidate(withoutGrafana, cfg, [], ok)).resolves.toBeDefined();
    const { cfg: next } = await checkCandidate(applyOps(text, [{ path: ['capabilities', 'kb_query', 'enabled'], value: false }]), cfg, [], ok);
    expect(next.capabilities['kb_query']?.enabled).toBe(false);
    expect(next.capabilities['review']?.enabled).toBe(true);
  });

  it('backs up before writing', () => {
    const dir = tmp();
    const path = join(dir, 'config.yaml');
    writeFileSync(path, 'old\n');
    const backup = writeConfig(path, 'new\n', new Date(2026, 9, 18, 9, 5, 7));
    expect(backup).toBe('config.yaml.bak-261018-090507');
    expect(readFileSync(join(dir, backup), 'utf8')).toBe('old\n');
    expect(readFileSync(path, 'utf8')).toBe('new\n');
  });
});

describe('admin server', () => {
  const statusWithHost = (port: number, host: string): Promise<number | undefined> => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/api/overview', headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });

  const statusOf = (port: number, path: string): Promise<number | undefined> => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });

  async function started(live?: Live) {
    const h = harness();
    const configPath = join(h.cfg.data_dir, 'config.yaml');
    const webDir = tmp();
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>audee</title>');
    writeFileSync(join(h.cfg.data_dir, 'secret.txt'), 'nope');
    let reloads = 0;
    const server = new AdminServer({
      configPath, dataDir: h.cfg.data_dir, startedAt: new Date(), webDir,
      live: () => live ?? { cfg: h.cfg, state: h.state, watcher: h.watcher, reloadedAt: new Date() },
      reload: async () => { reloads++; return { ok: true }; },
      doctor: async () => [{ name: 'node', ok: true, detail: 'v22' }],
    });
    const port = await server.listen(0);
    const token = adminToken(h.cfg.data_dir);
    const call = (path: string, init: RequestInit & { auth?: string | false } = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        ...(init.auth !== false ? { Authorization: `Bearer ${init.auth ?? token}` } : {}),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    return { ...h, server, port, call, configPath, reloads: () => reloads };
  }

  it('needs the token and a local Host header', async () => {
    const s = await started();
    expect((await s.call('/api/overview', { auth: false })).status).toBe(401);
    expect((await s.call('/api/overview', { auth: 'x'.repeat(64) })).status).toBe(401);
    expect(await statusWithHost(s.port, 'evil.example:80')).toBe(421); // fetch cannot set Host
    expect(await statusWithHost(s.port, `localhost:${s.port}`)).toBe(401);
    expect((await s.call('/api/overview')).status).toBe(200);
    expect(readFileSync(join(s.cfg.data_dir, 'admin-token'), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/u);
    await s.server.close();
  });

  it('reports the queue and controls it', async () => {
    const s = await started();
    s.watcher.queue.start();
    s.watcher.queue.enqueue(reviewJob());
    await tick();
    const ov = (await (await s.call('/api/overview')).json()) as Overview;
    expect(ov.mode).toBe('live');
    expect(ov.lanes.find((l) => l.name === 'heavy')?.running[0]).toMatchObject({ kind: 'review', key: MR, personName: 'p1' });
    expect(await (await s.call('/api/queue/pause', { method: 'POST', body: JSON.stringify({ paused: true }) })).json()).toEqual({ paused: true });
    expect(await (await s.call('/api/jobs/cancel', { method: 'POST', body: JSON.stringify({ kind: 'review', key: MR }) })).json()).toEqual({ result: 'cancelled' });
    expect((await s.call('/api/jobs/cancel', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await s.call('/api/jobs/retry', { method: 'POST', body: JSON.stringify({ kind: 'review', key: 'nope' }) })).status).toBe(409);
    await tick();
    const history = (await (await s.call('/api/events?status=cancelled')).json()) as { total: number };
    expect(history.total).toBe(1);
    await s.watcher.queue.stop();
    await s.server.close();
  });

  it('saves a valid config edit with a backup and leaves the file alone when it is invalid', async () => {
    const s = await started();
    const before = readFileSync(s.configPath, 'utf8');
    const bad = await s.call('/api/config', { method: 'PATCH', body: JSON.stringify({ ops: [{ path: ['capabilities', 'review', 'lane'], value: 'nowhere' }] }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { problems: string[] }).problems.join()).toMatch(/lane "nowhere"/u);
    expect(readFileSync(s.configPath, 'utf8')).toBe(before);
    const good = await s.call('/api/config', { method: 'PATCH', body: JSON.stringify({ ops: [{ path: ['capabilities', 'review', 'model'], value: 'claude-sonnet-5-5' }] }) });
    expect(good.status).toBe(200);
    expect(s.reloads()).toBe(1);
    expect(loadConfig(s.configPath).capabilities['review']?.model).toBe('claude-sonnet-5-5');
    const view = (await (await s.call('/api/config')).json()) as { backups: string[]; raw: unknown };
    expect(view.backups).toHaveLength(1);
    await s.server.close();
  });

  it('serves the UI without leaving the web folder', async () => {
    const s = await started();
    const page = await fetch(`http://127.0.0.1:${s.port}/jobs`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>audee</title>');
    for (const path of ['/..%2Fsecret.txt', '/%2e%2e%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt']) {
      const body = await new Promise<string>((resolve, reject) => {
        request({ host: '127.0.0.1', port: s.port, path }, (res) => { let text = ''; res.on('data', (c) => { text += String(c); }); res.on('end', () => resolve(text)); }).on('error', reject).end();
      });
      expect(body).not.toContain('nope');
    }
    expect(await statusOf(s.port, '/%')).toBe(400);
    await s.server.close();
  });
});

describe('serve reload', () => {
  it('reloads the config in place and keeps the lock', async () => {
    const cfg = testConfig({ maxConcurrent: 3 });
    const configPath = join(cfg.data_dir, 'config.yaml');
    const lines: string[] = [];
    const stop = new AbortController();
    const done = serve(configPath, stop.signal, { skipDoctor: true, adminPort: 0, out: (l) => lines.push(l) });
    while (!lines.some((l) => l.startsWith('dashboard:'))) await tick();
    const port = Number(/127\.0\.0\.1:(\d+)/u.exec(lines.find((l) => l.startsWith('dashboard:')) ?? '')?.[1]);
    const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { Authorization: `Bearer ${adminToken(cfg.data_dir)}`, 'Content-Type': 'application/json' } });
    const lock = readFileSync(join(cfg.data_dir, 'audee.lock'), 'utf8');
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('max_concurrent: 3', 'max_concurrent: 5'));
    expect(await (await call('/api/reload', { method: 'POST' })).json()).toEqual({ ok: true });
    expect(((await (await call('/api/overview')).json()) as Overview).maxConcurrent).toBe(5);
    expect(readFileSync(join(cfg.data_dir, 'audee.lock'), 'utf8')).toBe(lock);
    const good = readFileSync(configPath, 'utf8');
    for (const bad of ['not: [valid', good.replace(/^data_dir: .*$/mu, `data_dir: ${tmp()}`)]) {
      writeFileSync(configPath, bad);
      const failed = (await (await call('/api/reload', { method: 'POST' })).json()) as { ok: boolean; error: string };
      expect(failed.ok).toBe(false);
      const ov = (await (await call('/api/overview')).json()) as Overview;
      expect(ov.maxConcurrent).toBe(5);
      expect(ov.reloadError).toBeDefined();
    }
    stop.abort();
    await done;
    expect(existsSync(join(cfg.data_dir, 'audee.lock'))).toBe(false);
  });
});
