// Port of ciel/inbox.go: claim Teams messages the "Ciel inbox" Power Automate flow writes to OneDrive.
import { closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { InterruptedError } from '../runner/run.js';
import type { MessageRecord } from '../state/state.js';
import { outcomeFailed, outcomeRetrying } from '../state/state.js';
import { type ChatMessage, sender } from './message.js';

// What the flow writes for each chat message (contract version 1).
export type InboxFile = {
  version: number;
  chatId: string;
  meId: string;
  message: ChatMessage;
  name: string; // the inbox file name, which keys the message trail
};

// A file that does not decode; the decode error could quote the file's values, so it is never kept.
export class NotInboxJsonError extends Error {
  constructor() {
    super('not a valid inbox file');
    this.name = 'NotInboxJsonError';
  }
}

// An error whose trail reason is fixed text (ciel/watcher.go trailError), never message content.
export class TrailError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'TrailError';
  }
}

export function trailReason(err: unknown): string {
  if (err instanceof TrailError) return err.reason;
  return err instanceof Error ? err.message : String(err);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseInboxFile(raw: string | Buffer): InboxFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    throw new NotInboxJsonError();
  }
  if (!isPlainObject(parsed)) throw new NotInboxJsonError();
  const version = typeof parsed['version'] === 'number' ? parsed['version'] : 0;
  if (version !== 1) throw new Error(`unsupported version ${version}`);
  const chatId = typeof parsed['chatId'] === 'string' ? parsed['chatId'] : '';
  const meId = typeof parsed['meId'] === 'string' ? parsed['meId'] : '';
  const message = isPlainObject(parsed['message']) ? (parsed['message'] as unknown as ChatMessage) : undefined;
  if (chatId === '' || meId === '' || message === undefined || typeof message.id !== 'string' || message.id === '') {
    throw new Error('chatId, meId and message.id are required');
  }
  if (!isPlainObject(message.body)) message.body = {};
  return { version, chatId, meId, message, name: '' };
}

// inbox.go:45-52
export const notReadyForMs = 10 * 60_000; // an unparsable file is left alone in case OneDrive is still syncing it
export const giveUpAfterMs = 30 * 60_000; // how long a claimed file is retried
export const rawRetentionMs = 3 * 24 * 3600_000; // how long handled and rejected files are kept
const giveUpText = 'gave up after 30m0s: '; // Go's duration formatting, kept for the trail

export type Handle = (f: InboxFile, signal: AbortSignal) => Promise<void>;
export type Track = (file: string, update: (r: MessageRecord) => void) => void;

export class Inbox {
  readonly dir: string;
  readonly processing: string;
  readonly failed: string;
  readonly raw: string;
  readonly failingSince = new Map<string, number>();
  private readonly track: Track | undefined;
  private readonly now: () => Date;

  constructor(oneDriveDir: string, dataDir: string, opts: { track?: Track; now?: () => Date } = {}) {
    this.dir = join(oneDriveDir, 'inbox');
    this.processing = join(dataDir, 'processing');
    this.failed = join(dataDir, 'failed');
    this.raw = join(dataDir, 'raw');
    this.track = opts.track;
    this.now = opts.now ?? (() => new Date());
    for (const d of [this.dir, this.processing, this.failed, this.raw]) mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  // Handles every claimed file in message order and returns how many new files it claimed from OneDrive.
  // Files still in processing (from a crash or a failed attempt) are handled again; the handler dedupes them.
  async scan(signal: AbortSignal, handle: Handle): Promise<number> {
    const pending = jsonFiles(this.processing);
    let claimed = 0;
    for (const name of jsonFiles(this.dir)) {
      if (pending.includes(name)) continue; // a claim of the same name is still pending
      if (!this.ready(join(this.dir, name))) continue;
      try {
        moveFile(join(this.dir, name), join(this.processing, name));
      } catch (e) {
        console.error(`claim ${name}: ${(e as Error).message}`);
        continue;
      }
      pending.push(name);
      claimed++;
    }

    const items: Array<{ name: string; file: InboxFile }> = [];
    for (const name of pending) {
      let file: InboxFile;
      try {
        file = parseInboxFile(readFileSync(join(this.processing, name)));
      } catch (e) {
        const reason = e instanceof NotInboxJsonError ? e.message : (e as Error).message;
        this.reject(name, reason);
        continue;
      }
      file.name = name;
      items.push({ name, file });
    }
    items.sort((a, b) => sentAt(a.file.message) - sentAt(b.file.message));

    for (const it of items) {
      const m = it.file.message;
      this.record(it.name, (r) => {
        r.id = m.id;
        r.chatId = it.file.chatId;
        if (m.createdDateTime !== undefined) r.sentAt = m.createdDateTime;
        const s = sender(m);
        if (s !== undefined) r.senderId = s.id;
        r.attempts++;
      });
      let failure: unknown;
      try {
        await handle(it.file, signal);
      } catch (e) {
        failure = e;
      }
      if (signal.aborted || failure instanceof InterruptedError) break; // shutting down: leave the file for the next start
      if (failure !== undefined) {
        this.retryOrReject(it.name, failure);
        continue;
      }
      this.failingSince.delete(it.name);
      // A handled file left in processing would be handled again on every scan, so drop it if it cannot be kept.
      try {
        this.moveStamped(join(this.processing, it.name), join(this.raw, it.name));
      } catch (e) {
        console.error(`keep ${it.name}: ${(e as Error).message}`);
        rmSync(join(this.processing, it.name), { force: true });
      }
    }
    return claimed;
  }

  private record(file: string, update: (r: MessageRecord) => void): void {
    this.track?.(file, update);
  }

  // Deletes kept inbox files older than rawRetention, so colleagues' messages do not pile up.
  expire(now = this.now()): void {
    for (const dir of [this.raw, this.failed]) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        console.error(`list ${dir}: ${(e as Error).message}`);
        continue;
      }
      for (const e of entries) {
        if (!e.isFile()) continue;
        const path = join(dir, e.name);
        let mtime: number;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        if (now.getTime() - mtime < rawRetentionMs) continue;
        try {
          unlinkSync(path);
        } catch (err) {
          console.error(`expire ${e.name}: ${(err as Error).message}`);
        }
      }
    }
  }

  // Whether an inbox file can be claimed. Reading it first also makes File Provider download a cloud-only
  // placeholder; a file that is unreadable or not yet valid JSON waits, unless it has been invalid long enough
  // that it will never become valid.
  private ready(path: string): boolean {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch {
      return false;
    }
    try {
      JSON.parse(raw.toString('utf8'));
      return true;
    } catch {
      try {
        return this.now().getTime() - statSync(path).mtimeMs >= notReadyForMs;
      } catch {
        return false;
      }
    }
  }

  private retryOrReject(name: string, err: unknown): void {
    let first = this.failingSince.get(name);
    if (first === undefined) {
      first = this.now().getTime();
      this.failingSince.set(name, first);
    }
    if (this.now().getTime() - first < giveUpAfterMs) {
      console.error(`inbox file ${name} will be retried: ${trailReason(err)}`);
      this.record(name, (r) => {
        r.outcome = outcomeRetrying;
        r.lastError = trailReason(err);
      });
      return;
    }
    this.failingSince.delete(name);
    this.reject(name, giveUpText + trailReason(err));
  }

  // Moves a file to failed; reason is what the message trail keeps.
  private reject(name: string, reason: string): void {
    console.error(`inbox file ${name} rejected: ${reason}`);
    this.record(name, (r) => {
      r.outcome = outcomeFailed;
      r.reason = reason;
    });
    try {
      this.moveStamped(join(this.processing, name), join(this.failed, name));
    } catch (e) {
      console.error(`move ${name} to failed: ${(e as Error).message}`);
    }
  }

  // Moves a file and sets its modification time to now, which starts its retention.
  private moveStamped(src: string, dst: string): void {
    moveFile(src, dst);
    const now = this.now();
    try {
      utimesSync(dst, now, now);
    } catch (e) {
      console.error(`stamp ${dst}: ${(e as Error).message}`); // the file moved; it may expire early
    }
  }
}

function sentAt(m: ChatMessage): number {
  const t = m.createdDateTime === undefined ? Number.NaN : Date.parse(m.createdDateTime);
  return Number.isNaN(t) ? 0 : t;
}

export function jsonFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error(`list ${dir}: ${(e as Error).message}`);
    return [];
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.')).map((e) => e.name).sort();
}

// Renames src to dst, copying and deleting when they are on different volumes.
export function moveFile(src: string, dst: string): void {
  try {
    renameSync(src, dst);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
  }
  const fd = openSync(dst, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, readFileSync(src));
  } catch (e) {
    closeSync(fd);
    rmSync(dst, { force: true });
    throw e;
  }
  closeSync(fd);
  unlinkSync(src);
}
