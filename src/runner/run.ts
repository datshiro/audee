import { query, type Options, type SDKMessage, type SDKResultMessage, type SDKUserMessage, type Settings } from '@anthropic-ai/claude-agent-sdk';
import { apiKeyHelperCommand, CLAUDE_HACK, sessionEnv } from './env.js';

export type RunInput = {
  options: Options;
  prompt: string;
  timeoutMs: number;
  auth: 'subscription' | 'api_key';
  apiKeyItem?: string;
  baseUrl?: string; // API-key sessions only: an Anthropic-compatible gateway
  tmpdir?: string;
  signal?: AbortSignal;
  extraEnv?: Record<string, string>; // tests only
  // Asked once, when a turn ends with no background work left: a returned prompt continues the same session.
  followUp?: (text: string) => string | undefined;
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

// The SDK appends the CLI's stderr to its errors, and the MCP config (tokens included) is on the CLI's command line,
// so every value that could hold a secret is replaced before the message reaches events, files or notifications.
function mcpSecrets(options: Options): string[] {
  const values: string[] = [];
  for (const server of Object.values(options.mcpServers ?? {})) {
    const s = server as { env?: unknown; headers?: unknown; args?: unknown; url?: unknown };
    for (const group of [s.env, s.headers]) {
      if (typeof group === 'object' && group !== null) {
        for (const v of Object.values(group)) {
          if (typeof v !== 'string') continue;
          values.push(v);
          const credential = /^(?:Basic|Bearer)\s+(\S+)$/i.exec(v)?.[1]; // the token alone can appear in an error too
          if (credential !== undefined) values.push(credential);
        }
      }
    }
    if (Array.isArray(s.args)) for (const a of s.args) if (typeof a === 'string') values.push(a);
    if (typeof s.url === 'string') values.push(s.url);
  }
  return values.filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
}

export function redactMcpSecrets(message: string, options: Options): string {
  let out = message;
  for (const v of mcpSecrets(options)) out = out.replaceAll(v, '[redacted]');
  return out;
}

function collectToolUses(message: SDKMessage, toolUses: string[]): void {
  if (message.type !== 'assistant') return;
  for (const block of message.message.content) if (block.type === 'tool_use') toolUses.push(block.name);
}

// The session's input stays open while background work runs, so its completion notice still gets a turn.
// undefined ends the input, and with it the session.
function turns(first: string): { messages: AsyncIterable<SDKUserMessage>; send: (text: string | undefined) => void } {
  const pending: Array<string | undefined> = [];
  let wake: (() => void) | undefined;
  const user = (text: string): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  return {
    messages: (async function* () {
      yield user(first);
      for (;;) {
        while (pending.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
        const text = pending.shift();
        if (text === undefined) return;
        yield user(text);
      }
    })(),
    send: (text) => {
      pending.push(text);
      wake?.();
    },
  };
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
  const turnInput = input.followUp === undefined ? undefined : turns(input.prompt);
  let background = 0;
  let followedUp = false;
  try {
    const gateway = input.auth === 'api_key' && input.baseUrl !== undefined ? { ANTHROPIC_BASE_URL: input.baseUrl } : {};
    const env = { ...sessionEnv({ tmpdir: input.tmpdir }), ...gateway, ...(input.extraEnv ?? {}) };
    const executable = input.auth === 'subscription' ? { pathToClaudeCodeExecutable: CLAUDE_HACK } : {};
    for await (const message of query({ prompt: turnInput?.messages ?? input.prompt, options: { ...executable, ...options, env, abortController: controller } })) {
      collectToolUses(message, toolUses);
      if (message.type === 'system' && message.subtype === 'background_tasks_changed') background = message.tasks.filter((t) => t.ambient !== true).length;
      if (message.type !== 'result') continue;
      result = message;
      if (turnInput === undefined || background > 0) continue;
      const next: string | undefined = followedUp || message.subtype !== 'success' ? undefined : input.followUp?.(message.result);
      followedUp ||= next !== undefined;
      turnInput.send(next);
    }
  } catch (e) {
    if (input.signal?.aborted === true) throw new InterruptedError();
    if (timedOut) throw new Error(`timed out after ${input.timeoutMs} ms`);
    throw new Error(`session failed: ${redactMcpSecrets(e instanceof Error ? e.message : String(e), options)}`);
  } finally {
    turnInput?.send(undefined);
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
