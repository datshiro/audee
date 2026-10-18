import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { Overview, PersonStat } from '../api/types';
import { PendingBar, useConfigEditor } from '../components/pending-bar';
import { Checkbox, ListField, NumberField, Switch, TextField } from '../components/ui/controls';
import { Confirm, Overlay } from '../components/ui/overlay';
import { PageHeader, RefreshButton } from '../components/ui/page';
import { Empty, ErrorState, LoadingBlock } from '../components/ui/states';
import { isObj, type Draft } from '../lib/config-draft';
import { fmtRuns, fmtUsd } from '../lib/format';
import { useLoad } from '../lib/hooks';

type Obj = Record<string, unknown>;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function usageFor(person: Obj, stats: PersonStat[] | undefined): { runs: number; cost: number } | undefined {
  if (stats === undefined) return undefined;
  const ids = strings(person['ids']);
  const mine = stats.filter((s) => ids.includes(s.principal) || (s.personName !== undefined && s.personName === person['name']));
  return { runs: mine.reduce((n, s) => n + s.runs, 0), cost: mine.reduce((n, s) => n + s.costUsd, 0) };
}

function Grants({ can, capabilities, onChange, name }: { can: string[]; capabilities: string[]; onChange: (c: string[]) => void; name: string }) {
  const all = can.includes('*');
  const unknown = can.filter((c) => c !== '*' && !capabilities.includes(c));
  return (
    <fieldset>
      <legend className="sr-only">Capabilities {name} can use</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5">
        <Checkbox label={<span className="font-medium">* all</span>} checked={all} onChange={(on) => onChange(on ? ['*'] : [])} />
        {capabilities.map((c) => (
          <Checkbox key={c} mono label={c} disabled={all} checked={all || can.includes(c)} onChange={(on) => onChange(on ? [...can, c] : can.filter((x) => x !== c))} />
        ))}
        {unknown.map((c) => (
          <Checkbox key={c} mono label={<span className="text-danger">{c} (missing)</span>} checked onChange={() => onChange(can.filter((x) => x !== c))} />
        ))}
      </div>
    </fieldset>
  );
}

function PersonRow({ person, index, capabilities, usage, draft, people, changed, onRemove }: { person: Obj; index: number; capabilities: string[]; usage: { runs: number; cost: number } | undefined; draft: Draft; people: Obj[]; changed: boolean; onRemove: () => void }) {
  const update = (patch: Obj): void => draft.set(['people'], people.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const name = String(person['name'] ?? '');
  return (
    <li className={`grid gap-4 ${changed ? 'border-l-2 border-l-[var(--warn-strong)]' : ''} px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,10rem)_4.5rem_minmax(0,14rem)_minmax(0,1fr)_6rem_6.5rem_auto] lg:items-start`}>
      <TextField label="Name" value={name} onChange={(v) => update({ name: v })} changed={changed} className="lg:[&_.label]:sr-only" />
      <div className="flex items-center justify-between gap-3 lg:block lg:pt-2">
        <span className="label mb-0 lg:sr-only">Owner</span>
        <Switch label={`${name || 'person'} is owner`} checked={person['owner'] === true} onChange={(on) => update({ owner: on })} />
      </div>
      <ListField label="IDs" value={strings(person['ids'])} placeholder="teams:<sender-id>" hint="One per line, like teams:<sender-id>" onChange={(ids) => update({ ids })} className="lg:[&_.label]:sr-only" />
      <div>
        <span className="label lg:sr-only">Can use</span>
        <Grants name={name} can={strings(person['can'])} capabilities={capabilities} onChange={(can) => update({ can })} />
      </div>
      <NumberField label="Max inflight" integer value={typeof person['max_inflight'] === 'number' ? person['max_inflight'] : undefined} placeholder="2" onChange={(v) => {
        if (v === undefined) {
          const { max_inflight: _m, ...rest } = person;
          draft.set(['people'], people.map((p, i) => (i === index ? rest : p)));
        } else update({ max_inflight: v });
      }} className="lg:[&_.label]:sr-only" />
      <div className="text-[0.8125rem] lg:pt-2 lg:text-right">
        <span className="label lg:sr-only">Usage, 7 days</span>
        {usage === undefined ? (
          <span className="text-subtle">—</span>
        ) : (
          <span className="num">
            {fmtRuns(usage.runs)} · <span className="font-medium">{fmtUsd(usage.cost)}</span>
          </span>
        )}
      </div>
      <div className="lg:pt-0.5">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove} aria-label={`Remove ${name || 'person'}`}>
          <Trash2 className="size-3.5" aria-hidden="true" /> <span className="lg:sr-only">Remove</span>
        </button>
      </div>
    </li>
  );
}

function AddPersonDialog({ open, onClose, onAdd, taken }: { open: boolean; onClose: () => void; onAdd: (p: Obj) => void; taken: string[] }) {
  const [name, setName] = useState('');
  const [ids, setIds] = useState('');
  const [tried, setTried] = useState(false);
  const idList = ids.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== '');
  const nameErr = name.trim() === '' ? 'Enter a name' : taken.includes(name.trim()) ? 'Someone already has this name' : undefined;
  const idErr = idList.length === 0 ? 'Add at least one id' : undefined;
  const close = (): void => {
    setName('');
    setIds('');
    setTried(false);
    onClose();
  };
  const submit = (): void => {
    setTried(true);
    if (nameErr !== undefined || idErr !== undefined) return;
    onAdd({ name: name.trim(), ids: idList, can: [] });
    close();
  };
  return (
    <Overlay
      open={open}
      onClose={close}
      title="Add person"
      description="They can use nothing until you tick capabilities for them."
      footer={
        <>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit}>Add person</button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div>
          <label className="label" htmlFor="np-name">Name</label>
          <input id="np-name" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={tried && nameErr !== undefined} autoFocus />
          {tried && nameErr !== undefined && <p className="hint !text-danger">{nameErr}</p>}
        </div>
        <div>
          <label className="label" htmlFor="np-ids">IDs</label>
          <textarea id="np-ids" rows={3} className="input mono" value={ids} placeholder="teams:<sender-id>" onChange={(e) => setIds(e.target.value)} aria-invalid={tried && idErr !== undefined} aria-describedby="np-ids-hint" />
          <p id="np-ids-hint" className={`hint ${tried && idErr ? '!text-danger' : ''}`}>{tried && idErr ? idErr : 'One per line. Find a sender id on the Messages page.'}</p>
        </div>
        <button type="submit" hidden />
      </form>
    </Overlay>
  );
}

export function PeoplePage() {
  const { cfg, draft } = useConfigEditor();
  const overview = useLoad((signal) => api<Overview>('/api/overview', { signal }), []);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);

  const rawPeople = Array.isArray(cfg.data?.raw['people']) ? (cfg.data.raw['people'] as unknown[]) : [];
  const people = Array.isArray(draft.view['people']) ? (draft.view['people'] as unknown[]).filter(isObj) : [];
  const capabilities = Object.keys(isObj(draft.view['capabilities']) ? draft.view['capabilities'] : {});
  const reloadAll = (): void => {
    cfg.reload();
    overview.reload();
  };

  return (
    <>
      <PageHeader
        title="People"
        description="Who audee works for, and what each person may ask for. Usage covers the last 7 days."
        actions={
          <>
            <RefreshButton onClick={reloadAll} loading={cfg.loading || overview.loading} />
            {cfg.data !== undefined && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
                <Plus className="size-3.5" aria-hidden="true" /> Add person
              </button>
            )}
          </>
        }
      />
      {cfg.data === undefined ? (
        <div className="card p-4">{cfg.error !== undefined ? <ErrorState message={cfg.error} onRetry={cfg.reload} /> : <LoadingBlock rows={5} />}</div>
      ) : (
        <div className="card">
          <div className="hidden grid-cols-[minmax(0,10rem)_4.5rem_minmax(0,14rem)_minmax(0,1fr)_6rem_6.5rem_auto] gap-4 border-b border-line px-5 py-2.5 text-xs font-medium text-subtle lg:grid" aria-hidden="true">
            <span>Name</span>
            <span>Owner</span>
            <span>IDs</span>
            <span>Can use</span>
            <span>Max inflight</span>
            <span className="text-right">7d usage</span>
            <span className="w-8" />
          </div>
          {people.length === 0 ? (
            <Empty title="Nobody is configured">audee needs at least one person, usually the owner.</Empty>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {people.map((p, i) => (
                <PersonRow key={i} index={i} person={p} people={people} capabilities={capabilities} usage={usageFor(p, overview.data?.byPerson)} draft={draft} changed={JSON.stringify(rawPeople[i]) !== JSON.stringify(p)} onRemove={() => setRemoving(i)} />
              ))}
            </ul>
          )}
          {overview.error !== undefined && <p className="border-t border-line px-5 py-2 text-xs text-subtle">Usage unavailable: {overview.error}</p>}
        </div>
      )}
      <AddPersonDialog open={adding} onClose={() => setAdding(false)} taken={people.map((p) => String(p['name']))} onAdd={(p) => draft.set(['people'], [...people, p])} />
      <Confirm
        open={removing !== null}
        title={`Remove ${removing !== null ? String(people[removing]?.['name'] ?? 'this person') : ''}?`}
        confirmLabel="Remove person"
        danger
        onConfirm={() => {
          if (removing !== null) draft.set(['people'], people.filter((_, i) => i !== removing));
          setRemoving(null);
        }}
        onClose={() => setRemoving(null)}
      >
        After you save, audee ignores their messages. Their history stays in the events log.
        {people.length === 1 && <p className="mt-2 font-medium text-danger">This is the last person; audee will reject a config with nobody in it.</p>}
      </Confirm>
      <PendingBar draft={draft} onSaved={reloadAll} />
    </>
  );
}
