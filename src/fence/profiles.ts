import type { McpServerConfig, Options, Settings } from '@anthropic-ai/claude-agent-sdk';
import type { ProfileName } from '../config/schema.js';
import {
  CLASSIFY_DENIED_TOOLS, CLASSIFY_SYSTEM, GDS_CONTRACT_TOOL, IAM_TRACE_FILTERED_TOOL, IAM_TRACE_SERVER, IAM_TRACE_TOOLS, KB_QUERY_DENIED, KB_QUERY_REPO_DENIED, KB_QUERY_TOOLS,
  KB_QUERY_WIKI_DENIED, MCP_WRITE_DENIED, REVIEW_DENIED_TOOLS, REVIEW_EXTRA_DENIED, REVIEW_JIRA_ALIAS, REVIEW_JIRA_READ_TOOLS, REVIEW_JIRA_WRITE_TOOLS, REVIEW_MCP_SERVERS, probeCommands,
} from './constants.js';
import { makeGate, unsafeFilter, unsafeId, type GateSpec } from './gate.js';

export type KbPaths = { wiki: string; querySkill: string; scoutSkill: string; repos: string[] };

export type ProfileInput = {
  profile: ProfileName;
  model?: string;
  effort?: Options['effort'];
  budgetUsd?: number;
  cwd: string;
  schema?: Record<string, unknown>;
  mcpServers: Record<string, McpServerConfig>;
  skillDir?: string;
  kbPaths?: KbPaths;
  mcpTools?: Record<string, string[]>;
  seatbelt: boolean;
  apiKeyHelper?: string;
  configDir?: string; // absolute; only when not ~/.claude, whose ~/.claude.json REVIEW_EXTRA_DENIED covers
};

function required<T>(value: T | undefined, name: string, profile: ProfileName): T {
  if (value === undefined) throw new Error(`profile ${profile} needs ${name}`);
  return value;
}

// The profile decides which servers a session loads; the caller's map only supplies their definitions.
function pickServers(profile: ProfileName, available: Record<string, McpServerConfig>, names: string[]): Record<string, McpServerConfig> {
  const picked: Record<string, McpServerConfig> = {};
  for (const name of names) {
    const def = available[name];
    if (def === undefined) throw new Error(`profile ${profile} needs MCP server "${name}"`);
    picked[name] = def;
  }
  return picked;
}

const MAPPING_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
const KB_READ_TOOLS = ['Read', 'Glob', 'Grep', 'Agent'];

export function buildOptions(input: ProfileInput): Options {
  const options: Options = {
    cwd: input.cwd,
    persistSession: false,
    permissionPrompts: 'none',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  };
  if (input.budgetUsd !== undefined) options.maxBudgetUsd = input.budgetUsd;
  if (input.model !== undefined) options.model = input.model;
  if (input.effort !== undefined) options.effort = input.effort;
  if (input.schema !== undefined) options.outputFormat = { type: 'json_schema', schema: input.schema };

  const settings: Settings = {};
  // Sandboxed Bash must not skip the permission rules or fall back to running unsandboxed.
  if (input.seatbelt) settings.sandbox = { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false };
  if (input.apiKeyHelper !== undefined) settings.apiKeyHelper = input.apiKeyHelper;
  const gate = (spec: GateSpec): Options['hooks'] => ({ PreToolUse: [makeGate(spec)] });

  switch (input.profile) {
    case 'review': {
      const jira = input.mcpServers[REVIEW_JIRA_ALIAS] !== undefined;
      // `//` roots the rule at /, as in the //** rules
      const userConfig = input.configDir !== undefined ? [`Read(/${input.configDir}/.claude.json)`] : [];
      const denied = [...REVIEW_DENIED_TOOLS, ...REVIEW_EXTRA_DENIED, ...(jira ? REVIEW_JIRA_WRITE_TOOLS : []), ...userConfig];
      Object.assign(options, {
        permissionMode: 'auto',
        settingSources: ['user', 'project', 'local'],
        strictMcpConfig: true,
        mcpServers: pickServers('review', input.mcpServers, [...REVIEW_MCP_SERVERS, ...(jira ? [REVIEW_JIRA_ALIAS] : [])]),
        disallowedTools: denied,
        hooks: gate({ denyTools: denied, serverAllow: { [`mcp__${REVIEW_JIRA_ALIAS}`]: REVIEW_JIRA_READ_TOOLS } }),
      } satisfies Options);
      break;
    }
    case 'mapping': {
      const skill = required(input.skillDir, 'skillDir', 'mapping');
      const probes = probeCommands(skill);
      const denied = ['Edit(/' + skill + '/**)', 'Skill(kb-query)'];
      settings.permissions = { blockReadsOutsideWorkingDirectories: true };
      Object.assign(options, {
        tools: MAPPING_TOOLS,
        extraArgs: { restricted: null },
        permissionMode: 'dontAsk',
        settingSources: [],
        additionalDirectories: [skill],
        allowedTools: ['Edit(./**)', GDS_CONTRACT_TOOL, ...probes],
        disallowedTools: denied,
        hooks: gate({ allowTools: [...MAPPING_TOOLS, GDS_CONTRACT_TOOL], exactBash: probes, denyTools: denied }),
      } satisfies Options);
      break;
    }
    case 'kb_read': {
      const kb = required(input.kbPaths, 'kbPaths', 'kb_read');
      const denied = [
        ...KB_QUERY_DENIED,
        ...KB_QUERY_WIKI_DENIED.map((p) => 'Read(/' + kb.wiki + '/' + p + ')'),
        ...kb.repos.flatMap((r) => KB_QUERY_REPO_DENIED.map((p) => 'Read(/' + r + '/' + p + ')')),
      ];
      Object.assign(options, {
        tools: KB_READ_TOOLS,
        extraArgs: { restricted: null },
        permissionMode: 'dontAsk',
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: pickServers('kb_read', input.mcpServers, ['kb']),
        additionalDirectories: [kb.wiki, kb.querySkill, kb.scoutSkill, ...kb.repos],
        allowedTools: [...KB_QUERY_TOOLS],
        disallowedTools: denied,
        hooks: gate({ allowTools: [...KB_READ_TOOLS, ...KB_QUERY_TOOLS], denyTools: denied }),
      } satisfies Options);
      break;
    }
    case 'classifier': {
      Object.assign(options, {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: CLASSIFY_SYSTEM },
        disallowedTools: [...CLASSIFY_DENIED_TOOLS],
        strictMcpConfig: true,
        mcpServers: {},
        hooks: gate({ denyTools: [...CLASSIFY_DENIED_TOOLS] }),
      } satisfies Options);
      break;
    }
    case 'mcp_read': {
      const tools = required(input.mcpTools, 'mcpTools', 'mcp_read');
      const servers = Object.keys(tools);
      const allowed = servers.flatMap((s) => (tools[s] ?? []).map((t) => `mcp__${s}__${t}`));
      const denied = servers.flatMap((s) => (MCP_WRITE_DENIED[s] ?? []).map((t) => `mcp__${s}__${t}`));
      Object.assign(options, {
        tools: [],
        extraArgs: { restricted: null },
        permissionMode: 'dontAsk',
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: pickServers('mcp_read', input.mcpServers, servers),
        allowedTools: allowed,
        disallowedTools: denied,
        hooks: gate({ allowTools: allowed, denyTools: denied }),
      } satisfies Options);
      break;
    }
    case 'iam_trace': {
      Object.assign(options, {
        tools: [],
        extraArgs: { restricted: null },
        permissionMode: 'dontAsk',
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: pickServers('iam_trace', input.mcpServers, [IAM_TRACE_SERVER]),
        allowedTools: [...IAM_TRACE_TOOLS],
        hooks: gate({
          allowTools: [...IAM_TRACE_TOOLS],
          denyTools: [],
          argGuard: {
            [IAM_TRACE_FILTERED_TOOL]: { filter: unsafeFilter },
            [`mcp__${IAM_TRACE_SERVER}__trace_key`]: { key: unsafeId },
            [`mcp__${IAM_TRACE_SERVER}__campaign_journey`]: { campaignId: unsafeId },
            [`mcp__${IAM_TRACE_SERVER}__trace_identity`]: { userId: unsafeId, roleId: unsafeId, gameId: unsafeId, serverId: unsafeId },
          },
        }),
      } satisfies Options);
      break;
    }
  }
  if (Object.keys(settings).length > 0) options.settings = settings;
  return options;
}
