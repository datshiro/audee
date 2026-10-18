import { expect, test } from 'vitest';
import { main } from '../src/cli.js';

test('TestUnknownCommandPrintsUsage', async () => {
  const lines: string[] = [];
  const code = await main(['nope'], (s) => lines.push(s));
  expect(code).toBe(2);
  expect(lines.join('\n')).toContain('usage: audee');
});
