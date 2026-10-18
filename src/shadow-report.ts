// Compares shadow classifications with Ciel's, joined on message id, on normalised events.
import { existsSync, readFileSync } from 'node:fs';

type Raw = Record<string, unknown>;

export type Normalised = { msgId: string; addressed: boolean; intent: string; allowed: boolean | undefined; ts: string };

export function readEvents(path: string): Raw[] {
  if (!existsSync(path)) return [];
  const out: Raw[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v === 'object' && v !== null) out.push(v as Raw);
    } catch {
      // a partial last line is ignored
    }
  }
  return out;
}

// Ciel writes classify events with omitempty: a missing `addressed` is false and a missing `intent` is "".
function normalise(e: Raw): Normalised | undefined {
  const msgId = typeof e['msg_id'] === 'string' ? e['msg_id'] : '';
  if (msgId === '') return undefined;
  return {
    msgId,
    addressed: e['addressed'] === true,
    intent: typeof e['intent'] === 'string' ? e['intent'] : '',
    allowed: typeof e['allowed'] === 'boolean' ? e['allowed'] : undefined,
    ts: typeof e['ts'] === 'string' ? e['ts'] : '',
  };
}

function lastPerMessage(events: Raw[], keep: (e: Raw) => boolean, since: string | undefined): Map<string, Normalised> {
  const out = new Map<string, Normalised>();
  for (const e of events) {
    if (e['kind'] !== 'classify' || !keep(e)) continue;
    const n = normalise(e);
    if (n === undefined) continue;
    if (since !== undefined && n.ts !== '' && n.ts < since) continue;
    out.set(n.msgId, n); // file order is time order, so the last one wins
  }
  return out;
}

export type ShadowReport = { compared: number; agreeing: number; wouldBeDenied: number; lines: string[] };

export function shadowReport(cielEventsPath: string, audeeEventsPath: string, since?: string): ShadowReport {
  const ciel = lastPerMessage(readEvents(cielEventsPath), (e) => e['status'] !== 'failed' && e['shadow'] !== true, since);
  const audee = lastPerMessage(readEvents(audeeEventsPath), (e) => e['shadow'] === true && e['token'] !== true && e['status'] !== 'failed', since);
  let compared = 0;
  let agreeing = 0;
  let wouldBeDenied = 0;
  for (const [msgId, c] of ciel) {
    const a = audee.get(msgId);
    if (a === undefined) continue;
    compared++;
    if (a.addressed === c.addressed && a.intent === c.intent) agreeing++;
    if (c.addressed && a.allowed === false) wouldBeDenied++;
  }
  const pct = compared === 0 ? '0.0' : ((agreeing / compared) * 100).toFixed(1);
  return { compared, agreeing, wouldBeDenied, lines: [`compared: ${compared}`, `agreement: ${agreeing}/${compared} (${pct}%)`, `would be denied: ${wouldBeDenied}`] };
}
