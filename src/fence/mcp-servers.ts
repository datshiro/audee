import { readFileSync } from 'node:fs';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { expandHome } from '../config/load.js';

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function substitute(value: string, secrets: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => secrets[name] ?? whole);
}

function injectSecrets(def: Record<string, unknown>, secrets: Record<string, string>): Record<string, unknown> {
  const out = { ...def };
  if (isPlainObject(out['env'])) {
    out['env'] = Object.fromEntries(Object.entries(out['env']).map(([k, v]) => [k, typeof v === 'string' ? substitute(v, secrets) : v]));
  }
  if (Array.isArray(out['args'])) out['args'] = out['args'].map((a: unknown) => (typeof a === 'string' ? substitute(a, secrets) : a));
  if (isPlainObject(out['headers'])) {
    out['headers'] = Object.fromEntries(Object.entries(out['headers']).map(([k, v]) => [k, typeof v === 'string' ? substitute(v, secrets) : v]));
  }
  return out;
}

export type OwnMcpServers = Record<string, Record<string, unknown> | undefined>;

// Picks the named servers from audee's own mcp_servers, else the user's Claude Code config, and fills ${VAR} in
// their env, args and headers from secrets. Never log the file, a server definition or secrets: they hold tokens.
export function loadMcpServers(names: string[], secrets: Record<string, string>, userConfigPath = expandHome('~/.claude.json'), own: OwnMcpServers = {}): Record<string, McpServerConfig> {
  let user: unknown;
  try {
    user = JSON.parse(readFileSync(userConfigPath, 'utf8'));
  } catch (e) {
    const why = e instanceof SyntaxError ? 'is not valid JSON' : (e as Error).message;
    throw new Error(`read MCP servers from ${userConfigPath}: ${why}`);
  }
  const defined = isPlainObject(user) && isPlainObject(user['mcpServers']) ? user['mcpServers'] : {};
  const servers: Record<string, McpServerConfig> = {};
  for (const name of names) {
    const def = own[name] ?? defined[name];
    if (!isPlainObject(def)) throw new Error(`MCP server "${name}" is not defined at user scope`);
    servers[name] = injectSecrets(def, secrets) as McpServerConfig;
  }
  return servers;
}
