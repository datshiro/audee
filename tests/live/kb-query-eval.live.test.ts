// Live eval of kb_query over the baseline and trap questions. Costs money: runs only with KB_EVAL=1.
// KB_EVAL_OUT=<dir> (required), KB_EVAL_MODEL (default claude-haiku-5-5), KB_EVAL_IDS=Q1,T1 (optional subset),
// KB_EVAL_SYNTH_MODEL (optional: the tool-less writer of the split), KB_EVAL_MODE=tech (default product),
// KB_EVAL_QUESTIONS=<file> (optional: a questions file of the fixture's shape, to replay other questions).
// Never prints answer text: the console gets `id status cost durationMs` only.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { resolvePerson } from '../../src/authz/people.js';
import { kbQuery, kbQueryDir } from '../../src/capability/kb-query.js';
import { runAgent } from '../../src/runner/run.js';
import questions from '../fixtures/kb-query-eval/questions.json' with { type: 'json' };
import { testConfig } from '../helpers/test-config.js';
import { KB_DIR, liveSecrets } from './helpers.js';

type Obj = Record<string, unknown>;
type Summary = { questions: Obj[]; medianCostUsd: number | null; p90DurationMs: number | null };

const enabled = process.env['KB_EVAL'] === '1';
const ids = process.env['KB_EVAL_IDS']?.split(',').map((s) => s.trim()).filter((s) => s !== '');
const questionsFile = process.env['KB_EVAL_QUESTIONS'];
const pool: { id: string; question: string }[] = questionsFile !== undefined && questionsFile !== '' ? JSON.parse(readFileSync(questionsFile, 'utf8')) : questions;
const selected = pool.filter((x) => ids === undefined || ids.includes(x.id));

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const readJson = (path: string): unknown => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined);
const csv = (v: unknown): string => `"${String(v ?? '').replaceAll(/\s*\n\s*/gu, ' ').replaceAll('"', '""')}"`;

function outDir(): string {
  const out = process.env['KB_EVAL_OUT'];
  if (out === undefined || out === '') throw new Error('KB_EVAL_OUT is not set');
  return out;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function p90(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1]!;
}

// The delivered answer when there is one, else what the session returned.
function answerOf(jobDir: string, output: unknown): Obj | undefined {
  const answer = readJson(join(jobDir, 'answer.json'));
  if (isObj(answer)) return answer;
  return isObj(output) && isObj(output['structured']) ? output['structured'] : undefined;
}

function gradingRows(id: string, answer: Obj | undefined): string[] {
  if (answer === undefined) return [];
  if (Array.isArray(answer['sections'])) {
    return list(answer['sections']).flatMap((section, s) => list(isObj(section) ? section['blocks'] : []).map((block, i) => {
      const b = isObj(block) ? block : {};
      return [id, s, 'block', i, b['kind'], list(b['cites']).join('; '), b['text'], ''].map(csv).join(',');
    }));
  }
  if (answer['mode'] === 'tech') return [[id, '', 'answer', '', '', '', '', ''].map(csv).join(',')];
  const product = isObj(answer['product']) ? answer['product'] : {};
  return list(product['readings']).flatMap((reading, r) => {
    const rd = isObj(reading) ? reading : {};
    return (['journey', 'rules'] as const).flatMap((name) => list(rd[name]).map((item, i) => {
      const it = isObj(item) ? item : {};
      return [id, r, name, i, it['evidence'], it['cite'], it['text'], ''].map(csv).join(',');
    }));
  });
}

function itemCounts(answer: Obj | undefined): { src: number; kb: number; unverified: number } {
  const counts = { src: 0, kb: 0, unverified: 0 };
  const product = answer !== undefined && isObj(answer['product']) ? answer['product'] : {};
  for (const reading of list(product['readings'])) {
    const rd = isObj(reading) ? reading : {};
    for (const item of [...list(rd['journey']), ...list(rd['rules'])]) {
      const evidence = isObj(item) ? item['evidence'] : undefined;
      if (evidence === 'src' || evidence === 'kb' || evidence === 'unverified') counts[evidence]++;
    }
  }
  return counts;
}

function record(out: string, id: string, entry: Obj, rows: string[]): void {
  const summaryPath = join(out, 'summary.json');
  const prev = readJson(summaryPath);
  const others = isObj(prev) ? list(prev['questions']).filter((q) => isObj(q) && q['id'] !== id) as Obj[] : [];
  const all = [...others, entry];
  const nums = (key: string): number[] => all.map((q) => q[key]).filter((v): v is number => typeof v === 'number');
  const summary: Summary = { questions: all, medianCostUsd: median(nums('costUsd')), p90DurationMs: p90(nums('durationMs')) };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  const gradingPath = join(out, 'grading.csv');
  const header = 'id,reading,list,index,evidence,cite,text,verdict';
  const kept = existsSync(gradingPath) ? readFileSync(gradingPath, 'utf8').split('\n').slice(1).filter((l) => l !== '' && !l.startsWith(`${csv(id)},`)) : [];
  writeFileSync(gradingPath, [header, ...kept, ...rows].join('\n') + '\n');
}

describe.skipIf(!enabled)('kb_query eval (live)', () => {
  for (const q of selected) {
    it(q.id, async () => {
      const out = outDir();
      const model = process.env['KB_EVAL_MODEL'] ?? 'claude-haiku-5-5';
      const synth = process.env['KB_EVAL_SYNTH_MODEL'];
      const cfg = testConfig({ kbDir: KB_DIR, kbDefaultMode: process.env['KB_EVAL_MODE'] === 'tech' ? 'tech' : 'product', kbModel: model, ...(synth !== undefined && synth !== '' ? { kbSynthModel: synth } : {}) });
      const person = resolvePerson(cfg, 'teams:owner');
      if (person === undefined) throw new Error('no owner');
      const messageId = `eval${Date.now()}${q.id}`;
      const outcome = await kbQuery({
        cfg, person, run: runAgent, dataDir: cfg.data_dir, signal: new AbortController().signal, secrets: liveSecrets(),
        job: { kind: 'kb_query', channel: 'teams', chatId: '19:abc@thread.v2', principal: 'teams:owner', requesterName: 'owner', messageId, input: q.question, requestedAt: new Date().toISOString() },
      });
      const jobDir = kbQueryDir(cfg.data_dir, messageId);
      const dest = join(out, q.id);
      mkdirSync(dest, { recursive: true });
      for (const name of ['output.json', 'answer.json', 'page.html']) {
        if (existsSync(join(jobDir, name))) copyFileSync(join(jobDir, name), join(dest, name));
      }
      writeFileSync(join(dest, 'event.json'), JSON.stringify(outcome.event, null, 2));
      writeFileSync(join(dest, 'reply.html'), outcome.reply?.html ?? '');
      // A tech page goes out in the reply only; a product page is also in the job folder.
      if (outcome.reply?.file !== undefined && !existsSync(join(dest, 'page.html'))) writeFileSync(join(dest, 'page.html'), outcome.reply.file.content);

      const output = readJson(join(jobDir, 'output.json'));
      const answer = answerOf(jobDir, output);
      const event = outcome.event as Obj;
      const num = (key: string): number | null => (typeof event[key] === 'number' ? event[key] : null);
      record(out, q.id, {
        id: q.id, status: event['status'], reason: event['reason'] ?? null, mode: answer?.['mode'] ?? (answer?.['sections'] !== undefined ? 'tech' : null),
        costUsd: num('costUsd'), durationMs: num('durationMs'), itemsKept: num('itemsKept'), itemsRemoved: num('itemsRemoved'),
        items: itemCounts(answer),
      }, gradingRows(q.id, answer));
      console.log(`${q.id} ${String(event['status'])} ${String(event['costUsd'])} ${String(event['durationMs'])}`);
    });
  }
});
