import { useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ConfigMeta, ConfigView } from '../api/types';
import { PendingBar, useConfigEditor } from '../components/pending-bar';
import { Checkbox, NumberField, SelectField, Switch, SwitchRow, TextField } from '../components/ui/controls';
import { Overlay } from '../components/ui/overlay';
import { PageHeader, RefreshButton } from '../components/ui/page';
import { Empty, ErrorState, LoadingBlock } from '../components/ui/states';
import { getAt, isObj, type Draft } from '../lib/config-draft';
import { DURATION_RE, msToDuration } from '../lib/format';

type Obj = Record<string, unknown>;
const BUILTIN_PROFILE: Record<string, string> = { review: 'review', code_mapping: 'mapping', kb_query: 'kb_read' };
const durationError = (v: string): string | undefined => (DURATION_RE.test(v.trim()) ? undefined : 'Use a number followed by s, m or h, like 45m');
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const MODELS_LIST = 'model-suggestions';

function ModelList({ models }: { models: string[] }) {
  return (
    <datalist id={MODELS_LIST}>
      {models.map((m) => (
        <option key={m} value={m} />
      ))}
    </datalist>
  );
}

function RoutesEditor({ routes, onChange, changed }: { routes: Array<{ match: string; prompt: string }>; onChange: (r: Array<{ match: string; prompt: string }>) => void; changed: boolean }) {
  const update = (i: number, patch: Partial<{ match: string; prompt: string }>): void => onChange(routes.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="rounded-lg border border-line p-3">
      <legend className="px-1 text-xs font-medium text-muted">
        Routes {changed && <span className="text-warn">· changed</span>}
      </legend>
      <p className="hint mb-3 mt-0">The first route whose regex matches the MR URL picks the prompt. No match uses the capability prompt.</p>
      {routes.length === 0 && <p className="mb-3 text-[0.8125rem] text-subtle">No routes.</p>}
      <ol className="space-y-3">
        {routes.map((r, i) => (
          <li key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-end">
            <TextField label={`Route ${i + 1} match (regex)`} mono value={r.match} onChange={(v) => update(i, { match: v })} />
            <TextField label="Prompt" mono value={r.prompt} onChange={(v) => update(i, { prompt: v })} placeholder="/apo-review-mr {url}" />
            <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove route ${i + 1}`} onClick={() => onChange(routes.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="btn btn-sm mt-3" onClick={() => onChange([...routes, { match: '', prompt: '' }])}>
        <Plus className="size-3.5" aria-hidden="true" /> Add route
      </button>
    </fieldset>
  );
}

function McpEditor({ servers, tools, meta, onServers, onTools, changedServers, changedTools }: { servers: string[]; tools: string[]; meta: ConfigMeta; onServers: (s: string[]) => void; onTools: (t: string[]) => void; changedServers: boolean; changedTools: boolean }) {
  const known = Object.keys(meta.readOnlyMcpTools);
  const allowed = new Set(servers.flatMap((s) => meta.readOnlyMcpTools[s] ?? []));
  const stray = tools.filter((t) => !allowed.has(t));
  const toggleServer = (s: string, on: boolean): void => {
    const next = on ? [...servers, s] : servers.filter((x) => x !== s);
    onServers(next);
    if (!on) {
      const keep = new Set(next.flatMap((x) => meta.readOnlyMcpTools[x] ?? []));
      const pruned = tools.filter((t) => keep.has(t));
      if (pruned.length !== tools.length) onTools(pruned);
    }
  };
  const toggleTool = (t: string, on: boolean): void => onTools(on ? [...tools, t] : tools.filter((x) => x !== t));
  return (
    <fieldset className="rounded-lg border border-line p-3">
      <legend className="px-1 text-xs font-medium text-muted">MCP access {(changedServers || changedTools) && <span className="text-warn">· changed</span>}</legend>
      <div className="eyebrow mb-1">Servers</div>
      {known.length === 0 ? (
        <p className="text-[0.8125rem] text-subtle">No read-only MCP servers are known to this audee build.</p>
      ) : (
        <div className="flex flex-wrap gap-x-5">
          {known.map((s) => (
            <Checkbox key={s} mono label={s} checked={servers.includes(s)} onChange={(on) => toggleServer(s, on)} />
          ))}
        </div>
      )}
      {servers.filter((s) => !known.includes(s)).map((s) => (
        <p key={s} className="mt-1 text-xs text-danger">
          <span className="mono">{s}</span> has no read-only tool list, so it will be rejected.{' '}
          <button type="button" className="underline" onClick={() => toggleServer(s, false)}>Remove it</button>
        </p>
      ))}
      {servers.filter((s) => known.includes(s)).map((s) => (
        <div key={s} className="mt-3">
          <div className="eyebrow mb-1">
            Tools · <span className="mono normal-case tracking-normal">{s}</span>
          </div>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {(meta.readOnlyMcpTools[s] ?? []).map((t) => (
              <Checkbox key={t} mono label={t} checked={tools.includes(t)} onChange={(on) => toggleTool(t, on)} />
            ))}
          </div>
        </div>
      ))}
      {stray.length > 0 && (
        <div className="mt-3 rounded-md bg-danger-soft p-2.5 text-xs">
          <div className="mb-1 font-medium text-danger">Not on the read-only list (will be rejected):</div>
          {stray.map((t) => (
            <Checkbox key={t} mono label={t} checked onChange={() => toggleTool(t, false)} />
          ))}
        </div>
      )}
      <p className="hint mt-2">Only tools on the read-only list for each server can be granted.</p>
    </fieldset>
  );
}

function CapabilityCard({ name, view, effective, draft, meta, lanes, grantees, onRemove }: { name: string; view: Obj; effective: Obj | undefined; draft: Draft; meta: ConfigMeta; lanes: string[]; grantees: string[]; onRemove: () => void }) {
  const p = (field: string): Array<string | number> => ['capabilities', name, field];
  const val = (field: string): unknown => view[field] ?? effective?.[field];
  const explicit = (field: string): boolean => field in view;
  const isDefault = (field: string): string | undefined => (explicit(field) ? undefined : effective?.[field] !== undefined ? 'Default' : undefined);
  const profile = String(val('profile') ?? '');
  const enabled = view['enabled'] !== false;
  const timeoutRaw = view['timeout'];
  const timeout = typeof timeoutRaw === 'string' ? timeoutRaw : typeof effective?.['timeout'] === 'number' ? msToDuration(effective['timeout']) : '';
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const setOptNum = (field: string) => (v: number | undefined): void => (v === undefined ? draft.remove(p(field)) : draft.set(p(field), v));
  const routes = Array.isArray(val('routes')) ? (val('routes') as Array<{ match: string; prompt: string }>) : [];

  return (
    <article className={`card ${enabled ? '' : 'opacity-80'}`} aria-labelledby={`cap-${name}`}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 id={`cap-${name}`} className="mono text-[0.9375rem] font-semibold">
            {name}
          </h2>
          <span className="chip chip-plain mono">{profile || 'no profile'}</span>
          {meta.builtinCapabilities.includes(name) && <span className="chip chip-plain">built-in defaults</span>}
          {!enabled && <span className="chip chip-warn">disabled</span>}
          {draft.changed(['capabilities', name]) && <span className="chip chip-warn chip-plain">edited</span>}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[0.8125rem] text-muted">
            Enabled
            <Switch label={`${name} enabled`} checked={enabled} onChange={(on) => (on ? draft.remove(p('enabled')) : draft.set(p('enabled'), false))} />
          </label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove} aria-label={`Remove capability ${name}`}>
            <Trash2 className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Remove</span>
          </button>
        </div>
      </header>
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <TextField className="lg:col-span-2" label="Model" mono list={MODELS_LIST} value={String(val('model') ?? '')} hint={isDefault('model')} changed={draft.changed(p('model'))} onChange={(v) => (v.trim() === '' ? draft.remove(p('model')) : draft.set(p('model'), v.trim()))} />
          <SelectField label="Lane" value={String(val('lane') ?? '')} options={lanes} changed={draft.changed(p('lane'))} onChange={(v) => draft.set(p('lane'), v)} />
          <NumberField label="Budget (USD)" step={0.5} value={num(val('budget_usd'))} hint={isDefault('budget_usd') ?? 'Per session'} placeholder="No cap" changed={draft.changed(p('budget_usd'))} onChange={setOptNum('budget_usd')} />
          <TextField label="Timeout" mono value={timeout} hint={isDefault('timeout') ?? 'e.g. 45m, 2h'} validate={durationError} changed={draft.changed(p('timeout'))} onChange={(v) => draft.set(p('timeout'), v.trim())} />
          <NumberField label="Per-person limit" integer value={num(val('per_person_limit'))} placeholder="No limit" hint="Per person, in flight" changed={draft.changed(p('per_person_limit'))} onChange={setOptNum('per_person_limit')} />
        </div>
        {profile === 'mcp_read' && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
            <TextField className="lg:col-span-2" label="Trigger word" mono value={String(val('trigger') ?? '')} hint="A message must contain this word" changed={draft.changed(p('trigger'))} onChange={(v) => (v.trim() === '' ? draft.remove(p('trigger')) : draft.set(p('trigger'), v.trim()))} />
          </div>
        )}
        {(profile === 'review' || profile === 'mapping') && (
          <div className="grid gap-x-8 gap-y-2 rounded-lg bg-sunken px-4 py-3 sm:grid-cols-2">
            {profile === 'review' && (
              <SwitchRow label="Post findings" hint="Post review findings to the MR instead of only replying in Teams" checked={val('post_findings') === true} changed={draft.changed(p('post_findings'))} onChange={(on) => draft.set(p('post_findings'), on)} />
            )}
            <SwitchRow label="Seatbelt" hint="Run the session inside the macOS sandbox" checked={val('seatbelt') === true} changed={draft.changed(p('seatbelt'))} onChange={(on) => draft.set(p('seatbelt'), on)} />
          </div>
        )}
        {profile === 'review' && <RoutesEditor routes={routes} changed={draft.changed(p('routes'))} onChange={(r) => draft.set(p('routes'), r)} />}
        {profile === 'mcp_read' && (
          <McpEditor
            meta={meta}
            servers={asStrings(val('mcp'))}
            tools={asStrings(val('tools'))}
            changedServers={draft.changed(p('mcp'))}
            changedTools={draft.changed(p('tools'))}
            onServers={(s) => draft.set(p('mcp'), s)}
            onTools={(t) => draft.set(p('tools'), t)}
          />
        )}
        <p className="text-xs text-subtle">
          Granted to: {grantees.length === 0 ? <span>nobody yet (add it under People)</span> : <span className="text-muted">{grantees.join(', ')}</span>}
        </p>
      </div>
    </article>
  );
}

type NewCap = { name: string; profile: string; lane: string; model: string; budget?: number; timeout: string; trigger: string; servers: string[]; tools: string[] };

function AddCapabilityDialog({ open, onClose, existing, meta, lanes, onAdd }: { open: boolean; onClose: () => void; existing: string[]; meta: ConfigMeta; lanes: string[]; onAdd: (name: string, value: Obj) => void }) {
  const blank: NewCap = { name: '', profile: 'kb_read', lane: lanes[0] ?? '', model: meta.models[0] ?? '', timeout: '', trigger: '', servers: [], tools: [] };
  const [f, setF] = useState<NewCap>(blank);
  const [tried, setTried] = useState(false);
  const builtin = meta.builtinCapabilities.includes(f.name);
  const profiles = meta.profiles.filter((p) => p !== 'classifier');

  const errors: Partial<Record<keyof NewCap, string>> = {};
  if (!/^[a-z][a-z0-9_]*$/.test(f.name)) errors.name = 'Lowercase letters, digits and underscores, starting with a letter';
  else if (existing.includes(f.name)) errors.name = 'A capability with this name exists';
  if (f.lane === '') errors.lane = 'Pick a lane';
  if (f.timeout.trim() === '' ? !builtin : durationError(f.timeout) !== undefined) errors.timeout = 'Use a number followed by s, m or h, like 15m';
  if (f.profile === 'mcp_read') {
    if (f.trigger.trim() === '') errors.trigger = 'mcp_read capabilities need a trigger word';
    if (f.servers.length === 0) errors.servers = 'Pick at least one server';
    if (f.tools.length === 0) errors.tools = 'Pick at least one tool';
  }
  const valid = Object.keys(errors).length === 0;

  const close = (): void => {
    setF(blank);
    setTried(false);
    onClose();
  };
  const submit = (): void => {
    setTried(true);
    if (!valid) return;
    const value: Obj = { profile: f.profile, lane: f.lane };
    if (f.model.trim() !== '') value['model'] = f.model.trim();
    if (f.budget !== undefined) value['budget_usd'] = f.budget;
    if (f.timeout.trim() !== '') value['timeout'] = f.timeout.trim();
    if (f.profile === 'mcp_read') Object.assign(value, { trigger: f.trigger.trim(), mcp: f.servers, tools: f.tools });
    onAdd(f.name, value);
    close();
  };
  const err = (k: keyof NewCap): string | undefined => (tried ? errors[k] : undefined);
  const setName = (name: string): void => setF((x) => ({ ...x, name, ...(BUILTIN_PROFILE[name] !== undefined ? { profile: BUILTIN_PROFILE[name] } : {}) }));

  return (
    <Overlay
      open={open}
      onClose={close}
      title="Add capability"
      description="Added to the pending changes; nothing is written until you save."
      footer={
        <>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit}>Add capability</button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div>
          <label className="label" htmlFor="nc-name">Name</label>
          <input id="nc-name" className="input mono" list="builtin-names" value={f.name} onChange={(e) => setName(e.target.value.trim())} aria-invalid={err('name') !== undefined} aria-describedby="nc-name-hint" autoFocus />
          <datalist id="builtin-names">
            {meta.builtinCapabilities.filter((b) => !existing.includes(b)).map((b) => <option key={b} value={b} />)}
          </datalist>
          <p id="nc-name-hint" className={`hint ${err('name') ? '!text-danger' : ''}`}>
            {err('name') ?? (builtin ? 'Built-in: timeout, budget, prompt and directories default sensibly.' : `Built-in names: ${meta.builtinCapabilities.join(', ')}`)}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Profile" value={f.profile} options={profiles} onChange={(v) => setF((x) => ({ ...x, profile: v }))} />
          <div>
            <SelectField label="Lane" value={f.lane} options={lanes} onChange={(v) => setF((x) => ({ ...x, lane: v }))} />
            {err('lane') && <p className="hint !text-danger">{err('lane')}</p>}
          </div>
          <TextField className="sm:col-span-2" label="Model" mono list={MODELS_LIST} value={f.model} onChange={(v) => setF((x) => ({ ...x, model: v }))} />
          <NumberField label="Budget (USD)" step={0.5} value={f.budget} placeholder={builtin ? 'Built-in default' : 'No cap'} onChange={(v) => setF((x) => { const { budget: _b, ...rest } = x; return v === undefined ? rest : { ...rest, budget: v }; })} />
          <div>
            <label className="label" htmlFor="nc-timeout">Timeout</label>
            <input id="nc-timeout" className="input mono" value={f.timeout} placeholder={builtin ? 'Built-in default' : '15m'} onChange={(e) => setF((x) => ({ ...x, timeout: e.target.value }))} aria-invalid={err('timeout') !== undefined} aria-describedby="nc-timeout-hint" />
            <p id="nc-timeout-hint" className={`hint ${err('timeout') ? '!text-danger' : ''}`}>{err('timeout') ?? 'e.g. 10m, 1h'}</p>
          </div>
        </div>
        {f.profile === 'mcp_read' && (
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="nc-trigger">Trigger word</label>
              <input id="nc-trigger" className="input mono" value={f.trigger} placeholder="grafana_query" onChange={(e) => setF((x) => ({ ...x, trigger: e.target.value }))} aria-invalid={err('trigger') !== undefined} />
              {err('trigger') && <p className="hint !text-danger">{err('trigger')}</p>}
            </div>
            <McpEditor meta={meta} servers={f.servers} tools={f.tools} changedServers={false} changedTools={false} onServers={(s) => setF((x) => ({ ...x, servers: s }))} onTools={(t) => setF((x) => ({ ...x, tools: t }))} />
            {(err('servers') ?? err('tools')) && <p className="hint !text-danger">{err('servers') ?? err('tools')}</p>}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Overlay>
  );
}

function RemoveDialog({ name, grantees, onClose, onRemove }: { name: string | null; grantees: string[]; onClose: () => void; onRemove: (alsoGrants: boolean) => void }) {
  const [alsoGrants, setAlsoGrants] = useState(true);
  return (
    <Overlay
      open={name !== null}
      onClose={onClose}
      title={`Remove capability “${name ?? ''}”?`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={() => onRemove(alsoGrants && grantees.length > 0)}>Remove capability</button>
        </>
      }
    >
      <div className="space-y-3 text-[0.875rem] text-muted">
        <p>Its whole block is deleted from config.yaml when you save. Nobody can request it afterwards.</p>
        {grantees.length > 0 ? (
          <div className="rounded-lg border border-[var(--warn-strong)] bg-warn-soft p-3 text-ink">
            <p className="text-[0.8125rem]">
              <strong>{grantees.join(', ')}</strong> {grantees.length === 1 ? 'has' : 'have'} a <code className="mono">can</code> grant for it. audee rejects the save while a grant references a missing capability.
            </p>
            <div className="mt-2">
              <Checkbox label="Also remove it from their grants" checked={alsoGrants} onChange={setAlsoGrants} />
            </div>
          </div>
        ) : (
          <p className="text-xs">No one has an explicit grant for it.</p>
        )}
      </div>
    </Overlay>
  );
}

function grantsFor(people: unknown, name: string): string[] {
  if (!Array.isArray(people)) return [];
  return people.filter((p): p is Obj => isObj(p) && asStrings(p['can']).includes(name)).map((p) => String(p['name'] ?? '?'));
}

function Content({ view, data, draft, refresh }: { view: Obj; data: ConfigView; draft: Draft; refresh: ReactNode }) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const caps = isObj(view['capabilities']) ? view['capabilities'] : {};
  const names = Object.keys(caps);
  const effCaps = getAt(data.effective, ['capabilities']);
  const lanes = Object.keys(isObj(getAt(view, ['concurrency', 'lanes'])) ? (getAt(view, ['concurrency', 'lanes']) as Obj) : {});
  const removingGrantees = removing === null ? [] : grantsFor(view['people'], removing);
  const everyone = Array.isArray(view['people']) ? (view['people'] as Obj[]).filter((p) => asStrings(p['can']).includes('*')).map((p) => `${String(p['name'])} (*)`) : [];

  return (
    <>
      <PageHeader
        title="Capabilities"
        description="What audee can do, which lane it runs in, and what each session may spend."
        actions={
          <>
            {refresh}
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" aria-hidden="true" /> Add capability
            </button>
          </>
        }
      />
      <ModelList models={data.meta.models} />
      {names.length === 0 ? (
        <div className="card">
          <Empty title="No capabilities configured">Add one to let people ask audee for work.</Empty>
        </div>
      ) : (
        <div className="space-y-4">
          {names.map((name) => (
            <CapabilityCard
              key={name}
              name={name}
              view={isObj(caps[name]) ? (caps[name] as Obj) : {}}
              effective={isObj(getAt(effCaps, [name])) ? (getAt(effCaps, [name]) as Obj) : undefined}
              draft={draft}
              meta={data.meta}
              lanes={lanes}
              grantees={[...grantsFor(view['people'], name), ...everyone]}
              onRemove={() => setRemoving(name)}
            />
          ))}
        </div>
      )}
      <AddCapabilityDialog open={adding} onClose={() => setAdding(false)} existing={names} meta={data.meta} lanes={lanes} onAdd={(name, value) => draft.set(['capabilities', name], value)} />
      <RemoveDialog
        name={removing}
        grantees={removingGrantees}
        onClose={() => setRemoving(null)}
        onRemove={(alsoGrants) => {
          if (removing === null) return;
          if (alsoGrants && Array.isArray(view['people'])) {
            draft.set(['people'], (view['people'] as Obj[]).map((p) => (asStrings(p['can']).includes(removing) ? { ...p, can: asStrings(p['can']).filter((c) => c !== removing) } : p)));
          }
          draft.remove(['capabilities', removing]);
          setRemoving(null);
        }}
      />
    </>
  );
}

export function CapabilitiesPage() {
  const { cfg, draft } = useConfigEditor();
  if (cfg.data === undefined) {
    return (
      <>
        <PageHeader title="Capabilities" actions={<RefreshButton onClick={cfg.reload} loading={cfg.loading} />} />
        <div className="card p-4">{cfg.error !== undefined ? <ErrorState message={cfg.error} onRetry={cfg.reload} /> : <LoadingBlock rows={6} />}</div>
      </>
    );
  }
  return (
    <>
      <Content view={draft.view} data={cfg.data} draft={draft} refresh={<RefreshButton onClick={cfg.reload} loading={cfg.loading} />} />
      <PendingBar draft={draft} onSaved={cfg.reload} />
    </>
  );
}
