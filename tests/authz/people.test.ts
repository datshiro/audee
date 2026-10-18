import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { authFor, isAllowed, resolvePerson } from '../../src/authz/people.js';
import { loadConfig } from '../../src/config/load.js';

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
});
