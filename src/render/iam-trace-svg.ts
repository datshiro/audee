// One timeline lane as inline SVG, using only the elements and attributes checkAnswerPage allows: colours and dashes come
// from CSS classes, text is centred by CSS, and every model string is defanged, clipped and escaped.
import { defang } from './defang.js';
import { clip, escapeHTML } from './html.js';
import type { DeliveryPaths } from './iam-trace-channels.js';
import type { LayoutNode } from './iam-trace-layout.js';

export const PITCH = 156;
export const PAD = 8;
export const LANE_HEIGHT = 150;
export const LABEL_COLUMNS = 18;
export const SUB_COLUMNS = 20;
const SHRINK_LIMIT = 0.85;
const AXIS_Y = 56;
const R = 9;

export const laneWidth = (nodes: number): number => nodes * PITCH + 2 * PAD;

const length = (s: string): number => Array.from(s).length;

function pieces(word: string, columns: number): string[] {
  const chars = Array.from(word);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += columns) out.push(chars.slice(i, i + columns).join(''));
  return out;
}

// Greedy word wrap into at most maxLines lines of `columns` characters; words longer than a line are cut and the last
// line ends with an ellipsis when text is left over.
export function wrapText(source: string, columns: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const piece of defang(source).normalize('NFC').split(/\s+/u).filter((w) => w !== '').flatMap((w) => pieces(w, columns))) {
    if (line === '' || length(`${line} ${piece}`) <= columns) line = line === '' ? piece : `${line} ${piece}`;
    else {
      lines.push(line);
      line = piece;
    }
  }
  if (line !== '') lines.push(line);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), clip(lines.slice(maxLines - 1).join(' '), columns)];
}

export const wrapLabel = (label: string): string[] => wrapText(label, LABEL_COLUMNS, 2);

const text = (cls: string, x: number, y: number, body: string): string => `<text class="${cls}" x="${x}" y="${y}">${escapeHTML(body)}</text>`;

export function laneSvg(nodes: LayoutNode[]): string {
  const w = laneWidth(nodes.length);
  const cx = (i: number): number => PAD + PITCH / 2 + i * PITCH;
  const parts: string[] = [];
  if (nodes.length > 1) parts.push(`<path class="axis" d="M${cx(0)} ${AXIS_Y} L${cx(nodes.length - 1)} ${AXIS_Y}"/>`);
  // Times, results, notes and gaps come before the labels in the markup (placement is by x/y): the secret check reads the
  // page text with no separator between texts, and a label ending in "token:" must not run into a time.
  nodes.forEach((n, i) => {
    const x = cx(i);
    parts.push(text('tm', x, 88, `${n.time}${n.marked ? ' †' : ''}`));
    if (n.result !== undefined) parts.push(text('sb', x, 106, clip(defang(n.result), SUB_COLUMNS)));
    if (n.note !== undefined) parts.push(text('nt', x, 122, clip(defang(n.note), SUB_COLUMNS)));
    if (n.gap !== undefined) parts.push(text('gp', x + PITCH / 2, 142, n.gap));
  });
  nodes.forEach((n, i) => {
    const x = cx(i);
    if (n.inferred) parts.push(`<rect class="ring" x="${x - R - 4}" y="${AXIS_Y - R - 4}" width="${2 * R + 8}" height="${2 * R + 8}" rx="${R + 4}"/>`);
    parts.push(`<rect class="nd n-${n.cls}" x="${x - R}" y="${AXIS_Y - R}" width="${2 * R}" height="${2 * R}" rx="${R}"/>`);
  });
  nodes.forEach((n, i) => {
    // The asterisk rides on the last line so it never wraps onto a line of its own.
    const lines = wrapLabel(n.label);
    if (n.inferred) lines.splice(-1, 1, `${lines.at(-1) ?? ''} *`.trim());
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

// The three ways a message can reach the SDK, left to right: the message, the way, what the logs say about it.
export const PATHS_WIDTH = 760;
const ROWS = [50, 130, 210];
const BOX_H = 64;
const BOX_X = [24, 244, 508];
const BOX_W = [184, 228, 228];

export function pathsSvg(model: DeliveryPaths): string {
  const [mx, px, ox] = BOX_X as [number, number, number];
  const [mw, pw, ow] = BOX_W as [number, number, number];
  const top = (ROWS[0] as number) - BOX_H / 2;
  const bottom = (ROWS[2] as number) + BOX_H / 2;
  const parts: string[] = [`<rect class="mb" x="${mx}" y="${top}" width="${mw}" height="${bottom - top}" rx="8"/>`];
  model.message.forEach((line, i) => parts.push(text(i === 0 ? 'ls lb' : 'ls dt', mx + 12, top + 24 + i * 22, clip(defang(line), 20))));
  model.paths.forEach((path, i) => {
    const cy = ROWS[i] as number;
    const arrow = (from: number, to: number): string => `<path class="arw" d="M${from} ${cy} L${to - 7} ${cy}"/><polygon class="arh" points="${to - 8},${cy - 4} ${to},${cy} ${to - 8},${cy + 4}"/>`;
    parts.push(arrow(mx + mw, px), arrow(px + pw, ox));
    parts.push(`<rect class="pb" x="${px}" y="${cy - BOX_H / 2}" width="${pw}" height="${BOX_H}" rx="8"/>`);
    parts.push(`<rect class="ob-${path.outcome}" x="${ox}" y="${cy - BOX_H / 2}" width="${ow}" height="${BOX_H}" rx="8"/>`);
    parts.push(text('ls lb', px + 12, cy - 8, clip(defang(path.name), 26)));
    wrapText(path.detail, 26, 2).forEach((line, j) => parts.push(text('ls dt mu', px + 12, cy + 8 + j * 14, line)));
    parts.push(text('ls lb', ox + 12, cy - 8, clip(defang(path.result), 26)));
    wrapText(path.resultDetail, 26, 2).forEach((line, j) => parts.push(text('ls dt', ox + 12, cy + 8 + j * 14, line)));
  });
  const height = bottom + 12;
  return `<svg class="wp" viewBox="0 0 ${PATHS_WIDTH} ${height}" width="${PATHS_WIDTH}" height="${height}" aria-hidden="true"><g>${parts.join('')}</g></svg>`;
}
