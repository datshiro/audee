import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { STRUCTURED_OUTPUT_TOOL } from './constants.js';

// serverAllow: for a server entry (mcp__name), the only tools of that server that may run.
// argGuard: tool name -> argument name -> check returning why the value is refused, or undefined to let it through.
export type ArgCheck = (value: unknown) => string | undefined;
export type GateSpec = { allowTools?: string[]; denyTools: string[]; exactBash?: string[]; serverAllow?: Record<string, string[]>; argGuard?: Record<string, Record<string, ArgCheck>> };
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

// The MCP composes `<scope> (<filter>)`, and implicit AND binds tighter than OR, so a filter that closes the wrapper
// early (`x) OR (*`) makes the scope optional. If every string terminates where LogsQL's lexer ends it and the
// parentheses never dip below zero and end balanced, the filter is one group, whatever operators it holds. Forms the
// lexer reads differently from this model (brackets, stream filters, pipes, comments, stray backslashes, line
// breaks) are refused rather than modelled. A port of the hardened validator in apollo-debug-mcp
// (internal/trace/filter.go); the configured binary may predate it, so this gate is the boundary.
export function unsafeFilter(filter: unknown): string | undefined {
  if (typeof filter !== 'string') return 'must be a string';
  if (/^[\s\u0085]*$/u.test(filter)) return 'is blank'; // trim() keeps U+0085, which Go's TrimSpace strips
  let depth = 0;
  // Index-based: every structural character is one UTF-16 code unit and no surrogate equals one.
  for (let i = 0; i < filter.length; i++) {
    switch (filter[i]) {
      case '"':
      case '`':
      case "'": {
        const end = stringEnd(filter, i);
        if (typeof end === 'string') return end;
        i = end;
        break;
      }
      case '(': depth++; break;
      case ')':
        if (--depth < 0) return 'closes a parenthesis it never opened';
        break;
      case '[': case ']': return 'holds a bracketed range outside a quoted string';
      case '{': case '}': return 'holds a stream filter outside a quoted string';
      case '|': return 'holds a pipe outside a quoted string';
      case '\\': return 'holds a backslash outside a quoted string';
      case '#': return 'holds a comment outside a quoted string';
      case '\n': case '\r': return 'spans more than one line';
    }
  }
  return depth === 0 ? undefined : 'leaves a parenthesis unclosed';
}

// The index of the quote closing the string opened at `start`, or why it is refused. A "…" string ends where Go's
// strconv.QuotedPrefix ends it (LogsQL's lexer uses it), so a malformed escape is refused: the lexer would emit the
// lone quote and read the rest as query text. A `…` string is raw. A backslash inside '…' is refused, not modelled.
function stringEnd(s: string, start: number): number | string {
  const q = s[start];
  for (let j = start + 1; j < s.length; j++) {
    const c = s[j];
    if (c === q) return j;
    if (c === '\n' || c === '\r') return 'spans more than one line inside a quoted string';
    if (c !== '\\' || q === '`') continue;
    if (q === "'") return "holds a backslash inside a '-quoted string";
    const n = escapeLen(s, j + 1);
    if (n === 0) return 'holds a malformed escape inside a "-quoted string';
    j += n;
  }
  return 'has an unterminated quoted string';
}

const SIMPLE_ESCAPES = 'abfnrtv\\"';
const HEX_ESCAPES: Record<string, number> = { x: 2, u: 4, U: 8 };

// Length of a valid escape body starting at s[i] (the character after the backslash), or 0, following
// strconv.UnquoteChar with quote '"'.
function escapeLen(s: string, i: number): number {
  const c = s[i];
  if (c === undefined) return 0;
  if (SIMPLE_ESCAPES.includes(c)) return 1;
  const hex = HEX_ESCAPES[c];
  if (hex !== undefined) {
    const digits = s.slice(i + 1, i + 1 + hex);
    if (!new RegExp(`^[0-9A-Fa-f]{${hex}}$`, 'u').test(digits)) return 0;
    const v = Number.parseInt(digits, 16);
    if (c !== 'x' && (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff))) return 0;
    return hex + 1;
  }
  const octal = s.slice(i, i + 3);
  return /^[0-7]{3}$/u.test(octal) && Number.parseInt(octal, 8) <= 255 ? 3 : 0;
}

const ID_MAX = 128;
const ID_SHAPE = /^[A-Za-z0-9_.:@|-]+$/u;

// A trace id lands inside a LogsQL phrase match, and the configured MCP escapes only \ and " there. An absent id
// (undefined, null or "", all of which the MCP treats as not given) is the MCP's to refuse; a present one is an id, a
// channel or a workflow id (journey-<id>-<user>|<UTC time>).
export function unsafeId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return 'must be a string';
  if (value.length > ID_MAX) return `must be at most ${ID_MAX} characters`;
  return ID_SHAPE.test(value) ? undefined : 'may hold only letters, digits and _ . : @ | -';
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
  const checks = spec.argGuard?.[toolName];
  if (checks !== undefined) {
    if (typeof toolInput !== 'object' || toolInput === null) return { deny: true, reason: `${toolName}: input must be an object` };
    const input = toolInput as Record<string, unknown>;
    for (const [arg, check] of Object.entries(checks)) {
      const problem = check(input[arg]);
      if (problem !== undefined) return { deny: true, reason: `${toolName}: ${arg} ${problem}` };
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
