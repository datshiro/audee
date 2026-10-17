// Port of ciel/pin.go: copy the EventSource skill as committed at a ref into a folder named after the commit
// beside skill_dir, then point the skill_dir symlink at it. A mapping already running keeps the copy it started with.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const defaultSkillRef = 'origin/main';

export type PinInput = { skillSource: string; skillDir: string };
export type PinResult = { ref: string; version: string; dest: string };

function gitOutputBytes(dir: string, ...args: string[]): Buffer {
  try {
    return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    const stderr = err.stderr === undefined ? '' : String(err.stderr).trim();
    throw new Error(`git ${args[0] ?? ''}: ${stderr || err.message}`);
  }
}

function gitOutput(dir: string, ...args: string[]): string {
  return gitOutputBytes(dir, ...args).toString('utf8').trim();
}

// pin.go:70-92: the skill folder's tree, unpacked beside dest and renamed in whole.
export function extractSkill(repo: string, tree: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(dirname(dest), '.pin-'));
  try {
    const archive = gitOutputBytes(repo, 'archive', '--format=tar', tree);
    try {
      execFileSync('tar', ['-x', '-f', '-', '-C', tmp], { input: archive, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`unpack skill: ${(e as Error).message}`);
    }
    if (!existsSync(join(tmp, 'SKILL.md'))) throw new Error(`${tree} has no SKILL.md`);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// pin.go:19-67
export function pinSkill(input: PinInput, ref = ''): PinResult {
  if (ref === '') ref = defaultSkillRef;
  if (ref.startsWith('-')) throw new Error(`"${ref}" is not a git ref`);
  const src = input.skillSource;
  let prefix: string;
  try {
    prefix = gitOutput(src, 'rev-parse', '--show-prefix');
  } catch (e) {
    throw new Error(`skill_source: ${(e as Error).message}`);
  }
  if (ref.startsWith('origin/')) {
    // "origin/--upload-pack=..." passes the check above but would be read as a fetch option.
    gitOutput(src, 'fetch', '-q', '--end-of-options', 'origin', ref.slice('origin/'.length));
  }
  const commit = gitOutput(src, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}');
  const link = input.skillDir;
  try {
    if (!lstatSync(link).isSymbolicLink()) throw new Error(`skill_dir ${link} is a folder, not a pin: move it away first`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const version = commit.slice(0, 12);
  const dest = join(dirname(link), version);
  if (!existsSync(dest)) {
    // From a subfolder, git archive keeps only that subfolder's part of the tree.
    const top = gitOutput(src, 'rev-parse', '--show-toplevel');
    extractSkill(top, commit + ':' + prefix.replace(/\/$/, ''), dest);
  }
  const tmp = link + '.new';
  rmSync(tmp, { force: true });
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  symlinkSync(version, tmp);
  renameSync(tmp, link);
  return { ref, version, dest };
}
