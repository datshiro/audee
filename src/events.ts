// Port of ciel/events.go: one JSON line per event in <data_dir>/events.jsonl. Ciel's fields keep Ciel's
// keys and omitempty behaviour so the shadow report can read both files with one reader; audee's additions
// are written whenever they are set. Never put request text, reply text or secrets in an event.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export type Event = {
  kind: string; // classify | review | code_mapping | kb_query | <mcp_read capability>
  status: string; // classify: classified | failed; review: started | posted | nothing | failed; ...
  reason?: string;
  msgId?: string;
  addressed?: boolean;
  intent?: string;
  mrs?: number;
  mrUrl?: string;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  // audee additions
  shadow?: boolean;
  principal?: string;
  allowed?: boolean;
  toolUses?: string[];
  denials?: string[];
  token?: boolean; // shadow: the intent came from a trigger word, not the classifier
  itemsKept?: number; // kb_query: claims that passed audee's evidence check
  itemsRemoved?: number; // kb_query: claims audee removed
};

export const eventsPath = (dataDir: string): string => join(dataDir, 'events.jsonl');

// Ciel's omitempty fields: written only when non-zero (events.go:12-29).
const CIEL_OMITEMPTY: Array<[keyof Event, string]> = [
  ['reason', 'reason'], ['msgId', 'msg_id'], ['addressed', 'addressed'], ['intent', 'intent'], ['mrs', 'mrs'],
  ['mrUrl', 'mr'], ['sessionId', 'session_id'], ['costUsd', 'cost_usd'], ['numTurns', 'num_turns'], ['durationMs', 'duration_ms'],
];
const AUDEE_FIELDS: Array<[keyof Event, string]> = [
  ['shadow', 'shadow'], ['principal', 'principal'], ['allowed', 'allowed'], ['toolUses', 'tool_uses'], ['denials', 'denials'], ['token', 'token'],
  ['itemsKept', 'items_kept'], ['itemsRemoved', 'items_removed'],
];

export function eventLine(e: Event, now = new Date()): string {
  const out: Record<string, unknown> = { ts: now.toISOString(), kind: e.kind, status: e.status };
  for (const [field, key] of CIEL_OMITEMPTY) {
    const v = e[field];
    if (v === undefined || v === '' || v === false || v === 0) continue;
    out[key] = v;
  }
  for (const [field, key] of AUDEE_FIELDS) {
    const v = e[field];
    if (v !== undefined) out[key] = v;
  }
  return JSON.stringify(out);
}

export function appendEvent(dataDir: string, e: Event, now = new Date()): void {
  appendFileSync(eventsPath(dataDir), eventLine(e, now) + '\n', { mode: 0o600 });
}
