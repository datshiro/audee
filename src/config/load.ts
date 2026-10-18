import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { READ_ONLY_MCP_TOOLS } from '../fence/constants.js';
import { ConfigSchema, type Config } from './schema.js';

export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1));
  return p;
}

const PRINCIPAL = /^(teams|telegram):.+/;
const CHAT = /^19:.+@thread\.(v2|skype)$/;
const TRIGGER = /^[a-z][a-z0-9_]{2,30}$/;

type Rule = (cfg: Config, problems: string[]) => void;

function compiles(pattern: string, where: string, problems: string[]): void {
  try {
    new RegExp(pattern);
  } catch (e) {
    problems.push(`${where}: invalid regular expression: ${(e as Error).message}`);
  }
}

const RULES: Rule[] = [
  function principals(cfg, problems) {
    const seen = new Map<string, string>();
    for (const person of cfg.people) {
      for (const id of person.ids) {
        if (!PRINCIPAL.test(id)) problems.push(`people.${person.name}: id "${id}" must start with teams: or telegram:`);
        const other = seen.get(id);
        if (other !== undefined) problems.push(`people: id "${id}" appears twice (${other} and ${person.name})`);
        else seen.set(id, person.name);
      }
    }
  },
  function grants(cfg, problems) {
    for (const person of cfg.people) {
      for (const c of person.can) if (c !== '*' && !(c in cfg.capabilities)) problems.push(`people.${person.name}: can "${c}" is not a configured capability`);
    }
  },
  function owner(cfg, problems) {
    const owners = cfg.people.filter((p) => p.owner).length;
    if (owners !== 1) problems.push(`people: exactly one owner is required (found ${owners})`);
  },
  function mcpRead(cfg, problems) {
    for (const [name, cap] of Object.entries(cfg.capabilities)) {
      if (cap.profile === 'mcp_read') {
        if (cap.mcp === undefined || cap.mcp.length === 0) problems.push(`capabilities.${name}: mcp_read needs at least one server in mcp`);
        if (cap.tools === undefined || cap.tools.length === 0) problems.push(`capabilities.${name}: mcp_read needs at least one tool in tools`);
        if (cap.trigger === undefined || !TRIGGER.test(cap.trigger) || cap.trigger === 'kb_query') problems.push(`capabilities.${name}: trigger must match ^[a-z][a-z0-9_]{2,30}$ and not be kb_query`);
      } else if (cap.mcp !== undefined || cap.tools !== undefined) {
        problems.push(`capabilities.${name}: mcp and tools are only allowed on profile mcp_read`);
      }
    }
  },
  function lanes(cfg, problems) {
    for (const [name, cap] of Object.entries(cfg.capabilities)) if (!(cap.lane in cfg.concurrency.lanes)) problems.push(`capabilities.${name}: lane "${cap.lane}" is not in concurrency.lanes`);
  },
  function chats(cfg, problems) {
    const chats = cfg.channels.teams.chats;
    if (chats.length === 0) problems.push('channels.teams.chats must list at least one chat');
    for (const c of chats) if (!CHAT.test(c)) problems.push(`channels.teams.chats: "${c}" is not a Teams chat id`);
  },
  function regexes(cfg, problems) {
    compiles(cfg.channels.teams.mr_url_pattern, 'channels.teams.mr_url_pattern', problems);
    for (const [name, cap] of Object.entries(cfg.capabilities)) cap.routes.forEach((r, i) => compiles(r.match, `capabilities.${name}.routes[${i}].match`, problems));
  },
  function mcpReadNarrowsOnly(cfg, problems) {
    for (const [name, cap] of Object.entries(cfg.capabilities)) {
      if (cap.profile !== 'mcp_read') continue;
      const servers = cap.mcp ?? [];
      for (const s of servers) if (!(s in READ_ONLY_MCP_TOOLS)) problems.push(`capabilities.${name}: mcp server "${s}" is not a read-only server audee allows (${Object.keys(READ_ONLY_MCP_TOOLS).join(', ')})`);
      for (const t of cap.tools ?? []) if (!servers.some((s) => READ_ONLY_MCP_TOOLS[s]?.includes(t))) problems.push(`capabilities.${name}: tool "${t}" is not a read-only tool of ${servers.join(', ') || 'any listed server'}`);
    }
  },
];

export function loadConfig(path: string): Config {
  return validateConfig(parse(readFileSync(expandHome(path), 'utf8')));
}

// The parsed config, or an error listing every problem: the schema first, then the cross-field rules.
export function validateConfig(raw: unknown): Config {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('\n'));
  const problems: string[] = [];
  for (const rule of RULES) rule(parsed.data, problems);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return parsed.data;
}
