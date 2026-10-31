// Checks every src/kb cite in saved kb_query eval answers against the real checkouts and wiki. Reads files only, no
// sessions; runs only with KB_EVAL_CITES=1. KB_EVAL_OUT=<dir> (an eval output folder). Prints counts only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCite } from '../../src/capability/kb-evidence.js';
import { kbQueryDirs } from '../../src/capability/kb-query.js';
import { KB_DIR } from './helpers.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

describe.skipIf(process.env['KB_EVAL_CITES'] !== '1')('kb_query eval cites (live files)', () => {
  it('every delivered src/kb item resolves', () => {
    const out = process.env['KB_EVAL_OUT'];
    if (out === undefined || out === '') throw new Error('KB_EVAL_OUT is not set');
    const paths = kbQueryDirs(KB_DIR);
    const bad: string[] = [];
    let items = 0;
    for (const id of readdirSync(out)) {
      const file = join(out, id, 'answer.json');
      if (!existsSync(file)) continue;
      const answer = JSON.parse(readFileSync(file, 'utf8')) as Obj;
      for (const reading of list(isObj(answer['product']) ? answer['product']['readings'] : [])) {
        for (const item of [...list(reading['journey']), ...list(reading['rules'])]) {
          items++;
          const evidence = item['evidence'];
          const ok = (evidence === 'src' || evidence === 'kb') && resolveCite(evidence, String(item['cite']), paths) !== undefined;
          if (!ok) bad.push(`${id}:${String(evidence)}:${String(item['cite'])}`);
        }
      }
    }
    console.log(`items=${items} unresolved=${bad.length}`);
    expect(bad).toEqual([]);
  });
});
