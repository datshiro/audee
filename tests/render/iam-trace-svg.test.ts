import { describe, expect, it } from 'vitest';
import { checkAnswerPage } from '../../src/render/html.js';
import type { LayoutNode } from '../../src/render/iam-trace-layout.js';
import { LABEL_COLUMNS, laneSvg, laneWidth, LANE_HEIGHT, PITCH, widthRules, wrapLabel } from '../../src/render/iam-trace-svg.js';

const node = (over: Partial<LayoutNode> = {}): LayoutNode => ({ cls: 'other', label: 'Run', inferred: false, time: '10:00:00', marked: false, count: 1, ...over });
const wrap = (svg: string): string => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>x{}</style></head><body>${svg}</body></html>`;

describe('wrapLabel', () => {
  it('keeps a short label on one line and wraps at word boundaries into two', () => {
    expect(wrapLabel('Điều kiện')).toEqual(['Điều kiện']);
    expect(wrapLabel('Kết quả điều kiện quốc gia')).toEqual(['Kết quả điều kiện', 'quốc gia']);
  });

  it('cuts long words and clips more than two lines with an ellipsis', () => {
    expect(wrapLabel('x'.repeat(30))).toEqual(['x'.repeat(LABEL_COLUMNS), 'x'.repeat(12)]);
    const lines = wrapLabel('một hai ba bốn năm sáu bảy tám chín mười mười-một mười-hai');
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith('…')).toBe(true);
    expect(Array.from(lines[1] ?? '').length).toBeLessThanOrEqual(LABEL_COLUMNS + 1);
  });

  it('defangs links before wrapping and returns nothing for blank text', () => {
    expect(wrapLabel('xem https://evil.example/x').join(' ')).toContain('hxxps://');
    expect(wrapLabel('   ')).toEqual([]);
  });
});

describe('laneSvg', () => {
  it('sizes the viewBox from the node count and uses only allowed elements', () => {
    const svg = laneSvg([node(), node({ label: 'Gửi IAM', cls: 'sent', gap: '+1s' }), node({ cls: 'missing', time: '—', sub: 'không ghi nhận' })]);
    const w = laneWidth(3);
    expect(svg).toContain(`viewBox="0 0 ${w} ${LANE_HEIGHT}"`);
    expect(svg).toContain(`width="${w}" height="${LANE_HEIGHT}"`);
    expect(svg).toContain('class="w3"');
    expect(svg).toContain('aria-hidden="true"');
    expect(w).toBe(3 * PITCH + 16);
    expect([...svg.matchAll(/<([a-z]+)/g)].map((m) => m[1])).toEqual(expect.arrayContaining(['svg', 'g', 'path', 'rect', 'text']));
    expect(new Set([...svg.matchAll(/<([a-z]+)/g)].map((m) => m[1]))).toEqual(new Set(['svg', 'g', 'path', 'rect', 'text']));
    expect(svg).not.toContain('style=');
    expect(svg).not.toContain('circle');
    expect(checkAnswerPage(wrap(svg))).toBeUndefined();
  });

  it('draws round nodes as rects with rx, a dashed ring and an asterisk for inferred nodes, no axis for one node', () => {
    const one = laneSvg([node({ inferred: true, cls: 'check' })]);
    expect(one).toContain('class="ring"');
    expect(one).toContain('class="nd n-check"');
    expect(one).toContain('rx="9"');
    expect(one).toContain('Run *');
    expect(one).not.toContain('class="axis"');
    expect(laneSvg([node(), node()])).toContain('class="axis"');
    expect(laneSvg([node()])).not.toContain('class="ring"');
  });

  it('puts the label above, the time and sub-label below and the gap between nodes', () => {
    const svg = laneSvg([node({ label: 'A', sub: 'x3 đến 10:05:00', marked: true, gap: '+1.1s' }), node({ label: 'B' })]);
    const y = (cls: string): number => Number(new RegExp(`class="${cls}" x="[\\d.]+" y="(\\d+)"`).exec(svg)?.[1]);
    expect(y('lb')).toBeLessThan(56);
    expect(y('tm')).toBeGreaterThan(56);
    expect(y('sb')).toBeGreaterThan(y('tm'));
    expect(y('gp')).toBeGreaterThan(y('sb'));
    expect(svg).toContain('10:00:00 †');
    expect(svg).toContain('x3 đến 10:05:00');
    const gapX = Number(/class="gp" x="([\d.]+)"/.exec(svg)?.[1]);
    expect(gapX).toBe(8 + PITCH);
  });

  it('stacks a two-line label above the node without touching it', () => {
    const svg = laneSvg([node({ label: 'Kết quả điều kiện quốc gia' })]);
    const ys = [...svg.matchAll(/class="lb" x="[\d.]+" y="(\d+)"/g)].map((m) => Number(m[1]));
    expect(ys).toEqual([19, 36]);
  });

  it('escapes and defangs model text', () => {
    const svg = laneSvg([node({ label: '<script>alert(1)</script> https://evil.example', sub: '"><b>' })]);
    expect(svg).not.toContain('<script');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toContain('https://');
    expect(svg).toContain('&#34;&gt;&lt;b&gt;');
    expect(checkAnswerPage(wrap(svg))).toBeUndefined();
  });
});

describe('widthRules', () => {
  it('emits one rule per node count, scaling down to 85% before scrolling', () => {
    const css = widthRules([3, 1, 3]);
    expect(css).toBe(`.w1{max-width:${laneWidth(1)}px;min-width:${Math.round(laneWidth(1) * 0.85)}px}\n.w3{max-width:${laneWidth(3)}px;min-width:${Math.round(laneWidth(3) * 0.85)}px}`);
    expect(widthRules([0])).toBe('');
    expect(css).not.toMatch(/url\(|\\|<|>/u);
  });
});
