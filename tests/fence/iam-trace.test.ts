import { describe, expect, it } from 'vitest';
import { IAM_TRACE_SERVER, IAM_TRACE_TOOLS, READ_ONLY_MCP_TOOLS } from '../../src/fence/constants.js';
import { gateDecision, unsafeFilter, unsafeId } from '../../src/fence/gate.js';
import { buildOptions } from '../../src/fence/profiles.js';

const SEARCH_LOGS = 'mcp__iam-trace__search_logs';
const TRACE_KEY = 'mcp__iam-trace__trace_key';
const TRACE_IDENTITY = 'mcp__iam-trace__trace_identity';
const LIST_SERVICES = 'mcp__iam-trace__list_services';
const options = () => buildOptions({
  profile: 'iam_trace', cwd: '/tmp', seatbelt: false, schema: { type: 'object' }, budgetUsd: 2,
  mcpServers: { 'iam-trace': { command: 'x' }, grafana: { command: 'g' } },
  mcpTools: { 'iam-trace': ['evil'], grafana: ['query_prometheus'] },
});

async function decide(tool: string, input: unknown): Promise<string> {
  const hook = options().hooks?.PreToolUse?.[0]?.hooks[0];
  const out = await hook?.({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input } as never, undefined, { signal: new AbortController().signal });
  return JSON.stringify(out);
}

describe('iam_trace fence', () => {
  it('TestIamTraceToolList', () => {
    expect(IAM_TRACE_SERVER).toBe('iam-trace');
    expect(IAM_TRACE_TOOLS).toEqual(['mcp__iam-trace__trace_identity', 'mcp__iam-trace__trace_key', 'mcp__iam-trace__search_logs', 'mcp__iam-trace__list_services']);
    expect(Object.keys(READ_ONLY_MCP_TOOLS)).not.toContain('iam-trace');
  });

  it('TestIamTraceOptions', () => {
    const o = options();
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual(IAM_TRACE_TOOLS);
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['iam-trace']);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.extraArgs).toEqual({ restricted: null });
  });

  it('TestIamTraceNeedsServer', () => {
    expect(() => buildOptions({ profile: 'iam_trace', cwd: '/tmp', seatbelt: false, mcpServers: {} })).toThrow('profile iam_trace needs MCP server "iam-trace"');
  });

  it('TestIamTraceGateRechecks', async () => {
    for (const [tool, input] of [['Bash', { command: 'ls' }], ['Read', { file_path: '/etc/hosts' }], ['mcp__grafana__query_prometheus', {}], ['mcp__iam-trace__evil', {}], ['Agent', {}]] as const) {
      expect(await decide(tool, input), tool).toContain('"permissionDecision":"deny"');
    }
    for (const tool of IAM_TRACE_TOOLS) {
      expect(await decide(tool, { filter: '"journey workflow executed"', since: '24h' }), tool).toBe(JSON.stringify({ continue: true }));
    }
    expect(await decide('StructuredOutput', {})).toBe(JSON.stringify({ continue: true }));
  });

  it('TestIamTraceGateRefusesUnsafeFilter', async () => {
    expect(await decide(SEARCH_LOGS, { filter: '_time:[2026-10-25T00:00:00Z, 2026-10-25T03:00:00Z]' })).toContain('"permissionDecision":"deny"');
    expect(await decide(SEARCH_LOGS, {})).toContain('"permissionDecision":"deny"');
    const breakout = await decide(SEARCH_LOGS, { filter: String.raw`"a\"" ) OR ( {namespace="other-ns"} "b\""` });
    expect(breakout).toContain('"permissionDecision":"deny"');
    expect(breakout).not.toContain('other-ns');
    expect(await decide(SEARCH_LOGS, { filter: '_time:(2026-10-25T00:00:00Z, 2026-10-25T03:00:00Z) AND "x"' })).toBe(JSON.stringify({ continue: true }));
  });
});

describe('search_logs filter guard', () => {
  // Each of these, wrapped as <scope> (<filter>), would close the wrapper group early or desync the guard from the
  // LogsQL lexer; implicit AND binds tighter than OR, so the scope would stop binding.
  const BREAKOUTS = [
    // ' and ` are string delimiters too, so a " inside them must not open a string the guard tracks.
    String.raw`'"' x:range(1, 2] ) OR (* '"'`,
    String.raw`'"' {namespace="other"} '"'`,
    '`"` OR {app="pusher"} OR `"`',
    // An escaped quote inside a string.
    String.raw`"a\"" ) OR ( * "b\""`,
    String.raw`"x\"" ) or ( * "\""`,
    String.raw`'a\'' ) or ( * '\''`,
    // Unbalanced parentheses.
    'x) OR (*',
    '*) or (*',
    ') or (',
    'x) or ("kubernetes.namespace_name":"other-ns"',
    '(x',
    'x(',
    // Comments, line breaks and unmodelled bracket forms.
    'x #',
    'x # ) or (*',
    'x\n) or (*',
    'x\r) or (*',
    'error\nwarn',
    'x:range(1,2] ) or ( * y:range[1,2)',
    'x[0]',
    '{x}',
    '_time:[2026-09-01, 2026-09-02]',
    'x:range(1, 5]',
    '{app="apollo-pusher"}',
    'error | stats count()',
    String.raw`a\ b`,
    // Escapes Go's strconv (and so the LogsQL lexer) cannot decode inside "…".
    String.raw`"\q) or (* "`,
    String.raw`"\8"`,
    String.raw`"\x2"`,
    String.raw`"\u12"`,
    String.raw`"\'"`,
    String.raw`"\ud800") or (* "`,
    String.raw`"\U00110000"`,
    String.raw`"\400"`,
    // A raw line break inside any string form.
    '"a\nb") or (* "',
    '"a\n#") or (* "',
    '"a\rb"',
    '`a\nb`) or (* `',
    '`a\rb`',
    "'a\nb'",
    "'a\rb'",
    // A backslash inside '…' is not modelled; a backtick string is raw, so its backslash ends nothing.
    String.raw`'it\'s'`,
    String.raw`'a\'b'`,
    '`a\\` or (*',
    "'it''s') or (*",
    // Unterminated strings.
    '"unterminated',
    "'unterminated",
    '`unterminated',
    '"abc [x]',
    String.raw`"abc\"`,
    // Blank.
    '',
    '   ',
    '\t',
    '\u0085',
    ' \u0085 ',
  ];
  const ALLOWED = [
    '_time:(2026-10-25T01:00:00Z, 2026-10-25T04:00:00Z) AND ("journey workflow executed")',
    '"workflow executed" AND "u123"',
    '"journey workflow executed"',
    '("country gate" OR "enrichment")',
    'frequency check rejected',
    'x AND (y OR z)',
    '"a)b"',
    '"pipe | inside a string"',
    '"hash # inside a string"',
    '"[campaign] {x} a|b"',
    'msg:"role:1001:2002:3003"',
    'or *',
    'x:range(1, 5)',
    String.raw`"C:\\path\\x"`,
    String.raw`"say \"hi\""`,
    String.raw`"say \"[hi]\""`,
    String.raw`"a\"b"`,
    String.raw`"tab\there \x41 \u00e9 \U0001F600 \101 \a\b\f\n\r\v"`,
    "'single quoted'",
    "'a \" b'",
    '`backtick`',
    '`a) or (*`',
    'msg:~`\\d+`',
    String.raw`msg:~"\\d+"`,
    'service:"apollo-pusher" -"heartbeat"',
    'userId:in("1","2")',
  ];

  it('denies a filter that could leave its group', () => {
    for (const f of BREAKOUTS) expect(unsafeFilter(f), JSON.stringify(f)).toBeDefined();
  });
  it('allows ordinary filters, with any character inside a string', () => {
    for (const f of ALLOWED) expect(unsafeFilter(f), f).toBeUndefined();
  });
  it('never repeats the filter in the reason', () => {
    for (const f of ['x) OR ({namespace="other-ns"}', '"other-ns\\q"', "'other-ns", 'other-ns # x', '(other-ns']) {
      const reason = unsafeFilter(f);
      expect(reason, f).toBeDefined();
      expect(reason, f).not.toContain('other-ns');
    }
  });
  it('denies a filter that is not a string', () => {
    for (const f of [undefined, null, 1, ['_time:(a, b)'], { q: 'x' }]) expect(unsafeFilter(f), JSON.stringify(f)).toBeDefined();
  });
  it('checks only the listed tools and arguments', () => {
    const spec = { denyTools: [], argGuard: { [SEARCH_LOGS]: { filter: unsafeFilter } } };
    expect(gateDecision(spec, SEARCH_LOGS, { filter: '[x]' }).deny).toBe(true);
    expect(gateDecision(spec, SEARCH_LOGS, 'not an object').deny).toBe(true);
    expect(gateDecision(spec, SEARCH_LOGS, { filter: '"[x]"' }).deny).toBe(false);
    expect(gateDecision(spec, TRACE_KEY, { filter: '[x]' }).deny).toBe(false);
  });
});

describe('trace id guard', () => {
  const BAD_IDS = ['a b', ' ', 'x" OR *', 'x\\', 'a\nb', '[1]', '{x}', 'x#y', 'é', 'x'.repeat(129), 1, true, ['1001'], { id: '1' }];
  const GOOD_IDS = ['1001', 'u123', 'c-42', 'journey-j1-u123|2026-10-25T01:00:00.123Z', 'role:12:1001:2002:3', 'user@game', 'a_b.c', 'x'.repeat(128)];

  // The MCP treats an empty or null id as not given.
  it('allows an absent or empty id and an id of letters, digits and _ . : @ | -', () => {
    for (const v of [undefined, null, '', ...GOOD_IDS]) expect(unsafeId(v), String(v)).toBeUndefined();
  });
  it('denies anything else without repeating it', () => {
    for (const v of BAD_IDS) {
      const reason = unsafeId(v);
      expect(reason, JSON.stringify(v)).toBeDefined();
      if (typeof v === 'string' && v.trim() !== '') expect(reason, v).not.toContain(v);
    }
  });
  it('guards trace_key and trace_identity ids in the iam_trace gate', async () => {
    const deny = '"permissionDecision":"deny"';
    const allow = JSON.stringify({ continue: true });
    expect(await decide(TRACE_KEY, { key: 'journey-j1-u123|2026-10-25T01:00:00Z', since: '24h' })).toBe(allow);
    expect(await decide(TRACE_KEY, { key: 'x" OR "y' })).toContain(deny);
    expect(await decide(TRACE_KEY, { key: 'x'.repeat(129) })).toContain(deny);
    expect(await decide(TRACE_KEY, { key: 7 })).toContain(deny);
    expect(await decide(TRACE_IDENTITY, { userId: 'u123', roleId: '1001', gameId: 'g1', serverId: 's1', since: '24h' })).toBe(allow);
    expect(await decide(TRACE_IDENTITY, { userId: '', roleId: '1001', gameId: null, serverId: '' })).toBe(allow);
    expect(await decide(TRACE_KEY, { key: '' })).toBe(allow);
    for (const arg of ['userId', 'roleId', 'gameId', 'serverId']) {
      const out = await decide(TRACE_IDENTITY, { userId: 'u123', [arg]: 'zz9" OR *' });
      expect(out, arg).toContain(deny);
      expect(out, arg).toContain(arg);
      expect(out, arg).not.toContain('zz9');
    }
    expect(await decide(LIST_SERVICES, { filter: '[x]', key: '[x', since: '1h' })).toBe(allow);
    expect(await decide(TRACE_KEY, { key: 'k1', filter: '[x]' })).toBe(allow);
  });
});
