import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { STRUCTURED_OUTPUT_TOOL } from './constants.js';

// serverAllow: for a server entry (mcp__name), the only tools of that server that may run.
export type GateSpec = { allowTools?: string[]; denyTools: string[]; exactBash?: string[]; serverAllow?: Record<string, string[]> };
export type GateDecision = { deny: boolean; reason?: string };

const SEGMENT_SPLIT = /&&|\|\||;|\||\n|\$\(|`|\(|\)|\{|\}/;
const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
const SHELL_WRAPPERS = ['sh -c', 'bash -c', 'zsh -c', 'eval', 'exec', 'env', 'command'];
const BASH_RULE = /^Bash\((.*)\)$/s;

function bashSegments(command: string): string[] {
  return command.split(SEGMENT_SPLIT).map((s) => {
    let seg = s.trim();
    while (LEADING_ASSIGNMENT.test(seg)) seg = seg.replace(LEADING_ASSIGNMENT, '');
    return seg;
  }).filter((s) => s.length > 0);
}

function stripBash(entry: string): string {
  const m = BASH_RULE.exec(entry);
  return m?.[1] ?? entry;
}

function startsWithWord(segment: string, word: string): boolean {
  return segment === word || segment.startsWith(word + ' ');
}

function isServerEntry(entry: string): boolean {
  return entry.startsWith('mcp__') && !entry.slice('mcp__'.length).includes('__');
}

export function gateDecision(spec: GateSpec, toolName: string, toolInput: unknown): GateDecision {
  if (toolName === STRUCTURED_OUTPUT_TOOL) return { deny: false };
  for (const entry of spec.denyTools) {
    if (entry === toolName) return { deny: true, reason: `tool ${toolName} is denied` };
    if (isServerEntry(entry) && toolName.startsWith(entry + '__')) return { deny: true, reason: `server ${entry} is denied` };
  }
  for (const [server, allowed] of Object.entries(spec.serverAllow ?? {})) {
    if (toolName.startsWith(server + '__') && !allowed.includes(toolName)) return { deny: true, reason: `tool ${toolName} is not a read tool of ${server}` };
  }
  if (toolName === 'Bash') {
    const input = toolInput as { command?: unknown } | null;
    const command = typeof input?.command === 'string' ? input.command : '';
    const rules = spec.denyTools.filter((e) => BASH_RULE.test(e)).map(stripBash);
    for (const segment of bashSegments(command)) {
      for (const rule of rules) {
        if (rule.endsWith(' *') ? startsWithWord(segment, rule.slice(0, -2)) : segment === rule) {
          return { deny: true, reason: `command "${segment}" matches Bash(${rule})` };
        }
      }
      for (const wrapper of SHELL_WRAPPERS) {
        if (startsWithWord(segment, wrapper)) return { deny: true, reason: `shell wrapper "${wrapper}" is denied` };
      }
    }
    if (spec.exactBash !== undefined && !spec.exactBash.map(stripBash).includes(command.trim())) {
      return { deny: true, reason: 'only the listed probe commands may run' };
    }
  }
  if (spec.allowTools !== undefined && !spec.allowTools.includes(toolName)) return { deny: true, reason: `tool ${toolName} is not in the allow list` };
  return { deny: false };
}

export function makeGate(spec: GateSpec): HookCallbackMatcher {
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const decision = gateDecision(spec, input.tool_name, input.tool_input);
    if (!decision.deny) return { continue: true };
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason ?? 'denied by audee fence' } };
  };
  return { hooks: [hook] };
}
