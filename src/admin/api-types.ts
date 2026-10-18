// The admin API contract, shared by the daemon (src/admin) and the web UI (web/). Every route needs
// `Authorization: Bearer <token>` (the token from `audee dashboard`); errors are { error, problems? } with a 4xx/5xx status.

export type JobView = {
  kind: string;
  key: string; // MR url for a review, Teams message id for anything else
  chatId: string;
  principal: string;
  personName?: string;
  requesterName: string;
  mrUrl?: string;
  messageId?: string;
  input?: string; // the request text; owner-only view of what state.json already holds
  requestedAt: string;
  startedAt?: string; // running jobs only
};

export type LaneView = { name: string; concurrency: number; buffer: number; running: JobView[]; queued: JobView[] };

export type DayStat = { day: string; costUsd: number; runs: number; failures: number; classified: number };
export type KindStat = { kind: string; runs: number; failures: number; costUsd: number; avgDurationMs: number };
export type PersonStat = { principal: string; personName?: string; runs: number; costUsd: number };

// GET /api/overview
export type Overview = {
  pid: number;
  startedAt: string;
  reloadedAt: string;
  reloadError?: string; // the last reload failed; the previous config is still running
  mode: 'live' | 'shadow';
  paused: boolean;
  maxConcurrent: number;
  lanes: LaneView[];
  lastInboxAt?: string;
  configPath: string;
  dataDir: string;
  totals: { cost24h: number; cost7d: number; costAll: number; runs24h: number; failures24h: number; classified24h: number; avgDurationMs24h: number };
  daily: DayStat[]; // last 14 days, oldest first, local dates
  byKind: KindStat[]; // last 7 days
  byPerson: PersonStat[]; // last 7 days
};

export type EventRow = {
  ts: string;
  kind: string;
  status: string;
  reason?: string;
  msgId?: string;
  mrUrl?: string;
  principal?: string;
  personName?: string;
  intent?: string;
  addressed?: boolean;
  mrs?: number;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  shadow?: boolean;
  allowed?: boolean;
  toolUses?: string[];
  denials?: string[];
  token?: boolean;
};

// GET /api/events?kind=&status=&q=&from=&to=&limit=&offset=   (newest first; from/to are ISO times)
export type EventsPage = { total: number; rows: EventRow[]; kinds: string[]; statuses: string[] };

export type MessageRow = {
  file: string;
  id?: string;
  chatId?: string;
  senderId?: string;
  personName?: string;
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

// GET /api/messages?outcome=&q=&limit=&offset=   (newest first)
export type MessagesPage = { total: number; rows: MessageRow[]; outcomes: string[] };

// GET /api/requests?q=   (requests that can be retried, newest first)
export type RequestsPage = { rows: Array<JobView & { inflight: boolean }> };

// POST /api/jobs/cancel   { kind, key }
export type JobRef = { kind: string; key: string };
export type CancelResult = { result: 'cancelled' | 'removed' | 'not_found' };
// POST /api/jobs/retry   { kind, key }
export type RetryResult = { result: 'queued' | 'duplicate' | 'limit' | 'cooldown' | 'busy' };
// POST /api/queue/pause   { paused }
export type PauseResult = { paused: boolean };

export type Check = { name: string; ok: boolean; detail: string };
// GET /api/doctor
export type DoctorResult = { checks: Check[] };

export type ConfigMeta = {
  profiles: string[];
  readOnlyMcpTools: Record<string, string[]>; // the only MCP tools an mcp_read capability may list
  models: string[]; // suggestions; any model id is accepted
  efforts: string[];
  weekdays: string[];
  builtinCapabilities: string[]; // review, code_mapping, kb_query: names with built-in defaults
};

// GET /api/config
// raw: config.yaml as written (no defaults); effective: after defaults (durations in ms). Edit through ops on raw.
export type ConfigView = { path: string; text: string; raw: Record<string, unknown>; effective: Record<string, unknown>; backups: string[]; meta: ConfigMeta };

// One edit of config.yaml at a path such as ['capabilities', 'review', 'model']; delete removes the key or item.
export type ConfigOp = { path: Array<string | number>; value?: unknown; delete?: true };

// PATCH /api/config { ops } applies, backs up, writes and reloads. POST /api/config/validate { ops } only checks.
// 400 with { error, problems } when the result is invalid; the file is then untouched.
export type ConfigApplyResult = { ok: true; reloaded: boolean; checks: Check[]; backup?: string };

// POST /api/reload: re-read config.yaml from disk and restart the watcher.
export type ReloadResult = { ok: boolean; error?: string };

export type ApiError = { error: string; problems?: string[] };
