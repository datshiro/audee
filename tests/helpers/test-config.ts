import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/schema.js';

export type TestConfigOptions = {
  maxConcurrent?: number;
  heavy?: number;
  kb?: number;
  buffer?: number;
  kbPerPersonLimit?: number;
  maxInflight?: number;
  people?: number;
  kbDir?: string;
  mcpRead?: { name: string; trigger: string; mcp: string[]; tools: string[] };
};

// A valid config with the given concurrency shape and `people` teammates (teams:p1 ... teams:pN) plus the owner.
export function testConfig(o: TestConfigOptions = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'audee-cfg-'));
  const people = Array.from({ length: o.people ?? 5 }, (_, i) => `  - { name: p${i + 1}, ids: ["teams:p${i + 1}"], can: ["*"], max_inflight: ${o.maxInflight ?? 2} }`).join('\n');
  const mcpRead = o.mcpRead === undefined ? '' : `  ${o.mcpRead.name}: { profile: mcp_read, lane: kb, budget_usd: 2, timeout: 10m, trigger: ${o.mcpRead.trigger}, mcp: [${o.mcpRead.mcp.join(', ')}], tools: [${o.mcpRead.tools.join(', ')}] }\n`;
  const yaml = `data_dir: ${dir}
concurrency:
  max_concurrent: ${o.maxConcurrent ?? 3}
  lanes:
    heavy: { concurrency: ${o.heavy ?? 1}, buffer: ${o.buffer ?? 32} }
    kb: { concurrency: ${o.kb ?? 2}, buffer: ${o.buffer ?? 32} }
people:
  - { name: dat, owner: true, ids: ["teams:owner"], can: ["*"], max_inflight: ${o.maxInflight ?? 2} }
${people}
channels:
  teams:
    onedrive_dir: ${dir}
    chats: ["19:abc@thread.v2"]
capabilities:
  review: { profile: review, lane: heavy }
  code_mapping: { profile: mapping, lane: heavy }
  kb_query: { profile: kb_read, lane: kb${o.kbPerPersonLimit !== undefined ? `, per_person_limit: ${o.kbPerPersonLimit}` : ''}${o.kbDir !== undefined ? `, kb_dir: ${o.kbDir}` : ''} }
${mcpRead}`;
  const path = join(dir, 'config.yaml');
  writeFileSync(path, yaml);
  return loadConfig(path);
}
