import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLASSIFY_SYSTEM } from '../../src/fence/constants.js';
import { loadMcpServers } from '../../src/fence/mcp-servers.js';
import { buildOptions, type ProfileInput } from '../../src/fence/profiles.js';
import { captureSession, flagValues, hasFlag } from '../helpers/capture-argv.js';

const fixture = (name: string): string[] => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/ciel-2.1.300/${name}.argv.json`, import.meta.url)), 'utf8')) as string[];
const USER_CONFIG = fileURLToPath(new URL('../fixtures/claude-user-config.json', import.meta.url));
const SCHEMA = { type: 'object' };
const NOT_COMPARED = new Set(['--output-format', '--', '--append-system-prompt']);
const EXACT_LISTS = ['--allowedTools', '--tools', '--add-dir'];
const FIRST_VALUE = ['--permission-mode', '--max-budget-usd', '--model', '--effort'];
const WIDENING = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--plugin-dir'];

const servers = loadMcpServers(['gitlab', 'kb'], {}, USER_CONFIG);
const base = { cwd: process.cwd(), mcpServers: servers, seatbelt: false };
const INPUTS: Record<string, ProfileInput> = {
  review: { ...base, profile: 'review', model: 'MODEL', budgetUsd: 8 },
  mapping: { ...base, schema: SCHEMA, profile: 'mapping', model: 'MODEL', budgetUsd: 5, skillDir: '/SKILL' },
  kbquery: { ...base, schema: SCHEMA, profile: 'kb_read', model: 'MODEL', budgetUsd: 3, kbPaths: { wiki: '/WIKI', querySkill: '/QUERY_SKILL', scoutSkill: '/SCOUT_SKILL', repos: ['/REPO'] } },
  classifier: { ...base, schema: SCHEMA, profile: 'classifier', model: 'claude-opus-5-5', effort: 'low' },
};

const capture = (name: string) => {
  const input = INPUTS[name];
  if (input === undefined) throw new Error(name);
  return captureSession(buildOptions(input));
};

function mcpKeys(argv: string[]): string[] {
  const raw = flagValues(argv, '--mcp-config')[0];
  if (raw === undefined) return [];
  return Object.keys((JSON.parse(raw) as { mcpServers: Record<string, unknown> }).mcpServers).sort();
}

function expectSuperset(ciel: string[], sdk: string[]): void {
  for (const token of ciel) if (token.startsWith('--') && !NOT_COMPARED.has(token)) expect(hasFlag(sdk, token), token).toBe(true);
  const sdkDenied = flagValues(sdk, '--disallowedTools');
  for (const denied of flagValues(ciel, '--disallowedTools')) expect(sdkDenied, denied).toContain(denied);
  for (const flag of EXACT_LISTS) {
    const cielValues = flagValues(ciel, flag);
    if (cielValues.length === 0) expect(hasFlag(sdk, flag), flag).toBe(false);
    else expect(new Set(flagValues(sdk, flag)), flag).toEqual(new Set(cielValues));
  }
  for (const flag of FIRST_VALUE) {
    const cielValue = flagValues(ciel, flag)[0];
    if (cielValue !== undefined) expect(flagValues(sdk, flag)[0], flag).toBe(cielValue);
  }
  const cielSettings = flagValues(ciel, '--settings')[0];
  if (cielSettings !== undefined) expect(JSON.parse(flagValues(sdk, '--settings')[0] ?? '{}')).toMatchObject(JSON.parse(cielSettings) as object);
  for (const flag of WIDENING) expect(hasFlag(sdk, flag), flag).toBe(false);
  expect(flagValues(sdk, '--permission-mode')[0]).not.toBe('bypassPermissions');
}

describe('fence superset of Ciel', () => {
  it('TestReviewSupersetOfCiel', async () => {
    const { argv } = await capture('review');
    expectSuperset(fixture('review'), argv);
    expect(mcpKeys(argv)).toEqual(['gitlab', 'kb']);
    expect(hasFlag(argv, '--json-schema')).toBe(false);
  });
  it('TestMappingSupersetOfCiel', async () => {
    const { argv } = await capture('mapping');
    expectSuperset(fixture('mapping'), argv);
    expect(hasFlag(argv, '--mcp-config')).toBe(false);
  });
  it('TestKBQuerySupersetOfCiel', async () => {
    const { argv } = await capture('kbquery');
    expectSuperset(fixture('kbquery'), argv);
    expect(mcpKeys(argv)).toEqual(['kb']);
  });
  it('TestClassifierSupersetOfCiel', async () => {
    const { argv, init } = await capture('classifier');
    expectSuperset(fixture('classifier'), argv);
    expect(hasFlag(argv, '--mcp-config')).toBe(false);
    expect(JSON.stringify(init)).toContain(JSON.stringify(CLASSIFY_SYSTEM.slice(0, 40)).slice(1, -1));
  });
  it('TestReviewAddsBudgetNoPersistenceNoPrompts', async () => {
    const { argv } = await capture('review');
    expect(hasFlag(argv, '--no-session-persistence')).toBe(true);
    expect(flagValues(argv, '--max-budget-usd')[0]).toBe('8');
    expect(flagValues(argv, '--permission-prompts')[0]).toBe('none');
    expect(flagValues(argv, '--disallowedTools')).toContain('Read(~/.claude.json)');
  });
  it('TestMcpReadArgs', async () => {
    const tools = ['search_dashboards', 'get_dashboard_by_uid', 'query_prometheus', 'query_loki_logs'];
    const { argv } = await captureSession(buildOptions({ ...base, schema: SCHEMA, profile: 'mcp_read', mcpServers: { grafana: { command: 'grafana' } }, mcpTools: { grafana: tools }, budgetUsd: 2 }));
    expect(hasFlag(argv, '--restricted')).toBe(true);
    expect(hasFlag(argv, '--strict-mcp-config')).toBe(true);
    expect(flagValues(argv, '--permission-mode')[0]).toBe('dontAsk');
    expect(flagValues(argv, '--allowedTools')).toEqual(tools.map((t) => `mcp__grafana__${t}`));
    expect(flagValues(argv, '--disallowedTools')).toContain('mcp__grafana__update_dashboard');
    expect(mcpKeys(argv)).toEqual(['grafana']);
  });
  it('TestEveryProfileUsesClaudeCodePreset', async () => {
    for (const name of Object.keys(INPUTS)) {
      const { init } = await capture(name);
      const request = (init as { request?: { systemPrompt?: unknown; appendSystemPrompt?: string } }).request;
      expect(request, name).toBeDefined();
      expect(request?.systemPrompt, name).toBeUndefined();
      if (name === 'classifier') expect(request?.appendSystemPrompt).toContain(CLASSIFY_SYSTEM.slice(0, 40));
      else expect(request?.appendSystemPrompt, name).toBeUndefined();
    }
  }, 30_000);
});
