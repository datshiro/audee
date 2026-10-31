// audee's own check of a kb_query answer: every claim's cite must resolve to a file the session itself may read,
// inside a clean checkout or the wiki, before the claim reaches a page. What does not resolve is removed.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, matchesGlob, posix, relative, sep } from 'node:path';
import { KB_QUERY_DENIED, KB_QUERY_REPO_DENIED, KB_QUERY_WIKI_DENIED } from '../fence/constants.js';
import type { KbPaths } from '../fence/profiles.js';
import { redactSecretPairs } from '../render/secrets.js';
import { MAX_TECH_BLOCKS, MAX_TECH_CODE_LINES, MAX_TECH_SECTIONS, MAX_TECH_TEXT_CHARS } from './kb-tech-schema.js';

export type ResolvedCite = { kind: 'src'; cite: string; file: string; from: number; to: number } | { kind: 'kb'; cite: string; file: string };

const MAX_SPAN = 200;
const SRC_CITE = /^([A-Za-z0-9._-]+)\/([^\s:]+):(\d+)(?:-(\d+))?$/u;

// The session's Read(//**/.env) denials as globs on a path inside a checkout or the wiki.
const READ_DENIED = KB_QUERY_DENIED.flatMap((r) => /^Read\(\/\/(.+)\)$/u.exec(r)?.[1] ?? []);
const SRC_DENIED = [...KB_QUERY_REPO_DENIED, ...READ_DENIED];
const WIKI_DENIED = [...KB_QUERY_WIKI_DENIED, ...READ_DENIED];

const denied = (rel: string, globs: string[]): boolean => globs.some((g) => matchesGlob(rel, g));
const outside = (rel: string): boolean => rel === '' || isAbsolute(rel) || rel.split('/').includes('..');

function lineCount(file: string): number {
  const text = readFileSync(file, 'utf8');
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// Both the path the model gave and the path it resolves to must stay inside root and pass the denials, so a
// symlink inside a checkout cannot lead to its .env.
function inside(root: string, rel: string, globs: string[]): string | undefined {
  if (outside(rel) || denied(rel, globs)) return undefined;
  const real = realpathSync(join(root, rel));
  if (!real.startsWith(root + sep) || !statSync(real).isFile()) return undefined;
  return denied(relative(root, real), globs) ? undefined : real;
}

function resolveSrc(cite: string, paths: KbPaths): ResolvedCite | undefined {
  const m = SRC_CITE.exec(cite.trim());
  if (m === null) return undefined;
  const [, name = '', given = '', a = '', b] = m;
  const repos = paths.repos.filter((r) => basename(r) === name);
  if (repos.length !== 1) return undefined;
  const repo = realpathSync(repos[0]!);
  const rel = posix.normalize(given);
  const file = inside(repo, rel, SRC_DENIED);
  if (file === undefined) return undefined;
  const from = Number(a);
  const to = b === undefined ? from : Number(b);
  if (from < 1 || to < from || to - from > MAX_SPAN || to > lineCount(file)) return undefined;
  return { kind: 'src', cite: `${name}/${rel}:${from}-${to}`, file, from, to };
}

function resolveKb(cite: string, paths: KbPaths): ResolvedCite | undefined {
  const rel = posix.normalize(cite.trim().replace(/^kb-mcp\/wiki\//u, ''));
  if (!rel.endsWith('.md')) return undefined;
  const file = inside(realpathSync(paths.wiki), rel, WIKI_DENIED);
  return file === undefined ? undefined : { kind: 'kb', cite: rel, file };
}

// A model cite as a checked location, or undefined. Never throws. A leading "src:" or "kb:" label is the model echoing
// the evidence kind, not part of the path.
export function resolveCite(kind: 'src' | 'kb', cite: string, paths: KbPaths): ResolvedCite | undefined {
  const bare = cite.trim().replace(/^(?:src|kb):\s*/u, '');
  try {
    return kind === 'src' ? resolveSrc(bare, paths) : resolveKb(bare, paths);
  } catch {
    return undefined;
  }
}

const MIN_QUOTE_CHARS = 20;
const QUOTE_SLACK_LINES = 3;
const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();

// The quote appears at the cited place, whitespace aside: within a few lines of a source range, anywhere in a doc.
export function checkQuote(r: ResolvedCite, quote: string): boolean {
  const q = squash(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  try {
    const text = readFileSync(r.file, 'utf8');
    const haystack = r.kind === 'kb' ? text : text.split('\n').slice(Math.max(1, r.from - QUOTE_SLACK_LINES) - 1, r.to + QUOTE_SLACK_LINES).join('\n');
    return squash(haystack).includes(q);
  } catch {
    return false;
  }
}

// The day a wiki doc was copied from Confluence, when it is such a copy.
export function confluenceSyncDate(file: string): string | undefined {
  try {
    const text = readFileSync(file, 'utf8');
    if (!text.startsWith('---\n')) return undefined;
    const end = text.indexOf('\n---', 3);
    if (end < 0) return undefined;
    const lines = text.slice(4, end).split('\n').map((l) => l.trim());
    if (!lines.includes('source: confluence')) return undefined;
    const synced = lines.find((l) => l.startsWith('last_synced:'))?.slice('last_synced:'.length).trim().replace(/^["']/u, '');
    return synced === undefined ? undefined : /^\d{4}-\d{2}-\d{2}/u.exec(synced)?.[0];
  } catch {
    return undefined;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

// A tech cite is source when it reads as <service>/<path>:<line>, otherwise a wiki doc.
const resolveAny = (cite: string, paths: KbPaths): ResolvedCite | undefined => resolveCite('src', cite, paths) ?? resolveCite('kb', cite, paths);

// Keeps a text block with at least one resolving cite (its other cites go) and a code block whose one source cite
// resolves to at most MAX_TECH_CODE_LINES lines; drops emptied sections. Rewrites `answer` in place.
export function gateTech(answer: Obj, paths: KbPaths): { kept: number; removed: number; confluenceDates: string[] } {
  let kept = 0;
  let removed = 0;
  const dates = new Set<string>();
  const all = list(answer['sections']);
  const sections = all.slice(0, MAX_TECH_SECTIONS).filter((section) => {
    const blocks = list(section['blocks']);
    removed += Math.max(0, blocks.length - MAX_TECH_BLOCKS);
    section['blocks'] = blocks.slice(0, MAX_TECH_BLOCKS).filter((block) => {
      const cites = (Array.isArray(block['cites']) ? block['cites'] : []).filter((c): c is string => typeof c === 'string');
      let resolved: ResolvedCite[] = [];
      if (block['kind'] === 'code') {
        const r = cites.length === 1 ? resolveCite('src', cites[0]!, paths) : undefined;
        if (r?.kind === 'src' && r.to - r.from + 1 <= MAX_TECH_CODE_LINES) resolved = [r];
      } else if (typeof block['text'] === 'string' && block['text'].length <= MAX_TECH_TEXT_CHARS) {
        resolved = cites.flatMap((c) => resolveAny(c, paths) ?? []);
      }
      if (resolved.length === 0) {
        removed++;
        return false;
      }
      block['cites'] = resolved.map((r) => r.cite);
      for (const r of resolved) {
        const d = r.kind === 'kb' ? confluenceSyncDate(r.file) : undefined;
        if (d !== undefined) dates.add(d);
      }
      kept++;
      return true;
    });
    return list(section['blocks']).length > 0;
  });
  for (const s of all.slice(MAX_TECH_SECTIONS)) removed += list(s['blocks']).length;
  answer['sections'] = sections;
  return { kept, removed, confluenceDates: [...dates].sort() };
}

// The Markdown page body for a gated tech answer: a text block keeps its cites after it, and a code block's body is
// read by audee from the cited lines, secret-named values redacted, never taken from the model.
export function techMarkdown(answer: Obj, paths: KbPaths): { markdown: string; sources: string[] } {
  const out: string[] = [];
  const sources = new Set<string>();
  for (const section of list(answer['sections'])) {
    out.push(`## ${String(section['heading'] ?? '')}`, '');
    for (const block of list(section['blocks'])) {
      const cites = block['cites'] as string[];
      for (const c of cites) sources.add(c);
      if (block['kind'] === 'code') {
        const r = resolveCite('src', cites[0]!, paths);
        if (r?.kind !== 'src') continue;
        const body = redactSecretPairs(readFileSync(r.file, 'utf8').split('\n').slice(r.from - 1, r.to).join('\n'));
        const fence = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/gu)].map((m) => m[0].length + 1)));
        out.push(fence, `// ${r.cite}`, body, fence, '');
      } else {
        out.push(`${String(block['text'])} *(${cites.join('; ')})*`, '');
      }
    }
  }
  return { markdown: out.join('\n').trim(), sources: [...sources].slice(0, 10) };
}

// Keeps only journey steps and rules whose cite resolves; "unverified" items always go. A reading that lost a step
// loses its diagrams, which may show that step, and an emptied reading goes. Rewrites `product` in place.
export function gateProduct(product: Obj, paths: KbPaths): { kept: number; removed: number; confluenceDates: string[] } {
  let kept = 0;
  let removed = 0;
  const dates = new Set<string>();
  const check = (items: Obj[]): Obj[] => items.filter((item) => {
    const evidence = item['evidence'];
    const r = evidence === 'src' || evidence === 'kb' ? resolveCite(evidence, typeof item['cite'] === 'string' ? item['cite'] : '', paths) : undefined;
    if (r === undefined) {
      removed++;
      return false;
    }
    item['cite'] = r.cite;
    kept++;
    if (r.kind === 'kb') {
      const d = confluenceSyncDate(r.file);
      if (d !== undefined) dates.add(d);
    }
    return true;
  });
  const readings = list(product['readings']).filter((reading) => {
    const journey = list(reading['journey']);
    const keptJourney = check(journey);
    const rules = check(list(reading['rules']));
    reading['journey'] = keptJourney;
    reading['rules'] = rules;
    if (keptJourney.length < journey.length) reading['diagrams'] = [];
    return keptJourney.length > 0 || rules.length > 0;
  });
  product['readings'] = readings;
  return { kept, removed, confluenceDates: [...dates].sort() };
}
