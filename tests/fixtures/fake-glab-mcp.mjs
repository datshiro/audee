// A stand-in for glab-mcp over stdio. Appends each tool call to $FAKE_GLAB_LOG as one JSON line.
// FAKE_GLAB_MODE=error makes every tool return isError.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const log = (name, args) => appendFileSync(process.env.FAKE_GLAB_LOG, JSON.stringify({ name, args }) + '\n');
const reply = (value) => (process.env.FAKE_GLAB_MODE === 'error'
  ? { isError: true, content: [{ type: 'text', text: 'GitLab API error 500 token=never-shown' }] }
  : { content: [{ type: 'text', text: JSON.stringify(value) }] });
const ref = { project_id: z.union([z.number(), z.string()]), mr_iid: z.coerce.number() };

const server = new McpServer({ name: 'fake-glab', version: '0.0.0' });
server.registerTool('get_mr', { inputSchema: ref }, async (args) => {
  log('get_mr', args);
  return reply({ iid: args.mr_iid, state: 'opened', sha: '0123456789abcdef', author_username: 'author', web_url: 'u', user_has_approved: false, user_can_approve: true });
});
// Page 1 is full of unrelated discussions, so the ack is only found by reading page 2.
server.registerTool('list_mr_discussions', { inputSchema: { ...ref, page: z.number().optional(), per_page: z.number().optional() } }, async (args) => {
  log('list_mr_discussions', args);
  if (args.page === 1) return reply(Array.from({ length: 100 }, () => ({ notes: [{ body: 'lgtm', author: { username: 'kha' } }] })));
  return reply([{ notes: [{ body: '**Verdict: PASS — no confirmed findings** (head `0123456789`, base `aaaaaaaaaa` = main)', author: { username: 'dat' } }] }]);
});
server.registerTool('approve_mr', { inputSchema: { ...ref, sha: z.string().optional() } }, async (args) => {
  log('approve_mr', args);
  return reply({ approved: true });
});
server.registerTool('comment_mr', { inputSchema: { ...ref, body: z.string() } }, async (args) => {
  log('comment_mr', args);
  return reply({ id: 1 });
});
await server.connect(new StdioServerTransport());
