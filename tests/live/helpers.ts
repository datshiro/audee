// Helpers for the live fence tests: run a real session on a profile's options and collect what it did.
// Assertions never print secrets; they print `leaked: yes/no` or `denied: yes/no`.
import { query, type Options, type SDKMessage, type SDKResultMessage, type Settings } from '@anthropic-ai/claude-agent-sdk';
import { expandHome } from '../../src/config/load.js';
import { loadKeychainEnv } from '../../src/keychain.js';
import { apiKeyHelperCommand, sessionEnv } from '../../src/runner/env.js';

export const LIVE_MODEL = process.env['AUDEE_LIVE_MODEL'] ?? 'claude-opus-5-5';
export const KB_DIR = expandHome('~/.claude/kb');

export type ToolUse = { id: string; name: string; input: unknown };
export type ToolResult = { toolUseId: string; content: string; isError: boolean };
export type Init = { claude_code_version: string; apiKeySource: string; tools: string[]; mcp_servers: Array<{ name: string; status: string }>; model: string };
export type Collected = {
  texts: string[];
  toolUses: ToolUse[];
  toolResults: ToolResult[];
  denials: string[]; // tool names from the result's permission_denials
  deniedIds: Set<string>;
  result: SDKResultMessage | undefined;
  init: Init | undefined;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (isRecord(b) && typeof b['text'] === 'string' ? b['text'] : '')).join('\n');
  return '';
}

export async function collect(q: AsyncIterable<SDKMessage>): Promise<Collected> {
  const c: Collected = { texts: [], toolUses: [], toolResults: [], denials: [], deniedIds: new Set(), result: undefined, init: undefined };
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') c.init = m as unknown as Init;
    if (m.type === 'assistant') {
      for (const block of m.message.content) {
        if (block.type === 'text') c.texts.push(block.text);
        if (block.type === 'tool_use') c.toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    }
    if (m.type === 'user') {
      const content = (m as unknown as { message: { content: unknown } }).message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
            c.toolResults.push({ toolUseId: block['tool_use_id'], content: blockText(block['content']), isError: block['is_error'] === true });
          }
        }
      }
    }
    if (m.type === 'result') {
      c.result = m;
      for (const d of m.permission_denials) {
        c.denials.push(d.tool_name);
        c.deniedIds.add(d.tool_use_id);
      }
    }
  }
  return c;
}

// True when every tool use matching the predicate was denied, errored, or never got a result; true when none exists.
export function wasRefused(c: Collected, predicate: (t: ToolUse) => boolean): boolean {
  return c.toolUses.filter(predicate).every((t) => {
    if (c.deniedIds.has(t.id)) return true;
    const results = c.toolResults.filter((r) => r.toolUseId === t.id);
    return results.length === 0 || results.every((r) => r.isError);
  });
}

// Whether a planted value reached anything the session wrote or saw.
export function leaked(c: Collected, needle: string): boolean {
  if (needle === '') return false;
  const haystacks = [...c.texts, ...c.toolResults.map((r) => r.content), ...c.toolUses.map((t) => JSON.stringify(t.input)), resultText(c)];
  return haystacks.some((h) => h.includes(needle));
}

export function resultText(c: Collected): string {
  const r = c.result;
  if (r === undefined) return '';
  return r.subtype === 'success' ? r.result : r.errors.join('\n');
}

export function structuredOf(c: Collected): Record<string, unknown> | undefined {
  const r = c.result;
  if (r === undefined || r.subtype !== 'success') return undefined;
  const s = (r as unknown as { structured_output?: unknown }).structured_output;
  return isRecord(s) ? s : undefined;
}

export const bashCommand = (t: ToolUse): string => (isRecord(t.input) && typeof t.input['command'] === 'string' ? t.input['command'] : '');
export const readPath = (t: ToolUse): string => (isRecord(t.input) && typeof t.input['file_path'] === 'string' ? t.input['file_path'] : '');

export type LiveAuth = { auth: 'subscription' } | { auth: 'api_key'; apiKeyItem: string };

// Runs one session the way the runner would: the profile's options, the daemon's environment (sessionEnv:
// USER kept, CLAUDE_CONFIG_DIR dropped), the API key through apiKeyHelper only, and a hard timeout.
export async function runLive(options: Options, prompt: string, auth: LiveAuth = { auth: 'subscription' }, opts: { timeoutMs?: number; tmpdir?: string } = {}): Promise<Collected> {
  let settings: Settings = typeof options.settings === 'string' ? (JSON.parse(options.settings) as Settings) : { ...(options.settings ?? {}) };
  if (auth.auth === 'api_key') settings = { ...settings, apiKeyHelper: apiKeyHelperCommand(auth.apiKeyItem) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 600_000);
  try {
    const env = sessionEnv(opts.tmpdir !== undefined ? { tmpdir: opts.tmpdir } : {});
    return await collect(query({ prompt, options: { ...options, ...(Object.keys(settings).length > 0 ? { settings } : {}), env, abortController: controller } }));
  } finally {
    clearTimeout(timer);
  }
}

// keychain_env values for the review profile's MCP servers; audee's config has none today (gitlab reads its
// token through its own wrapper), so this is {} unless a config with keychain_env is pointed at.
export function liveSecrets(keychainEnv: Record<string, string> = {}): Record<string, string> {
  return loadKeychainEnv(keychainEnv).values;
}

export const yesNo = (b: boolean): string => (b ? 'yes' : 'no');
