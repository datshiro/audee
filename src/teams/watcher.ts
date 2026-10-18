// Port of ciel/watcher.go: inbox messages from allowed chats become permitted, queued capability jobs.
import { mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { authSettings, isAllowed, type Person, resolvePerson } from '../authz/people.js';
import { kbQuery } from '../capability/kb-query.js';
import { expireScratchDirs, mapping } from '../capability/mapping.js';
import { mcpRead } from '../capability/mcp-read.js';
import { review } from '../capability/review.js';
import type { Capability, CapabilityOutcome } from '../capability/types.js';
import { expandHome } from '../config/load.js';
import type { Config, ProfileName } from '../config/schema.js';
import { appendEvent, type Event } from '../events.js';
import { notify } from '../notify.js';
import { type Job, jobKey } from '../queue/job.js';
import { CancelledError, type CancelResult, type EnqueueResult, Queue, type RunOutcome } from '../queue/queue.js';
import { busyText, deniedText, failedText, kbQueryEmptyReply, pendingText, queuedReply, queuedText, recentReply, replyHTML, unavailableText } from '../render/html.js';
import { InterruptedError, type runAgent } from '../runner/run.js';
import type { HistoryEntry, MessageRecord, State } from '../state/state.js';
import { outcomeClassified, outcomeSkipped } from '../state/state.js';
import { ClassifyError, type Decision, Detector, plainText, requestText, triggersOf } from './detect.js';
import { type Inbox, type InboxFile, jsonFiles, rawRetentionMs, TrailError } from './inbox.js';
import { type ChatMessage, principalOf, sender } from './message.js';
import type { Outbox } from './outbox.js';

export const scanEveryMs = 5_000;
export const outcomeDenied = 'denied';
const messageIdRe = /^[0-9]{10,}$/u;

export type Source = { scan(signal: AbortSignal, handle: (f: InboxFile, signal: AbortSignal) => Promise<void>): Promise<number> };

export type WatcherDeps = {
  cfg: Config;
  state: State;
  source: Source;
  inbox?: Inbox; // for expire(); absent in shadow mode
  outbox: Outbox;
  run: typeof runAgent;
  secrets: Record<string, string>;
  capabilities?: Partial<Record<ProfileName, Capability>>;
  now?: () => Date;
  userConfigPath?: string;
  handle?: (f: InboxFile, signal: AbortSignal) => Promise<void>; // shadow mode replaces the live handler
};

const REAL_CAPABILITIES: Partial<Record<ProfileName, Capability>> = { review, mapping, kb_read: kbQuery, mcp_read: mcpRead };

const userIdOf = (principal: string): string => principal.replace(/^teams:/u, '');

export const rerunDir = (dataDir: string): string => join(dataDir, 'rerun');

// config.go quietAlertDue: no inbox file for quiet_after of today's work hours; nights and weekends never trigger.
export function quietAlertDue(teams: Config['channels']['teams'], now: Date, lastInbox: Date | undefined): boolean {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const minutes = (clock: string): number => {
    const [h, m] = clock.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayStart = midnight.getTime() + minutes(teams.work_hours.start) * 60_000;
  const dayEnd = midnight.getTime() + minutes(teams.work_hours.end) * 60_000;
  if (!teams.work_hours.days.includes(days[now.getDay()] as (typeof teams.work_hours.days)[number]) || now.getTime() < dayStart || now.getTime() >= dayEnd) return false;
  let since = lastInbox?.getTime() ?? 0;
  if (since < dayStart) since = dayStart;
  return now.getTime() - since >= teams.quiet_after;
}

export class Watcher {
  readonly cfg: Config;
  readonly state: State;
  readonly source: Source;
  readonly outbox: Outbox;
  readonly queue: Queue;
  readonly detector: Detector;
  private readonly inbox: Inbox | undefined;
  private readonly runAgent: typeof runAgent;
  private readonly secrets: Record<string, string>;
  private readonly capabilities: Partial<Record<ProfileName, Capability>>;
  private readonly now: () => Date;
  private readonly userConfigPath: string | undefined;
  private readonly dataDir: string;
  private readonly handler: (f: InboxFile, signal: AbortSignal) => Promise<void>;
  private quietAlertFor: string | undefined;
  private quietAlerted = false;

  constructor(deps: WatcherDeps) {
    this.handler = deps.handle ?? ((f, s) => this.handle(f, s));
    this.cfg = deps.cfg;
    this.state = deps.state;
    this.source = deps.source;
    this.inbox = deps.inbox;
    this.outbox = deps.outbox;
    this.runAgent = deps.run;
    this.secrets = deps.secrets;
    this.capabilities = deps.capabilities ?? REAL_CAPABILITIES;
    this.now = deps.now ?? (() => new Date());
    this.userConfigPath = deps.userConfigPath;
    this.dataDir = expandHome(this.cfg.data_dir);
    this.detector = Detector.fromConfig(this.cfg);
    this.queue = new Queue(this.cfg, this.state, (job, signal) => this.runJob(job, signal), this.now);
  }

  // Scans until the signal aborts. Detection runs here, one message at a time; capability sessions run on the queue.
  async run(signal: AbortSignal): Promise<void> {
    // Shadow only classifies: saved jobs and reruns wait for live mode, so shadow never starts a session that acts.
    const shadow = this.cfg.channels.teams.shadow;
    if (!shadow) this.queue.start();
    while (!signal.aborted) {
      const n = await this.source.scan(signal, this.handler);
      if (n > 0) this.state.inboxArrived(this.now());
      const now = this.now();
      this.inbox?.expire(now);
      this.state.pruneRequests(new Date(now.getTime() - rawRetentionMs));
      expireScratchDirs(this.dataDir, new Date(now.getTime() - rawRetentionMs));
      if (!shadow) this.takeReruns();
      this.checkQuiet(now);
      if (signal.aborted) break;
      await sleep(scanEveryMs, undefined, { signal }).catch(() => undefined);
    }
  }

  // watcher.go:72-83: warn once when the flows look dead, then stay silent until a file arrives.
  checkQuiet(now: Date): void {
    const last = this.state.lastInbox();
    const key = last?.toISOString() ?? '';
    if (this.quietAlerted && this.quietAlertFor === key) return;
    if (!quietAlertDue(this.cfg.channels.teams, now, last)) return;
    this.quietAlerted = true;
    this.quietAlertFor = key;
    const hours = Math.round(this.cfg.channels.teams.quiet_after / 3600_000);
    notify('audee: inbox is quiet', `No Teams message arrived for ${hours}h. Check the Power Automate flows and OneDrive sync.`);
  }

  // Throws when the message should be retried (a failed classify). The message is marked seen once classified.
  async handle(f: InboxFile, signal: AbortSignal): Promise<void> {
    const msg = f.message;
    if (!this.cfg.channels.teams.chats.includes(f.chatId)) {
      this.skip(f, 'chat not allowed');
      return;
    }
    if (this.state.hasSeen(msg.id)) {
      this.skip(f, 'duplicate');
      return;
    }
    this.detector.meId = f.meId;
    if (msg.messageType !== 'message') {
      this.state.markSeen(msg.id);
      this.skip(f, 'system event');
      return;
    }
    const candidate = this.detector.isCandidate(msg, plainText(msg));
    const principal = principalOf(msg);
    const person = principal === undefined ? undefined : resolvePerson(this.cfg, principal);
    if (person === undefined) {
      // Unknown sender: never classified. A message that @mentions the user gets a refusal (user decision 6a).
      this.record(f.chatId, msg);
      if (candidate && this.detector.mentionsMe(msg) && principal !== undefined) {
        this.outbox.reply(f.chatId, userIdOf(principal), deniedText('audee'));
        this.track(f, outcomeDenied, 'unknown sender');
      } else {
        this.skip(f, candidate ? 'unknown sender' : 'not a candidate');
      }
      return;
    }
    const token = candidate ? this.detector.capabilityToken(triggersOf(this.cfg), msg) : undefined;
    if (token !== undefined) {
      // Queued before the message is marked seen: a crash in between redelivers it, never loses the question.
      const action = this.askCapability(f.chatId, msg, person, token.capability, token.question);
      this.record(f.chatId, msg);
      this.state.trackMessage(f.name, (r) => {
        r.outcome = outcomeClassified;
        r.reason = action;
        r.intent = token.capability;
        r.addressed = true;
      });
      return;
    }
    let dec: Decision | undefined;
    if (candidate) {
      const started = this.now().getTime();
      try {
        dec = await this.detector.classify(this.history(f.chatId, msg), msg, this.classifySession(this.cfg.classifier.auth, signal));
      } catch (e) {
        const reason = e instanceof ClassifyError ? e.reason : 'claude session failed';
        appendEvent(this.dataDir, { kind: 'classify', status: 'failed', msgId: msg.id, reason, durationMs: this.now().getTime() - started });
        throw new TrailError(`classify message ${msg.id}: ${(e as Error).message}`, reason);
      }
      appendEvent(this.dataDir, { kind: 'classify', status: 'classified', msgId: msg.id, addressed: dec.addressedToMe, intent: dec.intent, mrs: dec.mrUrls.length, durationMs: this.now().getTime() - started, principal: person.ids[0] ?? principal ?? '' });
    }
    this.record(f.chatId, msg);
    if (!candidate || dec === undefined) {
      this.skip(f, 'not a candidate');
      return;
    }
    const decision = dec;
    const action = decision.addressedToMe ? this.act(f.chatId, msg, person, decision) : 'not addressed to me';
    this.state.trackMessage(f.name, (r) => {
      r.outcome = outcomeClassified;
      r.reason = action;
      r.intent = decision.intent;
      r.addressed = decision.addressedToMe;
      r.mrUrls = decision.mrUrls;
    });
  }

  classifySession(auth: 'subscription' | 'api_key', signal: AbortSignal) {
    return {
      run: this.runAgent, model: this.cfg.classifier.model, effort: this.cfg.classifier.effort, timeoutMs: this.cfg.classifier.timeout,
      cwd: expandHome(this.cfg.capabilities['review']?.workdir ?? '~/.claude/kb'), ...authSettings(this.cfg, auth), signal,
    };
  }

  skip(f: InboxFile, reason: string): void {
    this.track(f, outcomeSkipped, reason);
  }

  private track(f: InboxFile, outcome: string, reason: string): void {
    this.state.trackMessage(f.name, (r: MessageRecord) => {
      r.outcome = outcome;
      r.reason = reason;
    });
  }

  // watcher.go:184-226: notifies the owner or queues the requested work, one reply per kind, and names the action.
  act(chatId: string, msg: ChatMessage, person: Person, dec: Decision): string {
    const principal = principalOf(msg) ?? '';
    const userId = userIdOf(principal);
    const base = { channel: 'teams' as const, chatId, principal, requesterName: sender(msg)?.displayName ?? '', requestedAt: this.now().toISOString() };
    if (dec.intent === 'code_mapping') {
      if (!messageIdRe.test(msg.id)) {
        notify('audee: code mapping requested', dec.summary);
        return 'notified: unexpected message id';
      }
      if (!this.configured('code_mapping', chatId, userId)) return 'unavailable: code_mapping';
      if (!isAllowed(person, 'code_mapping')) {
        this.outbox.reply(chatId, userId, deniedText('code_mapping'));
        return 'denied: code_mapping';
      }
      const job: Job = { ...base, kind: 'code_mapping', messageId: msg.id, input: this.mappingInput(chatId, msg) };
      this.state.recordRequest(job);
      notify('audee: code mapping requested', dec.summary);
      return this.enqueueOne(job);
    }
    if (dec.intent !== 'review_mr' || dec.mrUrls.length === 0) {
      notify('audee: someone needs you', dec.summary);
      return 'notified';
    }
    if (!this.configured('review', chatId, userId)) return 'unavailable: review';
    if (!isAllowed(person, 'review')) {
      this.outbox.reply(chatId, userId, deniedText('review'));
      return 'denied: review';
    }
    const actions: string[] = [];
    const lists: Record<string, string[]> = { queued: [], cooldown: [], busy: [] };
    for (const url of dec.mrUrls) {
      const job: Job = { ...base, kind: 'review', mrUrl: url };
      this.state.recordRequest(job);
      const result = this.queue.enqueue(job);
      if (result === 'queued') notify('audee: review requested', url);
      if (result === 'queued' || result === 'cooldown' || result === 'busy') lists[result]?.push(url);
      if (result === 'duplicate') lists['cooldown']?.push(url); // already queued from another message: not reviewed twice
      actions.push({ queued: 'review queued', cooldown: 'reviewed recently', busy: 'dropped: queue full', duplicate: 'already queued', limit: 'limit reached' }[result]);
      if (result === 'limit') this.outbox.reply(chatId, userId, pendingText('review'));
    }
    this.tell(chatId, userId, queuedReply, lists['queued'] ?? []);
    this.tell(chatId, userId, recentReply, lists['cooldown'] ?? []);
    this.tell(chatId, userId, busyText(), lists['busy'] ?? []);
    if ((lists['busy'] ?? []).length > 0) notify('audee: queue full, request dropped', (lists['busy'] ?? []).join(' '));
    return actions.join(', ');
  }

  // watcher.go:229-257, generalised to every token-triggered capability.
  askCapability(chatId: string, msg: ChatMessage, person: Person, capability: string, question: string): string {
    const principal = principalOf(msg) ?? '';
    const userId = userIdOf(principal);
    if (!messageIdRe.test(msg.id)) return `${capability} ignored: unexpected message id`;
    if (!this.configured(capability, chatId, userId)) return `unavailable: ${capability}`;
    if (!isAllowed(person, capability)) {
      this.outbox.reply(chatId, userId, deniedText(capability));
      return `denied: ${capability}`;
    }
    const job: Job = { kind: capability, channel: 'teams', chatId, principal, requesterName: sender(msg)?.displayName ?? '', messageId: msg.id, input: question, requestedAt: this.now().toISOString() };
    if (question === '') {
      this.outbox.reply(chatId, userId, kbQueryEmptyReply);
      return `${capability} without a question`;
    }
    if (this.state.pendingJobs().some((j) => jobKey(j) === jobKey(job) && j.kind === job.kind)) {
      return `${capability} already queued`; // the same message again, after a crash before it was marked seen
    }
    this.state.recordRequest(job);
    return this.enqueueOne(job);
  }

  // review, code_mapping and kb_query are built-in kinds the config may leave out; queueing one would throw.
  // A disabled capability answers the same way, so its trigger never falls through to the classifier.
  private configured(kind: string, chatId: string, userId: string): boolean {
    const cap = this.cfg.capabilities[kind];
    if (cap?.enabled === true) return true;
    this.outbox.reply(chatId, userId, unavailableText(kind));
    notify('audee: capability not configured', `${kind} was requested but is ${cap === undefined ? 'not in the config' : 'disabled'}`);
    return false;
  }

  // The dashboard's retry: the recorded request again, ignoring the review cooldown, like `audee rerun`.
  retry(kind: string, key: string): EnqueueResult {
    if (this.cfg.channels.teams.shadow) throw new Error('audee runs in shadow mode, which never runs a request');
    if (this.cfg.capabilities[kind]?.enabled !== true) throw new Error(`capability ${kind} is not enabled`);
    const job = this.state.findRequest(key);
    if (job === undefined || job.kind !== kind) throw new Error(`no ${kind} request for ${key} in audee's history`);
    if (kind !== 'review' && (job.input ?? '') === '') throw new Error(`the text of request ${key} is no longer kept`);
    const result = this.queue.enqueue(job, { ignoreCooldown: true });
    this.tellEnqueued(job, result);
    return result;
  }

  // The dashboard's stop: a queued job is answered here; a running one through runJob once its session aborts.
  cancel(kind: string, key: string): CancelResult {
    const { result, job } = this.queue.cancel(kind, key);
    if (result === 'removed' && job !== undefined) this.fail(job, 'cancelled by owner', 'cancelled');
    return result;
  }

  private enqueueOne(job: Job, opts: { ignoreCooldown?: boolean } = {}): string {
    return this.tellEnqueued(job, this.queue.enqueue(job, opts));
  }

  // Replies for one queued job, by the queue's answer; reviews are batched in act().
  private tellEnqueued(job: Job, result: EnqueueResult): string {
    const userId = userIdOf(job.principal);
    switch (result) {
      case 'queued':
        this.notice(job, queuedText(job.kind));
        return `${job.kind} queued`;
      case 'duplicate':
        return `${job.kind} already queued`;
      case 'cooldown':
        this.notice(job, recentReply);
        return 'reviewed recently';
      case 'limit':
        this.outbox.reply(job.chatId, userId, pendingText(job.kind));
        return `${job.kind} skipped: requester has one pending`;
      case 'busy':
        this.notice(job, busyText());
        notify('audee: queue full, request dropped', jobKey(job));
        return `${job.kind} dropped: queue full`;
    }
  }

  // actions.go tell: one reply listing the MR links; nothing without links.
  private tell(chatId: string, userId: string, text: string, urls: string[]): void {
    if (urls.length === 0) return;
    this.outbox.reply(chatId, userId, replyHTML(text, ...urls));
  }

  // actions.go notice: with the MR link for a review, as is for anything else.
  private notice(job: Job, text: string): void {
    this.outbox.reply(job.chatId, userIdOf(job.principal), job.kind === 'review' ? replyHTML(text, job.mrUrl ?? '') : text);
  }

  record(chatId: string, m: ChatMessage): void {
    const e: HistoryEntry = { principal: principalOf(m) ?? '', at: m.createdDateTime ?? '', text: plainText(m), mentionsMe: this.detector.mentionsMe(m) };
    this.state.record(chatId, m.id, e, this.cfg.channels.teams.history_size);
  }

  // watcher.go:268-289: the remembered messages sent before msg, oldest first, in the shape the detector reads.
  history(chatId: string, msg: ChatMessage): ChatMessage[] {
    const cutoff = Date.parse(msg.createdDateTime ?? '');
    const out: ChatMessage[] = [];
    for (const e of this.state.chatHistory(chatId)) {
      if (!(Date.parse(e.at) < cutoff)) continue;
      const m: ChatMessage = { id: '', messageType: 'message', createdDateTime: e.at, body: { contentType: 'text', content: e.text } };
      if (e.principal !== '') m.from = { user: { id: userIdOf(e.principal) } };
      if (e.mentionsMe) m.mentions = [{ mentioned: { user: { id: this.detector.meId } } }];
      out.push(m);
    }
    return out;
  }

  // watcher.go:293-303: the request as laid out, after the sender's earlier remembered messages.
  mappingInput(chatId: string, msg: ChatMessage): string {
    let out = '';
    const who = sender(msg)?.id;
    for (const m of this.history(chatId, msg)) {
      if (sender(m)?.id === who) out += 'Earlier message (line breaks lost):\n' + (m.body.content ?? '') + '\n\n';
    }
    return out + 'Request:\n' + requestText(msg);
  }

  // watcher.go:306-345: queue the requests `audee rerun` asked for, ignoring the review cooldown.
  takeReruns(): void {
    const dir = rerunDir(this.dataDir);
    for (const name of jsonFiles(dir)) {
      const path = join(dir, name);
      let job: Job | undefined;
      let problem: string | undefined;
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Job>;
        job = { kind: raw.kind ?? 'review', channel: 'teams', chatId: raw.chatId ?? '', principal: raw.principal ?? '', requesterName: raw.requesterName ?? '', requestedAt: raw.requestedAt ?? this.now().toISOString(), ...(raw.mrUrl !== undefined ? { mrUrl: raw.mrUrl } : {}), ...(raw.messageId !== undefined ? { messageId: raw.messageId } : {}), ...(raw.input !== undefined ? { input: raw.input } : {}) };
        if (job.chatId === '' || job.principal === '' || jobKey(job) === '' || (job.kind !== 'review' && (job.input ?? '') === '')) problem = 'chat_id, principal and mr_url, or message_id and input, are required';
        else if (job.kind !== 'review' && !messageIdRe.test(job.messageId ?? '')) problem = `message_id "${job.messageId ?? ''}" is not a Teams message id`;
      } catch (e) {
        problem = (e as Error).message;
      }
      try {
        unlinkSync(path);
      } catch (e) {
        console.error(`remove rerun ${name}: ${(e as Error).message}`);
        continue;
      }
      if (problem !== undefined || job === undefined) {
        console.error(`rerun ${name} rejected: ${problem ?? 'unreadable'}`);
        continue;
      }
      this.enqueueOne(job, { ignoreCooldown: true });
    }
  }

  // A job that will not run: recorded, the review cooldown lifted, and the requester told.
  private fail(job: Job, reason: string, status = 'failed'): void {
    appendEvent(this.dataDir, { kind: job.kind, status, reason, ...(job.mrUrl !== undefined ? { mrUrl: job.mrUrl } : {}), ...(job.messageId !== undefined ? { msgId: job.messageId } : {}), principal: job.principal });
    if (job.kind === 'review' && job.mrUrl !== undefined) this.state.forgetReview(job.mrUrl);
    this.notice(job, failedText(job.kind));
    notify(`audee: ${job.kind} ${status}`, jobKey(job));
  }

  // The queue's runner: one capability session for the job, with every outcome answered.
  async runJob(job: Job, signal: AbortSignal): Promise<RunOutcome> {
    const userId = userIdOf(job.principal);
    const failed = (reason: string, status = 'failed'): RunOutcome => {
      this.fail(job, reason, status);
      return 'done';
    };
    const person = resolvePerson(this.cfg, job.principal);
    const profile = this.cfg.capabilities[job.kind]?.profile;
    const capability = profile === undefined ? undefined : this.capabilities[profile];
    if (person === undefined || capability === undefined) return failed(person === undefined ? 'requester is no longer configured' : `capability ${job.kind} is not configured`);
    if (!isAllowed(person, job.kind)) return failed(`requester is no longer allowed ${job.kind}`);
    if (this.cfg.capabilities[job.kind]?.enabled === false) return failed(`capability ${job.kind} is disabled`);
    appendEvent(this.dataDir, { kind: job.kind, status: 'started', ...(job.mrUrl !== undefined ? { mrUrl: job.mrUrl } : {}), ...(job.messageId !== undefined ? { msgId: job.messageId } : {}), principal: job.principal });
    let outcome: CapabilityOutcome;
    try {
      outcome = await capability({ cfg: this.cfg, job, person, run: this.runAgent, dataDir: this.dataDir, signal, secrets: this.secrets, ...(this.userConfigPath !== undefined ? { userConfigPath: this.userConfigPath } : {}) });
    } catch (e) {
      if (signal.reason instanceof CancelledError) return failed('cancelled by owner', 'cancelled');
      if (e instanceof InterruptedError || signal.aborted) return 'interrupted';
      return failed(e instanceof Error ? e.message : String(e));
    }
    if (outcome.forgetReview !== undefined) this.state.forgetReview(outcome.forgetReview);
    if (outcome.reply !== undefined) {
      try {
        if (outcome.reply.file !== undefined) this.outbox.replyFile(job.chatId, userId, outcome.reply.html, outcome.reply.file.name, outcome.reply.file.content);
        else this.outbox.reply(job.chatId, userId, outcome.reply.html);
        if (outcome.removeAfterReply !== undefined) rmSync(outcome.removeAfterReply, { recursive: true, force: true });
      } catch (e) {
        notify('audee: Teams reply failed', (e as Error).message);
      }
    }
    const event: Event = { ...outcome.event, kind: outcome.event.kind ?? job.kind, status: outcome.event.status ?? 'done', principal: job.principal, ...(job.mrUrl !== undefined ? { mrUrl: job.mrUrl } : {}), ...(job.messageId !== undefined ? { msgId: job.messageId } : {}) };
    appendEvent(this.dataDir, event);
    if (outcome.notifyOwner !== undefined) notify(`audee: ${job.kind}`, outcome.notifyOwner);
    return 'done';
  }
}

export function ensureRerunDir(dataDir: string): void {
  mkdirSync(rerunDir(dataDir), { recursive: true, mode: 0o700 });
}
