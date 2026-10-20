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
  peopleIds?: string[]; // extra people named after their Teams id, teams:<id>, can ['*']
  grants?: Record<string, string[]>; // overrides `can` for a person named by id
  kbDir?: string;
  mcpRead?: { name: string; trigger: string; mcp: string[]; tools: string[] };
  review?: { prompt?: string; postFindings?: boolean; workdir?: string; routes?: Array<{ match: string; prompt: string }>; seatbelt?: boolean; autoApprove?: boolean };
  gitlab?: Record<string, string>; // person id (owner, p1, ...) -> GitLab username
  keychainEnv?: Record<string, string>;
  onedriveDir?: string;
  mapping?: { skillDir?: string; skillSource?: string; prompt?: string };
  teams?: { chats?: string[]; aliases?: string[]; mrUrlPattern?: string; historySize?: number; quietAfter?: string; shadow?: boolean; workHours?: { days: string[]; start: string; end: string } };
  authOwner?: 'subscription' | 'api_key';
};

const q = (s: string): string => JSON.stringify(s);

// A valid config with the given concurrency shape and `people` teammates (teams:p1 ... teams:pN) plus the owner.
export function testConfig(o: TestConfigOptions = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'audee-cfg-'));
  const can = (id: string): string => `[${(o.grants?.[id] ?? ['*']).map(q).join(', ')}]`;
  const gitlab = (id: string): string => (o.gitlab?.[id] !== undefined ? `, gitlab: ${q(o.gitlab[id])}` : '');
  const people = [
    ...Array.from({ length: o.people ?? 5 }, (_, i) => `  - { name: p${i + 1}, ids: ["teams:p${i + 1}"], can: ${can(`p${i + 1}`)}${gitlab(`p${i + 1}`)}, max_inflight: ${o.maxInflight ?? 2} }`),
    ...(o.peopleIds ?? []).map((id) => `  - { name: ${q(id)}, ids: [${q('teams:' + id)}], can: ${can(id)}${gitlab(id)}, max_inflight: ${o.maxInflight ?? 2} }`),
  ].join('\n');
  const mcpRead = o.mcpRead === undefined ? '' : `  ${o.mcpRead.name}: { profile: mcp_read, lane: kb, budget_usd: 2, timeout: 10m, trigger: ${o.mcpRead.trigger}, mcp: [${o.mcpRead.mcp.join(', ')}], tools: [${o.mcpRead.tools.join(', ')}] }\n`;
  const review = [
    'profile: review', 'lane: heavy',
    o.review?.prompt !== undefined ? `prompt: ${q(o.review.prompt)}` : '',
    o.review?.postFindings !== undefined ? `post_findings: ${o.review.postFindings}` : '',
    o.review?.workdir !== undefined ? `workdir: ${q(o.review.workdir)}` : '',
    o.review?.seatbelt !== undefined ? `seatbelt: ${o.review.seatbelt}` : '',
    o.review?.autoApprove !== undefined ? `auto_approve: ${o.review.autoApprove}` : '',
    o.review?.routes !== undefined ? `routes: [${o.review.routes.map((r) => `{ match: ${q(r.match)}, prompt: ${q(r.prompt)} }`).join(', ')}]` : '',
  ].filter((s) => s !== '').join(', ');
  const mapping = [
    'profile: mapping', 'lane: heavy',
    o.mapping?.skillDir !== undefined ? `skill_dir: ${q(o.mapping.skillDir)}` : '',
    o.mapping?.skillSource !== undefined ? `skill_source: ${q(o.mapping.skillSource)}` : '',
    o.mapping?.prompt !== undefined ? `prompt: ${q(o.mapping.prompt)}` : '',
  ].filter((s) => s !== '').join(', ');
  const teams = [
    `onedrive_dir: ${q(o.onedriveDir ?? dir)}`,
    `chats: [${(o.teams?.chats ?? ['19:abc@thread.v2']).map(q).join(', ')}]`,
    o.teams?.aliases !== undefined ? `aliases: [${o.teams.aliases.map(q).join(', ')}]` : '',
    o.teams?.mrUrlPattern !== undefined ? `mr_url_pattern: ${q(o.teams.mrUrlPattern)}` : '',
    o.teams?.historySize !== undefined ? `history_size: ${o.teams.historySize}` : '',
    o.teams?.quietAfter !== undefined ? `quiet_after: ${o.teams.quietAfter}` : '',
    o.teams?.shadow !== undefined ? `shadow: ${o.teams.shadow}` : '',
    o.teams?.workHours !== undefined ? `work_hours: { days: [${o.teams.workHours.days.join(', ')}], start: ${q(o.teams.workHours.start)}, end: ${q(o.teams.workHours.end)} }` : '',
  ].filter((s) => s !== '').join(', ');
  const yaml = `data_dir: ${dir}
auth: { owner: ${o.authOwner ?? 'subscription'}, teammates: api_key, api_key_keychain_item: audee-anthropic }
concurrency:
  max_concurrent: ${o.maxConcurrent ?? 3}
  lanes:
    heavy: { concurrency: ${o.heavy ?? 1}, buffer: ${o.buffer ?? 32} }
    kb: { concurrency: ${o.kb ?? 2}, buffer: ${o.buffer ?? 32} }
people:
  - { name: dat, owner: true, ids: ["teams:owner"], can: ["*"]${gitlab('owner')}, max_inflight: ${o.maxInflight ?? 2} }
${people}
channels:
  teams: { ${teams} }
capabilities:
  review: { ${review} }
  code_mapping: { ${mapping} }
  kb_query: { profile: kb_read, lane: kb${o.kbPerPersonLimit !== undefined ? `, per_person_limit: ${o.kbPerPersonLimit}` : ''}${o.kbDir !== undefined ? `, kb_dir: ${o.kbDir}` : ''} }
${mcpRead}keychain_env: ${JSON.stringify(o.keychainEnv ?? {})}
`;
  const path = join(dir, 'config.yaml');
  writeFileSync(path, yaml);
  return loadConfig(path);
}
