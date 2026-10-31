// The gather session's evidence ledger: cites with quotes copied from the cited place, which audee checks before any
// writer sees them. audee-owned, so the pinned kb-answer-v1 stays untouched. Must not import kb-query.ts.
import type { RunResult } from '../runner/run.js';
import { matches } from './kb-answer.js';

export const MAX_LEDGER = 40;
export const MAX_QUOTE_CHARS = 1200;
export const MAX_ABOUT_CHARS = 200;

const stringList = { type: 'array', items: { type: 'string' } };

export const GATHER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'failed'] },
    topic: { type: 'string', description: 'What the question asks, at most 12 words, in the language of the question.' },
    lang: { type: 'string', enum: ['vi', 'en'] },
    ledger: {
      type: 'array',
      description: `At most ${MAX_LEDGER} entries.`,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'E1, E2, ... in order.' },
          kind: { type: 'string', enum: ['src', 'kb'] },
          cite: { type: 'string', description: 'For kind "src": <service>/<path>:<from>-<to>. For kind "kb": the doc\'s path inside the wiki. No other prefix.' },
          quote: { type: 'string', description: `1 to 15 consecutive lines copied exactly from the cited place, at most ${MAX_QUOTE_CHARS} characters.` },
          about: { type: 'string', description: `What the quote shows, at most ${MAX_ABOUT_CHARS} characters.` },
        },
        required: ['id', 'kind', 'cite', 'quote', 'about'],
        additionalProperties: false,
      },
    },
    notes: { ...stringList, description: 'At most 5, each under 250 characters.' },
    missing: { ...stringList, description: 'What the KB and the source do not cover.' },
  },
  required: ['status', 'topic', 'lang', 'ledger', 'notes', 'missing'],
  additionalProperties: false,
};

export type LedgerEntry = { id: string; kind: 'src' | 'kb'; cite: string; quote: string; about: string };
export type Gathered = { topic: string; lang: 'vi' | 'en'; ledger: LedgerEntry[]; notes: string[]; missing: string[] };

// The ledger, or a throw with a fixed reason. matches() ignores the length limits, so they are enforced here.
export function parseGather(result: RunResult): Gathered {
  if (result.isError) throw new Error('gather reported an error');
  const s = result.structured;
  if (!matches(s, GATHER_SCHEMA)) throw new Error('gather returned no ledger');
  const g = s as Gathered & { status: string };
  if (g.status === 'failed') throw new Error('gather session could not finish');
  const ledger = g.ledger.slice(0, MAX_LEDGER).filter((e) => e.quote.length <= MAX_QUOTE_CHARS && e.about.length <= MAX_ABOUT_CHARS);
  return { topic: g.topic, lang: g.lang, ledger, notes: g.notes, missing: g.missing };
}
