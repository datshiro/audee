import { describe, expect, it } from 'vitest';
import { kbQueryReplyHTML } from '../../src/render/html.js';

describe('defang', () => {
  // ciel/kbquery_test.go:399-405
  it('TestKBQueryDefangsEveryShownText', () => {
    const [html] = kbQueryReplyHTML({ status: 'need_input', missing: ['See HTTPS://evil.example or www.evil.example'] });
    expect(html.toLowerCase()).not.toContain('https://');
    expect(html).not.toContain('www.evil');
    // Go's $1 keeps the captured case: HTTPS:// becomes hxxpS://
    expect(html).toContain('hxxpS://evil.example');
    expect(html).toContain('www[.]evil.example');
  });
});
