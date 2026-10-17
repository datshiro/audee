// Based on Job in ciel/actions.go:106-124.
export type Job = {
  kind: string; // capability name: review | code_mapping | kb_query | <mcp_read capability>
  channel: 'teams'; // 'telegram' later
  chatId: string;
  principal: string; // teams:<sender-id>
  requesterName: string;
  mrUrl?: string;
  messageId?: string;
  input?: string;
  requestedAt: string; // ISO time
};

// The request's identity: the MR for a review, the asking message for anything else (ciel Job.key).
export function jobKey(j: Job): string {
  return j.kind === 'review' ? (j.mrUrl ?? '') : (j.messageId ?? '');
}

export function sameJob(a: Job, b: Job): boolean {
  return a.kind === b.kind && jobKey(a) === jobKey(b);
}
