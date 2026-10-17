// Port of ciel/main.go:112-151: ask the running audee to redo a request by dropping a file the watcher picks up.
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome } from './config/load.js';
import type { Config } from './config/schema.js';
import type { Job } from './queue/job.js';
import { loadState } from './state/state.js';
import { rerunDir } from './teams/watcher.js';

export const messageIdRe = /^[0-9]{10,}$/u;

export function rerun(cfg: Config, target: string, dataDir = expandHome(cfg.data_dir)): Job {
  const isMR = new RegExp(cfg.channels.teams.mr_url_pattern, 'u').exec(target)?.[0] === target;
  if (!isMR && !messageIdRe.test(target)) throw new Error(`"${target}" is neither an MR URL matching mr_url_pattern nor a Teams message id`);
  const state = loadState(dataDir);
  const job = state.findRequest(target);
  if (job === undefined) throw new Error(`no request for ${target} in audee's history`);
  if (!isMR && (job.input ?? '') === '') throw new Error(`no code-mapping or kb_query request for message ${target} in the last 3 days`);
  const dir = rerunDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = randomBytes(16).toString('hex') + '.json';
  const tmp = join(dir, '.' + name);
  writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
  renameSync(tmp, join(dir, name));
  return job;
}
