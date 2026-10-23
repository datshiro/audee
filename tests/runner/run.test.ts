import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
const STDERR_ARGV = fixture('fake-claude-stderr-argv.sh');

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

  it('TestRunnerRedactsMcpSecretsFromErrors', async () => {
    const token = 'FAKETOKEN-redact-7c2e91';
    const options = {
      pathToClaudeCodeExecutable: STDERR_ARGV,
      mcpServers: {
        grafana: { command: 'grafana-mcp', env: { GRAFANA_SERVICE_ACCOUNT_TOKEN: token } },
        remote: { type: 'http' as const, url: 'https://mcp.example/sse?key=url-secret-91', headers: { Authorization: 'Bearer header-secret-55' } },
      },
    };
    const err = await runAgent({ options, prompt: 'x', timeoutMs: 10_000, auth: 'subscription' }).then(
      () => { throw new Error('the session should have failed'); },
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/^session failed: /);
    expect(err.message).toContain('stderr: fatal: bad args:'); // the CLI's output is kept, only the values go
    expect(err.message).toContain('[redacted]');
    for (const secret of [token, 'url-secret-91', 'header-secret-55']) expect(err.message).not.toContain(secret);
  }, 20_000);

  it('TestRunnerGatewayOnlyForApiKey', async () => {
    const gateway = 'https://gateway.example/litellm';
    const dump = async (auth: 'subscription' | 'api_key'): Promise<string[]> => {
      const dir = await mkdtemp(join(tmpdir(), 'audee-run-'));
      const envOut = join(dir, 'env');
      await runAgent({ options: { pathToClaudeCodeExecutable: ENV_DUMP }, prompt: 'x', timeoutMs: 10_000, auth, apiKeyItem: 'audee-anthropic', baseUrl: gateway, extraEnv: { FAKE_CLAUDE_ARGV_OUT: join(dir, 'argv'), FAKE_CLAUDE_ENV_OUT: envOut } }).catch(() => undefined);
      return (await readFile(envOut, 'utf8')).split('\n');
    };
    expect(await dump('api_key')).toContain(`ANTHROPIC_BASE_URL=${gateway}`);
    expect((await dump('subscription')).some((l) => l.startsWith('ANTHROPIC_BASE_URL='))).toBe(false); // the login never goes to the gateway
  }, 20_000);

  it('TestSubscriptionRunsThroughClaudeHack', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audee-run-'));
    const configOut = join(dir, 'config-dir');
    await writeFile(join(dir, 'claude'), `#!/bin/sh\necho "$CLAUDE_CONFIG_DIR" > "${configOut}"\n`);
    await chmod(join(dir, 'claude'), 0o755);
    await runAgent({ options: {}, prompt: 'x', timeoutMs: 10_000, auth: 'subscription', extraEnv: { PATH: `${dir}:${process.env['PATH'] ?? ''}` } }).catch(() => undefined);
    expect((await readFile(configOut, 'utf8')).trim()).toBe(join(process.env['HOME'] ?? '', '.claude-hack'));
  }, 20_000);
});
