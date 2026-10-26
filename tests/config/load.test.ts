import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { testConfig } from '../helpers/test-config.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/config/${name}`, import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../../config.example.yaml', import.meta.url));

function rejection(name: string): string {
  try {
    loadConfig(fixture(name));
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`${name} loaded but should have been rejected`);
}

describe('config', () => {
  it('TestConfigLoadsExample', () => {
    const cfg = loadConfig(EXAMPLE);
    expect(cfg.people.some((p) => p.owner)).toBe(true);
    expect(cfg.concurrency.max_concurrent).toBe(3);
    expect(cfg.concurrency.lanes['kb']?.concurrency).toBe(2);
  });
  it('TestConfigRejectsBadPrincipalPrefix', () => expect(rejection('bad-prefix.yaml')).toContain('entra:x'));
  it('TestConfigRejectsDuplicateIds', () => expect(rejection('duplicate-ids.yaml')).toContain('appears twice'));
  it('TestConfigRejectsUnknownCapabilityGrant', () => expect(rejection('unknown-grant.yaml')).toContain('not a configured capability'));
  it('rejects default_mode outside kb_read', () => expect(rejection('default-mode-wrong-profile.yaml')).toContain('default_mode is only allowed on profile kb_read'));
  it('TestConfigAllowsSubscriptionForTeammates', () => expect(loadConfig(fixture('teammates-subscription.yaml')).auth.teammates).toBe('subscription'));
  it('TestConfigRejectsMcpOnFixedProfile', () => expect(rejection('mcp-on-fixed.yaml')).toContain('only allowed on profile mcp_read'));
  it('TestConfigRejectsBadRegex', () => expect(rejection('bad-regex.yaml')).toContain('mr_url_pattern'));
  it('TestConfigRejectsEmptyChats', () => expect(rejection('empty-chats.yaml')).toContain('chats'));
  it('TestConfigReportsAllProblems', () => {
    const message = rejection('three-problems.yaml');
    expect(message).toContain('entra:x');
    expect(message).toContain('appears twice');
    expect(message).toContain('not a configured capability');
    expect(message.split('\n')).toHaveLength(3);
  });
  it('TestConfigRejectsWriteToolInMcpRead', () => expect(rejection('mcp-read-write-tool.yaml')).toContain('update_dashboard'));
  it('TestConfigRejectsUnknownMcpServer', () => expect(rejection('mcp-read-unknown-server.yaml')).toContain('argocd'));
  it('TestConfigAcceptsIamTrace', () => expect(testConfig({ iamTrace: {} }).capabilities['iam_trace']).toMatchObject({ profile: 'iam_trace', lane: 'iam_trace', timeout: 1_200_000, budget_usd: 4, per_person_limit: 1 }));
  it('TestConfigGivesRenamedIamTraceTheDefaults', () => {
    expect(loadConfig(fixture('iam-trace-renamed.yaml')).capabilities['traces']).toMatchObject({ profile: 'iam_trace', timeout: 1_200_000, budget_usd: 4, per_person_limit: 1 });
    expect(loadConfig(fixture('iam-trace-renamed-tuned.yaml')).capabilities['traces']).toMatchObject({ profile: 'iam_trace', timeout: 300_000, budget_usd: 1.5, per_person_limit: 2 });
  });
  it('TestConfigRejectsToolsOnIamTrace', () => expect(rejection('iam-trace-tools.yaml')).toContain('only allowed on profile mcp_read'));
  it('TestConfigRejectsSecondIamTrace', () => expect(rejection('iam-trace-twice.yaml')).toContain('at most one capability may use profile iam_trace'));
  it('TestConfigRejectsIamTraceServerInMcpRead', () => expect(rejection('mcp-read-iam-trace.yaml')).toContain('mcp server "iam-trace" is not a read-only server audee allows'));
  it('TestConfigRejectsIamTraceAsMcpReadTrigger', () => expect(rejection('mcp-read-trigger-iam-trace.yaml')).toContain('not be kb_query or iam_trace'));

  it('TestConfigGatewayMustBeHttps', () => {
    const example = readFileSync(EXAMPLE, 'utf8');
    const write = (url: string): string => {
      const path = join(mkdtempSync(join(tmpdir(), 'audee-cfg-')), 'config.yaml');
      writeFileSync(path, example.replace('  api_key_keychain_item: audee-anthropic', `  api_key_keychain_item: audee-anthropic\n  base_url: ${url}`));
      return path;
    };
    expect(loadConfig(write('https://gateway.example')).auth.base_url).toBe('https://gateway.example');
    expect(() => loadConfig(write('http://gateway.example'))).toThrow('auth.base_url: must be an https URL');
  });
});
