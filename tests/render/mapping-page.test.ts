import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkAnswerPage, decodeEntities, type MappingResult } from '../../src/render/html.js';
import { checkMappingPage, MAPPING_COPY_SCRIPT, mappingFileName, mappingNotice, mappingPage, mappingPageCSP, mappingPageVisibleTexts, mappingTexts } from '../../src/render/mapping-page.js';

const RES: MappingResult = {
  status: 'done',
  codeMapping: 'parts[2] >= 1 && x < "<script>" https://a.example/x',
  sampleMessage: '[ev]|a<b>|https://b.example',
  supportedOutputFields: [{ name: 'Level', type: 'int' }],
  probeSummary: 'RESULT 0 problem(s) <b>ok</b>',
  identityVerdict: 'userId from RoleID',
  assumptions: ['env test, see https://c.example'],
  toConfirm: ['productCode for prod'],
  notes: ['WARN one'],
  missing: [],
};

const pre = (page: string, id: string): string => decodeEntities(new RegExp(`<pre id="${id}">\\n([\\s\\S]*?)</pre>`).exec(page)?.[1] ?? '');

describe('code mapping page', () => {
  const page = mappingPage('jus_vn LogLevelUp <i>x</i>', RES);

  it('passes the mapping check and not the answer-page check', () => {
    expect(checkMappingPage(page)).toBeUndefined();
    expect(checkAnswerPage(page)).toBeDefined();
  });

  it('pins the script by its hash, without unsafe-inline for scripts', () => {
    const hash = createHash('sha256').update(MAPPING_COPY_SCRIPT, 'utf8').digest('base64');
    expect(mappingPageCSP).toContain(`script-src 'sha256-${hash}'`);
    expect(mappingPageCSP).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(MAPPING_COPY_SCRIPT).not.toMatch(/[<>]/);
  });

  it.each([
    ['a changed script', (p: string) => p.replace(MAPPING_COPY_SCRIPT, MAPPING_COPY_SCRIPT + ' ')],
    ['a second script', (p: string) => p.replace('</main>', '<script>alert(1)</script></main>')],
    ['no script', (p: string) => p.replace(`<script>${MAPPING_COPY_SCRIPT}</script>`, '')],
    ['an event handler', (p: string) => p.replace('<button data-copy="codeMapping">', '<button data-copy="codeMapping" onclick="x()">')],
    ['unsafe-inline scripts', (p: string) => p.replace(mappingPageCSP, mappingPageCSP + " 'unsafe-inline'")],
    ['a script attribute', (p: string) => p.replace(`<script>${MAPPING_COPY_SCRIPT}`, `<script src="x">${MAPPING_COPY_SCRIPT}`)],
  ])('refuses %s', (_name, change) => {
    expect(checkMappingPage(change(page))).toBeDefined();
  });

  it('keeps code bytes exact and defangs only the summary', () => {
    expect(JSON.parse(pre(page, 'codeMapping'))).toBe(RES.codeMapping);
    expect(pre(page, 'sampleMessage')).toBe(RES.sampleMessage);
    expect(JSON.parse(pre(page, 'supportedOutputFields'))).toEqual(RES.supportedOutputFields);
    expect(page).toContain('hxxps://c.example');
    expect(page).not.toContain('<b>ok</b>');
    expect(page).not.toContain('<i>x</i>');
  });

  it('keeps a leading newline in a block', () => {
    expect(pre(mappingPage('r', { ...RES, sampleMessage: '\nline' }), 'sampleMessage')).toBe('\nline');
  });

  it('shows the summary before the blocks', () => {
    const order = ['Tóm tắt', 'RESULT 0 problem(s)', 'userId from RoleID', 'Giả định', 'Cần xác nhận', 'WARN one', 'id="codeMapping"', 'id="supportedOutputFields"', 'id="sampleMessage"'].map((s) => page.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('reads visible text without the script', () => {
    const texts = mappingPageVisibleTexts(page);
    expect(texts.some((s) => s.includes('userId from RoleID'))).toBe(true);
    expect(texts.some((s) => s.includes('addEventListener'))).toBe(false);
  });

  it('lists every field for the secret check', () => {
    const texts = mappingTexts('req', RES);
    for (const want of ['req', RES.codeMapping, RES.sampleMessage, 'Level', 'RESULT 0', 'RoleID', 'env test', 'productCode', 'WARN one']) {
      expect(texts.some((s) => s.includes(want ?? ''))).toBe(true);
    }
  });

  it('names the file and writes the notice', () => {
    expect(mappingFileName('42', new Date('2026-10-28T16:05:09Z'))).toBe('codemapping-42-20261028-160509.html');
    expect(mappingNotice(RES)).toContain('RESULT 0 problem(s) &lt;b&gt;ok&lt;/b&gt;');
  });
});
