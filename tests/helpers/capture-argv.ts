import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/fake-claude.sh', import.meta.url));
const LIST_FLAGS = new Set(['--allowedTools', '--disallowedTools', '--tools', '--add-dir', '--setting-sources']);

export async function captureSession(options: Options): Promise<{ argv: string[]; rawArgv: string[]; init: unknown }> {
  const dir = await mkdtemp(join(tmpdir(), 'audee-capture-'));
  const argvOut = join(dir, 'argv');
  const stdinOut = join(dir, 'stdin');
  const run = (async () => {
    try {
      const q = query({ prompt: 'probe', options: { ...options, pathToClaudeCodeExecutable: FAKE_CLAUDE, env: { ...(options.env ?? {}), PATH: process.env.PATH ?? '', FAKE_CLAUDE_ARGV_OUT: argvOut, FAKE_CLAUDE_STDIN_OUT: stdinOut } } });
      for await (const m of q) void m;
    } catch {
      // expected: the fake binary exits 1
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('capture timed out')), 15_000); });
  try { await Promise.race([run, timeout]); } finally { clearTimeout(timer); }
  const raw = await readFile(argvOut, 'utf8').catch(() => '');
  const records = raw.split('\n--END--\n').filter((r) => r.length > 0);
  const last = records[records.length - 1];
  if (last === undefined) throw new Error('no session invocation captured');
  const rawArgv = last.split('\0');
  if (rawArgv[rawArgv.length - 1] === '') rawArgv.pop();
  const argv = rawArgv.flatMap((t) => {
    if (t.startsWith('--') && t.includes('=')) { const i = t.indexOf('='); return [t.slice(0, i), t.slice(i + 1)]; }
    return [t];
  });
  const stdin = await readFile(stdinOut, 'utf8').catch(() => '');
  const first = stdin.split('\n')[0];
  const init: unknown = first !== undefined && first.length > 0 ? JSON.parse(first) : undefined;
  return { argv, rawArgv, init };
}

export function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    for (let j = i + 1; j < argv.length; j++) {
      const v = argv[j];
      if (v === undefined || v.startsWith('-')) break;
      if (LIST_FLAGS.has(flag)) out.push(...v.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
      else out.push(v);
    }
  }
  return out;
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}
