// `audee doctor`: refuses an unsafe or unverified setup. Prints check names and pass/fail, never a secret
// value or the contents of ~/.claude.json.
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { authSettings, claudeConfigDir } from './authz/people.js';
import { answerSchemaMatches, printAnswerSchema } from './capability/kb-answer.js';
import { kbQueryDirs } from './capability/kb-query.js';
import { expandHome } from './config/load.js';
import type { Config, ProfileName } from './config/schema.js';
import { IAM_TRACE_SERVER, REVIEW_JIRA_SERVER, REVIEW_MCP_SERVERS } from './fence/constants.js';
import { loadMcpServers } from './fence/mcp-servers.js';
import { buildOptions, type KbPaths } from './fence/profiles.js';
import { FENCE_VERIFIED_ON } from './fence/verified.js';
import { hasKeychainItem } from './keychain.js';
import { runAgent } from './runner/run.js';
import { ensureRerunDir } from './teams/watcher.js';

export type Check = { name: string; ok: boolean; detail: string };

export type DoctorDeps = {
  nodeVersion?: string;
  sdkPackage?: () => { version: string; claudeCodeVersion?: string };
  verified?: { claudeCode: string; sdk: string; apiKeyGuard: string | null };
  hasKeychainItem?: (item: string) => boolean;
  userConfigPath?: string; // ~/.claude.json
  settingsPath?: string; // ~/.claude/settings.json, loaded by API-key review sessions
  env?: NodeJS.ProcessEnv;
  optionsFor?: (profile: ProfileName, cap: Config['capabilities'][string]) => Options;
  kbDirs?: (kbDir: string) => KbPaths;
  printAnswerSchema?: (kbDir: string) => Promise<unknown>;
  shadowDirs?: string[]; // ~/.ciel/raw, ~/.ciel/failed
  launchdNode?: string; // the plist's program
  journeyTriggerRepo?: string;
  authProbe?: () => Promise<Check>; // opt-in: a tiny session on the owner's auth in the daemon's environment
};

const BASH_PROFILES = new Set<ProfileName>(['review', 'mapping']);
const SECRET_KEY = /TOKEN|SECRET|KEY|PASSWORD/iu;

export function sdkPackage(): { version: string; claudeCodeVersion?: string } {
  const require = createRequire(import.meta.url);
  const raw = JSON.parse(readFileSync(join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')) as { version: string; claudeCodeVersion?: string };
  return raw;
}

function writable(dir: string): string | undefined {
  try {
    accessSync(dir, constants.W_OK);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

const minutes = (clock: string): number => {
  const [h, m] = clock.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

// A session on the owner's auth with the environment the daemon uses (sessionEnv, USER kept, plus auth.claude_config_dir).
// Proves the daemon path (runAgent's env and auth), so it loads no settings, hooks or tools: the cost stays small and fixed.
export async function ownerAuthProbe(cfg: Config): Promise<Check> {
  const options: Options = {
    cwd: tmpdir(), tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, permissionPrompts: 'none',
    permissionMode: 'dontAsk', systemPrompt: { type: 'preset', preset: 'claude_code' }, model: cfg.classifier.model, maxBudgetUsd: 0.25,
  };
  const auth = cfg.auth.owner;
  try {
    const result = await runAgent({ options, prompt: 'Reply with the single word ok', timeoutMs: 90_000, ...authSettings(cfg, auth) });
    return { name: 'auth probe', ok: !result.isError, detail: result.isError ? `session reported an error (${auth})` : `owner session ran on ${auth} in the daemon environment (cost $${(result.costUsd ?? 0).toFixed(3)})` };
  } catch (e) {
    const message = (e as Error).message;
    // A budget stop happens only after billed calls: the login worked, the probe was just too expensive.
    if (/maximum budget/iu.test(message)) return { name: 'auth probe', ok: true, detail: `warning: owner session authenticated on ${auth} but stopped at the probe budget; ${message}` };
    return { name: 'auth probe', ok: false, detail: message };
  }
}

export async function runDoctor(cfg: Config, deps: DoctorDeps = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };
  const verified = deps.verified ?? FENCE_VERIFIED_ON;
  const env = deps.env ?? process.env;
  const dataDir = expandHome(cfg.data_dir);
  const teams = cfg.channels.teams;

  // 1. node
  const nodeVersion = deps.nodeVersion ?? process.version;
  const major = Number(nodeVersion.replace(/^v/u, '').split('.')[0]);
  check('node', major >= 22, `${nodeVersion}`);

  // 2, 3. the SDK and the Claude Code it bundles
  let pkg: { version: string; claudeCodeVersion?: string } | undefined;
  try {
    pkg = (deps.sdkPackage ?? sdkPackage)();
  } catch (e) {
    check('sdk version', false, (e as Error).message);
  }
  if (pkg !== undefined) {
    check('sdk version', pkg.version === verified.sdk, `${pkg.version}, fence verified on ${verified.sdk}`);
    check('claude code version', pkg.claudeCodeVersion === verified.claudeCode, `bundled ${pkg.claudeCodeVersion ?? 'unknown'}, fence verified on ${verified.claudeCode}`);
  }

  // The shell's CLAUDE_CONFIG_DIR never reaches sessions (sessionEnv); subscription sessions use auth.claude_config_dir
  const lanes = [cfg.auth.owner, cfg.auth.teammates, cfg.classifier.auth];
  const configDir = cfg.auth.claude_config_dir;
  const configPath = expandHome(configDir);
  if (!lanes.includes('subscription')) check('config dir', true, `${configDir} unused: no session runs on the subscription`);
  else if (!existsSync(configPath) || !statSync(configPath).isDirectory()) check('config dir', false, `${configDir} is not a directory; subscription sessions would have no login`);
  // Outside ~/.claude, Claude Code keeps the login in <dir>/.claude.json; ~/.claude's sits beside it as ~/.claude.json
  else if (claudeConfigDir(cfg) !== undefined && !existsSync(join(configPath, '.claude.json'))) check('config dir', false, `${configDir} has no .claude.json; log in with CLAUDE_CONFIG_DIR=${configDir} claude`);
  else if (env['CLAUDE_CONFIG_DIR'] !== undefined) check('config dir', true, `warning: CLAUDE_CONFIG_DIR is set in this shell; subscription sessions use ${configDir} (its login and settings)`);
  else check('config dir', true, configDir);

  // 4. seatbelt fails closed
  const optionsFor = deps.optionsFor ?? ((profile, cap) => buildOptions({
    profile, cwd: dataDir, seatbelt: cap.seatbelt, skillDir: '/SKILL',
    mcpServers: { gitlab: { command: 'x' }, kb: { command: 'x' }, [IAM_TRACE_SERVER]: { command: 'x' } }, kbPaths: { wiki: '/W', querySkill: '/Q', scoutSkill: '/S', repos: [] }, mcpTools: {},
  }));
  for (const [name, cap] of Object.entries(cfg.capabilities)) {
    if (!cap.seatbelt) continue;
    let detail = 'sandbox enabled, failIfUnavailable';
    let ok = false;
    try {
      const settings = optionsFor(cap.profile, cap).settings;
      const sandbox = typeof settings === 'object' && settings !== null ? (settings as { sandbox?: { enabled?: boolean; failIfUnavailable?: boolean } }).sandbox : undefined;
      ok = sandbox?.enabled === true && sandbox.failIfUnavailable === true;
      if (!ok) detail = 'seatbelt is on but the options do not fail closed';
    } catch (e) {
      detail = (e as Error).message;
    }
    check(`seatbelt ${name}`, ok, detail);
  }

  // 5, 10. MCP servers exist at user scope; the kb server reads no keychain_env variable
  const userConfigPath = deps.userConfigPath ?? expandHome('~/.claude.json');
  const serverNames = new Set<string>();
  for (const [name, cap] of Object.entries(cfg.capabilities)) {
    if (cap.profile === 'review') for (const s of REVIEW_MCP_SERVERS) serverNames.add(s);
    if (cap.profile === 'kb_read') serverNames.add('kb');
    if (cap.profile === 'mcp_read') for (const s of cap.mcp ?? []) serverNames.add(s);
    if (cap.profile === 'iam_trace') serverNames.add(IAM_TRACE_SERVER);
    void name;
  }
  try {
    const servers = loadMcpServers([...serverNames], {}, userConfigPath);
    check('mcp servers', true, `${[...serverNames].sort().join(', ')} defined in ${userConfigPath}`);
    const kb = servers['kb'];
    if (kb !== undefined) {
      const text = JSON.stringify(kb);
      const used = Object.keys(cfg.keychain_env).filter((v) => text.includes('${' + v + '}')).sort();
      check('kb server env', used.length === 0, used.length === 0 ? 'reads no keychain_env variable' : `the kb MCP server reads ${used.join(', ')} from keychain_env, which kb_query sessions do not get`);
    }
    // A fixed detail: the definition carries the Grafana token in its env.
    const trace = servers[IAM_TRACE_SERVER];
    if (trace !== undefined) {
      const command = 'command' in trace && typeof trace.command === 'string' ? trace.command : undefined;
      const ok = command !== undefined && isAbsolute(command) && existsSync(command);
      check(`${IAM_TRACE_SERVER} command`, ok, ok ? `the ${IAM_TRACE_SERVER} MCP server command exists` : `the ${IAM_TRACE_SERVER} MCP server has no command, or its command is not an absolute path on disk`);
    }
  } catch (e) {
    check('mcp servers', false, `${(e as Error).message} (read ${userConfigPath})`);
  }
  if (Object.values(cfg.capabilities).some((c) => c.profile === 'review')) {
    const jira = cfg.mcp_servers[REVIEW_JIRA_SERVER];
    if (jira === undefined) {
      check('review jira', true, `warning: no mcp_servers.${REVIEW_JIRA_SERVER}, so reviews cannot read the Jira ticket`);
    } else {
      const text = JSON.stringify(jira);
      const missing = [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1] ?? '').filter((v) => cfg.keychain_env[v] === undefined);
      check('review jira', missing.length === 0, missing.length === 0 ? `mcp_servers.${REVIEW_JIRA_SERVER} is configured and its keychain_env variables are defined; review sessions may only read with it` : `mcp_servers.${REVIEW_JIRA_SERVER} uses ${missing.join(', ')}, which keychain_env does not define`);
    }
  }

  // 6. teammates: on the API key, the Keychain item and the API key guard for Bash-capable grants; on the owner's
  // login, a warning, since their Bash-capable sessions run as the owner and can reach the login token.
  const teammates = cfg.people.filter((p) => !p.owner);
  if (teammates.length > 0) {
    const bashCapable = teammates.filter((p) => p.can.some((c) => (c === '*' ? Object.values(cfg.capabilities) : [cfg.capabilities[c]]).some((cap) => cap !== undefined && BASH_PROFILES.has(cap.profile)))).map((p) => p.name);
    if (cfg.auth.teammates === 'subscription') {
      check('teammates', true, bashCapable.length > 0
        ? `warning: teammates run on the owner's login, and Bash-capable grants (${bashCapable.join(', ')}) can reach its token`
        : "teammates run on the owner's login with Bash-free capabilities");
    } else {
      const has = (deps.hasKeychainItem ?? hasKeychainItem)(cfg.auth.api_key_keychain_item);
      check('teammate api key', has, has ? `Keychain item ${cfg.auth.api_key_keychain_item} exists` : `Keychain item ${cfg.auth.api_key_keychain_item} is missing (security add-generic-password -a "$USER" -s ${cfg.auth.api_key_keychain_item} -w)`);
      if (bashCapable.length > 0) {
        const guarded = verified.apiKeyGuard === verified.claudeCode;
        check('api key guard', guarded, guarded ? `passed on ${verified.claudeCode}` : `teammates have Bash-capable capabilities but the API key guard has not passed on this version (${bashCapable.join(', ')})`);
      } else {
        check('api key guard', true, 'teammates use only Bash-free capabilities');
      }
    }
  } else {
    check('teammates', true, 'owner only');
  }
  if (cfg.classifier.auth === 'api_key') {
    const has = (deps.hasKeychainItem ?? hasKeychainItem)(cfg.auth.api_key_keychain_item);
    check('classifier api key', has, has ? `Keychain item ${cfg.auth.api_key_keychain_item} exists` : `Keychain item ${cfg.auth.api_key_keychain_item} is missing (security add-generic-password -a "$USER" -s ${cfg.auth.api_key_keychain_item} -w)`);
  }
  if (cfg.auth.base_url !== undefined) check('api gateway', true, `${cfg.auth.base_url} for API-key sessions`);
  if (cfg.capabilities['review']?.auto_approve === true) {
    const owner = cfg.people.find((p) => p.owner);
    const unmapped = cfg.people.filter((p) => !p.owner && p.gitlab === undefined && (p.can.includes('*') || p.can.includes('review'))).map((p) => p.name);
    if (owner?.gitlab === undefined) check('review auto-approve', false, 'the owner has no people[].gitlab, so no MR is ever approved');
    else if (cfg.capabilities['review']?.post_findings !== true) check('review auto-approve', true, 'warning: post_findings is off, so the review may post no PASS acknowledgement and no MR gets approved');
    else check('review auto-approve', true, unmapped.length === 0 ? 'every review requester has people[].gitlab' : `warning: no people[].gitlab for ${unmapped.join(', ')}; their clean MRs wait for the owner`);
  }

  // 7, 17. folders
  if (teams.shadow) {
    for (const dir of deps.shadowDirs ?? [expandHome('~/.ciel/raw'), expandHome('~/.ciel/failed')]) {
      let ok = false;
      try {
        ok = statSync(dir).isDirectory();
        accessSync(dir, constants.R_OK);
      } catch {
        ok = false;
      }
      check('shadow source', ok, ok ? `${dir} readable` : `${dir} is not readable`);
    }
  } else {
    const oneDrive = expandHome(teams.onedrive_dir);
    for (const sub of ['inbox', 'outbox']) {
      const dir = join(oneDrive, sub);
      const problem = existsSync(dir) ? writable(dir) : 'missing';
      check(`onedrive ${sub}`, problem === undefined, problem === undefined ? `${dir} writable` : `${dir}: ${problem}`);
    }
  }
  const dataProblem = writable(dataDir);
  check('data dir', dataProblem === undefined, dataProblem === undefined ? `${dataDir} writable` : `${dataDir}: ${dataProblem}`);
  try {
    ensureRerunDir(dataDir);
    check('rerun dir', true, join(dataDir, 'rerun'));
  } catch (e) {
    check('rerun dir', false, (e as Error).message);
  }

  // 8. pinned skill; review workdir; journey-trigger repo
  for (const [name, cap] of Object.entries(cfg.capabilities)) {
    if (cap.profile === 'mapping') {
      const link = expandHome(cap.skill_dir ?? '');
      let ok = false;
      let detail = '';
      try {
        if (!lstatSync(link).isSymbolicLink()) throw new Error(`${link} is not a symlink (run audee pin-skill)`);
        const real = realpathSync(link);
        ok = existsSync(join(real, 'SKILL.md'));
        detail = ok ? `pinned at ${real}` : `${real} has no SKILL.md`;
      } catch (e) {
        detail = `${(e as Error).message} (run audee pin-skill)`;
      }
      check(`skill ${name}`, ok, detail);
      const repo = deps.journeyTriggerRepo ?? process.env['JOURNEY_TRIGGER_REPO'] ?? expandHome('~/workspace/apollo/journey-trigger');
      const isRepo = existsSync(join(repo, '.git'));
      check('journey-trigger repo', true, isRepo ? repo : `warning: ${repo} is not a git repo; probe worktrees are not pruned after a failed mapping`);
    }
    if (cap.profile === 'review') {
      const workdir = expandHome(cap.workdir ?? '~/.claude/kb');
      const ok = existsSync(workdir) && statSync(workdir).isDirectory();
      check(`workdir ${name}`, ok, ok ? workdir : `${workdir} is missing`);
    }
  }

  // 9. kb checkouts and the kb-mcp binary
  for (const [name, cap] of Object.entries(cfg.capabilities)) {
    if (cap.profile !== 'kb_read') continue;
    const kbDir = expandHome(cap.kb_dir ?? '~/.claude/kb');
    try {
      const paths = (deps.kbDirs ?? kbQueryDirs)(kbDir);
      const bin = join(kbDir, 'kb-mcp', 'kb-mcp');
      const hasBin = existsSync(bin);
      check(`kb ${name}`, hasBin, hasBin ? `${paths.repos.length} service checkouts readable` : `${bin} is missing`);
    } catch (e) {
      check(`kb ${name}`, false, (e as Error).message);
    }
    // Product answers need kb-mcp render-answer and the contract audee pinned; tech answers need neither.
    if (cap.default_mode === 'product') {
      try {
        const printed = await (deps.printAnswerSchema ?? printAnswerSchema)(kbDir);
        check(`kb render-answer ${name}`, true, 'kb-mcp render-answer runs');
        const same = answerSchemaMatches(printed);
        check(`kb answer schema ${name}`, same, same ? 'matches the pinned kb-answer-v1' : 'KB contract changed: update src/capability/kb-answer-schema.ts');
      } catch (e) {
        check(`kb render-answer ${name}`, false, `kb-mcp render-answer --print-schema failed (rebuild or pull the KB repo): ${(e as Error).message}`);
      }
    }
  }

  // 11. the user settings env block loaded by review sessions: subscription ones read auth.claude_config_dir's,
  // API-key ones ~/.claude's
  const settingsPaths = [...new Set([
    ...(lanes.includes('api_key') ? [deps.settingsPath ?? expandHome('~/.claude/settings.json')] : []),
    ...(lanes.includes('subscription') ? [join(configPath, 'settings.json')] : []),
  ])];
  for (const settingsPath of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { env?: Record<string, unknown> };
      const bad = Object.keys(settings.env ?? {}).filter((k) => k.startsWith('ANTHROPIC_') || SECRET_KEY.test(k)).sort();
      check('settings env', bad.length === 0, bad.length === 0 ? `${settingsPath} env holds no secret-named key` : `${settingsPath} env holds ${bad.join(', ')}; review sessions would load them`);
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      check('settings env', missing, missing ? `${settingsPath} absent` : `${settingsPath}: ${(e as Error).message}`);
    }
  }

  // 12, 15. chats and work hours
  check('chats', teams.chats.length > 0, `${teams.chats.length} allowed chat(s)`);
  const dayStart = minutes(teams.work_hours.start);
  const dayEnd = minutes(teams.work_hours.end);
  const hoursOk = dayEnd > dayStart && teams.quiet_after <= (dayEnd - dayStart) * 60_000;
  check('work hours', hoursOk, hoursOk ? `${teams.work_hours.start}-${teams.work_hours.end}, quiet after ${Math.round(teams.quiet_after / 60_000)} min` : 'work_hours.end must be after start and quiet_after must fit in the work day');

  // launchd program
  const launchdNode = deps.launchdNode ?? '/opt/homebrew/bin/node';
  check('launchd node', true, existsSync(launchdNode) ? launchdNode : `warning: ${launchdNode} is missing; the launchd agent runs that path, not the shell's node`);

  // auth probe (opt-in: costs one tiny session)
  if (deps.authProbe !== undefined) checks.push(await deps.authProbe());
  else check('auth probe', true, 'skipped (run audee doctor --probe to run one owner session in the daemon environment)');

  return checks;
}

export function formatChecks(checks: Check[]): string[] {
  return checks.map((c) => `${c.ok ? (c.detail.startsWith('warning:') ? 'warn ' : 'ok   ') : 'FAIL '} ${c.name.padEnd(22)} ${c.detail}`);
}
