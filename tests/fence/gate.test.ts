import { describe, expect, it } from 'vitest';
import { gateDecision } from '../../src/fence/gate.js';

const bash = (command: string) => ({ command });

describe('gate', () => {
  it('TestGateDeniesListedTool', () => {
    expect(gateDecision({ denyTools: ['mcp__gitlab__merge_mr'] }, 'mcp__gitlab__merge_mr', {}).deny).toBe(true);
  });
  it('TestGateDeniesServerPrefix', () => {
    const spec = { denyTools: ['mcp__gitlab'] };
    expect(gateDecision(spec, 'mcp__gitlab__merge_mr', {}).deny).toBe(true);
    expect(gateDecision(spec, 'mcp__kb__kb_read_doc', {}).deny).toBe(false);
  });
  it('TestGateDeniesBashPrefix', () => {
    const spec = { denyTools: ['Bash(git push *)'] };
    expect(gateDecision(spec, 'Bash', bash('git push origin main')).deny).toBe(true);
    expect(gateDecision(spec, 'Bash', bash('git pull')).deny).toBe(false);
  });
  it('TestGateDeniesCompoundBash', () => {
    const spec = { denyTools: ['Bash(printenv *)', 'Bash(git push *)'] };
    expect(gateDecision(spec, 'Bash', bash('ls && printenv')).deny).toBe(true);
    expect(gateDecision(spec, 'Bash', bash('FOO=1 git push')).deny).toBe(true);
    expect(gateDecision(spec, 'Bash', bash('echo $(printenv)')).deny).toBe(true);
    expect(gateDecision(spec, 'Bash', bash('ls; printenv | head')).deny).toBe(true);
  });
  it('TestGateDeniesShellWrappers', () => {
    const spec = { denyTools: [] };
    for (const c of ["sh -c 'git push'", 'bash -c "printenv"', 'zsh -c ls', 'eval printenv', 'exec printenv', 'env printenv', 'command printenv']) {
      expect(gateDecision(spec, 'Bash', bash(c)).deny, c).toBe(true);
    }
    expect(gateDecision(spec, 'Bash', bash('ls -la')).deny).toBe(false);
  });
  it('TestGateDeniesToolOutsideAllowList', () => {
    const spec = { allowTools: ['Read', 'Glob'], denyTools: [] };
    expect(gateDecision(spec, 'Write', {}).deny).toBe(true);
    expect(gateDecision(spec, 'Read', {}).deny).toBe(false);
  });
  it('TestGateAllowsStructuredOutput', () => {
    expect(gateDecision({ allowTools: ['Read'], denyTools: ['StructuredOutput'] }, 'StructuredOutput', {}).deny).toBe(false);
  });
  it('TestGateExactBash', () => {
    const probe = 'bash /SKILL/scripts/probe-pipeline.sh ./eventsource.json';
    const spec = { allowTools: ['Bash'], denyTools: [], exactBash: [`Bash(${probe})`] };
    expect(gateDecision(spec, 'Bash', bash(probe)).deny).toBe(false);
    expect(gateDecision(spec, 'Bash', bash(`${probe} --ref refs/heads/evil`)).deny).toBe(true);
    expect(gateDecision(spec, 'Bash', bash(`${probe}; printenv`)).deny).toBe(true);
    expect(gateDecision(spec, 'Bash', bash('cat ../secret')).deny).toBe(true);
  });
  it('TestGateLetsOtherToolsThrough', () => {
    const spec = { denyTools: ['Bash(git push *)', 'mcp__gitlab__merge_mr'] };
    expect(gateDecision(spec, 'Read', { file_path: 'x' }).deny).toBe(false);
    expect(gateDecision(spec, 'Bash', bash('git status')).deny).toBe(false);
    expect(gateDecision(spec, 'mcp__gitlab__get_mr', {}).deny).toBe(false);
  });
});
