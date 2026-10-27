import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { authFor, authSettings, isAllowed, resolvePerson } from '../../src/authz/people.js';
import { expandHome, loadConfig } from '../../src/config/load.js';
import { ConfigSchema } from '../../src/config/schema.js';

const cfg = loadConfig(fileURLToPath(new URL('../fixtures/config/people.yaml', import.meta.url)));

describe('people', () => {
  it('TestRequesterDenied', () => {
    const nobody = resolvePerson(cfg, 'teams:nobody');
    expect(nobody).toBeUndefined();
    expect(isAllowed(nobody, 'kb_query')).toBe(false);
  });
  it('TestCapabilityNotGranted', () => {
    const minh = resolvePerson(cfg, 'teams:minh-1');
    expect(isAllowed(minh, 'review')).toBe(false);
    expect(isAllowed(minh, 'kb_query')).toBe(true);
  });
  it('TestOwnerHasEverything', () => {
    const dat = resolvePerson(cfg, 'teams:owner-1');
    expect(dat?.owner).toBe(true);
    for (const c of ['review', 'kb_query', 'code_mapping', 'grafana']) expect(isAllowed(dat, c)).toBe(true);
  });
  it('TestTeammateUsesApiKey', () => {
    const dat = resolvePerson(cfg, 'teams:owner-1');
    const minh = resolvePerson(cfg, 'teams:minh-1');
    if (dat === undefined || minh === undefined) throw new Error('fixture people missing');
    expect(authFor(cfg, minh)).toBe('api_key');
    expect(authFor(cfg, dat)).toBe('subscription');
  });
  it('TestSubscriptionConfigDirOnlyWhenNotDefault', () => {
    const at = (dir: string) => ({ ...cfg, auth: { ...cfg.auth, claude_config_dir: dir } });
    expect(cfg.auth.claude_config_dir).toBe('~/.claude');
    expect(authSettings(cfg, 'subscription')).toEqual({ auth: 'subscription' });
    expect(authSettings(at('~/.claude/'), 'subscription')).toEqual({ auth: 'subscription' });
    expect(authSettings(at(expandHome('~/.claude')), 'subscription')).toEqual({ auth: 'subscription' });
    expect(authSettings(at('~/.claude-hack'), 'subscription')).toEqual({ auth: 'subscription', configDir: expandHome('~/.claude-hack') });
    expect(authSettings(at('/opt/claude-x/'), 'subscription')).toEqual({ auth: 'subscription', configDir: '/opt/claude-x' });
    expect(authSettings(at('~/.claude-hack'), 'api_key')).not.toHaveProperty('configDir');
  });
  it('TestConfigDirMustBeHomeOrAbsolute', () => {
    const dirOk = (dir: string): boolean => ConfigSchema.shape.auth.safeParse({ claude_config_dir: dir }).success;
    for (const dir of ['~/.claude-hack', '/opt/claude']) expect(dirOk(dir), dir).toBe(true);
    for (const dir of ['claude-hack', './x', '~x', '~/a,b', '']) expect(dirOk(dir), dir).toBe(false);
  });
});
