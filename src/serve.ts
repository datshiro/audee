import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReplacement, ConfigProblems } from './admin/config-edit.js';
import { type Live, AdminServer } from './admin/server.js';
import type { ReloadResult } from './admin/api-types.js';
import { expandHome, loadConfig } from './config/load.js';
import type { Config } from './config/schema.js';
import { type Check, formatChecks, runDoctor } from './doctor.js';
import { loadKeychainEnv } from './keychain.js';
import { acquireLock } from './lock.js';
import { runAgent } from './runner/run.js';
import { loadState, type State } from './state/state.js';
import { Inbox } from './teams/inbox.js';
import { Outbox } from './teams/outbox.js';
import { ShadowSource, shadowHandler } from './teams/shadow.js';
import { ensureRerunDir, Watcher, type WatcherDeps } from './teams/watcher.js';

export type ServeOptions = { out?: (s: string) => void; skipDoctor?: boolean; webDir?: string; adminPort?: number };

// Runs the Teams agent until the signal aborts, then waits for running sessions to stop. One instance at a
// time; refuses to start when doctor finds a problem. Secrets stay in memory and reach only MCP servers.
// The dashboard can reload the config: the new one must pass what startup checks (and keep data_dir, the
// dashboard port and every capability with saved jobs); then the watcher stops (running sessions are interrupted
// and stay saved, so they restart from the beginning) and a new one starts. The lock and the dashboard stay up.
export async function serve(configPath: string, signal: AbortSignal, opts: ServeOptions = {}): Promise<void> {
  const out = opts.out ?? console.log;
  let cfg = loadConfig(configPath);
  const dataDir = expandHome(cfg.data_dir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(join(dataDir, 'audee.lock'));
  try {
    if (opts.skipDoctor !== true) {
      const checks = await runDoctor(cfg);
      for (const line of formatChecks(checks)) out(line);
      if (checks.some((c) => !c.ok)) throw new Error('doctor found problems');
    }
    ensureRerunDir(dataDir);
    const state = loadState(dataDir);
    if (state.paused) out('queue is paused: queued jobs wait until it is resumed on the dashboard');
    const doctor = opts.skipDoctor === true ? async (): Promise<Check[]> => [] : (c: Config) => runDoctor(c);
    let live: Live | undefined;
    let next: Config | undefined;
    let cycle = new AbortController();
    let reloaded: ((r: ReloadResult) => void) | undefined;
    const reload = async (): Promise<ReloadResult> => {
      try {
        const candidate = loadConfig(configPath);
        await checkReplacement(candidate, cfg, state.pendingJobs(), doctor);
        next = candidate;
      } catch (e) {
        const error = e instanceof ConfigProblems ? e.problems.join('\n') : (e as Error).message;
        if (live !== undefined) live.reloadError = error;
        out(`config reload refused, still on the previous config: ${error}`);
        return { ok: false, error };
      }
      return new Promise<ReloadResult>((resolve) => {
        reloaded = resolve;
        cycle.abort();
      });
    };
    const admin = new AdminServer({
      configPath: expandHome(configPath), dataDir, startedAt: new Date(), live: () => live, reload, doctor,
      ...(opts.webDir !== undefined ? { webDir: opts.webDir } : {}),
    });
    try {
      const port = await admin.listen(opts.adminPort ?? cfg.admin.port);
      out(`dashboard: http://127.0.0.1:${port}/ (run \`audee dashboard\` for the sign-in link)`);
    } catch (e) {
      out(`dashboard: not started: ${(e as Error).message}`); // the agent itself runs on
    }
    try {
      while (!signal.aborted) {
        cycle = new AbortController();
        const watcher = new Watcher(watcherDeps(cfg, state, dataDir, out));
        live = { cfg, state, watcher, reloadedAt: new Date() };
        reloaded?.({ ok: true });
        reloaded = undefined;
        try {
          await watcher.run(AbortSignal.any([signal, cycle.signal]));
        } finally {
          live = undefined;
          await watcher.queue.stop();
        }
        if (signal.aborted || next === undefined) break;
        cfg = next;
        next = undefined;
        out('config reloaded');
      }
    } finally {
      reloaded?.({ ok: false, error: 'audee is shutting down' });
      await admin.close();
    }
  } finally {
    release();
  }
}

function watcherDeps(cfg: Config, state: State, dataDir: string, out: (s: string) => void): WatcherDeps {
  const keychain = loadKeychainEnv(cfg.keychain_env);
  for (const problem of keychain.errors) out(`keychain_env: ${problem}`); // names and items only, never values
  if (cfg.channels.teams.shadow) {
    return {
      cfg, state, source: ShadowSource.forCiel(state), outbox: new Outbox(join(dataDir, 'shadow-outbox'), join(dataDir, 'tmp')),
      run: runAgent, secrets: keychain.values, handle: shadowHandler({ cfg, state, run: runAgent }),
    };
  }
  const oneDrive = expandHome(cfg.channels.teams.onedrive_dir);
  const inbox = new Inbox(oneDrive, dataDir, { track: (file, update) => state.trackMessage(file, update) });
  return { cfg, state, source: inbox, inbox, outbox: Outbox.forOneDrive(oneDrive, dataDir), run: runAgent, secrets: keychain.values };
}
