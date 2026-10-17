import { setMaxListeners } from 'node:events';
import type { Config } from '../config/schema.js';
import type { State } from '../state/state.js';
import { type Job, jobKey, sameJob } from './job.js';

export type RunOutcome = 'done' | 'interrupted';
export type EnqueueResult = 'queued' | 'duplicate' | 'limit' | 'cooldown' | 'busy';
export type Runner = (job: Job, signal: AbortSignal) => Promise<RunOutcome>;

export const reviewCooldownMs = 30 * 60 * 1000; // ciel/actions.go:18 reviewCooldown
const defaultMaxInflight = 2;

type Lane = { name: string; concurrency: number; buffer: number; queued: Job[]; running: number };

export class Queue {
  private readonly lanes: Lane[];
  private readonly running = new Set<Job>();
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
    for (const j of this.running) if (match(j)) n++;
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
      if (!this.inflight((j) => sameJob(j, job))) this.lane(job).queued.push(job);
    }
    this.schedule();
  }

  // Stops starting jobs, aborts the running ones and waits for every run to settle.
  async stop(): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    await Promise.allSettled(this.settled);
  }

  private schedule(): void {
    if (this.stopping) return;
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
    this.running.add(job);
    const signal = this.controller.signal;
    const settled = new Promise<RunOutcome>((resolve) => resolve(this.run(job, signal)))
      .then((outcome) => {
        if (outcome !== 'interrupted') this.state.removeJob(job);
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
