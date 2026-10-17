import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { InterruptedError, runAgent } from '../../src/runner/run.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const SLOW = fixture('fake-claude-slow.sh');
const FAILING = fixture('fake-claude.sh');
const ENV_DUMP = fixture('fake-claude-env.sh');

async function pidGone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(250);
  }
  return false;
}

describe('runner', () => {
  const savedKey = process.env['ANTHROPIC_API_KEY'];
  afterEach(() => {
    if (savedKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedKey;
  });

  it('TestRunnerTimesOut', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audee-run-'));
    const pidOut = join(dir, 'pid');
    const started = Date.now();
    await expect(runAgent({ options: { pathToClaudeCodeExecutable: SLOW }, prompt: 'x', timeoutMs: 1000, auth: 'subscription', extraEnv: { FAKE_CLAUDE_PID_OUT: pidOut } })).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number((await readFile(pidOut, 'utf8')).trim());
    expect(pid).toBeGreaterThan(0);
    expect(await pidGone(pid, 10_000)).toBe(true);
  }, 20_000);

  it('TestRunnerInterrupted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audee-run-'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    await expect(runAgent({ options: { pathToClaudeCodeExecutable: SLOW }, prompt: 'x', timeoutMs: 10_000, auth: 'subscription', signal: controller.signal, extraEnv: { FAKE_CLAUDE_PID_OUT: join(dir, 'pid') } })).rejects.toBeInstanceOf(InterruptedError);
  }, 20_000);

  it('TestRunnerWrapsFailure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audee-run-'));
    await expect(runAgent({ options: { pathToClaudeCodeExecutable: FAILING }, prompt: 'x', timeoutMs: 10_000, auth: 'subscription', extraEnv: { FAKE_CLAUDE_ARGV_OUT: join(dir, 'argv') } })).rejects.toThrow(/^session failed: /);
  }, 20_000);

  it('TestRunnerApiKeyUsesHelper', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audee-run-'));
    const argvOut = join(dir, 'argv');
    const envOut = join(dir, 'env');
    process.env['ANTHROPIC_API_KEY'] = 'must-not-leak';
    const options = { pathToClaudeCodeExecutable: ENV_DUMP, settings: { permissions: { blockReadsOutsideWorkingDirectories: true } } };
    const before = JSON.stringify(options);
    await expect(runAgent({ options, prompt: 'x', timeoutMs: 10_000, auth: 'api_key', apiKeyItem: 'audee-anthropic', extraEnv: { FAKE_CLAUDE_ARGV_OUT: argvOut, FAKE_CLAUDE_ENV_OUT: envOut } })).rejects.toThrow(/^session failed: /);
    const argv = (await readFile(argvOut, 'utf8')).split('\n');
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}') as { apiKeyHelper?: string; permissions?: unknown };
    expect(settings.apiKeyHelper).toMatch(/api-key-helper\.sh audee-anthropic$/);
    expect(settings.permissions).toEqual({ blockReadsOutsideWorkingDirectories: true });
    expect(JSON.stringify(options)).toBe(before);
    const env = (await readFile(envOut, 'utf8')).split('\n');
    expect(env.some((l) => l.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
    expect(env.some((l) => l.startsWith('USER='))).toBe(true);
    expect(env.some((l) => l.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false);
    await expect(runAgent({ options, prompt: 'x', timeoutMs: 1000, auth: 'api_key' })).rejects.toThrow('no keychain item is configured');
  }, 20_000);
});
