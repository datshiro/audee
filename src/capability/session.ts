import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { authFor, authSettings } from '../authz/people.js';
import type { Capability as CapabilityConfig } from '../config/schema.js';
import type { Event } from '../events.js';
import type { RunInput, RunResult } from '../runner/run.js';
import type { CapabilityContext } from './types.js';

// The RunInput every capability builds: the profile's options, the config timeout, the person's auth and the
// shutdown signal. Nothing else reaches the session.
export function sessionInput(ctx: CapabilityContext, cap: CapabilityConfig, options: Options, prompt: string, extra: { tmpdir?: string } = {}): RunInput {
  return {
    options,
    prompt,
    timeoutMs: cap.timeout,
    ...authSettings(ctx.cfg, authFor(ctx.cfg, ctx.person)),
    signal: ctx.signal,
    ...(extra.tmpdir !== undefined ? { tmpdir: extra.tmpdir } : {}),
  };
}

export function sessionEvent(result: RunResult | undefined, durationMs: number): Partial<Event> {
  if (result === undefined) return { durationMs };
  return {
    durationMs,
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ...(result.turns !== undefined ? { numTurns: result.turns } : {}),
    toolUses: result.toolUses,
    denials: result.denials,
  };
}

export function capabilityConfig(ctx: CapabilityContext): CapabilityConfig {
  const cap = ctx.cfg.capabilities[ctx.job.kind];
  if (cap === undefined) throw new Error(`capability ${ctx.job.kind} is not configured`);
  return cap;
}

// A per-message scratch folder. The folder is wiped before each run, so an empty or path-like id must never
// resolve to the shared parent folder or outside it.
export function messageDir(dataDir: string, sub: string, messageId: string | undefined): string {
  if (messageId === undefined || messageId === '' || messageId !== basename(messageId) || messageId.startsWith('.')) {
    throw new Error(`message id "${messageId ?? ''}" is not a plain folder name`);
  }
  return join(dataDir, sub, messageId);
}

// A fresh scratch folder: a rerun must not see the last attempt's files, and expiry dates it by mtime.
export function freshDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// What the session's output looked like, kept beside the request for the owner to inspect.
export function keepOutput(dir: string, result: RunResult | undefined, error?: string): void {
  const out = result === undefined
    ? { error }
    : { isError: result.isError, text: result.text, structured: result.structured, sessionId: result.sessionId, costUsd: result.costUsd, turns: result.turns, denials: result.denials, toolUses: result.toolUses, ...(error !== undefined ? { error } : {}) };
  writeFileSync(join(dir, 'output.json'), JSON.stringify(out, null, 2), { mode: 0o600 });
}

export function keepResult(dir: string, res: unknown): void {
  writeFileSync(join(dir, 'result.json'), JSON.stringify(res, null, 2), { mode: 0o600 });
}
