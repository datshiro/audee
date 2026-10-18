import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConfigOp } from '../api/types';

export type Path = Array<string | number>;
type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function getAt(root: unknown, path: Path): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (Array.isArray(cur) && typeof key === 'number') cur = cur[key];
    else if (isObj(cur)) cur = cur[String(key)];
    else return undefined;
  }
  return cur;
}

const hasAt = (root: unknown, path: Path): boolean => {
  const parent = getAt(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (last === undefined) return false;
  if (Array.isArray(parent)) return typeof last === 'number' && last < parent.length;
  return isObj(parent) && Object.hasOwn(parent, String(last));
};

export function applyOps(raw: Obj, ops: ConfigOp[]): Obj {
  const root = structuredClone(raw);
  for (const op of ops) {
    let cur: unknown = root;
    for (let i = 0; i < op.path.length - 1; i++) {
      const key = op.path[i]!;
      const next = Array.isArray(cur) ? cur[key as number] : (cur as Obj)[String(key)];
      if (!isObj(next) && !Array.isArray(next)) {
        if (op.delete) {
          cur = undefined;
          break;
        }
        const fresh: Obj = {};
        if (Array.isArray(cur)) cur[key as number] = fresh;
        else (cur as Obj)[String(key)] = fresh;
        cur = fresh;
      } else cur = next;
    }
    if (cur === undefined) continue;
    const last = op.path[op.path.length - 1]!;
    if (op.delete) {
      if (Array.isArray(cur)) cur.splice(last as number, 1);
      else delete (cur as Obj)[String(last)];
    } else if (Array.isArray(cur)) cur[last as number] = structuredClone(op.value);
    else (cur as Obj)[String(last)] = structuredClone(op.value);
  }
  return root;
}

const startsWith = (path: Path, prefix: Path): boolean => prefix.length <= path.length && prefix.every((k, i) => k === path[i]);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

let dirtyCount = 0;
export const hasUnsavedChanges = (): boolean => dirtyCount > 0;

export type Draft = {
  ops: ConfigOp[];
  view: Obj;
  set: (path: Path, value: unknown) => void;
  remove: (path: Path) => void;
  changed: (path: Path) => boolean;
  discard: () => void;
};

export function useDraft(raw: Obj | undefined): Draft {
  const [ops, setOps] = useState<ConfigOp[]>([]);
  const base = useMemo(() => raw ?? {}, [raw]);
  const view = useMemo(() => applyOps(base, ops), [base, ops]);

  useEffect(() => {
    if (ops.length === 0) return;
    dirtyCount++;
    const warn = (e: BeforeUnloadEvent): void => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => {
      dirtyCount--;
      window.removeEventListener('beforeunload', warn);
    };
  }, [ops.length === 0]);

  const push = useCallback(
    (op: ConfigOp) => {
      setOps((prev) => {
        // An index path refers to a position that earlier ops may have shifted, so it never collapses them.
        if (op.path.some((k) => typeof k === 'number')) return [...prev, op];
        const rest = prev.filter((o) => !startsWith(o.path, op.path));
        const withoutOp = applyOps(base, rest);
        const unchanged = op.delete ? !hasAt(withoutOp, op.path) : hasAt(withoutOp, op.path) && same(getAt(withoutOp, op.path), op.value);
        if (unchanged) return rest;
        const restoresRaw = op.delete ? !hasAt(base, op.path) : hasAt(base, op.path) && same(getAt(base, op.path), op.value);
        if (restoresRaw && !rest.some((o) => startsWith(op.path, o.path))) return rest;
        return [...rest, op];
      });
    },
    [base],
  );

  const set = useCallback((path: Path, value: unknown) => push({ path, value }), [push]);
  const remove = useCallback((path: Path) => push({ path, delete: true }), [push]);
  const changed = useCallback((path: Path) => ops.some((o) => startsWith(o.path, path) || startsWith(path, o.path)), [ops]);
  const discard = useCallback(() => setOps([]), []);

  return { ops, view, set, remove, changed, discard };
}
