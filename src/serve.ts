import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, loadConfig } from './config/load.js';
import { runAgent } from './runner/run.js';
import { loadState } from './state/state.js';
import { Inbox } from './teams/inbox.js';
import { Outbox } from './teams/outbox.js';
import { ShadowSource, shadowHandler } from './teams/shadow.js';
import { ensureRerunDir, Watcher, type WatcherDeps } from './teams/watcher.js';

// Runs the Teams agent until the signal aborts, then waits for running sessions to stop.
// Lock, Keychain secrets and doctor come in phase 12; `secrets` is empty until then.
export async function serve(configPath: string, signal: AbortSignal, secrets: Record<string, string> = {}): Promise<void> {
  const cfg = loadConfig(configPath);
  const dataDir = expandHome(cfg.data_dir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  ensureRerunDir(dataDir);
  const state = loadState(dataDir);
  const shadow = cfg.channels.teams.shadow;
  const oneDrive = expandHome(cfg.channels.teams.onedrive_dir);
  let deps: WatcherDeps;
  if (shadow) {
    // Shadow reads copies of Ciel's handled files, classifies, records, and never acts; the outbox is a local decoy.
    deps = {
      cfg, state, source: ShadowSource.forCiel(state), outbox: new Outbox(join(dataDir, 'shadow-outbox'), join(dataDir, 'tmp')),
      run: runAgent, secrets, handle: shadowHandler({ cfg, state, run: runAgent }),
    };
  } else {
    const inbox = new Inbox(oneDrive, dataDir, { track: (file, update) => state.trackMessage(file, update) });
    deps = { cfg, state, source: inbox, inbox, outbox: Outbox.forOneDrive(oneDrive, dataDir), run: runAgent, secrets };
  }
  const watcher = new Watcher(deps);
  try {
    await watcher.run(signal);
  } finally {
    await watcher.queue.stop();
  }
}
