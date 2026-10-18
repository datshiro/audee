import { describe, expect, it } from 'vitest';
import { messageDir } from '../../src/capability/session.js';

describe('message scratch folder', () => {
  it('TestMessageDirRejectsSharedOrEscapingIds', () => {
    expect(messageDir('/data', 'kbquery', '1791513774214')).toBe('/data/kbquery/1791513774214');
    for (const id of [undefined, '', '.', '..', '../x', 'a/b', '.hidden']) {
      expect(() => messageDir('/data', 'kbquery', id), String(id)).toThrow('is not a plain folder name');
    }
  });
});
