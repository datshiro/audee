import { describe, expect, it } from 'vitest';
import { clip, deniedText, escapeHTML, fitAnswer, kbAnswerFileName, kbAnswerPage, kbQueryReplyHTML, mappingReplyHTML, maxNotes, maxReplyChars, replyHTML, reviewBlockedReply, reviewReadyWaitReply, reviewUnreviewableReply } from '../../src/render/html.js';
import { runeLength } from '../../src/render/text.js';

const count = (s: string, needle: string): number => s.split(needle).length - 1;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe('reply html', () => {
  it('kb answer page renders Markdown, stays inert and escapes the question', () => {
    const answer = '## Flow\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nA --> B\n```\n\n<script>alert(1)</script> <img src=x onerror=alert(1)> see https://evil.example and [x](javascript:alert(1))';
    const sources = Array.from({ length: 11 }, (_, i) => `svc/file${i}.go`);
    const page = kbAnswerPage('why <b>this</b>?', { status: 'done', answer, sources });
    for (const want of ['<!doctype html>', '<meta charset="utf-8">', "default-src 'none'; style-src 'unsafe-inline'", '<h2>Flow</h2>', '<li>one</li>', '<table>', '<pre><code>A --&gt; B', 'why &lt;b&gt;this&lt;/b&gt;?', '&lt;script&gt;alert(1)&lt;/script&gt;', '&lt;img src=x onerror=alert(1)&gt;', 'hxxps://evil.example']) {
      expect(page).toContain(want);
    }
    for (const unwanted of ['<script', '<img', 'href=', 'src="http', 'https://', 'svc/file10.go']) expect(page).not.toContain(unwanted);
    expect(count(page, 'svc/file')).toBe(maxNotes);
  });

  it('kb answer file name carries the message id and a UTC stamp', () => {
    expect(kbAnswerFileName('1792420164339', new Date('2026-10-19T14:31:05.123Z'))).toBe('kb-answer-1792420164339-20261019-143105.html');
  });

  it('review status replies escape, defang, cap and hide secrets', () => {
    expect(reviewUnreviewableReply('targets <main> see https://evil.example', [])).toBe('⚠️ <b>Chưa đánh giá được MR</b>: targets &lt;main&gt; see hxxps://evil.example');
    expect(runeLength(reviewUnreviewableReply('x'.repeat(1000), []))).toBeLessThan(400);
    expect(reviewUnreviewableReply('token=abcdefgh12345678', [])).toBe('⚠️ <b>Chưa đánh giá được MR</b>: ');
    expect(reviewReadyWaitReply('uses s3cr3t-value-123', ['s3cr3t-value-123'])).not.toContain('s3cr3t');
    expect(reviewBlockedReply('<script>', [], true)).toBe('⛔ <b>MR chưa merge được</b>: &lt;script&gt;. Xem comment trên MR.');
    expect(reviewBlockedReply('x', [], false)).not.toContain('Xem comment');
  });

  // ciel/ciel_test.go:134
  it('TestReviewedHTML', () => {
    const head = reviewReadyWaitReply('review sạch', []);
    const got = replyHTML(head, 'https://gitlab.example.com/g/p/-/merge_requests/5?a=1&b="2"');
    const want = head + '<br><a href="https://gitlab.example.com/g/p/-/merge_requests/5?a=1&amp;b=&#34;2&#34;">https://gitlab.example.com/g/p/-/merge_requests/5?a=1&amp;b=&#34;2&#34;</a>';
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
