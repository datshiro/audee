// Port of ciel/main.go:169-199. Values are returned to the caller and held in memory; audee never writes
// them to process.env, a file, a log line or an error message.
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

const SECURITY = '/usr/bin/security';

function account(): string {
  return process.env['USER'] ?? userInfo().username;
}

export let keychainLookup = (item: string): string => {
  let out: string;
  try {
    out = execFileSync(SECURITY, ['find-generic-password', '-a', account(), '-s', item, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new Error(`Keychain item "${item}": not found`);
  }
  const value = out.trim();
  if (value === '') throw new Error(`Keychain item "${item}" is empty`);
  return value;
};

export function setKeychainLookup(fn: typeof keychainLookup): void {
  keychainLookup = fn;
}

// Whether the item exists, without reading its value (no -w, so no password prompt and nothing printed).
export function hasKeychainItem(item: string): boolean {
  try {
    execFileSync(SECURITY, ['find-generic-password', '-a', account(), '-s', item], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

export type KeychainEnv = { values: Record<string, string>; errors: string[] };

// Every keychain_env variable from its Keychain item. Unlike Ciel, process.env is neither read nor written:
// a value set in the shell never reaches a session, and a missing item is reported by variable name only.
export function loadKeychainEnv(vars: Record<string, string>, lookup = keychainLookup): KeychainEnv {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const [name, item] of Object.entries(vars)) {
    try {
      values[name] = lookup(item);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { values, errors };
}
