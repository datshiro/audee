// Port of ciel/detect.go and the kb_query trigger from ciel/kbquery.go:21-49.
import type { Config } from '../config/schema.js';
import { buildOptions } from '../fence/profiles.js';
import { firstLine } from '../render/html.js';
import type { RunInput, runAgent } from '../runner/run.js';
import { type ChatMessage, sender } from './message.js';

const TAG_RE = /<[^>]*>/gu;
const SPACE_RE = /[\s\p{Zs}]+/gu;
const HREF_RE = /href="([^"]+)"/gu;
const LINE_BREAK_RE = /<br\s*\/?>|<\/(?:p|div|pre|li)>/giu;
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

// Go html.UnescapeString for the entities Teams emits: numeric ones and the common named ones.
export function unescapeHTML(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/gu, (whole, body: string) => {
    try {
      if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16));
      if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    } catch {
      return whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// detect.go:24-35: flattens Teams HTML while keeping link targets, which may differ from the link text.
export function plainText(m: ChatMessage): string {
  let content = m.body.content ?? '';
  if (m.body.contentType === 'html') {
    const links = [...content.matchAll(HREF_RE)].map((x) => unescapeHTML(x[1] ?? ''));
    content = content.replaceAll('<br>', '\n').replace(TAG_RE, ' ');
    content = unescapeHTML(content) + ' ' + links.join(' ');
  }
  return content.replace(SPACE_RE, ' ').trim();
}

// detect.go:41-47: the message as the sender laid it out; unlike plainText it keeps newlines and tabs.
export function requestText(m: ChatMessage): string {
  let content = m.body.content ?? '';
  if (m.body.contentType === 'html') content = unescapeHTML(content.replace(LINE_BREAK_RE, '\n').replace(TAG_RE, ''));
  return content.replaceAll(' ', ' ').trim();
}

export type Decision = { addressedToMe: boolean; intent: string; mrUrls: string[]; summary: string };

// detect.go:109-118 decisionSchema
export const decisionSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    addressed_to_me: { type: 'boolean' },
    intent: { type: 'string', enum: ['review_mr', 'code_mapping', 'question', 'other'] },
    mr_urls: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['addressed_to_me', 'intent', 'mr_urls', 'summary'],
  additionalProperties: false,
};

// What the message trail may keep of a classify failure (ciel/watcher.go classifyFailure): never the model's text.
export class ClassifyError extends Error {
  constructor(message: string, readonly reason: 'classify timed out' | 'claude session failed' | 'classify returned no decision') {
    super(message);
    this.name = 'ClassifyError';
  }
}

export type ClassifySession = {
  run: typeof runAgent;
  model: string;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
  cwd: string;
  auth: 'subscription' | 'api_key';
  apiKeyItem?: string;
  baseUrl?: string;
  signal: AbortSignal;
};

export type DetectorConfig = { aliases: string[]; mrUrlPattern: string };

const WORD_EDGE = '[^\\p{L}\\p{N}_]';
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ciel/kbquery.go:21-24 wordEdge: an alias inside "update" or a token inside "kb_queryx" does not count.
export function tokenRe(token: string): RegExp {
  return new RegExp(`(?:^|${WORD_EDGE})${escapeRegExp(token)}(?:${WORD_EDGE}|$)`, 'iu');
}

export type Trigger = { capability: string; token: string };

// kb_query, the fixed iam_trace word and every mcp_read capability's trigger word.
export function triggersOf(cfg: Config): Trigger[] {
  const out: Trigger[] = [{ capability: 'kb_query', token: 'kb_query' }];
  for (const [name, cap] of Object.entries(cfg.capabilities)) {
    if (cap.profile === 'mcp_read' && cap.trigger !== undefined) out.push({ capability: name, token: cap.trigger });
    if (cap.profile === 'iam_trace') out.push({ capability: name, token: 'iam_trace' });
  }
  return out;
}

export class Detector {
  readonly aliases: string[];
  private readonly mrRe: RegExp;
  meId: string;

  constructor(cfg: DetectorConfig, meId = '') {
    this.aliases = cfg.aliases;
    this.mrRe = new RegExp(cfg.mrUrlPattern, 'u');
    this.meId = meId;
  }

  static fromConfig(cfg: Config, meId = ''): Detector {
    return new Detector({ aliases: cfg.channels.teams.aliases, mrUrlPattern: cfg.channels.teams.mr_url_pattern }, meId);
  }

  mentionsMe(m: ChatMessage): boolean {
    return (m.mentions ?? []).some((x) => x.mentioned?.user?.id === this.meId);
  }

  // detect.go:67-81: the cheap filter that decides whether a message is worth a model call.
  isCandidate(m: ChatMessage, text: string): boolean {
    if (m.messageType !== 'message') return false;
    const s = sender(m);
    if (s === undefined || s.id === this.meId) return false;
    if (this.mentionsMe(m) || this.mrRe.test(text)) return true;
    const lower = text.toLowerCase();
    return this.aliases.some((a) => a !== '' && lower.includes(a.toLowerCase()));
  }

  // kbquery.go:40-49: an alias as a whole word.
  namesAlias(text: string): boolean {
    return this.aliases.some((a) => a !== '' && tokenRe(a).test(text));
  }

  // kbquery.go:28-38, generalised: the first trigger word found, when the message addresses the user.
  capabilityToken(triggers: Trigger[], m: ChatMessage): { capability: string; question: string } | undefined {
    const text = requestText(m);
    for (const t of triggers) {
      const match = tokenRe(t.token).exec(text);
      if (match === null) continue;
      if (!(this.mentionsMe(m) || this.namesAlias(text))) return undefined;
      const question = text.slice(match.index + match[0].length).trim().replace(/^[:\-– ]+/u, '');
      return { capability: t.capability, question };
    }
    return undefined;
  }

  kbQueryQuestion(m: ChatMessage): [string, boolean] {
    const hit = this.capabilityToken([{ capability: 'kb_query', token: 'kb_query' }], m);
    return hit === undefined ? ['', false] : [hit.question, true];
  }

  // detect.go:171-179
  prompt(history: ChatMessage[], msg: ChatMessage): string {
    let out = 'Earlier messages, oldest first:\n';
    for (const m of history) out += this.line(m) + '\n';
    return out + '\nNEW message:\n' + this.line(msg);
  }

  // detect.go:182-195: speakers are "the user" or a stable pseudonym, so no colleague names reach the model.
  line(m: ChatMessage): string {
    let who = 'someone';
    const s = sender(m);
    if (s !== undefined) who = s.id === this.meId ? 'the user' : 'person-' + shortId(s.id);
    let text = plainText(m);
    if (this.mentionsMe(m)) text += ' [this message @mentions the user]';
    return `[${who}] ${text}`;
  }

  // detect.go:205-218: only URLs that match the pattern and appear verbatim in the conversation.
  validMRURLs(urls: string[], history: ChatMessage[], msg: ChatMessage): string[] {
    const corpus = [...history, msg].map((m) => plainText(m) + ' ').join('');
    const out: string[] = [];
    for (let u of urls) {
      u = u.replace(/[.,);]+$/u, '');
      const found = this.mrRe.exec(u)?.[0];
      if (found === u && corpus.includes(u) && !out.includes(u)) out.push(u);
    }
    return out;
  }

  // detect.go:123-169 Classify, on the classifier profile through the injected run.
  async classify(history: ChatMessage[], msg: ChatMessage, session: ClassifySession): Promise<Decision> {
    const options = buildOptions({ profile: 'classifier', cwd: session.cwd, mcpServers: {}, model: session.model, effort: session.effort, schema: decisionSchema, seatbelt: false });
    const input: RunInput = {
      options, prompt: this.prompt(history, msg), timeoutMs: session.timeoutMs, auth: session.auth,
      ...(session.apiKeyItem !== undefined ? { apiKeyItem: session.apiKeyItem } : {}),
      ...(session.baseUrl !== undefined ? { baseUrl: session.baseUrl } : {}), signal: session.signal,
    };
    let result;
    try {
      result = await session.run(input);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/^timed out after /u.test(message)) throw new ClassifyError(`claude classify: ${message}`, 'classify timed out');
      throw new ClassifyError(`claude classify: ${message}`, 'claude session failed');
    }
    if (result.isError || result.structured === undefined || result.structured === null) {
      throw new ClassifyError(`claude classify returned no decision: ${firstLine(result.text)}`, 'classify returned no decision');
    }
    const s = result.structured as Record<string, unknown>;
    if (typeof s !== 'object' || typeof s['addressed_to_me'] !== 'boolean' || typeof s['intent'] !== 'string') {
      throw new ClassifyError('decode decision: not a decision object', 'classify returned no decision');
    }
    const urls = Array.isArray(s['mr_urls']) ? s['mr_urls'].filter((x): x is string => typeof x === 'string') : [];
    return { addressedToMe: s['addressed_to_me'], intent: s['intent'], mrUrls: this.validMRURLs(urls, history, msg), summary: typeof s['summary'] === 'string' ? s['summary'] : '' };
  }
}

export function shortId(id: string): string {
  return id.length > 6 ? id.slice(0, 6) : id;
}
