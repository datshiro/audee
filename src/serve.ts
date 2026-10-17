import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, loadConfig } from './config/load.js';
import { formatChecks, runDoctor } from './doctor.js';
import { loadKeychainEnv } from './keychain.js';
import { acquireLock } from './lock.js';
import { runAgent } from './runner/run.js';
import { loadState } from './state/state.js';
import { Inbox } from './teams/inbox.js';
import { Outbox } from './teams/outbox.js';
import { ShadowSource, shadowHandler } from './teams/shadow.js';
import { ensureRerunDir, Watcher, type WatcherDeps } from './teams/watcher.js';

export type ServeOptions = { out?: (s: string) => void; skipDoctor?: boolean };

// Runs the Teams agent until the signal aborts, then waits for running sessions to stop. One instance at a
// time; refuses to start when doctor finds a problem. Secrets stay in memory and reach only MCP servers.
export async function serve(configPath: string, signal: AbortSignal, opts: ServeOptions = {}): Promise<void> {
  const out = opts.out ?? console.log;
  const cfg = loadConfig(configPath);
  const dataDir = expandHome(cfg.data_dir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(join(dataDir, 'audee.lock'));
  try {
    if (opts.skipDoctor !== true) {
      const checks = await runDoctor(cfg);
      for (const line of formatChecks(checks)) out(line);
      if (checks.some((c) => !c.ok)) throw new Error('doctor found problems');
    }
    const keychain = loadKeychainEnv(cfg.keychain_env);
    for (const problem of keychain.errors) out(`keychain_env: ${problem}`); // names and items only, never values
    ensureRerunDir(dataDir);
    const state = loadState(dataDir);
    const shadow = cfg.channels.teams.shadow;
    const oneDrive = expandHome(cfg.channels.teams.onedrive_dir);
    let deps: WatcherDeps;
    if (shadow) {
      deps = {
        cfg, state, source: ShadowSource.forCiel(state), outbox: new Outbox(join(dataDir, 'shadow-outbox'), join(dataDir, 'tmp')),
        run: runAgent, secrets: keychain.values, handle: shadowHandler({ cfg, state, run: runAgent }),
      };
    } else {
      const inbox = new Inbox(oneDrive, dataDir, { track: (file, update) => state.trackMessage(file, update) });
      deps = { cfg, state, source: inbox, inbox, outbox: Outbox.forOneDrive(oneDrive, dataDir), run: runAgent, secrets: keychain.values };
    }
    const watcher = new Watcher(deps);
    try {
      await watcher.run(signal);
    } finally {
      await watcher.queue.stop();
    }
  } finally {
    release();
  }
}
