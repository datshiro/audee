import { fileURLToPath } from 'node:url';
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { loadMcpServers } from '../../src/fence/mcp-servers.js';

const USER_CONFIG = fileURLToPath(new URL('../fixtures/claude-user-config.json', import.meta.url));

describe('mcp servers', () => {
  it('TestLoadMcpServersPicksNamed', () => {
    const servers = loadMcpServers(['gitlab', 'kb'], {}, USER_CONFIG);
    expect(Object.keys(servers).sort()).toEqual(['gitlab', 'kb']);
  });
  it('TestLoadMcpServersMissing', () => {
    expect(() => loadMcpServers(['gitlab', 'nope'], {}, USER_CONFIG)).toThrow('MCP server "nope" is not defined at user scope');
  });
  it('TestLoadMcpServersInjectsSecrets', () => {
    const servers = loadMcpServers(['gitlab'], { GL_TOKEN: 'fake-123' }, USER_CONFIG);
    const gitlab = servers['gitlab'] as McpStdioServerConfig;
    expect(gitlab.env?.['GITLAB_TOKEN']).toBe('fake-123');
    const untouched = loadMcpServers(['gitlab'], {}, USER_CONFIG)['gitlab'] as McpStdioServerConfig;
    expect(untouched.env?.['GITLAB_TOKEN']).toBe('${GL_TOKEN}');
  });
});
