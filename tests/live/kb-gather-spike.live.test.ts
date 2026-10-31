// Spike: how often the gather session's quotes are found, word for word, at the place it cites. Costs money: runs
// only with KB_SPIKE=1. KB_SPIKE_OUT=<dir> (required). Prints counts only, never quotes.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { checkQuote, resolveCite } from '../../src/capability/kb-evidence.js';
import { GATHER_SCHEMA, parseGather } from '../../src/capability/kb-gather.js';
import { gatherPrompt, kbQueryDirs } from '../../src/capability/kb-query.js';
import { loadMcpServers } from '../../src/fence/mcp-servers.js';
import { buildOptions } from '../../src/fence/profiles.js';
import questions from '../fixtures/kb-query-eval/questions.json' with { type: 'json' };
import { KB_DIR, liveSecrets, runLive, structuredOf } from './helpers.js';

const IDS = ['Q1', 'Q4', 'Q8'];

function outDir(): string {
  const out = process.env['KB_SPIKE_OUT'];
  if (out === undefined || out === '') throw new Error('KB_SPIKE_OUT is not set');
  mkdirSync(out, { recursive: true });
  return out;
}

// rate.txt from every <id>.json written so far.
function writeRate(out: string): void {
  const lines: string[] = [];
  let entries = 0;
  let verified = 0;
  for (const id of IDS) {
    const path = join(out, `${id}.json`);
    if (!existsSync(path)) continue;
    const r = JSON.parse(readFileSync(path, 'utf8')) as { checks: Array<{ resolved: boolean; quoteOk: boolean }> };
    const v = r.checks.filter((c) => c.resolved && c.quoteOk).length;
    lines.push(`${id} entries=${r.checks.length} verified=${v}`);
    entries += r.checks.length;
    verified += v;
  }
  lines.push(`rate=${entries === 0 ? 0 : (verified / entries).toFixed(3)} entries=${entries} verified=${verified}`);
  writeFileSync(join(out, 'rate.txt'), lines.join('\n') + '\n');
}

describe.skipIf(process.env['KB_SPIKE'] !== '1')('kb_query gather spike (live)', () => {
  for (const id of IDS) {
    it(id, async () => {
      const out = outDir();
      const q = questions.find((x) => x.id === id);
      if (q === undefined) throw new Error(`no question ${id}`);
      const paths = kbQueryDirs(KB_DIR);
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'audee-spike-')));
      writeFileSync(join(dir, 'question.txt'), q.question);
      const interservice = existsSync(join(KB_DIR, 'INTERSERVICE.md'));
      if (interservice) copyFileSync(join(KB_DIR, 'INTERSERVICE.md'), join(dir, 'INTERSERVICE.md'));
      const options = buildOptions({ profile: 'kb_read', cwd: dir, mcpServers: loadMcpServers(['kb'], liveSecrets()), kbPaths: paths, schema: GATHER_SCHEMA, model: 'claude-haiku-5-5', seatbelt: false });
      const c = await runLive(options, gatherPrompt(KB_DIR, paths, interservice));
      const g = parseGather({ isError: c.result?.is_error ?? true, text: '', structured: structuredOf(c), costUsd: c.result?.total_cost_usd, denials: [], toolUses: [], durationMs: 0 });
      const checks = g.ledger.map((e) => {
        const r = resolveCite(e.kind, e.cite, paths);
        return { id: e.id, kind: e.kind, resolved: r !== undefined, quoteOk: r !== undefined && checkQuote(r, e.quote) };
      });
      writeFileSync(join(out, `${id}.json`), JSON.stringify({ ledger: g.ledger, checks }, null, 2), { mode: 0o600 });
      writeRate(out);
      console.log(`${id} entries=${checks.length} resolved=${checks.filter((x) => x.resolved).length} verified=${checks.filter((x) => x.quoteOk).length} cost=${String(c.result?.total_cost_usd)}`);
    });
  }
});
