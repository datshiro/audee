import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { confluenceSyncDate, gateProduct, resolveCite } from '../../src/capability/kb-evidence.js';
import type { KbPaths } from '../../src/fence/profiles.js';

type Obj = Record<string, unknown>;
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const CONFLUENCE = '---\ntitle: "Churn Segment"\nsource: confluence\nlast_synced: 2026-05-20T07:34:23Z\n---\n\n# Churn\n';

describe('kb_query evidence gate', () => {
  let root: string;
  let paths: KbPaths;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'audee-evidence-')));
    const portal = join(root, 'refs/portal-service');
    const journey = join(root, 'refs/journey-service');
    const wiki = join(root, 'wiki');
    for (const d of [join(portal, 'internal'), join(portal, 'config'), journey, join(wiki, 'explanatory'), join(wiki, 'inbox'), join(wiki, 'people')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(portal, 'internal/x.go'), lines(4));
    writeFileSync(join(portal, 'big.go'), lines(600));
    writeFileSync(join(portal, 'config/values-prod.yaml'), lines(2));
    writeFileSync(join(portal, '.env'), 'TOKEN=x\n');
    symlinkSync('.env', join(portal, 'link.go'));
    writeFileSync(join(root, 'outside.go'), lines(3));
    symlinkSync(join(root, 'outside.go'), join(portal, 'escape.go'));
    writeFileSync(join(journey, 'a.go'), lines(3));
    writeFileSync(join(wiki, 'explanatory/a.md'), '# A\n');
    writeFileSync(join(wiki, 'explanatory/churn.md'), CONFLUENCE);
    writeFileSync(join(wiki, 'inbox/x.md'), '# draft\n');
    writeFileSync(join(wiki, 'people/y.md'), '# person\n');
    symlinkSync('../inbox/x.md', join(wiki, 'explanatory/draft.md'));
    paths = { wiki, querySkill: join(root, 'skills/kb-query'), scoutSkill: join(root, 'skills/kb-scout'), repos: [portal, journey] };
  });

  it('resolves a source cite inside one checkout and its line range', () => {
    expect(resolveCite('src', 'portal-service/internal/x.go:2-3', paths)).toMatchObject({ kind: 'src', cite: 'portal-service/internal/x.go:2-3', from: 2, to: 3 });
    expect(resolveCite('src', 'portal-service/internal/x.go:4', paths)).toMatchObject({ cite: 'portal-service/internal/x.go:4-4' });
    for (const bad of ['portal-service/internal/x.go:0', 'portal-service/internal/x.go:5-2', 'portal-service/internal/x.go:3-9', 'portal-service/big.go:1-500']) {
      expect(resolveCite('src', bad, paths), bad).toBeUndefined();
    }
  });

  it('reads a cite the model labelled with its kind as the bare cite', () => {
    expect(resolveCite('src', 'src: portal-service/internal/x.go:2-3', paths)).toEqual(resolveCite('src', 'portal-service/internal/x.go:2-3', paths));
    expect(resolveCite('kb', 'kb: explanatory/a.md', paths)).toEqual(resolveCite('kb', 'explanatory/a.md', paths));
    expect(resolveCite('kb', 'kb: explanatory/a.md', paths)).toBeDefined();
  });

  it('refuses a source cite without a known checkout prefix', () => {
    expect(resolveCite('src', 'internal/x.go:2', paths)).toBeUndefined();
    expect(resolveCite('src', 'nope/x.go:1', paths)).toBeUndefined();
  });

  it('refuses a source cite the session may not read', () => {
    for (const bad of ['portal-service/../journey-service/a.go:1', 'portal-service/escape.go:1', 'portal-service/config/values-prod.yaml:1', 'portal-service/.env:1', 'portal-service/link.go:1']) {
      expect(resolveCite('src', bad, paths), bad).toBeUndefined();
    }
  });

  it('refuses dot files and folders and case variants of denied names', () => {
    const portal = paths.repos[0]!;
    for (const d of ['.deploy', '.circleci', 'SECRETS']) mkdirSync(join(portal, d));
    writeFileSync(join(portal, '.deploy/values-prod.yaml'), lines(2));
    writeFileSync(join(portal, '.circleci/config.yml'), lines(2));
    writeFileSync(join(portal, 'SECRETS/dev.yaml'), lines(2));
    writeFileSync(join(portal, 'Application-prod.yml'), lines(2));
    writeFileSync(join(portal, '.git'), 'gitdir: /x\n');
    writeFileSync(join(paths.wiki, 'inbox/.d.md'), '# d\n');
    for (const bad of ['portal-service/.ENV:1', 'portal-service/.deploy/values-prod.yaml:1', 'portal-service/.circleci/config.yml:1', 'portal-service/SECRETS/dev.yaml:1', 'portal-service/Application-prod.yml:1', 'portal-service/.git:1']) {
      expect(resolveCite('src', bad, paths), bad).toBeUndefined();
    }
    for (const bad of ['INBOX/x.md', 'People/y.md', 'inbox/.d.md']) expect(resolveCite('kb', bad, paths), bad).toBeUndefined();
  });

  it('resolves a wiki cite with or without the wiki prefix, never into inbox or people', () => {
    expect(resolveCite('kb', 'explanatory/a.md', paths)).toMatchObject({ kind: 'kb', cite: 'explanatory/a.md' });
    expect(resolveCite('kb', 'kb-mcp/wiki/explanatory/a.md', paths)).toMatchObject({ cite: 'explanatory/a.md' });
    for (const bad of ['inbox/x.md', 'people/y.md', 'missing.md', 'explanatory/draft.md', '../outside.go', 'explanatory']) {
      expect(resolveCite('kb', bad, paths), bad).toBeUndefined();
    }
  });

  it('reads the sync date of a Confluence copy only', () => {
    expect(confluenceSyncDate(join(paths.wiki, 'explanatory/churn.md'))).toBe('2026-05-20');
    expect(confluenceSyncDate(join(paths.wiki, 'explanatory/a.md'))).toBeUndefined();
    expect(confluenceSyncDate(join(paths.wiki, 'missing.md'))).toBeUndefined();
  });

  it('removes unconfirmed items, clears diagrams of a reading that lost a step and drops an emptied reading', () => {
    const product: Obj = {
      readings: [
        {
          journey: [
            { actor: 'player', text: 'opens', evidence: 'src', cite: 'portal-service/internal/x.go:2-3' },
            { actor: 'player', text: 'guessed', evidence: 'unverified', cite: '' },
          ],
          rules: [{ text: 'documented', evidence: 'kb', cite: 'kb-mcp/wiki/explanatory/churn.md' }],
          diagrams: [{ nodes: [], edges: [] }],
        },
        { journey: [], rules: [{ text: 'made up', evidence: 'src', cite: 'portal-service/internal/nope.go:1' }], diagrams: [] },
      ],
    };
    expect(gateProduct(product, paths)).toEqual({ kept: 2, removed: 2, confluenceDates: ['2026-05-20'] });
    const readings = product['readings'] as Obj[];
    expect(readings).toHaveLength(1);
    expect(readings[0]?.['diagrams']).toEqual([]);
    expect((readings[0]?.['rules'] as Obj[])[0]?.['cite']).toBe('explanatory/churn.md');
  });
});
