import { describe, expect, it } from 'vitest';
import { buildOptions, type ProfileInput } from '../../src/fence/profiles.js';

describe('seatbelt', () => {
  it('TestSeatbeltNeverAutoAllowsOrEscapes', () => {
    const inputs: ProfileInput[] = [
      { profile: 'review', cwd: '/tmp', seatbelt: true, mcpServers: { gitlab: { command: 'g' }, kb: { command: 'k' } } },
      { profile: 'mapping', cwd: '/tmp', seatbelt: true, mcpServers: {}, skillDir: '/SKILL', schema: { type: 'object' } },
    ];
    for (const input of inputs) {
      const settings = buildOptions(input).settings;
      expect(settings, input.profile).toMatchObject({ sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false } });
    }
  });
});
