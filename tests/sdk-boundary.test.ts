import { describe, expect, it } from 'vitest';
import { captureSession, flagValues, hasFlag } from './helpers/capture-argv.js';

describe('sdk boundary', () => {
  it('TestSDKMapsFenceOptionsToFlags', async () => {
    const { argv, rawArgv, init } = await captureSession({
      extraArgs: { restricted: null },
      persistSession: false,
      strictMcpConfig: true,
      mcpServers: { kb: { command: 'kb' } },
      maxBudgetUsd: 3,
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['Read'],
      disallowedTools: ['Bash(git push *)'],
      model: 'MODEL',
      effort: 'low',
      settingSources: [],
      settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'APPENDED-MARKER' },
    });
    expect(rawArgv).toContain('--max-budget-usd=3');
    for (const f of ['--restricted', '--no-session-persistence', '--strict-mcp-config', '--json-schema']) expect(hasFlag(argv, f), f).toBe(true);
    expect(flagValues(argv, '--max-budget-usd')[0]).toBe('3');
    expect(flagValues(argv, '--permission-mode')[0]).toBe('dontAsk');
    expect(flagValues(argv, '--permission-prompts')[0]).toBe('none');
    expect(flagValues(argv, '--model')[0]).toBe('MODEL');
    expect(flagValues(argv, '--effort')[0]).toBe('low');
    expect(flagValues(argv, '--disallowedTools')).toContain('Bash(git push *)');
    expect(flagValues(argv, '--allowedTools')).toEqual(['Read']);
    expect(flagValues(argv, '--tools')).toEqual(['Read', 'Glob', 'Grep']);
    const settings = JSON.parse(flagValues(argv, '--settings')[0] ?? 'null') as { permissions: { blockReadsOutsideWorkingDirectories: boolean } };
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    const mcp = JSON.parse(flagValues(argv, '--mcp-config')[0] ?? 'null') as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers)).toEqual(['kb']);
    expect(JSON.stringify(init)).toContain('APPENDED-MARKER');
  }, 20_000);

  it('TestStrictMcpWithNoServers', async () => {
    const { argv } = await captureSession({ strictMcpConfig: true, mcpServers: {} });
    expect(hasFlag(argv, '--strict-mcp-config')).toBe(true);
    expect(hasFlag(argv, '--mcp-config')).toBe(false);
  }, 20_000);
});
