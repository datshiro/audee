import { describe, expect, it } from 'vitest';
import { answerPageVisibleTexts, checkAnswerPage, clip, decodeEntities, deniedText, escapeHTML, fitAnswer, kbAnswerFileName, kbAnswerPage, kbQueryReplyHTML, kbTopicLine, mappingReplyHTML, maxNotes, maxReplyChars, replyHTML, reviewBlockedReply, reviewReadyWaitReply, reviewUnreviewableReply } from '../../src/render/html.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    expect(reviewUnreviewableReply('token=abcdefgh12345678', [])).toBe('⚠️ <b>Chưa đánh giá được MR</b>');
    expect(reviewBlockedReply('', [], true)).toBe('⛔ <b>MR chưa merge được</b>. Xem comment trên MR.');
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

describe('kbTopicLine', () => {
  const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i + 1}`).join(' ');
  it('renders the topic in italics', () => {
    expect(kbTopicLine('past segment tính audience', 'x')).toBe('<br><i>Về: past segment tính audience</i>');
  });
  it('falls back to the question clipped to 20 words', () => {
    const line = kbTopicLine('', words(25));
    expect(line).toContain('Về: w1 ');
    expect(line.endsWith('w20…</i>')).toBe(true);
  });
  it('falls back when the topic is longer than 20 words', () => {
    expect(kbTopicLine(words(21), 'short question')).toBe('<br><i>Về: short question</i>');
  });
  it('escapes and defangs model text', () => {
    const line = kbTopicLine('<b>x</b> https://evil.example', 'q');
    expect(line).toContain('&lt;b&gt;');
    expect(line).not.toContain('<b>');
    expect(line).not.toContain('https://');
  });
  it('caps a single very long word', () => {
    expect(kbTopicLine('x'.repeat(10_000), 'q').length).toBeLessThan(400);
  });
  it('is empty when there is neither topic nor question', () => {
    expect(kbTopicLine('', '')).toBe('');
  });
});

describe('product answer page', () => {
  const golden = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/kb-answer/${name}`, import.meta.url)), 'utf8');

  it('accepts the renderer\'s pages, escaped look-alike text included', () => {
    expect(checkAnswerPage(golden('product-vi.html'))).toBeUndefined();
    expect(checkAnswerPage(golden('product-en-overview.html'))).toBeUndefined();
    expect(checkAnswerPage(golden('product-vi.html').replace('</main>', '<p>&lt;img src=x onerror=y&gt; url(z) href=q</p></main>'))).toBeUndefined();
  });

  it('refuses anything outside the renderer\'s markup', () => {
    const page = golden('product-vi.html');
    const bad: Array<[string, string]> = [
      ['<script>alert(1)</script>', 'element'],
      ['<a href="x">y</a>', 'element'],
      ['<p onclick="x">y</p>', 'attribute'],
      ['<p style="color:red">y</p>', 'attribute'],
      ['<p class="a" class="b">y</p>', 'attribute'],
      ['<svg><foreignObject></foreignObject></svg>', 'element'],
      ['<img src=x>', 'markup'],
      ['<!-- x -->', 'markup'],
      ['< p>', 'markup'],
      ['<img src="https://evil/x.png" <p>', 'markup'],
      ['<meta http-equiv="refresh" content="0;url=https://evil/" <p>', 'markup'],
      ['<meta http-equiv="refresh" content="0;url=https://evil">', 'csp'],
      [`<meta http-equiv="Content-Security-Policy" content="${"default-src 'none'; style-src 'unsafe-inline'"}">`, 'csp'],
      ['<style >p{background:url(https://evil/t)}</style>', 'stylesheet'],
      ['x > y', 'markup'],
    ];
    for (const [markup, reason] of bad) expect(checkAnswerPage(page.replace('</main>', `${markup}</main>`)), markup).toBe(reason);
    expect(checkAnswerPage(page.replace('</style>', 'p{background:url(https://x)}</style>'))).toBe('stylesheet');
    expect(checkAnswerPage(page.replace('</style>', 'p{background:image-set("https://x" 1x)}</style>'))).toBe('stylesheet');
    expect(checkAnswerPage(page.replace('</style>', 'p{background:src("https://x")}</style>'))).toBe('stylesheet');
    expect(checkAnswerPage(page.replace(/<meta charset="utf-8">/i, '<meta charset="iso-2022-jp">'))).toBe('attribute');
    expect(checkAnswerPage(page.replace(/<head>/i, '<div></div><head>'))).toBe('csp');
    expect(checkAnswerPage(page.replace(/<head>/i, 'x<head>'))).toBe('csp');
    expect(checkAnswerPage(page.replace('</style>', '</style ><a href="x">y</a><style></style>'))).toBe('stylesheet');
    expect(checkAnswerPage(page.replace('</style>', '</STYLE><form></form><style></style>'))).toBe('stylesheet');
    expect(checkAnswerPage(page.replace("default-src 'none'", "default-src *"))).toBe('csp');
    expect(checkAnswerPage(page.replace(/<meta http-equiv[^>]*>/, ''))).toBe('csp');
    expect(checkAnswerPage(page.replace('http-equiv="Content-Security-Policy"', 'http-equiv="X-Nothing"'))).toBe('csp');
    expect(checkAnswerPage(page.replace('http-equiv="Content-Security-Policy"', 'http-equiv="refresh" content="0;url=https://evil"'))).toBe('attribute');
    const meta = /<meta http-equiv[^>]*>/.exec(page)?.[0] ?? '';
    expect(checkAnswerPage(page.replace(meta, '').replace('<main>', `<main>${meta}`))).toBe('csp');
    expect(checkAnswerPage(page.replace('<!doctype html>', ''))).toBe('markup');
    expect(checkAnswerPage(page + ' '.repeat(2 * 1024 * 1024))).toBe('page too large');
  });

  it('reads what the page shows, SVG labels and encoded text included', () => {
    expect(decodeEntities('&#115;k&#x2d;&lt;&amp;&#43;&nbsp;&bogus;')).toBe('sk-<&+\u00a0&bogus;'.replace('\u00a0', ' '));
    const page = golden('product-vi.html').replace('</svg>', '<text x="1" y="1">to&#107;en: abcdefgh123</text></svg>');
    expect(answerPageVisibleTexts(page).some((t) => t.includes('token: abcdefgh123'))).toBe(true);
    expect(answerPageVisibleTexts(page).some((t) => t.includes('--bg'))).toBe(false);
    const titled = golden('product-vi.html').replace(/<title>[^<]*<\/title>/, '<title>to&#107;en: abcdefgh456</title>');
    expect(answerPageVisibleTexts(titled).some((t) => t.includes('token: abcdefgh456'))).toBe(true);
  });
});

