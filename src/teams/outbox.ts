// Port of ciel/outbox.go: hand replies to the "Ciel outbox" Power Automate flow, which posts them in Teams.
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { moveFile } from './inbox.js';

export type ReplyFile = { version: 1; chatId: string; mentionUserId: string; html: string; file?: { name: string; content: string } };

export class Outbox {
  // dir is the folder the flow watches (OneDrive /Ciel/outbox, or a shadow folder); tmp is local.
  constructor(readonly dir: string, readonly tmp: string) {
    for (const d of [dir, tmp]) mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  static forOneDrive(oneDriveDir: string, dataDir: string): Outbox {
    return new Outbox(join(oneDriveDir, 'outbox'), join(dataDir, 'tmp'));
  }

  // Posts html in the chat, preceded by an @mention of userId.
  reply(chatId: string, userId: string, html: string): void {
    this.write({ version: 1, chatId, mentionUserId: userId, html });
  }

  // reply plus a file: the flow saves content as name in OneDrive /Ciel/files and appends a share link to html.
  replyFile(chatId: string, userId: string, html: string, name: string, content: string): void {
    this.write({ version: 1, chatId, mentionUserId: userId, html, file: { name, content } });
  }

  // Written outside OneDrive and moved in whole, so the flow never picks up a partial file.
  private write(reply: ReplyFile): void {
    const name = randomBytes(16).toString('hex') + '.json';
    const tmp = join(this.tmp, name);
    writeFileSync(tmp, encode(reply), { mode: 0o600 });
    try {
      moveFile(tmp, join(this.dir, name));
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
}

// Byte-compatible with Ciel's Go encoder: keys sorted at every level, and <, >, &, U+2028 and U+2029 escaped
// as Go's json.Marshal escapes them.
export function encode(reply: ReplyFile): string {
  return JSON.stringify(sortKeys(reply)).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  return sorted;
}
