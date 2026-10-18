import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type PinInput, pinSkill } from '../../src/capability/pin-skill.js';

// ciel/pin_test.go:12
function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

// ciel/pin_test.go:22: writes SKILL.md with body in repo's skill folder and commits it.
function commitSkill(repo: string, body: string): void {
  const skill = join(repo, '.claude', 'skills', 'es');
  mkdirSync(join(skill, 'scripts'), { recursive: true, mode: 0o700 });
  writeFileSync(join(skill, 'SKILL.md'), body);
  writeFileSync(join(skill, 'scripts', 'probe-pipeline.sh'), 'echo probe');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', body);
}

// ciel/pin_test.go:36: an upstream repo with one committed skill, a clone as skill_source, a fresh pin folder.
function pinTest(): { upstream: string; input: PinInput } {
  const upstream = mkdtempSync(join(tmpdir(), 'audee-up-'));
  git(upstream, 'init', '-q', '-b', 'main');
  commitSkill(upstream, 'v1');
  const clone = join(mkdtempSync(join(tmpdir(), 'audee-clone-')), 'kb');
  git(upstream, 'clone', '-q', upstream, clone);
  return { upstream, input: { skillSource: join(clone, '.claude', 'skills', 'es'), skillDir: join(mkdtempSync(join(tmpdir(), 'audee-pin-')), 'skills', 'es') } };
}

const pinned = (input: PinInput): string => readFileSync(join(input.skillDir, 'SKILL.md'), 'utf8');

describe('pin-skill', () => {
  it('TestPinSkillFetchesOriginMainByDefault', () => {
    const { upstream, input } = pinTest();
    commitSkill(upstream, 'v2'); // after the clone: only a fetch sees it
    const result = pinSkill(input, '');
    expect(result.ref).toBe('origin/main');
    expect(pinned(input)).toBe('v2');
    expect(existsSync(join(input.skillDir, 'scripts', 'probe-pipeline.sh'))).toBe(true);
  });

  it('TestPinSkillIgnoresUncommittedEdits', () => {
    const { input } = pinTest();
    writeFileSync(join(input.skillSource, 'SKILL.md'), 'dirty');
    pinSkill(input, 'HEAD');
    expect(pinned(input)).toBe('v1');
  });

  it('TestPinSkillSwapsAndKeepsTheOldCopy', () => {
    const { upstream, input } = pinTest();
    pinSkill(input, '');
    const old = realpathSync(input.skillDir);
    commitSkill(upstream, 'v2');
    pinSkill(input, '');
    expect(pinned(input)).toBe('v2');
    expect(existsSync(join(old, 'SKILL.md'))).toBe(true); // a mapping still running on it keeps it
    expect(realpathSync(input.skillDir)).not.toBe(old);
  });

  it('TestPinSkillRefusesBadInput', () => {
    const { input } = pinTest();
    expect(() => pinSkill(input, '--upload-pack=x')).toThrow('is not a git ref');
    expect(() => pinSkill(input, 'origin/--upload-pack=x')).toThrow();
    expect(() => pinSkill(input, 'no-such-ref')).toThrow();
    mkdirSync(input.skillDir, { recursive: true, mode: 0o700 });
    expect(() => pinSkill(input, 'HEAD')).toThrow('not a pin');
  });
});
