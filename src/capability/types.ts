import type { Person } from '../authz/people.js';
import type { Config } from '../config/schema.js';
import type { Event } from '../events.js';
import type { Job } from '../queue/job.js';
import type { runAgent } from '../runner/run.js';

export type Reply = { html: string; file?: { name: string; content: string } };

export type CapabilityContext = {
  cfg: Config;
  job: Job;
  person: Person;
  run: typeof runAgent; // injected so tests replace it with a fake returning a canned RunResult
  dataDir: string;
  signal: AbortSignal; // shutdown; passed to runAgent
  secrets: Record<string, string>; // keychain_env values, for loadMcpServers only
  userConfigPath?: string; // tests only: a fake ~/.claude.json
};

export type CapabilityOutcome = {
  reply?: Reply;
  notifyOwner?: string;
  forgetReview?: string;
  removeAfterReply?: string; // a scratch folder the watcher deletes once the reply was delivered
  event: Partial<Event>;
};

export type Capability = (ctx: CapabilityContext) => Promise<CapabilityOutcome>;
