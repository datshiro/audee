import { fileURLToPath } from 'node:url';

// SSH_AUTH_SOCK: git fetch over SSH uses the agent, as in Ciel kbquery.go:191.
const KEPT = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SSH_AUTH_SOCK'] as const;

export function sessionEnv(opts: { tmpdir?: string }, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of KEPT) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  if (opts.tmpdir !== undefined) env['TMPDIR'] = opts.tmpdir;
  return env;
}

export const API_KEY_HELPER = fileURLToPath(new URL('../../deploy/api-key-helper.sh', import.meta.url));
export const CLAUDE_HACK = fileURLToPath(new URL('../../deploy/claude-hack.sh', import.meta.url));

// Claude Code runs the helper through a shell, so the item name must not carry shell syntax.
export function apiKeyHelperCommand(item: string): string {
  if (item.length === 0 || /[^A-Za-z0-9._-]/.test(item)) throw new Error('keychain item name may only contain letters, digits, dot, underscore and dash');
  return `${API_KEY_HELPER} ${item}`;
}
