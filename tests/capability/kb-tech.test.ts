import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { gateTech, techMarkdown } from '../../src/capability/kb-evidence.js';
import { type CheckedEntry, mapTechCites } from '../../src/capability/kb-synth.js';
import type { KbPaths } from '../../src/fence/profiles.js';

type Obj = Record<string, unknown>;
const SOURCE = Array.from({ length: 40 }, (_, i) => (i === 4 ? 'const password = "hunter2hunter2"' : `func step${i + 1}() {}`)).join('\n') + '\n';
const text = (t: string, cites: string[]): Obj => ({ kind: 'text', text: t, cites });
const code = (cite: string): Obj => ({ kind: 'code', text: '', cites: [cite] });
const answer = (sections: Obj[]): Obj => ({ status: 'done', topic: 't', lang: 'en', title: 'T', sections, notes: [], missing: [] });

describe('kb_query tech answers', () => {
  let paths: KbPaths;
  beforeEach(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'audee-tech-')));
    mkdirSync(join(root, 'portal-service'));
    mkdirSync(join(root, 'wiki/explanatory'), { recursive: true });
    writeFileSync(join(root, 'portal-service/x.go'), SOURCE);
    writeFileSync(join(root, 'wiki/explanatory/a.md'), '# A\n');
    paths = { wiki: join(root, 'wiki'), querySkill: '', scoutSkill: '', repos: [join(root, 'portal-service')] };
  });

  it('keeps cited blocks, drops uncited ones, long code and emptied sections', () => {
    const a = answer([
      { heading: 'Kept', blocks: [text('cited', ['portal-service/x.go:2-3', 'nope/y.go:1']), text('uncited', []), text('doc', ['explanatory/a.md']), code('portal-service/x.go:1-20')] },
      { heading: 'Gone', blocks: [text('bad', ['portal-service/x.go:99'])] },
    ]);
    expect(gateTech(a, paths)).toEqual({ kept: 2, removed: 3, confluenceDates: [] });
    const sections = a['sections'] as Obj[];
    expect(sections.map((s) => s['heading'])).toEqual(['Kept']);
    expect((sections[0]!['blocks'] as Obj[])[0]!['cites']).toEqual(['portal-service/x.go:2-3']);
  });

  it('drops a text block over the length limit and blocks past the section cap', () => {
    const a = answer([{ heading: 'H', blocks: [text('x'.repeat(1501), ['portal-service/x.go:2']), ...Array.from({ length: 21 }, () => text('ok', ['portal-service/x.go:2']))] }]);
    expect(gateTech(a, paths)).toMatchObject({ kept: 19, removed: 3 });
  });

  it('writes Markdown with cites after each text block and code read from the file', () => {
    const a = answer([{ heading: 'Flow', blocks: [text('It checks the limit.', ['portal-service/x.go:2-3']), code('portal-service/x.go:4-6')] }]);
    gateTech(a, paths);
    ((a['sections'] as Obj[])[0]!['blocks'] as Obj[])[1]!['text'] = 'model text never shown';
    const { markdown, sources } = techMarkdown(a, paths);
    expect(markdown).toContain('## Flow');
    expect(markdown).toContain('It checks the limit. *(portal-service/x.go:2-3)*');
    expect(markdown).toContain('```\n// portal-service/x.go:4-6\nfunc step4() {}\nconst password = "<redacted>"\nfunc step6() {}\n```');
    expect(markdown).not.toContain('model text never shown');
    expect(markdown).not.toContain('hunter2hunter2');
    expect(sources).toEqual(['portal-service/x.go:2-3', 'portal-service/x.go:4-6']);
  });

  it('maps evidence ids to real cites and drops blocks citing unknown ids or code citing a doc', () => {
    const entries: CheckedEntry[] = [
      { id: 'E1', kind: 'src', cite: 'portal-service/x.go:2-3', about: '', quote: '', context: '' },
      { id: 'E2', kind: 'kb', cite: 'explanatory/a.md', about: '', quote: '', context: '' },
    ];
    const a = answer([{ heading: 'H', blocks: [text('a', ['E1', 'E9']), text('b', ['E9']), code('E2'), code('E1')] }]);
    expect(mapTechCites(a, entries)).toEqual({ removed: 2 });
    const blocks = (a['sections'] as Obj[])[0]!['blocks'] as Obj[];
    expect(blocks.map((b) => b['cites'])).toEqual([['portal-service/x.go:2-3'], ['portal-service/x.go:2-3']]);
  });
});
