import { describe, expect, it } from 'vitest';
import { loadKeychainEnv } from '../src/keychain.js';

const fakeLookup = (item: string): string => {
  if (item === 'missing') throw new Error(`Keychain item "${item}": not found`);
  return 'secret-for-' + item;
};

describe('keychain', () => {
  // ciel/ciel_test.go TestLoadKeychainEnv, with the one change: values are returned, process.env is not consulted
  it('TestLoadKeychainEnv', () => {
    process.env['AUDEE_TEST_PRESET'] = 'from-shell';
    try {
      const got = loadKeychainEnv({ AUDEE_TEST_UNSET: 'svc-a', AUDEE_TEST_PRESET: 'svc-b', AUDEE_TEST_MISSING: 'missing' }, fakeLookup);
      expect(got.values).toEqual({ AUDEE_TEST_UNSET: 'secret-for-svc-a', AUDEE_TEST_PRESET: 'secret-for-svc-b' });
      expect(got.errors).toHaveLength(1);
      expect(got.errors[0]).toContain('AUDEE_TEST_MISSING');
      expect(got.errors[0]).not.toContain('secret-for');
    } finally {
      delete process.env['AUDEE_TEST_PRESET'];
    }
  });

  it('TestLoadKeychainEnvDoesNotTouchProcessEnv', () => {
    const before = JSON.stringify(process.env);
    const got = loadKeychainEnv({ AUDEE_TEST_TOKEN: 'svc-token' }, fakeLookup);
    expect(got.values['AUDEE_TEST_TOKEN']).toBe('secret-for-svc-token');
    expect(process.env['AUDEE_TEST_TOKEN']).toBeUndefined();
    expect(JSON.stringify(process.env)).toBe(before);
  });
});
