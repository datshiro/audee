import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { basename, join } from 'node:path';
import { authFor } from '../authz/people.js';
import type { Capability as CapabilityConfig } from '../config/schema.js';
import type { Event } from '../events.js';
import type { RunInput, RunResult } from '../runner/run.js';
import type { CapabilityContext } from './types.js';

// The RunInput every capability builds: the profile's options, the config timeout, the person's auth and the
// shutdown signal. Nothing else reaches the session.
export function sessionInput(ctx: CapabilityContext, cap: CapabilityConfig, options: Options, prompt: string, extra: { tmpdir?: string } = {}): RunInput {
  const auth = authFor(ctx.cfg, ctx.person);
  return {
    options,
    prompt,
    timeoutMs: cap.timeout,
    auth,
    ...(auth === 'api_key' ? { apiKeyItem: ctx.cfg.auth.api_key_keychain_item } : {}),
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
