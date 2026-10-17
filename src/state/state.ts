// Port of ciel/state.go. Go's mutex becomes plain sequential code: every write is synchronous and
// saved by write-to-temp-then-rename in the same folder, so a crash never leaves a half-written file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Job, jobKey, sameJob } from '../queue/job.js';

export const maxSeenMessages = 1000;
export const maxMessageRows = 1000;

// Message outcomes (state.go:35-41). A row is open while processing or retrying.
export const outcomeProcessing = 'processing';
export const outcomeRetrying = 'retrying';
export const outcomeSkipped = 'skipped';
export const outcomeClassified = 'classified';
export const outcomeFailed = 'failed';

// One row of the message trail; it holds no message text or names (state.go:45-60).
export type MessageRecord = {
  file: string;
  id?: string;
  chatId?: string;
  senderId?: string;
  sentAt?: string;
  claimedAt: string;
  updatedAt: string;
  outcome: string;
  reason?: string;
  intent?: string;
  addressed?: boolean;
  mrUrls?: string[];
  attempts: number;
  lastError?: string;
};

export const isOpen = (r: MessageRecord): boolean => r.outcome === outcomeProcessing || r.outcome === outcomeRetrying;

// The part of an earlier chat message the classifier needs as context (state.go:88-93).
export type HistoryEntry = {
  principal: string;
  at: string; // ISO time
  text: string;
  mentionsMe: boolean;
};

type Persisted = {
  seen: string[];
  shadowSeen: string[];
  reviews: Record<string, string>; // MR url -> last review start (ISO)
  history: Record<string, HistoryEntry[]>; // chat id -> recent messages, oldest first
  lastInboxAt?: string;
  jobs: Job[]; // queued or running, so a restart resumes them
  requests: Record<string, Job>; // job key -> latest request, for `audee rerun`
  messages: MessageRecord[]; // what happened to each claimed inbox file, oldest first
};

export class State {
  readonly path: string;
  seen: string[] = [];
  shadowSeen: string[] = [];
  reviews: Record<string, string> = {};
  history: Record<string, HistoryEntry[]> = {};
  lastInboxAt?: string;
  jobs: Job[] = [];
  requests: Record<string, Job> = {};
  messages: MessageRecord[] = [];

  constructor(path: string) {
    this.path = path;
  }

  trackMessage(file: string, update: (r: MessageRecord) => void, now = new Date()): void {
    if (file === '') return; // not from an inbox file, so nothing to trace back to
    const at = now.toISOString();
    let i = this.messages.findIndex((r) => r.file === file && isOpen(r));
    if (i < 0) {
      this.messages.push({ file, claimedAt: at, updatedAt: at, outcome: outcomeProcessing, attempts: 0 });
      if (this.messages.length > maxMessageRows) this.messages = this.messages.slice(-maxMessageRows);
      i = this.messages.length - 1;
    }
    const row = this.messages[i];
    if (row === undefined) return;
    update(row);
    row.updatedAt = at;
    this.save();
  }

  hasSeen(msgId: string): boolean {
    return this.seen.includes(msgId);
  }

  markSeen(msgId: string): void {
    this.markSeenUnsaved(msgId);
    this.save();
  }

  // Marks the message handled and adds it to the chat's history in one save (state.go:141-152).
  record(chatId: string, msgId: string, e: HistoryEntry, size: number): void {
    this.markSeenUnsaved(msgId);
    const h = [...(this.history[chatId] ?? []), e].sort((a, b) => a.at.localeCompare(b.at));
    this.history[chatId] = h.length > size ? h.slice(-size) : h;
    this.save();
  }

  private markSeenUnsaved(msgId: string): void {
    this.seen.push(msgId);
    if (this.seen.length > maxSeenMessages) this.seen = this.seen.slice(-maxSeenMessages);
  }

  hasShadowSeen(msgId: string): boolean {
    return this.shadowSeen.includes(msgId);
  }

  markShadowSeen(msgId: string): void {
    this.shadowSeen.push(msgId);
    if (this.shadowSeen.length > maxSeenMessages) this.shadowSeen = this.shadowSeen.slice(-maxSeenMessages);
    this.save();
  }

  chatHistory(chatId: string): HistoryEntry[] {
    return [...(this.history[chatId] ?? [])];
  }

  inboxArrived(t: Date): void {
    this.lastInboxAt = t.toISOString();
    this.save();
  }

  lastInbox(): Date | undefined {
    return this.lastInboxAt === undefined ? undefined : new Date(this.lastInboxAt);
  }

  // Reports false when the same MR was reviewed within the cooldown (state.go:181-190).
  startReview(url: string, cooldownMs: number, now = new Date()): boolean {
    const last = this.reviews[url];
    if (last !== undefined && now.getTime() - new Date(last).getTime() < cooldownMs) return false;
    this.reviews[url] = now.toISOString();
    this.save();
    return true;
  }

  addJob(job: Job): void {
    this.jobs.push(job);
    this.save();
  }

  removeJob(job: Job): void {
    const i = this.jobs.findIndex((j) => sameJob(j, job));
    if (i >= 0) {
      this.jobs.splice(i, 1);
      this.save();
    }
  }

  pendingJobs(): Job[] {
    return [...this.jobs];
  }

  // Lifts the cooldown so a failed review can be requested again.
  forgetReview(url: string): void {
    delete this.reviews[url];
    this.save();
  }

  recordRequest(job: Job): void {
    this.requests[jobKey(job)] = job;
    this.save();
  }

  // Forgets requests that carry message text and were made before cutoff.
  pruneRequests(cutoff: Date): void {
    const before = Object.keys(this.requests).length;
    for (const [key, j] of Object.entries(this.requests)) {
      if (j.input !== undefined && j.input !== '' && new Date(j.requestedAt).getTime() < cutoff.getTime()) delete this.requests[key];
    }
    if (Object.keys(this.requests).length !== before) this.save();
  }

  // The recorded request, or, for an MR url, the earliest remembered message containing it (state.go:242-262).
  findRequest(key: string): Job | undefined {
    const recorded = this.requests[key];
    if (recorded !== undefined) return recorded;
    if (!key.includes('/-/merge_requests/')) return undefined;
    let found: Job | undefined;
    let at: string | undefined;
    for (const [chatId, entries] of Object.entries(this.history)) {
      for (const e of entries) {
        if (e.text.includes(key) && (at === undefined || e.at < at)) {
          at = e.at;
          found = { kind: 'review', channel: 'teams', chatId, principal: e.principal, requesterName: '', mrUrl: key, requestedAt: e.at };
        }
      }
    }
    return found;
  }

  save(): void {
    const data: Persisted = {
      seen: this.seen, shadowSeen: this.shadowSeen, reviews: this.reviews, history: this.history,
      ...(this.lastInboxAt !== undefined ? { lastInboxAt: this.lastInboxAt } : {}),
      jobs: this.jobs, requests: this.requests, messages: this.messages,
    };
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export function loadState(dataDir: string): State {
  mkdirSync(dataDir, { recursive: true });
  const s = new State(join(dataDir, 'state.json'));
  if (!existsSync(s.path)) return s;
  const raw = JSON.parse(readFileSync(s.path, 'utf8')) as Partial<Persisted>;
  s.seen = raw.seen ?? [];
  s.shadowSeen = raw.shadowSeen ?? [];
  s.reviews = raw.reviews ?? {};
  s.history = raw.history ?? {};
  if (raw.lastInboxAt !== undefined) s.lastInboxAt = raw.lastInboxAt;
  s.jobs = raw.jobs ?? [];
  s.requests = raw.requests ?? {};
  s.messages = raw.messages ?? [];
  return s;
}
