import { describe, expect, it } from 'vitest';
import { apiKeyHelperCommand, sessionEnv } from '../../src/runner/env.js';

const base = { PATH: '/usr/bin', HOME: '/Users/x', USER: 'x', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/x', SSH_AUTH_SOCK: '/tmp/agent.sock', GITLAB_PAT: 'glpat-secret', AWS_SECRET: 'aws', ANTHROPIC_API_KEY: 'sk-ant-secret', CLAUDE_CONFIG_DIR: '/Users/x/.claude-hack' };

describe('session env', () => {
  it('TestSessionEnvAllowlist', () => {
    const env = sessionEnv({}, base);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'SSH_AUTH_SOCK', 'TMPDIR', 'USER']);
    for (const k of ['GITLAB_PAT', 'AWS_SECRET', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']) expect(env).not.toHaveProperty(k);
    expect(env['USER']).toBe('x');
  });
  it('TestSessionEnvKeepsSshAgent', () => {
    expect(sessionEnv({}, base)['SSH_AUTH_SOCK']).toBe('/tmp/agent.sock');
    expect(sessionEnv({}, { PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' });
  });
  it('TestSessionEnvTmpdir', () => {
    expect(sessionEnv({ tmpdir: '/tmp/session' }, base)['TMPDIR']).toBe('/tmp/session');
    expect(apiKeyHelperCommand('audee-anthropic')).toMatch(/\/deploy\/api-key-helper\.sh audee-anthropic$/);
    expect(() => apiKeyHelperCommand('x; printenv')).toThrow('keychain item name');
  });
});
