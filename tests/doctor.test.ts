import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Check, type DoctorDeps, formatChecks, runDoctor } from '../src/doctor.js';
import { testConfig, type TestConfigOptions } from './helpers/test-config.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'audee-doctor-'));
const VERIFIED = { claudeCode: '2.1.302', sdk: '0.3.302', apiKeyGuard: null as string | null };

// A setup where every check can pass: OneDrive folders, a pinned skill, a fake user config and settings file.
function setup(cfgOpts: TestConfigOptions = {}, depOverrides: DoctorDeps = {}) {
  const oneDrive = tmp();
  for (const d of ['inbox', 'outbox']) mkdirSync(join(oneDrive, d), { recursive: true });
  const skillReal = join(tmp(), 'abc123');
  mkdirSync(skillReal);
  writeFileSync(join(skillReal, 'SKILL.md'), 'skill');
  const skillLink = join(tmp(), 'kb-eventsource-ops');
  symlinkSync(skillReal, skillLink);
  const workdir = tmp();
  const userConfigPath = join(tmp(), 'claude.json');
  writeFileSync(userConfigPath, JSON.stringify({ mcpServers: { gitlab: { command: 'glab', env: { GITLAB_TOKEN: '${GL_TOKEN}' } }, kb: { command: 'kb' } } }));
  const settingsPath = join(tmp(), 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ env: { LANG: 'en_US.UTF-8' } }));
  const cfg = testConfig({ people: 0, onedriveDir: oneDrive, mapping: { skillDir: skillLink }, review: { workdir }, keychainEnv: { GL_TOKEN: 'audee-gitlab' }, ...cfgOpts });
  const deps: DoctorDeps = {
    nodeVersion: 'v25.8.2',
    sdkPackage: () => ({ version: '0.3.302', claudeCodeVersion: '2.1.302' }),
    verified: VERIFIED,
    hasKeychainItem: () => true,
    userConfigPath,
    settingsPath,
    env: { PATH: '/usr/bin' },
    kbDirs: () => ({ wiki: '/w', querySkill: '/q', scoutSkill: '/s', repos: ['/r1', '/r2'] }),
    launchdNode: '/usr/bin/env',
    journeyTriggerRepo: tmp(),
    ...depOverrides,
  };
  return { cfg, deps, settingsPath, userConfigPath };
}

const failing = (checks: Check[]): string[] => checks.filter((c) => !c.ok).map((c) => c.name);

describe('doctor', () => {
  it('TestDoctorVersionGate', async () => {
    const { cfg, deps } = setup();
    const bad = await runDoctor(cfg, { ...deps, sdkPackage: () => ({ version: '0.3.303', claudeCodeVersion: '2.1.303' }) });
    expect(failing(bad)).toEqual(expect.arrayContaining(['sdk version', 'claude code version']));
    const good = await runDoctor(cfg, deps);
    expect(failing(good).filter((n) => n.includes('version'))).toEqual([]);
    const oldNode = await runDoctor(cfg, { ...deps, nodeVersion: 'v20.19.0' });
    expect(failing(oldNode)).toContain('node');
  });

  it('TestDoctorSeatbeltFailClosed', async () => {
    const { cfg, deps } = setup({ review: { seatbelt: true } });
    const real = await runDoctor(cfg, deps);
    expect(real.find((c) => c.name === 'seatbelt review')).toMatchObject({ ok: true });
    const open = await runDoctor(cfg, { ...deps, optionsFor: () => ({ settings: { sandbox: { enabled: true } } }) });
    expect(open.find((c) => c.name === 'seatbelt review')).toMatchObject({ ok: false });
  });

  it('TestDoctorTeammatesNeedKeyGuard', async () => {
    const { cfg, deps } = setup({ people: 1, grants: { p1: ['review'] } });
    const checks = await runDoctor(cfg, deps);
    const guard = checks.find((c) => c.name === 'api key guard');
    expect(guard?.ok).toBe(false);
    expect(guard?.detail).toContain('teammates have Bash-capable capabilities but the API key guard has not passed on this version');
    const passed = await runDoctor(cfg, { ...deps, verified: { ...VERIFIED, apiKeyGuard: '2.1.302' } });
    expect(passed.find((c) => c.name === 'api key guard')?.ok).toBe(true);
    const star = await runDoctor(testConfig({ people: 1, grants: { p1: ['*'] } }), deps);
    expect(star.find((c) => c.name === 'api key guard')?.ok).toBe(false);
  });

  it('TestDoctorBashFreeTeammatesNeedOnlyKey', async () => {
    const { cfg, deps } = setup({ people: 1, grants: { p1: ['kb_query'] } });
    const checks = await runDoctor(cfg, deps);
    expect(checks.find((c) => c.name === 'api key guard')).toMatchObject({ ok: true });
    expect(checks.find((c) => c.name === 'teammate api key')).toMatchObject({ ok: true });
    const noKey = await runDoctor(cfg, { ...deps, hasKeychainItem: () => false });
    expect(noKey.find((c) => c.name === 'teammate api key')?.ok).toBe(false);
    expect(noKey.find((c) => c.name === 'teammate api key')?.detail).toContain('security add-generic-password');
  });

  it('TestDoctorPassesOwnerOnlySetup', async () => {
    const { cfg, deps } = setup();
    const checks = await runDoctor(cfg, deps);
    expect(failing(checks)).toEqual([]);
    expect(checks.find((c) => c.name === 'teammates')?.detail).toBe('owner only');
    expect(checks.find((c) => c.name === 'mcp servers')?.detail).toContain('gitlab, kb defined in');
    expect(checks.find((c) => c.name === 'auth probe')?.detail).toContain('skipped');
    const warned = await runDoctor(cfg, { ...deps, env: { CLAUDE_CONFIG_DIR: '/Users/x/.claude-hack' } });
    expect(warned.find((c) => c.name === 'config dir')).toMatchObject({ ok: true });
    expect(warned.find((c) => c.name === 'config dir')?.detail).toContain('warning: CLAUDE_CONFIG_DIR is set');
    expect(formatChecks(warned).some((l) => l.startsWith('warn '))).toBe(true);
    const probed = await runDoctor(cfg, { ...deps, authProbe: async () => ({ name: 'auth probe', ok: true, detail: 'owner session ran' }) });
    expect(probed.find((c) => c.name === 'auth probe')?.detail).toBe('owner session ran');
  });

  it('TestDoctorNeverPrintsSecrets', async () => {
    const secret = 'hunter2-plain-secret-value';
    const { cfg, deps, settingsPath, userConfigPath } = setup();
    writeFileSync(settingsPath, JSON.stringify({ env: { GITLAB_TOKEN: secret, LANG: 'C' } }));
    writeFileSync(userConfigPath, JSON.stringify({ mcpServers: { gitlab: { command: 'glab', env: { GITLAB_TOKEN: secret } }, kb: { command: 'kb', env: { KB_SECRET: '${GL_TOKEN}' } } } }));
    const checks = await runDoctor(cfg, { ...deps, hasKeychainItem: (item) => item !== secret });
    const text = formatChecks(checks).join('\n');
    expect(text).not.toContain(secret);
    expect(text).toContain('GITLAB_TOKEN'); // the offending key name is shown
    expect(checks.find((c) => c.name === 'kb server env')).toMatchObject({ ok: false });
    expect(checks.find((c) => c.name === 'kb server env')?.detail).toContain('GL_TOKEN');
  });

  it('TestDoctorFlagsSecretSettingsEnv', async () => {
    const { cfg, deps, settingsPath } = setup();
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x', GITLAB_TOKEN: 'y', my_password: 'z', LANG: 'C', PATH: '/x' } }));
    const checks = await runDoctor(cfg, deps);
    const env = checks.find((c) => c.name === 'settings env');
    expect(env?.ok).toBe(false);
    expect(env?.detail).toContain('ANTHROPIC_API_KEY, GITLAB_TOKEN, my_password');
    expect(env?.detail).not.toContain('LANG');
    const absent = await runDoctor(cfg, { ...deps, settingsPath: join(tmp(), 'nope.json') });
    expect(absent.find((c) => c.name === 'settings env')).toMatchObject({ ok: true });
  });

  it('TestDoctorBashCapableByProfile', async () => {
    const { cfg, deps } = setup({ people: 1, grants: { p1: ['kb_query'] } });
    const kb = cfg.capabilities['kb_query'];
    if (kb === undefined) throw new Error('kb_query missing');
    cfg.capabilities['kb_query'] = { ...kb, profile: 'review' };
    const checks = await runDoctor(cfg, deps);
    expect(checks.find((c) => c.name === 'api key guard')?.ok).toBe(false);
  });

  it('TestDoctorTeammatesOnLoginWarnInsteadOfGuard', async () => {
    const { cfg, deps } = setup({ people: 1, grants: { p1: ['review'] } });
    cfg.auth.teammates = 'subscription';
    const checks = await runDoctor(cfg, { ...deps, hasKeychainItem: () => false });
    expect(checks.find((c) => c.name === 'teammates')).toMatchObject({ ok: true });
    expect(checks.find((c) => c.name === 'teammates')?.detail).toContain('warning:');
    expect(checks.find((c) => c.name === 'api key guard')).toBeUndefined();
    expect(checks.find((c) => c.name === 'teammate api key')).toBeUndefined();
  });

  it('review auto-approve needs the owner mapped and warns about unmapped requesters', async () => {
    const off = setup({ people: 1 });
    expect((await runDoctor(off.cfg, off.deps)).find((c) => c.name === 'review auto-approve')).toBeUndefined();

    const noOwner = setup({ people: 1, review: { workdir: tmp(), autoApprove: true } });
    expect((await runDoctor(noOwner.cfg, noOwner.deps)).find((c) => c.name === 'review auto-approve')).toMatchObject({ ok: false });

    const partial = setup({ people: 2, gitlab: { owner: 'dat', p1: 'kha' }, review: { workdir: tmp(), autoApprove: true } });
    const warn = (await runDoctor(partial.cfg, partial.deps)).find((c) => c.name === 'review auto-approve');
    expect(warn).toMatchObject({ ok: true });
    expect(warn?.detail).toBe('warning: no people[].gitlab for p2; their clean MRs wait for the owner');

    const all = setup({ people: 1, gitlab: { owner: 'dat', p1: 'kha' }, review: { workdir: tmp(), autoApprove: true } });
    expect((await runDoctor(all.cfg, all.deps)).find((c) => c.name === 'review auto-approve')?.detail).toBe('every review requester has people[].gitlab');
  });

  it('TestDoctorClassifierKeyChecked', async () => {
    const { cfg, deps } = setup();
    cfg.classifier.auth = 'api_key';
    const missing = await runDoctor(cfg, { ...deps, hasKeychainItem: () => false });
    expect(missing.find((c) => c.name === 'classifier api key')?.ok).toBe(false);
  });
});
