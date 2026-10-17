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
  review?: { prompt?: string; postFindings?: boolean; workdir?: string; routes?: Array<{ match: string; prompt: string }> };
  mapping?: { skillDir?: string; skillSource?: string; prompt?: string };
};

// A valid config with the given concurrency shape and `people` teammates (teams:p1 ... teams:pN) plus the owner.
export function testConfig(o: TestConfigOptions = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'audee-cfg-'));
  const people = Array.from({ length: o.people ?? 5 }, (_, i) => `  - { name: p${i + 1}, ids: ["teams:p${i + 1}"], can: ["*"], max_inflight: ${o.maxInflight ?? 2} }`).join('\n');
  const mcpRead = o.mcpRead === undefined ? '' : `  ${o.mcpRead.name}: { profile: mcp_read, lane: kb, budget_usd: 2, timeout: 10m, trigger: ${o.mcpRead.trigger}, mcp: [${o.mcpRead.mcp.join(', ')}], tools: [${o.mcpRead.tools.join(', ')}] }\n`;
  const q = (s: string): string => JSON.stringify(s);
  const review = [
    'profile: review', 'lane: heavy',
    o.review?.prompt !== undefined ? `prompt: ${q(o.review.prompt)}` : '',
    o.review?.postFindings !== undefined ? `post_findings: ${o.review.postFindings}` : '',
    o.review?.workdir !== undefined ? `workdir: ${q(o.review.workdir)}` : '',
    o.review?.routes !== undefined ? `routes: [${o.review.routes.map((r) => `{ match: ${q(r.match)}, prompt: ${q(r.prompt)} }`).join(', ')}]` : '',
  ].filter((s) => s !== '').join(', ');
  const mapping = [
    'profile: mapping', 'lane: heavy',
    o.mapping?.skillDir !== undefined ? `skill_dir: ${q(o.mapping.skillDir)}` : '',
    o.mapping?.skillSource !== undefined ? `skill_source: ${q(o.mapping.skillSource)}` : '',
    o.mapping?.prompt !== undefined ? `prompt: ${q(o.mapping.prompt)}` : '',
  ].filter((s) => s !== '').join(', ');
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
  review: { ${review} }
  code_mapping: { ${mapping} }
  kb_query: { profile: kb_read, lane: kb${o.kbPerPersonLimit !== undefined ? `, per_person_limit: ${o.kbPerPersonLimit}` : ''}${o.kbDir !== undefined ? `, kb_dir: ${o.kbDir}` : ''} }
${mcpRead}`;
  const path = join(dir, 'config.yaml');
  writeFileSync(path, yaml);
  return loadConfig(path);
}
