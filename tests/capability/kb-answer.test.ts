import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePerson } from '../../src/authz/people.js';
import { answerMode, answerSchemaMatches, renderAnswerPage, setRenderAnswerPage } from '../../src/capability/kb-answer.js';
import { KB_ANSWER_SCHEMA } from '../../src/capability/kb-answer-schema.js';
import { kbQuery, kbQueryDir, kbQueryDirs, kbQuerySchema, setKbRefSync } from '../../src/capability/kb-query.js';
import type { CapabilityContext } from '../../src/capability/types.js';
import type { Job } from '../../src/queue/job.js';
import { eventLine, type Event } from '../../src/events.js';
import { checkAnswerPage, kbQueryEmptyReply, kbQueryFileReply, kbQueryNotKnownReply, kbQueryWithheldReply } from '../../src/render/html.js';
import type { RunInput, RunResult } from '../../src/runner/run.js';
import { testConfig } from '../helpers/test-config.js';

const USER_CONFIG = fileURLToPath(new URL('../fixtures/claude-user-config.json', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures/kb-answer/', import.meta.url));
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const GOLDEN = fixture('product-vi.html');

type Obj = Record<string, unknown>;
const productAnswer = (): Obj => JSON.parse(fixture('product-vi.json')) as Obj;
const reading = (a: Obj): Obj => ((a['product'] as Obj)['readings'] as Obj[])[0] as Obj;

// A KB with the checkouts and the wiki doc product-vi.json cites.
function testKB(): string {
  const kb = join(mkdtempSync(join(tmpdir(), 'audee-kb-')), 'kb');
  for (const d of ['kb-mcp/wiki/explanatory/flows', '.claude/skills/kb-scout', '../agents/kb-query', '.kb-ref-worktrees/pusher', '.kb-ref-worktrees/journey-node/internal']) mkdirSync(join(kb, d), { recursive: true, mode: 0o700 });
  symlinkSync('../../../agents/kb-query', join(kb, '.claude/skills/kb-query'));
  writeFileSync(join(kb, 'kb-mcp/wiki/explanatory/flows/iam-frequency-check.md'), '# IAM frequency check\n');
  writeFileSync(join(kb, '.kb-ref-worktrees/journey-node/internal/check.go'), Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(kb, 'kb.yaml'), 'wiki_dir: ./kb-mcp/wiki\nrepos:\n  - path: ../pusher\n    name: pusher\n  - path: ../journey-node\n    name: journey-node\nref_policy:\n  worktree_root: .kb-ref-worktrees\n');
  return kb;
}

const result = (structured: unknown): RunResult => ({ isError: false, text: '', structured, costUsd: 0.1, turns: 3, sessionId: 's1', denials: [], toolUses: ['Read'], durationMs: 10 });

function harness(structured: unknown, input = 'giới hạn tần suất popup hoạt động thế nào?', mode: 'tech' | 'product' | 'none' = 'product', secrets: Record<string, string> = {}) {
  const kb = testKB();
  const cfg = testConfig({ kbDir: kb, ...(mode !== 'none' ? { kbDefaultMode: mode } : {}) });
  const person = resolvePerson(cfg, 'teams:owner');
  if (person === undefined) throw new Error('no person');
  const inputs: RunInput[] = [];
  const run = async (i: RunInput): Promise<RunResult> => {
    inputs.push(i);
    return result(structured);
  };
  const job: Job = { kind: 'kb_query', channel: 'teams', chatId: 'chat', principal: 'teams:owner', requesterName: 'linh', messageId: '1791513774214', input, requestedAt: new Date().toISOString() };
  const ctx: CapabilityContext = { cfg, job, person, run, dataDir: cfg.data_dir, signal: new AbortController().signal, secrets, userConfigPath: USER_CONFIG };
  return { ctx, inputs, kb, dir: kbQueryDir(cfg.data_dir, '1791513774214') };
}

describe('kb_query product answers', () => {
  let rendered: Obj[] = [];
  let page = GOLDEN;
  beforeEach(() => {
    rendered = [];
    page = GOLDEN;
    setKbRefSync(async () => {});
    setRenderAnswerPage(async (_kb, dir) => {
      rendered.push(JSON.parse(readFileSync(join(dir, 'answer.json'), 'utf8')) as Obj);
      return page;
    });
  });
  afterEach(() => setRenderAnswerPage(renderAnswerPage));

  it('decides the mode from flags, not from the model', () => {
    expect(answerMode('how does it work?', 'product')).toEqual({ mode: 'product', question: 'how does it work?' });
    expect(answerMode('how does it work? --tech', 'product')).toEqual({ mode: 'tech', question: 'how does it work?' });
    expect(answerMode('—tech how does it work', 'product').mode).toBe('tech');
    expect(answerMode('how --full', 'product')).toEqual({ mode: 'tech', question: 'how --full' });
    expect(answerMode('trace --code-flow.', 'product').mode).toBe('tech');
    expect(answerMode('the high-tech flow', 'product').mode).toBe('product');
    expect(answerMode('how does it work?', undefined).mode).toBe('tech');
    const pasted = 'cfg:\n  a:\n    b: 1\nwhy?';
    expect(answerMode(pasted, 'tech').question).toBe(pasted);
    expect(answerMode(pasted, 'product').question).toBe(pasted);
  });

  it('sends a product answer as the rendered page', async () => {
    const h = harness(productAnswer());
    const out = await kbQuery(h.ctx);
    expect(out.event.status).toBe('done');
    expect(out.reply?.html.startsWith(kbQueryFileReply)).toBe(true);
    expect(out.reply?.file?.content).toBe(GOLDEN);
    expect(out.removeAfterReply).toBe(h.dir);
    expect(h.inputs[0]?.options.outputFormat).toEqual({ type: 'json_schema', schema: KB_ANSWER_SCHEMA });
    expect(h.inputs[0]?.prompt).toContain(`This answer's mode is product`);
    expect(reading(rendered[0] as Obj)['purpose']).toMatchObject({ recorded: true, source: 'explanatory/flows/iam-frequency-check.md' });
  });

  it('keeps today\'s schema and prompt in tech mode', async () => {
    for (const [input, mode] of [['how? --tech', 'product'], ['how?', 'tech'], ['how?', 'none']] as const) {
      const h = harness({ status: 'done', answer: 'x', sources: [], notes: [], missing: [] }, input, mode);
      const out = await kbQuery(h.ctx);
      expect(out.event.status, String(out.event.reason)).toBe('done');
      expect(h.inputs[0]?.options.outputFormat).toEqual({ type: 'json_schema', schema: kbQuerySchema });
      expect(h.inputs[0]?.prompt).not.toContain('mode is product');
      expect(rendered).toHaveLength(0);
    }
    const h = harness({ status: 'done', answer: 'x', sources: [], notes: [], missing: [] }, 'how? --tech', 'product');
    await kbQuery(h.ctx);
    expect(readFileSync(join(h.dir, 'question.txt'), 'utf8')).toBe('how?');
  });

  it('answers a bare --tech with the empty-question reply, without a session', async () => {
    const h = harness(productAnswer(), '--tech');
    const out = await kbQuery(h.ctx);
    expect(out.reply?.html).toBe(kbQueryEmptyReply);
    expect(h.inputs).toHaveLength(0);
  });

  it('rethrows when cancelled while rendering', async () => {
    const h = harness(productAnswer());
    const abort = new AbortController();
    setRenderAnswerPage(async () => {
      abort.abort();
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    await expect(kbQuery({ ...h.ctx, signal: abort.signal })).rejects.toThrow('aborted');
  });

  it('refuses an answer in the wrong mode or shape', async () => {
    const tech = { ...productAnswer(), mode: 'tech' };
    const extra = { ...productAnswer(), html: '<b>x</b>' };
    for (const [s, reason] of [[tech, 'answer came back in tech mode'], [extra, 'answer does not match the contract']] as const) {
      const out = await kbQuery(harness(s).ctx);
      expect(out.event.status).toBe('failed');
      expect(out.event.reason).toBe(reason);
    }
    expect(rendered).toHaveLength(0);
  });

  it('answers not_known when the model found nothing, keeping its output', async () => {
    const empty = productAnswer();
    (empty['product'] as Obj)['readings'] = [];
    const h = harness(empty);
    const out = await kbQuery(h.ctx);
    expect(out.event).toMatchObject({ status: 'not_known', reason: 'model found no evidence', itemsKept: 0, itemsRemoved: 0 });
    expect(out.reply?.html.startsWith(kbQueryNotKnownReply)).toBe(true);
    expect(out.reply?.file).toBeUndefined();
    expect(out.removeAfterReply).toBeUndefined();
    expect(existsSync(join(h.dir, 'output.json'))).toBe(true);
    expect(eventLine(out.event as Event)).toContain('"items_kept":0');
    expect(rendered).toHaveLength(0);
  });

  it('withholds an empty answer whose topic holds a secret', async () => {
    const empty: Obj = { ...productAnswer(), topic: 'token sk-live-0123456789abcdef' };
    (empty['product'] as Obj)['readings'] = [];
    const out = await kbQuery(harness(empty, undefined, 'product', { KEY: 'sk-live-0123456789abcdef' }).ctx);
    expect(out.event.status).toBe('withheld');
  });

  it('answers not_known when no claim survives the evidence check, without claim text in the event', async () => {
    const a = productAnswer();
    const texts: string[] = [];
    for (const r of (a['product'] as Obj)['readings'] as Obj[]) {
      for (const k of ['journey', 'rules']) {
        for (const item of r[k] as Obj[]) {
          item['evidence'] = 'src';
          item['cite'] = 'journey-node/internal/nope.go:1';
          texts.push(item['text'] as string);
        }
      }
    }
    const out = await kbQuery(harness(a).ctx);
    expect(out.event).toMatchObject({ status: 'not_known', reason: 'no claim survived the evidence check', itemsKept: 0, itemsRemoved: texts.length });
    expect(out.reply?.html.startsWith(kbQueryNotKnownReply)).toBe(true);
    const json = JSON.stringify(out.event);
    for (const x of texts) expect(json).not.toContain(x);
    expect(rendered).toHaveLength(0);
  });

  it('says how many claims it removed and when a Confluence copy was synced', async () => {
    const a = productAnswer();
    const r = reading(a);
    r['rules'] = [...(r['rules'] as Obj[]), { kind: 'default', text: 'synced rule', evidence: 'kb', cite: 'explanatory/flows/churn.md' }, { kind: 'default', text: 'bad cite', evidence: 'src', cite: 'pusher/none.go:1' }];
    const h = harness(a);
    writeFileSync(join(h.kb, 'kb-mcp/wiki/explanatory/flows/churn.md'), '---\nsource: confluence\nlast_synced: 2026-05-20T07:34:23Z\n---\n# Churn\n');
    const out = await kbQuery(h.ctx);
    expect(out.event).toMatchObject({ status: 'done', itemsKept: 5, itemsRemoved: 2 }); // the unverified step and the bad cite
    expect(out.reply?.html).toContain('Đã bỏ 2 ý');
    expect(out.reply?.html).toContain('bản sao Confluence đồng bộ ngày 2026-05-20');
    expect(reading(rendered[0] as Obj)['diagrams']).toEqual([]);
  });

  it('withholds a secret the page would show apart', async () => {
    const pair = productAnswer();
    const cfg = reading(pair)['config'] as Obj[];
    cfg[0] = { setting: 'DB password', where: 'engineering', default: 'Hunter2Prod99x' };
    const label = productAnswer();
    ((reading(label)['diagrams'] as Obj[])[0]?.['nodes'] as Obj[])[1] = { id: 'a', label: 'ghp_abcdefghijklmnopqrstu' };
    const bold = productAnswer();
    reading(bold)['summary'] = 'key glpat-**abcdefghijklmnopqrstuvwx**';
    for (const s of [pair, label, bold]) {
      const out = await kbQuery(harness(s).ctx);
      expect(out.event.status).toBe('withheld');
      expect(out.reply?.html).toBe(kbQueryWithheldReply);
    }
    expect(rendered).toHaveLength(0);
  });

  it('withholds a known secret the renderer encoded as entities', async () => {
    const secret = 'zz9Plural+Zalpha';
    page = GOLDEN.replace('</main>', `<p>${[...secret].map((c) => `&#${c.codePointAt(0)};`).join('')}</p></main>`);
    const out = await kbQuery(harness(productAnswer(), undefined, 'product', { TOKEN: secret }).ctx);
    expect(out.event.status).toBe('withheld');
  });

  it('shows a reason only when its wiki doc exists', async () => {
    for (const source of ['services/pusher.md', 'explanatory/missing.md', 'explanatory/../../kb.yaml']) {
      const a = productAnswer();
      (reading(a)['purpose'] as Obj)['source'] = source;
      await kbQuery(harness(a).ctx);
      expect(reading(rendered.at(-1) as Obj)['purpose']).toEqual({ recorded: false, text: '', source: '' });
    }
  });

  it('fails without answer text in the event when rendering or the page check fails', async () => {
    const planted = 'PLANTEDVALUE';
    setRenderAnswerPage(async () => {
      throw Object.assign(new Error(`render-answer: ${planted}`), { stderr: planted, code: 1 });
    });
    let out = await kbQuery(harness(productAnswer()).ctx);
    expect(out.event).toMatchObject({ status: 'failed', reason: 'renderer failed' });
    expect(JSON.stringify(out.event) + (out.notifyOwner ?? '')).not.toContain(planted);
    setRenderAnswerPage(async () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    });
    out = await kbQuery(harness(productAnswer()).ctx);
    expect(out.event.reason).toBe('renderer missing');
    for (const bad of ['<script>x</script>', '<a href="x">y</a>']) {
      setRenderAnswerPage(async () => GOLDEN.replace('</main>', `${bad}</main>`));
      out = await kbQuery(harness(productAnswer()).ctx);
      expect(out.event.status).toBe('failed');
      expect(out.event.reason).toMatch(/^rendered page failed the safety check/);
    }
  });

  it('pins the same contract as the KB copy in this test tree', () => {
    expect(answerSchemaMatches(KB_ANSWER_SCHEMA)).toBe(true);
    expect(answerSchemaMatches({ ...KB_ANSWER_SCHEMA, $id: 'kb-answer-v2' })).toBe(false);
    const status = (KB_ANSWER_SCHEMA['properties'] as Record<string, { enum?: string[] }>)['status'];
    expect(status?.enum).toEqual(['done', 'failed']);
  });

  // Needs a KB whose tracked kb-mcp has render-answer, e.g. AUDEE_KB_DIR=~/.claude/kb-wt/kb-answer-renderer.
  const realKb = process.env['AUDEE_KB_DIR'];
  it.skipIf(realKb === undefined || !existsSync(join(realKb ?? '', 'kb-mcp', 'kb-mcp')))('the real renderer output passes the page check', async () => {
    const kb = realKb as string;
    const dir = mkdtempSync(join(tmpdir(), 'audee-render-'));
    writeFileSync(join(dir, 'answer.json'), fixture('product-vi.json'));
    writeFileSync(join(dir, 'question.txt'), '<script>alert(1)</script> src=x onerror=y url(z)');
    const html = await renderAnswerPage(kb, dir, kbQueryDirs(kb).wiki, new AbortController().signal);
    expect(checkAnswerPage(html)).toBeUndefined();
  });
});
