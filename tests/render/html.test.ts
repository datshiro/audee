import { describe, expect, it } from 'vitest';
import { clip, deniedText, escapeHTML, fitAnswer, kbQueryReplyHTML, mappingReplyHTML, maxNotes, maxReplyChars, replyHTML, reviewedReply, reviewNothingReply } from '../../src/render/html.js';
import { runeLength } from '../../src/render/text.js';

const count = (s: string, needle: string): number => s.split(needle).length - 1;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe('reply html', () => {
  it('review nothing reply escapes, defangs, caps and hides secrets', () => {
    expect(reviewNothingReply('targets <main> see https://evil.example', [])).toContain('Lý do: targets &lt;main&gt; see hxxps://evil.example');
    expect(runeLength(reviewNothingReply('x'.repeat(1000), []))).toBeLessThan(400);
    const hidden = reviewNothingReply('token=abcdefgh12345678', []);
    expect(hidden).not.toContain('Lý do');
    expect(reviewNothingReply('uses s3cr3t-value-123', ['s3cr3t-value-123'])).not.toContain('s3cr3t');
  });

  // ciel/ciel_test.go:134
  it('TestReviewedHTML', () => {
    const got = replyHTML(reviewedReply, 'https://gitlab.example.com/g/p/-/merge_requests/5?a=1&b="2"');
    const want = reviewedReply + '<br><a href="https://gitlab.example.com/g/p/-/merge_requests/5?a=1&amp;b=&#34;2&#34;">https://gitlab.example.com/g/p/-/merge_requests/5?a=1&amp;b=&#34;2&#34;</a>';
    expect(got).toBe(want);
  });

  // ciel/mapping_test.go:107
  it('TestMappingReplyHTML', () => {
    const [html, fits] = mappingReplyHTML({ status: 'done', codeMapping: 'parts[2] >= 1 && x < "<script>"\nnext', sampleMessage: 'a', supportedOutputFields: [{ name: 'Level' }] });
    expect(fits).toBe(true);
    expect(html).toContain('<pre>"parts[2] &gt;= 1 &amp;&amp; x &lt; \\"&lt;script&gt;\\"\\nnext"</pre>');
    expect(html).not.toContain('<script>');

    const [missingHtml] = mappingReplyHTML({ status: 'need_input', missing: Array.from({ length: 11 }, () => 'item') });
    expect(count(missingHtml, '<li>')).toBe(maxNotes);

    const [doneHtml] = mappingReplyHTML({ status: 'done', codeMapping: 'x', sampleMessage: 'a|sample', notes: ['probe ok'], missing: ['confirm productCode'], supportedOutputFields: [{}] });
    for (const unwanted of ['a|sample', 'probe ok', 'confirm productCode', 'sampleMessage']) expect(doneHtml).not.toContain(unwanted);

    const [, tooLongFits] = mappingReplyHTML({ status: 'done', codeMapping: 'x'.repeat(30000), sampleMessage: 'a', supportedOutputFields: [{}] });
    expect(tooLongFits).toBe(false);
  });

  // ciel/kbquery_test.go:407
  it.each([
    ['plain text', 'x'.repeat(maxReplyChars)],
    ['ascii diagram', 'A --> B <-- C & D\n'.repeat(1500)],
  ])('TestKBQueryLongAnswerIsClippedToFit %s', (_name, answer) => {
    const sources = Array.from({ length: 15 }, () => '&'.repeat(300));
    const [html, clipped] = kbQueryReplyHTML({ status: 'done', answer, sources });
    expect(clipped).toBe(true);
    expect(html).toContain('cắt bớt');
    expect(runeLength(html)).toBeLessThanOrEqual(maxReplyChars);
    expect(count(html, '<li>')).toBe(maxNotes);
  });

  it('TestReplyEscaped', () => {
    const html = replyHTML('ok', 'https://x.example/<script>alert(1)</script>?m=<at>Đạt</at>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<at>');
    expect(html).toContain('&lt;script&gt;');
    expect(escapeHTML('<at id="0">Đạt</at> & \'q\'')).toBe('&lt;at id=&#34;0&#34;&gt;Đạt&lt;/at&gt; &amp; &#39;q&#39;');
  });

  it('TestDeniedTextEscapesCapability', () => {
    const text = deniedText('<b onclick="x">review</b>');
    expect(text).not.toContain('<b onclick');
    expect(text).toContain('&lt;b onclick=&#34;x&#34;&gt;review&lt;/b&gt;');
    expect(text).toContain('Hãy nhờ Đạt cấp quyền nhé.');
  });

  it('TestClipNeverSplitsEmoji', () => {
    const eyes = '👀'.repeat(300);
    const clipped = clip(eyes, 200);
    expect(LONE_SURROGATE.test(clipped)).toBe(false);
    expect(runeLength(clipped)).toBe(201);
    const [fitted, wasClipped] = fitAnswer(eyes, 100);
    expect(wasClipped).toBe(true);
    expect(LONE_SURROGATE.test(fitted)).toBe(false);
    expect(runeLength(fitted)).toBeLessThanOrEqual(100);
  });
});
