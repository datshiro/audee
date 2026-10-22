// Product-mode kb_query: the session returns kb-answer-v1 (KB_ANSWER_SCHEMA), kb-mcp render-answer turns it into
// the HTML page, and audee checks both sides itself before anything reaches the chat.
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { answerPageVisibleTexts, checkAnswerPage, failedText, kbAnswerFileName, kbQueryFileReply, kbQueryWithheldReply, kbTopicLine } from '../render/html.js';
import { leaksSecret } from '../render/secrets.js';
import type { RunResult } from '../runner/run.js';
import type { KbPaths } from '../fence/profiles.js';
import { KB_ANSWER_SCHEMA } from './kb-answer-schema.js';
import { keepOutput, sessionEvent } from './session.js';
import type { CapabilityContext, CapabilityOutcome } from './types.js';

const execFileAsync = promisify(execFile);

export type AnswerMode = 'tech' | 'product';

// --tech, and the engineer-only --full and --code-flow, with any dash a chat client may turn "--" into.
const TECH_FLAGS = /(?<=^|\s)(?:--|[-—–])(?:tech|full|code-flow)(?=$|\s|[.,;:!?])/giu;
const TECH_FLAG = /(?<=^|\s)(?:--|[-—–])tech(?=$|\s|[.,;:!?])/giu;

// The mode is decided here, not by the model. Only the --tech token is taken out of the question the session reads,
// which otherwise stays verbatim; --full and --code-flow stay for the skill, which shapes engineer answers with them.
export function answerMode(input: string, defaultMode: AnswerMode | undefined): { mode: AnswerMode; question: string } {
  const mode = new RegExp(TECH_FLAGS.source, TECH_FLAGS.flags).test(input) ? 'tech' : (defaultMode ?? 'tech');
  const flagged = new RegExp(TECH_FLAG.source, TECH_FLAG.flags).test(input);
  return { mode, question: flagged ? input.replace(TECH_FLAG, '').trim() : input };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// The structured result against the pinned schema: types, enums, required and no extra fields.
function matches(v: unknown, s: Obj): boolean {
  switch (s['type']) {
    case 'object': {
      if (!isObj(v)) return false;
      const props = (s['properties'] ?? {}) as Record<string, Obj>;
      if (((s['required'] ?? []) as string[]).some((k) => !(k in v))) return false;
      return Object.entries(v).every(([k, x]) => props[k] !== undefined && matches(x, props[k]));
    }
    case 'array':
      return Array.isArray(v) && v.every((x) => matches(x, s['items'] as Obj));
    case 'string':
      return typeof v === 'string' && (!Array.isArray(s['enum']) || (s['enum'] as string[]).includes(v));
    case 'boolean':
      return typeof v === 'boolean';
    default:
      return false;
  }
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v, v.replaceAll('**', ''));
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (isObj(v)) for (const x of Object.values(v)) strings(x, out);
  return out;
}

const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// Every string, plus the pairs a page shows apart: a setting beside its default, an actor beside its step, an edge
// beside the node it leaves. A "password" setting and its value in two cells is still a pair.
export function answerTexts(product: Obj): string[] {
  const out = strings(product);
  for (const r of list(product['readings'])) {
    for (const c of list(r['config'])) out.push(`${str(c['setting'])}: ${str(c['default'])}`, `${str(c['setting'])} = ${str(c['default'])}`);
    for (const j of list(r['journey'])) out.push(`${str(j['actor'])}: ${str(j['text'])}`);
    for (const d of list(r['diagrams'])) {
      const labels = new Map(list(d['nodes']).map((n) => [str(n['id']), str(n['label'])]));
      for (const e of list(d['edges'])) out.push(`${labels.get(str(e['from'])) ?? ''}: ${str(e['label'])}`, `${str(e['label'])}: ${labels.get(str(e['to'])) ?? ''}`);
    }
  }
  return out;
}

const REASON_SOURCE = /^(product|specs|roadmap|explanatory)\/[^\s]+\.md$/u;

// A recorded reason must cite a doc that exists inside the wiki under one of the reason folders; otherwise the page
// says the reason is not recorded. The renderer checks the same; this holds whatever the binary does.
export function checkReasonSources(product: Obj, wiki: string): void {
  let root: string;
  try {
    root = realpathSync(wiki);
  } catch {
    root = '';
  }
  for (const r of list(product['readings'])) {
    const p = r['purpose'];
    if (!isObj(p) || p['recorded'] !== true) continue;
    const source = str(p['source']).trim().replace(/^kb-mcp\/wiki\//u, '');
    let ok = root !== '' && REASON_SOURCE.test(source) && !source.includes('..');
    if (ok) {
      try {
        const real = realpathSync(join(root, source));
        ok = real.startsWith(root + sep) && statSync(real).isFile();
      } catch {
        ok = false;
      }
    }
    r['purpose'] = ok ? { ...p, source } : { recorded: false, text: '', source: '' };
  }
}

// Only what the renderer needs: no HOME, no SSH agent, no tokens.
function renderEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'LANG', 'TMPDIR']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

export let renderAnswerPage = async (kbDir: string, dir: string, wiki: string, signal: AbortSignal): Promise<string> => {
  await execFileAsync(join(kbDir, 'kb-mcp', 'kb-mcp'), ['render-answer', '--in', 'answer.json', '--question', 'question.txt', '--out', 'page.html', '--wiki', wiki], { cwd: dir, env: renderEnv(), timeout: 60_000, signal });
  return readFileSync(join(dir, 'page.html'), 'utf8');
};

export function setRenderAnswerPage(fn: typeof renderAnswerPage): void {
  renderAnswerPage = fn;
}

export let printAnswerSchema = async (kbDir: string): Promise<unknown> => {
  const { stdout } = await execFileAsync(join(kbDir, 'kb-mcp', 'kb-mcp'), ['render-answer', '--print-schema'], { cwd: kbDir, env: renderEnv(), timeout: 30_000 });
  return JSON.parse(stdout) as unknown;
};

export function setPrintAnswerSchema(fn: typeof printAnswerSchema): void {
  printAnswerSchema = fn;
}

export const answerSchemaMatches = (printed: unknown): boolean => JSON.stringify(printed) === JSON.stringify(KB_ANSWER_SCHEMA);

// The outcome of a product-mode session. Event and owner reasons are fixed strings: answer text never reaches them.
export async function productOutcome(ctx: CapabilityContext, dir: string, result: RunResult, started: number, kbDir: string, paths: KbPaths): Promise<CapabilityOutcome> {
  const kind = 'kb_query';
  const base = sessionEvent(result, Date.now() - started);
  const failed = (reason: string, keep = true): CapabilityOutcome => {
    if (keep) keepOutput(dir, result, reason);
    return { reply: { html: failedText(kind) }, notifyOwner: `kb_query failed: ${reason}: ${dir}`, event: { ...base, kind, status: 'failed', reason } };
  };
  const withheld = (): CapabilityOutcome => ({ reply: { html: kbQueryWithheldReply }, notifyOwner: `kb_query answer withheld: it looks like it holds a credential: ${dir}`, event: { ...base, kind, status: 'withheld', reason: 'answer looks like it holds a credential' } });
  if (result.isError) return failed('kb_query reported an error');
  const s = result.structured;
  if (!isObj(s) || !matches(s, KB_ANSWER_SCHEMA)) return failed('answer does not match the contract');
  if (s['status'] === 'failed') return failed('kb_query session could not finish (see its notes in output.json)');
  if (s['mode'] !== 'product') return failed('answer mode mismatch');
  const product = s['product'] as Obj;
  if (list(product['readings']).length === 0) return failed('product answer has no readings');
  keepOutput(dir, result);
  const question = readFileSync(join(dir, 'question.txt'), 'utf8');
  const known = Object.values(ctx.secrets);
  const meta = [str(s['topic']), str(s['answer']), question, ...(s['sources'] as string[]), ...(s['notes'] as string[]), ...(s['missing'] as string[])];
  if (leaksSecret([...answerTexts(product), ...meta], known)) return withheld();
  checkReasonSources(product, paths.wiki);
  writeFileSync(join(dir, 'answer.json'), JSON.stringify(s), { mode: 0o600 });
  let page: string;
  try {
    page = await renderAnswerPage(kbDir, dir, paths.wiki, ctx.signal);
  } catch (e) {
    if (ctx.signal.aborted) throw e; // cancelled or shutting down: the watcher requeues or reports it
    const err = e as { stderr?: unknown; code?: unknown; path?: unknown };
    writeFileSync(join(dir, 'render-error.txt'), [(e as Error).message, String(err.stderr ?? '')].join('\n'), { mode: 0o600 });
    const missing = err.code === 'ENOENT' && err.path !== join(dir, 'page.html');
    return failed(missing ? 'renderer missing' : 'renderer failed', false);
  }
  const unsafe = checkAnswerPage(page);
  if (unsafe !== undefined) return failed(`rendered page failed the safety check (${unsafe})`, false); // a fixed word
  if (leaksSecret(answerPageVisibleTexts(page), known)) return withheld();
  const file = { name: kbAnswerFileName(ctx.job.messageId ?? ''), content: page };
  return { reply: { html: kbQueryFileReply + kbTopicLine(str(s['topic']), ctx.job.input ?? ''), file }, event: { ...base, kind, status: 'done' }, removeAfterReply: dir };
}
