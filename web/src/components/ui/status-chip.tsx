const DANGER = ['failed', 'error', 'errored', 'crashed', 'rejected'];
const WARN = ['cancelled', 'canceled', 'timeout', 'timed_out', 'denied', 'skipped', 'limit', 'cooldown', 'busy', 'duplicate', 'over_budget', 'removed'];
const OK = ['done', 'posted', 'classified', 'completed', 'ok', 'handled', 'answered', 'replied', 'success', 'queued_ok', 'not_known'];
const INFO = ['started', 'running', 'queued', 'pending', 'claimed', 'retrying'];

export function toneOf(status: string): 'danger' | 'warn' | 'ok' | 'info' | 'plain' {
  const s = status.toLowerCase();
  if (DANGER.includes(s)) return 'danger';
  if (WARN.includes(s)) return 'warn';
  if (OK.includes(s)) return 'ok';
  if (INFO.includes(s)) return 'info';
  return 'plain';
}

export function StatusChip({ status }: { status: string }) {
  const tone = toneOf(status);
  return <span className={`chip ${tone === 'plain' ? '' : `chip-${tone}`}`}>{status}</span>;
}
