import { query, type Options, type SDKMessage, type SDKResultMessage, type Settings } from '@anthropic-ai/claude-agent-sdk';
import { apiKeyHelperCommand, sessionEnv } from './env.js';

export type RunInput = {
  options: Options;
  prompt: string;
  timeoutMs: number;
  auth: 'subscription' | 'api_key';
  apiKeyItem?: string;
  tmpdir?: string;
  signal?: AbortSignal;
  extraEnv?: Record<string, string>; // tests only
};

export type RunResult = {
  isError: boolean;
  text: string;
  structured?: unknown;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  denials: string[];
  toolUses: string[];
  durationMs: number;
};

export class InterruptedError extends Error {
  constructor() {
    super('interrupted by shutdown');
    this.name = 'InterruptedError';
  }
}

// Returns a copy: the caller's Options (built once by buildOptions) are never mutated.
function withApiKeyHelper(options: Options, item: string | undefined): Options {
  if (item === undefined) throw new Error('api key auth requested but no keychain item is configured');
  const current: Settings = typeof options.settings === 'string' ? (JSON.parse(options.settings) as Settings) : { ...(options.settings ?? {}) };
  return { ...options, settings: { ...current, apiKeyHelper: apiKeyHelperCommand(item) } };
}

function collectToolUses(message: SDKMessage, toolUses: string[]): void {
  if (message.type !== 'assistant') return;
  for (const block of message.message.content) if (block.type === 'tool_use') toolUses.push(block.name);
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  const started = Date.now();
  const options = input.auth === 'api_key' ? withApiKeyHelper(input.options, input.apiKeyItem) : input.options;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  const onAbort = (): void => controller.abort();
  if (input.signal?.aborted === true) controller.abort();
  else input.signal?.addEventListener('abort', onAbort, { once: true });

  const toolUses: string[] = [];
  let result: SDKResultMessage | undefined;
  try {
    const env = { ...sessionEnv({ tmpdir: input.tmpdir }), ...(input.extraEnv ?? {}) };
    for await (const message of query({ prompt: input.prompt, options: { ...options, env, abortController: controller } })) {
      collectToolUses(message, toolUses);
      if (message.type === 'result') result = message;
    }
  } catch (e) {
    if (input.signal?.aborted === true) throw new InterruptedError();
    if (timedOut) throw new Error(`timed out after ${input.timeoutMs} ms`);
    throw new Error(`session failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }
  if (input.signal?.aborted === true) throw new InterruptedError();
  if (timedOut) throw new Error(`timed out after ${input.timeoutMs} ms`);
  if (result === undefined) throw new Error('session failed: no result message');
  return {
    isError: result.is_error,
    text: result.subtype === 'success' ? result.result : result.errors.join('\n'),
    structured: result.subtype === 'success' ? result.structured_output : undefined,
    costUsd: result.total_cost_usd,
    turns: result.num_turns,
    sessionId: result.session_id,
    denials: result.permission_denials.map((d) => d.tool_name),
    toolUses,
    durationMs: Date.now() - started,
  };
}
