// Shadow mode: classify copies of Ciel's handled files and record what live mode would have decided.
// It never moves, deletes or edits Ciel's files, never queues a job, and never writes to the OneDrive outbox.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authSettings, isAllowed, resolvePerson } from '../authz/people.js';
import { expandHome } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { appendEvent } from '../events.js';
import type { runAgent } from '../runner/run.js';
import type { State } from '../state/state.js';
import { ClassifyError, Detector, plainText, triggersOf } from './detect.js';
import { type InboxFile, jsonFiles, parseInboxFile } from './inbox.js';
import { principalOf } from './message.js';

export class ShadowSource {
  constructor(readonly dirs: string[], private readonly state: State) {}

  static forCiel(state: State): ShadowSource {
    return new ShadowSource([expandHome('~/.ciel/raw'), expandHome('~/.ciel/failed')], state);
  }

  // Reads every new *.json once; an unparsable file is marked seen and skipped. Nothing is moved or deleted.
  async scan(signal: AbortSignal, handle: (f: InboxFile, signal: AbortSignal) => Promise<void>): Promise<number> {
    let seen = 0;
    for (const dir of this.dirs) {
      for (const name of jsonFiles(dir)) {
        if (signal.aborted) return seen;
        if (this.state.hasShadowSeen(name)) continue;
        let file: InboxFile;
        try {
          file = parseInboxFile(readFileSync(join(dir, name)));
        } catch {
          this.state.markShadowSeen(name);
          continue;
        }
        file.name = name;
        seen++;
        try {
          await handle(file, signal);
        } finally {
          this.state.markShadowSeen(name);
        }
      }
    }
    return seen;
  }
}

export type ShadowDeps = { cfg: Config; state: State; run: typeof runAgent; now?: () => Date };

const capabilityOfIntent: Record<string, string | undefined> = { review_mr: 'review', code_mapping: 'code_mapping' };

// The shadow handler: allowlist and candidate check, history for context, then the token trigger or the
// classifier on the owner's auth regardless of sender. Appends one classify event and stops.
export function shadowHandler(deps: ShadowDeps): (f: InboxFile, signal: AbortSignal) => Promise<void> {
  const { cfg, state, run } = deps;
  const now = deps.now ?? (() => new Date());
  const dataDir = expandHome(cfg.data_dir);
  const detector = Detector.fromConfig(cfg);
  const triggers = triggersOf(cfg);
  return async (f, signal) => {
    const msg = f.message;
    if (!cfg.channels.teams.chats.includes(f.chatId) || msg.messageType !== 'message') return;
    detector.meId = f.meId;
    const candidate = detector.isCandidate(msg, plainText(msg));
    const principal = principalOf(msg) ?? '';
    const person = principal === '' ? undefined : resolvePerson(cfg, principal);
    const history = historyOf(state, cfg, detector, f.chatId, msg);
    state.record(f.chatId, msg.id, { principal, at: msg.createdDateTime ?? '', text: plainText(msg), mentionsMe: detector.mentionsMe(msg) }, cfg.channels.teams.history_size);
    if (!candidate) return;
    const token = detector.capabilityToken(triggers, msg);
    if (token !== undefined) {
      appendEvent(dataDir, { kind: 'classify', status: 'classified', shadow: true, token: true, msgId: msg.id, intent: token.capability, addressed: true, principal, allowed: person !== undefined && isAllowed(person, token.capability) }, now());
      return;
    }
    const auth = cfg.classifier.auth;
    const started = now().getTime();
    try {
      const dec = await detector.classify(history, msg, {
        run, model: cfg.classifier.model, effort: cfg.classifier.effort, timeoutMs: cfg.classifier.timeout,
        cwd: expandHome(cfg.capabilities['review']?.workdir ?? '~/.claude/kb'), ...authSettings(cfg, auth), signal,
      });
      const needed = capabilityOfIntent[dec.intent];
      const allowed = person !== undefined && (needed === undefined || isAllowed(person, needed));
      appendEvent(dataDir, { kind: 'classify', status: 'classified', shadow: true, msgId: msg.id, intent: dec.intent, addressed: dec.addressedToMe, mrs: dec.mrUrls.length, principal, allowed, durationMs: now().getTime() - started }, now());
    } catch (e) {
      const reason = e instanceof ClassifyError ? e.reason : 'claude session failed';
      appendEvent(dataDir, { kind: 'classify', status: 'failed', shadow: true, msgId: msg.id, principal, reason, durationMs: now().getTime() - started }, now());
    }
  };
}

function historyOf(state: State, cfg: Config, detector: Detector, chatId: string, msg: InboxFile['message']): InboxFile['message'][] {
  const cutoff = Date.parse(msg.createdDateTime ?? '');
  return state.chatHistory(chatId).filter((e) => Date.parse(e.at) < cutoff).map((e) => ({
    id: '', messageType: 'message', createdDateTime: e.at, body: { contentType: 'text', content: e.text },
    ...(e.principal !== '' ? { from: { user: { id: e.principal.replace(/^teams:/u, '') } } } : {}),
    ...(e.mentionsMe ? { mentions: [{ mentioned: { user: { id: detector.meId } } }] } : {}),
  }));
}
