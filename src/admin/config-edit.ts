// Dashboard edits of config.yaml: applied to the YAML document (so comments stay), checked with the same schema,
// fence rules and doctor the daemon starts with, and written only when all of them pass.
import { copyFileSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { expandHome, validateConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import type { Check } from '../doctor.js';
import type { Job } from '../queue/job.js';
import type { ConfigOp } from './api-types.js';

export class ConfigProblems extends Error {
  constructor(readonly problems: string[]) {
    super(problems.length === 1 ? (problems[0] ?? '') : `${problems.length} problems in the new config`);
    this.name = 'ConfigProblems';
  }
}

const isKey = (k: unknown): k is string | number => (typeof k === 'string' && k !== '') || (typeof k === 'number' && Number.isInteger(k) && k >= 0);

export function applyOps(text: string, ops: unknown): string {
  if (!Array.isArray(ops) || ops.length === 0) throw new ConfigProblems(['ops must be a non-empty list']);
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new ConfigProblems(doc.errors.map((e) => `config.yaml: ${e.message}`));
  for (const op of ops as ConfigOp[]) {
    if (typeof op !== 'object' || op === null || !Array.isArray(op.path) || op.path.length === 0 || !op.path.every(isKey)) {
      throw new ConfigProblems([`invalid op ${JSON.stringify(op)}: path must be a non-empty list of keys`]);
    }
    if (op.delete !== true && op.value === undefined) throw new ConfigProblems([`op at ${op.path.join('.')} needs a value or delete`]);
    try {
      if (op.delete === true) doc.deleteIn(op.path);
      else doc.setIn(op.path, op.value);
    } catch (e) {
      throw new ConfigProblems([`op at ${op.path.join('.')}: ${(e as Error).message}`]);
    }
  }
  return doc.toString();
}

export type Doctor = (cfg: Config) => Promise<Check[]>;

// The candidate config text, or every reason it cannot replace the running one.
export async function checkCandidate(text: string, running: Config, pending: Job[], doctor: Doctor): Promise<{ cfg: Config; checks: Check[] }> {
  let cfg: Config;
  try {
    cfg = validateConfig(parseDocument(text).toJS());
  } catch (e) {
    throw new ConfigProblems((e as Error).message.split('\n'));
  }
  return { cfg, checks: await checkReplacement(cfg, running, pending, doctor) };
}

// What startup would refuse, plus what only a restart can change, plus saved jobs a removed capability would drop.
export async function checkReplacement(cfg: Config, running: Config, pending: Job[], doctor: Doctor): Promise<Check[]> {
  const problems: string[] = [];
  if (expandHome(cfg.data_dir) !== expandHome(running.data_dir)) problems.push('data_dir can only change with a restart');
  if (cfg.admin.port !== running.admin.port) problems.push('admin.port can only change with a restart');
  for (const kind of new Set(pending.map((j) => j.kind))) {
    if (cfg.capabilities[kind] === undefined) problems.push(`capabilities.${kind} has saved jobs: stop them on the Jobs page before removing it`);
  }
  if (problems.length > 0) throw new ConfigProblems(problems);
  const checks = await doctor(cfg);
  const failing = checks.filter((c) => !c.ok);
  if (failing.length > 0) throw new ConfigProblems(failing.map((c) => `doctor: ${c.name}: ${c.detail}`));
  return checks;
}

const stamp = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Keeps the current file as <name>.bak-<yymmdd-hhmmss>, then replaces it by write-to-temp-then-rename.
export function writeConfig(path: string, text: string, now = new Date()): string {
  const backup = `${path}.bak-${stamp(now)}`;
  copyFileSync(path, backup);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  return basename(backup);
}

export function listBackups(path: string): string[] {
  const prefix = basename(path) + '.bak-';
  try {
    return readdirSync(dirname(path)).filter((f) => f.startsWith(prefix)).sort().reverse();
  } catch {
    return [];
  }
}

export function readConfigText(path: string): string {
  return readFileSync(path, 'utf8');
}
