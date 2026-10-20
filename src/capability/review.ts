// Port of Ciel's MR review (ciel/actions.go) onto the review profile.
import { expandHome } from '../config/load.js';
import type { Capability as CapabilityConfig } from '../config/schema.js';
import { REVIEW_MCP_SERVERS } from '../fence/constants.js';
import { loadMcpServers } from '../fence/mcp-servers.js';
import { buildOptions } from '../fence/profiles.js';
import { failedReply, firstLine, replyHTML, reviewBlockedReply, reviewReadyWaitReply, reviewUnreviewableReply } from '../render/html.js';
import { InterruptedError, type RunResult } from '../runner/run.js';
import { capabilityConfig, sessionEvent, sessionInput } from './session.js';
import type { Capability, CapabilityOutcome } from './types.js';

// actions.go:20-26
export const unattendedIntro = `

You are running unattended from a chat watcher; nobody can answer questions.
MCP servers may still be starting when this session begins. Before starting the review, run ToolSearch
with "select:mcp__gitlab__list_mrs". If it is not found, run \`sleep 5\` and search again, up to 12 times.
Start the review only once it is found; if it never appears, review anyway and say that GitLab was unavailable.
`;

// actions.go:28-32
export const postFindingsAnswer = `Publishing: the user wants confirmed findings posted on the MR. If the review asks whether to post
them, the answer is "Post review comments on the MR". Post every finding as an inline diff comment on its
file and line (mcp__gitlab__post_review_findings with file and new_line); only a finding whose line is not in the
diff may fall back to a general note. Then add one summary comment (mcp__gitlab__comment_mr).
If you end up posting nothing on the MR (for example a rule says to post nothing), still post one short comment
with mcp__gitlab__comment_mr saying the review ran and why nothing was posted, unless GitLab is unreachable.
That comment does not count as posting: finish with "REVIEW_POSTED: no: <the same reason>".
`;

// actions.go:34-36
export const reportOnlyAnswer = `Publishing: the user wants findings kept off the MR. If the review asks whether to post them,
the answer is "Leave it report-only"; do not post findings any other way.
`;

// actions.go:38-41
export const ticketUnavailable = `If the Jira ticket cannot be read (for example the Atlassian connector needs authorization), that alone
does not make the code review untrustworthy: judge the MR on the code review and post as you would for that result.
In the acknowledgement or summary, replace the ticket line with "_Ticket <key> not checked (<reason>)._".
`;

// actions.go:43-46
export const unattendedOutro = `If any other step would ask the user something, take the option that posts nothing extra.
Never approve or merge the MR yourself; only report its status.
Finish your answer with exactly two final lines.
First: "REVIEW_STATUS: ready: <reason>" only when the review skill judged the MR clean (its clean: true, acknowledgement posted),
"REVIEW_STATUS: blocked: <reason>" when there are findings, lint blocks, ticket gaps or an audit objection,
otherwise "REVIEW_STATUS: unreviewable: <reason>". The reason is at most 15 words, in Vietnamese, naming the main blocker
categories with counts (for example "2 lỗi blocker, ticket thiếu tiêu chí AC-3"), with no links.
Last: "REVIEW_POSTED: yes" if you posted anything on the MR (inline comments, a summary or an acknowledgement),
or if the review skipped the acknowledgement because one for the same head commit already exists,
otherwise "REVIEW_POSTED: no: <short reason>".`;

export const reviewPostedMarker = 'REVIEW_POSTED:';
export const maxStatusReasonWords = 15;

export type ReviewStatus = 'ready' | 'blocked' | 'unreviewable';
export type ReviewResult = { posted: boolean; reason: string; status: ReviewStatus; statusReason: string };

const clipWords = (s: string, n: number): string => s.trim().split(/\s+/).filter((w) => w !== '').slice(0, n).join(' ');

const statusLine = /^REVIEW_STATUS:\s*(ready|blocked|unreviewable)\s*(?::\s*(.*))?$/i;

// Only the session's own closing lines count: the status must be the line right before the final REVIEW_POSTED
// line, so a status quoted from MR text earlier in the output cannot pass. Anything else is unreviewable, and
// ready without anything posted cannot be trusted as clean.
function reviewStatus(text: string, posted: boolean, reason: string): { status: ReviewStatus; statusReason: string } {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const m = statusLine.exec(lines.at(-2) ?? '');
  if (!(lines.at(-1) ?? '').startsWith(reviewPostedMarker) || m === null) {
    return { status: 'unreviewable', statusReason: posted ? 'the review did not report a status' : reason };
  }
  const status = (m[1] ?? '').toLowerCase() as ReviewStatus;
  if (status === 'ready' && !posted) return { status: 'unreviewable', statusReason: reason };
  return { status, statusReason: clipWords(m[2] ?? '', maxStatusReasonWords) };
}

// actions.go:319-325
export function reviewPrompt(template: string, mrUrl: string, postFindings: boolean): string {
  const answer = postFindings ? postFindingsAnswer : reportOnlyAnswer;
  return template.replaceAll('{url}', mrUrl) + unattendedIntro + answer + ticketUnavailable + unattendedOutro;
}

// config.go reviewPromptTemplate: the prompt of the first route matching mrUrl, or the default prompt.
export function reviewPromptTemplate(cap: CapabilityConfig, mrUrl: string): string {
  for (const r of cap.routes) if (new RegExp(r.match).test(mrUrl)) return r.prompt;
  return cap.prompt ?? '/apo-review-mr {url}';
}

// actions.go:356-388 parseReviewOutput, reading RunResult.text
export function parseReviewOutput(result: RunResult): ReviewResult {
  if (result.isError) throw new Error(`review reported an error: ${firstLine(result.text)}`);
  const text = result.text;
  const i = text.lastIndexOf(reviewPostedMarker);
  if (i < 0) return { posted: false, reason: 'the review did not say whether it posted anything', ...reviewStatus(text, false, 'the review did not say whether it posted anything') };
  const answer = firstLine(text.slice(i + reviewPostedMarker.length)).trim();
  if (answer.toLowerCase().startsWith('yes')) return { posted: true, reason: '', ...reviewStatus(text, true, '') };
  let reason = answer;
  if (reason.toLowerCase().startsWith('no')) reason = reason.slice(2).trim().replace(/^:/, '').trim();
  if (reason === '') reason = 'no reason given';
  return { posted: false, reason, ...reviewStatus(text, false, reason) };
}

export const review: Capability = async (ctx) => {
  const cap = capabilityConfig(ctx);
  const mrUrl = ctx.job.mrUrl ?? '';
  const started = Date.now();
  const fail = (reason: string, result?: RunResult): CapabilityOutcome => ({
    reply: { html: replyHTML(failedReply, mrUrl) },
    notifyOwner: `review failed: ${mrUrl}`,
    forgetReview: mrUrl,
    event: { ...sessionEvent(result, Date.now() - started), kind: 'review', status: 'failed', reason, mrUrl },
  });
  let options;
  try {
    options = buildOptions({
      profile: 'review', cwd: expandHome(cap.workdir ?? '~/.claude/kb'),
      mcpServers: loadMcpServers(REVIEW_MCP_SERVERS, ctx.secrets, ctx.userConfigPath),
      model: cap.model, ...(cap.budget_usd !== undefined ? { budgetUsd: cap.budget_usd } : {}), seatbelt: cap.seatbelt,
    });
  } catch (e) {
    return fail((e as Error).message);
  }
  const prompt = reviewPrompt(reviewPromptTemplate(cap, mrUrl), mrUrl, cap.post_findings);
  let result: RunResult;
  try {
    result = await ctx.run(sessionInput(ctx, cap, options, prompt));
  } catch (e) {
    if (e instanceof InterruptedError) throw e;
    return fail((e as Error).message);
  }
  let res: ReviewResult;
  try {
    res = parseReviewOutput(result);
  } catch (e) {
    return fail((e as Error).message, result);
  }
  const base = { ...sessionEvent(result, Date.now() - started), kind: 'review', mrUrl };
  const secrets = Object.values(ctx.secrets);
  const html = res.status === 'ready' ? reviewReadyWaitReply(res.statusReason, secrets)
    : res.status === 'blocked' ? reviewBlockedReply(res.statusReason, secrets, res.posted)
    : reviewUnreviewableReply(res.statusReason, secrets);
  return {
    reply: { html: replyHTML(html, mrUrl) },
    notifyOwner: `review ${res.status}: ${mrUrl}`,
    event: { ...base, status: res.status, reason: res.statusReason },
  };
};
