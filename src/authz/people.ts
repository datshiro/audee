import type { Config } from '../config/schema.js';

export type Person = { name: string; owner: boolean; ids: string[]; can: string[]; max_inflight: number };

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
