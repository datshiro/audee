import { resolve } from 'node:path';
import { expandHome } from '../config/load.js';
import type { Config } from '../config/schema.js';

export type Person = { name: string; owner: boolean; ids: string[]; can: string[]; gitlab?: string; max_inflight: number };

export function resolvePerson(cfg: Config, principal: string): Person | undefined {
  return cfg.people.find((p) => p.ids.includes(principal));
}

export function isAllowed(person: Person | undefined, capability: string): boolean {
  if (person === undefined) return false;
  return person.can.includes('*') || person.can.includes(capability);
}

export function authFor(cfg: Config, person: Person): 'subscription' | 'api_key' {
  return person.owner ? cfg.auth.owner : cfg.auth.teammates;
}

export type AuthSettings = { auth: 'subscription' | 'api_key'; apiKeyItem?: string; baseUrl?: string; configDir?: string };

// Undefined for ~/.claude: CLAUDE_CONFIG_DIR stays unset there, as Claude Code finds its login and ~/.claude.json
// differently once the variable is set, even to the default.
export function claudeConfigDir(cfg: Config): string | undefined {
  const dir = resolve(expandHome(cfg.auth.claude_config_dir));
  return dir === resolve(expandHome('~/.claude')) ? undefined : dir;
}

// API-key sessions get the Keychain item and, when configured, the company gateway; subscription sessions use the login.
export function authSettings(cfg: Config, auth: 'subscription' | 'api_key'): AuthSettings {
  if (auth === 'subscription') {
    const configDir = claudeConfigDir(cfg);
    return configDir === undefined ? { auth } : { auth, configDir };
  }
  return { auth, apiKeyItem: cfg.auth.api_key_keychain_item, ...(cfg.auth.base_url !== undefined ? { baseUrl: cfg.auth.base_url } : {}) };
}
