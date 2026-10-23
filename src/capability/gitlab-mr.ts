// Approving a clean MR as the owner. audee decides here, in code; the review session never approves.
// GitLab is reached through the user's glab-mcp server, so the token stays inside that process.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadMcpServers } from '../fence/mcp-servers.js';

export type MrInfo = { iid: number; state: string; sha: string; author_username: string; web_url: string; user_has_approved: boolean; user_can_approve: boolean };
export type MrRef = { project: string; iid: number };
export type GitLabMr = {
  getMr(ref: MrRef): Promise<MrInfo>;
  hasPassAck(ref: MrRef, sha: string, ownerGitlab: string): Promise<boolean>;
  approve(ref: MrRef, sha: string): Promise<void>;
  comment(ref: MrRef, body: string): Promise<void>;
  close(): Promise<void>;
};
export type ApprovalDecision = { approve: true; sha: string } | { approve: false; why: string };

export function mrRef(mrUrl: string): MrRef {
  const m = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/.exec(mrUrl);
  if (m === null) throw new Error('not a GitLab merge request URL');
  return { project: m[1] ?? '', iid: Number(m[2]) };
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// Checked in this order; the first refusal is the reason the requester sees.
export function approvalDecision(i: {
  autoApprove: boolean; status: string; before?: MrInfo; after?: MrInfo; ackFound: boolean;
  requesterGitlab?: string; ownerGitlab?: string; statusReason: string;
}): ApprovalDecision {
  if (!i.autoApprove || i.status !== 'ready') return { approve: false, why: i.statusReason };
  const { before, after } = i;
  if (before === undefined || after === undefined) return { approve: false, why: 'không gọi được GitLab' };
  if (after.state !== 'opened') return { approve: false, why: 'MR không còn mở' };
  if (before.sha !== after.sha) return { approve: false, why: 'MR có commit mới sau khi review' };
  if (i.ownerGitlab === undefined) return { approve: false, why: 'chưa map tài khoản GitLab của Đạt' };
  if (!i.ackFound) return { approve: false, why: 'chưa thấy xác nhận PASS trên MR' };
  if (i.requesterGitlab === undefined) return { approve: false, why: 'chưa map tài khoản GitLab của bạn' };
  if (same(i.requesterGitlab, after.author_username)) return { approve: false, why: 'bạn là tác giả MR' };
  if (same(i.ownerGitlab, after.author_username)) return { approve: false, why: 'MR của Đạt, cần người khác approve' };
  if (!after.user_can_approve) return { approve: false, why: 'tài khoản Đạt không approve được MR này' };
  if (after.user_has_approved) return { approve: false, why: 'Đạt đã approve trước đó' };
  return { approve: true, sha: after.sha };
}

type Note = { body?: unknown; author?: { username?: unknown } };

// The skill's clean acknowledgement for this head, written by the owner's account (the session posts as the owner).
// Matching the body alone would let the MR author forge it.
export function noteHasPassAck(note: Note, sha: string, ownerGitlab: string): boolean {
  const body = typeof note.body === 'string' ? note.body : '';
  const author = typeof note.author?.username === 'string' ? note.author.username : '';
  return same(author, ownerGitlab) && body.includes('Verdict: PASS') && body.includes('head `' + sha.slice(0, 10) + '`');
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const timeoutMs = 60_000;
const maxDiscussionPages = 10;

function asMrInfo(v: unknown): MrInfo {
  if (!isPlainObject(v)) throw new Error('get_mr returned an unexpected shape');
  const { iid, state, sha, author_username, web_url, user_has_approved, user_can_approve } = v;
  if (typeof iid !== 'number' || typeof state !== 'string' || typeof sha !== 'string' || sha === '' || typeof author_username !== 'string' || author_username === ''
    || typeof web_url !== 'string' || typeof user_has_approved !== 'boolean' || typeof user_can_approve !== 'boolean') {
    throw new Error('get_mr returned an unexpected shape');
  }
  return { iid, state, sha, author_username, web_url, user_has_approved, user_can_approve };
}

// Starts the user's gitlab MCP server. Never log its definition: its env and args hold tokens.
export async function connectGitLabMr(secrets: Record<string, string>, userConfigPath?: string, signal?: AbortSignal): Promise<GitLabMr> {
  const def = loadMcpServers(['gitlab'], secrets, userConfigPath)['gitlab'];
  if (def === undefined || !('command' in def) || typeof def.command !== 'string') throw new Error('gitlab MCP server has no command');
  const transport = new StdioClientTransport({
    command: def.command,
    args: def.args ?? [],
    env: { ...getDefaultEnvironment(), ...(def.env ?? {}) },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'audee', version: '1.0.0' });
  const options = { timeout: timeoutMs, ...(signal !== undefined ? { signal } : {}) };
  await client.connect(transport, options);
  // The tool's text is never put in an error: it may echo request details.
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const r = (await client.callTool({ name, arguments: args }, undefined, options)) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    const text = r.content?.[0]?.text;
    if (r.isError === true || typeof text !== 'string') throw new Error(`${name} failed`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${name} returned an unexpected shape`);
    }
  };
  return {
    getMr: async (ref) => asMrInfo(await call('get_mr', { project_id: ref.project, mr_iid: ref.iid })),
    hasPassAck: async (ref, sha, ownerGitlab) => {
      for (let page = 1; page <= maxDiscussionPages; page++) {
        const discussions = await call('list_mr_discussions', { project_id: ref.project, mr_iid: ref.iid, page, per_page: 100 });
        if (!Array.isArray(discussions)) throw new Error('list_mr_discussions returned an unexpected shape');
        for (const d of discussions) {
          const notes: unknown = isPlainObject(d) ? d['notes'] : undefined;
          if (Array.isArray(notes) && notes.some((n) => isPlainObject(n) && noteHasPassAck(n as Note, sha, ownerGitlab))) return true;
        }
        if (discussions.length < 100) return false;
      }
      return false;
    },
    approve: async (ref, sha) => { await call('approve_mr', { project_id: ref.project, mr_iid: ref.iid, sha }); },
    comment: async (ref, body) => { await call('comment_mr', { project_id: ref.project, mr_iid: ref.iid, body }); },
    close: async () => { await client.close(); },
  };
}
