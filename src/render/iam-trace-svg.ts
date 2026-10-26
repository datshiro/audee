// One timeline lane as inline SVG, using only the elements and attributes checkAnswerPage allows: colours and dashes come
// from CSS classes, text is centred by CSS, and every model string is defanged, clipped and escaped.
import { defang } from './defang.js';
import { clip, escapeHTML } from './html.js';
import type { LayoutNode } from './iam-trace-layout.js';

export const PITCH = 156;
export const PAD = 8;
export const LANE_HEIGHT = 134;
export const LABEL_COLUMNS = 18;
export const SUB_COLUMNS = 20;
const SHRINK_LIMIT = 0.85;
const AXIS_Y = 56;
const R = 9;

export const laneWidth = (nodes: number): number => nodes * PITCH + 2 * PAD;

const length = (s: string): number => Array.from(s).length;

function pieces(word: string): string[] {
  const chars = Array.from(word);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += LABEL_COLUMNS) out.push(chars.slice(i, i + LABEL_COLUMNS).join(''));
  return out;
}

// Greedy word wrap into at most two lines of LABEL_COLUMNS characters; words longer than a line are cut.
export function wrapLabel(label: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const piece of defang(label).normalize('NFC').split(/\s+/u).filter((w) => w !== '').flatMap(pieces)) {
    if (line === '' || length(`${line} ${piece}`) <= LABEL_COLUMNS) line = line === '' ? piece : `${line} ${piece}`;
    else {
      lines.push(line);
      line = piece;
    }
  }
  if (line !== '') lines.push(line);
  if (lines.length <= 2) return lines;
  return [lines[0] as string, clip(lines.slice(1).join(' '), LABEL_COLUMNS)];
}

const text = (cls: string, x: number, y: number, body: string): string => `<text class="${cls}" x="${x}" y="${y}">${escapeHTML(body)}</text>`;

export function laneSvg(nodes: LayoutNode[]): string {
  const w = laneWidth(nodes.length);
  const cx = (i: number): number => PAD + PITCH / 2 + i * PITCH;
  const parts: string[] = [];
  if (nodes.length > 1) parts.push(`<path class="axis" d="M${cx(0)} ${AXIS_Y} L${cx(nodes.length - 1)} ${AXIS_Y}"/>`);
  // Times, sub-labels and gaps come before the labels in the markup (placement is by x/y): the secret check reads the
  // page text with no separator between texts, and a label ending in "token:" must not run into a time.
  nodes.forEach((n, i) => {
    const x = cx(i);
    parts.push(text('tm', x, 88, `${n.time}${n.marked ? ' †' : ''}`));
    if (n.sub !== undefined) parts.push(text('sb', x, 106, clip(defang(n.sub), SUB_COLUMNS)));
    if (n.gap !== undefined) parts.push(text('gp', x + PITCH / 2, 126, n.gap));
  });
  nodes.forEach((n, i) => {
    const x = cx(i);
    if (n.inferred) parts.push(`<rect class="ring" x="${x - R - 4}" y="${AXIS_Y - R - 4}" width="${2 * R + 8}" height="${2 * R + 8}" rx="${R + 4}"/>`);
    parts.push(`<rect class="nd n-${n.cls}" x="${x - R}" y="${AXIS_Y - R}" width="${2 * R}" height="${2 * R}" rx="${R}"/>`);
  });
  nodes.forEach((n, i) => {
    const lines = wrapLabel(n.label + (n.inferred ? ' *' : ''));
    lines.forEach((line, j) => parts.push(text('lb', cx(i), 36 - (lines.length - 1 - j) * 17, line)));
  });
  return `<svg class="w${nodes.length}" viewBox="0 0 ${w} ${LANE_HEIGHT}" width="${w}" height="${LANE_HEIGHT}" aria-hidden="true"><g>${parts.join('')}</g></svg>`;
}

// A lane scales down with the page to 85% of its natural width and scrolls sideways below that. The stylesheet
// cannot read the SVG's own width, so each node count used gets its own class.
export function widthRules(counts: Iterable<number>): string {
  return [...new Set(counts)]
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
    .map((n) => `.w${n}{max-width:${laneWidth(n)}px;min-width:${Math.round(laneWidth(n) * SHRINK_LIMIT)}px}`)
    .join('\n');
}
