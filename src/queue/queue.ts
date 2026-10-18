import { setMaxListeners } from 'node:events';
import type { Config } from '../config/schema.js';
import type { State } from '../state/state.js';
import { type Job, jobKey, sameJob } from './job.js';

export type RunOutcome = 'done' | 'interrupted';
export type EnqueueResult = 'queued' | 'duplicate' | 'limit' | 'cooldown' | 'busy';
export type CancelResult = 'cancelled' | 'removed' | 'not_found';
export type LaneSnapshot = { name: string; concurrency: number; buffer: number; running: Array<{ job: Job; startedAt: Date }>; queued: Job[] };

// The abort reason of a job the owner stopped, so the runner can tell it from a shutdown (which keeps the job).
export class CancelledError extends Error {
  constructor() {
    super('cancelled by owner');
    this.name = 'CancelledError';
  }
}
export type Runner = (job: Job, signal: AbortSignal) => Promise<RunOutcome>;

export const reviewCooldownMs = 30 * 60 * 1000; // ciel/actions.go:18 reviewCooldown
const defaultMaxInflight = 2;

type Lane = { name: string; concurrency: number; buffer: number; queued: Job[]; running: number };

export class Queue {
  private readonly lanes: Lane[];
  private readonly running = new Map<Job, { controller: AbortController; startedAt: Date }>();
  private readonly settled: Promise<void>[] = [];
  private controller = new AbortController();
  private stopping = true;
  private cursor = 0;

  constructor(
    private readonly cfg: Config,
    private readonly state: State,
    private readonly run: Runner,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.lanes = Object.entries(cfg.concurrency.lanes).map(([name, l]) => ({ name, concurrency: l.concurrency, buffer: l.buffer, queued: [], running: 0 }));
    setMaxListeners(4 * cfg.concurrency.max_concurrent + 8, this.controller.signal);
  }

  private lane(job: Job): Lane {
    const name = this.cfg.capabilities[job.kind]?.lane;
    const lane = this.lanes.find((l) => l.name === name);
    if (lane === undefined) throw new Error(`job kind ${job.kind} has no lane`);
    return lane;
  }

  private inflight(match: (j: Job) => boolean): number {
    let n = 0;
    for (const lane of this.lanes) n += lane.queued.filter(match).length;
    for (const j of this.running.keys()) if (match(j)) n++;
    return n;
  }

  enqueue(job: Job, opts: { ignoreCooldown?: boolean } = {}): EnqueueResult {
    const lane = this.lane(job);
    if (this.inflight((j) => sameJob(j, job))) return 'duplicate';
    const person = this.cfg.people.find((p) => p.ids.includes(job.principal));
    const maxInflight = person?.max_inflight ?? defaultMaxInflight;
    if (this.inflight((j) => j.principal === job.principal) >= maxInflight) return 'limit';
    const perKind = this.cfg.capabilities[job.kind]?.per_person_limit;
    if (perKind !== undefined && this.inflight((j) => j.principal === job.principal && j.kind === job.kind) >= perKind) return 'limit';
    if (job.kind === 'review' && opts.ignoreCooldown !== true && !this.state.startReview(jobKey(job), reviewCooldownMs, this.now())) return 'cooldown';
    if (lane.queued.length >= lane.buffer) {
      // ciel/actions.go Reviewer.push drop path: lift the cooldown just taken, persist nothing.
      if (job.kind === 'review') this.state.forgetReview(jobKey(job));
      return 'busy';
    }
    this.state.addJob(job);
    lane.queued.push(job);
    this.schedule();
    return 'queued';
  }

  // Re-queues the persisted jobs in saved order, without re-persisting and without cooldown checks.
  start(): void {
    this.stopping = false;
    this.controller = new AbortController();
    setMaxListeners(4 * this.cfg.concurrency.max_concurrent + 8, this.controller.signal);
    for (const job of this.state.pendingJobs()) {
      if (this.inflight((j) => sameJob(j, job))) continue;
      const lane = this.lanes.find((l) => l.name === this.cfg.capabilities[job.kind]?.lane);
      if (lane === undefined) {
        // A capability removed from the config: throwing here would stop every restart, so the job is dropped.
        console.error(`dropped saved ${job.kind} job ${jobKey(job)}: the capability is no longer configured`);
        this.state.removeJob(job);
        continue;
      }
      lane.queued.push(job);
    }
    this.schedule();
  }

  // Stops starting jobs, aborts the running ones and waits for every run to settle.
  async stop(): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    await Promise.allSettled(this.settled);
  }

  // A paused queue keeps accepting jobs but starts none until resumed.
  setPaused(paused: boolean): void {
    this.state.setPaused(paused);
    this.schedule();
  }

  get paused(): boolean {
    return this.state.paused;
  }

  // Removes a queued job (returned, for the caller to answer), or aborts a running one; either way it is gone
  // from state.json once settled.
  cancel(kind: string, key: string): { result: CancelResult; job?: Job } {
    const match = (j: Job): boolean => j.kind === kind && jobKey(j) === key;
    for (const lane of this.lanes) {
      const i = lane.queued.findIndex(match);
      if (i < 0) continue;
      const [job] = lane.queued.splice(i, 1);
      if (job === undefined) break;
      this.state.removeJob(job);
      return { result: 'removed', job };
    }
    for (const [job, run] of this.running) {
      if (!match(job)) continue;
      run.controller.abort(new CancelledError());
      return { result: 'cancelled', job };
    }
    return { result: 'not_found' };
  }

  snapshot(): LaneSnapshot[] {
    return this.lanes.map((lane) => ({
      name: lane.name, concurrency: lane.concurrency, buffer: lane.buffer, queued: [...lane.queued],
      running: [...this.running].filter(([job]) => this.cfg.capabilities[job.kind]?.lane === lane.name).map(([job, run]) => ({ job, startedAt: run.startedAt })),
    }));
  }

  private schedule(): void {
    if (this.stopping || this.state.paused) return;
    let started = true;
    while (started) {
      started = false;
      for (let i = 0; i < this.lanes.length; i++) {
        const lane = this.lanes[(this.cursor + i) % this.lanes.length];
        if (lane === undefined || lane.queued.length === 0) continue;
        if (lane.running >= lane.concurrency || this.running.size >= this.cfg.concurrency.max_concurrent) continue;
        const job = lane.queued.shift();
        if (job === undefined) continue;
        this.cursor = (this.cursor + i + 1) % this.lanes.length;
        this.launch(lane, job);
        started = true;
        break;
      }
    }
  }

  private launch(lane: Lane, job: Job): void {
    lane.running++;
    const controller = new AbortController();
    this.running.set(job, { controller, startedAt: this.now() });
    const signal = AbortSignal.any([this.controller.signal, controller.signal]);
    const settled = new Promise<RunOutcome>((resolve) => resolve(this.run(job, signal)))
      .then((outcome) => {
        if (outcome !== 'interrupted' || controller.signal.aborted) this.state.removeJob(job);
      }, () => {
        this.state.removeJob(job);
      })
      .finally(() => {
        lane.running--;
        this.running.delete(job);
        const i = this.settled.indexOf(settled);
        if (i >= 0) this.settled.splice(i, 1);
        this.schedule();
      });
    this.settled.push(settled);
  }

  // For tests and doctor: how many jobs are running and queued right now.
  counts(): { running: number; queued: number } {
    return { running: this.running.size, queued: this.lanes.reduce((n, l) => n + l.queued.length, 0) };
  }
}
