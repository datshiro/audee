import { useState } from 'react';
import { Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { ConfigView } from '../api/types';
import { PendingBar, useConfigEditor } from '../components/pending-bar';
import { Checkbox, ListField, NumberField, SelectField, Switch, TextField } from '../components/ui/controls';
import { Confirm } from '../components/ui/overlay';
import { PageHeader, RefreshButton, Section } from '../components/ui/page';
import { Empty, ErrorState, LoadingBlock } from '../components/ui/states';
import { getAt, isObj, type Draft, type Path } from '../lib/config-draft';
import { DURATION_RE, msToDuration } from '../lib/format';

type Obj = Record<string, unknown>;
const AUTH = ['subscription', 'api_key'];
const durationError = (v: string): string | undefined => (DURATION_RE.test(v.trim()) ? undefined : 'Use a number followed by s, m or h, like 4h');
const CLOCK_RE = /^\d{2}:\d{2}$/;

function useField(draft: Draft, effective: Obj) {
  const raw = (path: Path): unknown => getAt(draft.view, path);
  const value = (path: Path): unknown => raw(path) ?? getAt(effective, path);
  const str = (path: Path): string => String(value(path) ?? '');
  const dur = (path: Path): string => {
    const r = raw(path);
    if (typeof r === 'string') return r;
    const e = getAt(effective, path);
    return typeof e === 'number' ? msToDuration(e) : '';
  };
  const hint = (path: Path, fallback?: string): string | undefined => (raw(path) === undefined && getAt(effective, path) !== undefined ? 'Default' : fallback);
  const setText = (path: Path) => (v: string): void => (v.trim() === '' ? draft.remove(path) : draft.set(path, v.trim()));
  return { raw, value, str, dur, hint, setText, changed: draft.changed, set: draft.set, remove: draft.remove };
}

function Lanes({ draft, effective }: { draft: Draft; effective: Obj }) {
  const [name, setName] = useState('');
  const lanes = getAt(draft.view, ['concurrency', 'lanes']);
  const entries = isObj(lanes) ? Object.entries(lanes) : [];
  const caps = getAt(draft.view, ['capabilities']);
  const users = (lane: string): string[] => (isObj(caps) ? Object.entries(caps).filter(([, c]) => isObj(c) && c['lane'] === lane).map(([n]) => n) : []);
  const err = name === '' ? undefined : !/^[a-z][a-z0-9_-]*$/.test(name) ? 'Lowercase letters, digits, - and _' : entries.some(([n]) => n === name) ? 'Lane exists' : undefined;
  const add = (): void => {
    if (name === '' || err !== undefined) return;
    draft.set(['concurrency', 'lanes', name], { concurrency: 1, buffer: 32 });
    setName('');
  };
  return (
    <div>
      <div className="eyebrow mb-2">Lanes</div>
      {entries.length === 0 ? (
        <p className="text-[0.8125rem] text-subtle">No lanes. Capabilities need a lane to run in.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-line">
          {entries.map(([lane, cfg]) => {
            const c = isObj(cfg) ? cfg : {};
            const used = users(lane);
            const effBuffer = getAt(effective, ['concurrency', 'lanes', lane, 'buffer']);
            return (
              <li key={lane} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto] sm:items-end">
                <div className="min-w-0 sm:pb-2">
                  <div className="mono text-[0.8125rem] font-semibold">{lane}</div>
                  <div className="truncate text-xs text-subtle">{used.length > 0 ? `Used by ${used.join(', ')}` : 'Unused'}</div>
                </div>
                <NumberField label="Concurrency" integer value={typeof c['concurrency'] === 'number' ? c['concurrency'] : undefined} changed={draft.changed(['concurrency', 'lanes', lane, 'concurrency'])} onChange={(v) => v !== undefined && draft.set(['concurrency', 'lanes', lane, 'concurrency'], v)} />
                <NumberField label="Buffer" integer value={typeof c['buffer'] === 'number' ? c['buffer'] : typeof effBuffer === 'number' ? effBuffer : undefined} placeholder="32" changed={draft.changed(['concurrency', 'lanes', lane, 'buffer'])} onChange={(v) => (v === undefined ? draft.remove(['concurrency', 'lanes', lane, 'buffer']) : draft.set(['concurrency', 'lanes', lane, 'buffer'], v))} />
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  disabled={used.length > 0}
                  title={used.length > 0 ? `In use by ${used.join(', ')}; move them to another lane first` : `Remove lane ${lane}`}
                  aria-label={`Remove lane ${lane}`}
                  onClick={() => draft.remove(['concurrency', 'lanes', lane])}
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="mt-3 flex items-start gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <div className="min-w-0 flex-1 sm:max-w-60">
          <label htmlFor="new-lane" className="sr-only">New lane name</label>
          <input id="new-lane" className="input mono" placeholder="new lane name" value={name} onChange={(e) => setName(e.target.value.trim())} aria-invalid={err !== undefined} aria-describedby="new-lane-hint" />
          <p id="new-lane-hint" className={`hint ${err ? '!text-danger' : ''}`}>{err ?? 'Starts with concurrency 1, buffer 32'}</p>
        </div>
        <button type="submit" className="btn" disabled={name === '' || err !== undefined}>
          <Plus className="size-4" aria-hidden="true" /> Add lane
        </button>
      </form>
    </div>
  );
}

function Content({ data, draft }: { data: ConfigView; draft: Draft }) {
  const f = useField(draft, data.effective);
  const [shadowConfirm, setShadowConfirm] = useState(false);
  const shadowPath = ['channels', 'teams', 'shadow'];
  const shadow = f.value(shadowPath) === true;
  const daysPath = ['channels', 'teams', 'work_hours', 'days'];
  const days = Array.isArray(f.value(daysPath)) ? (f.value(daysPath) as string[]) : [];
  const listOf = (path: Path): string[] => (Array.isArray(f.value(path)) ? (f.value(path) as unknown[]).map(String) : []);
  const baseUrlErr = (v: string): string | undefined => (v.trim() === '' || /^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/u.test(v.trim()) ? undefined : 'Must be an https URL');
  const setShadow = (on: boolean): void => (on ? draft.set(shadowPath, true) : getAt(data.raw, shadowPath) === undefined ? draft.remove(shadowPath) : draft.set(shadowPath, false));

  return (
    <div className="space-y-6">
      <datalist id="settings-models">
        {data.meta.models.map((m) => <option key={m} value={m} />)}
      </datalist>

      <Section title="Teams channel" description="Which chats audee watches and when it answers.">
        <div className="space-y-5">
          <div className={`flex items-start justify-between gap-4 rounded-lg p-4 ${shadow ? 'shadow-band' : 'border border-line bg-sunken'}`}>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[0.875rem] font-semibold">
                <TriangleAlert className={`size-4 ${shadow ? 'text-warn' : 'text-subtle'}`} aria-hidden="true" />
                Shadow mode {shadow ? 'is on' : 'is off'}
                {f.changed(shadowPath) && <span className="chip chip-warn chip-plain">unsaved</span>}
              </div>
              <p className="mt-1 text-[0.8125rem] text-muted">
                Shadow mode reads copies of handled files and only classifies. It never runs jobs and never replies, for anyone.
              </p>
            </div>
            <Switch label="Shadow mode" checked={shadow} onChange={(on) => (on ? setShadowConfirm(true) : setShadow(false))} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <ListField label="Chats" value={listOf(['channels', 'teams', 'chats'])} placeholder="19:<chat-id>@thread.v2" hint="One chat id per line. Every other chat is ignored." changed={f.changed(['channels', 'teams', 'chats'])} onChange={(v) => f.set(['channels', 'teams', 'chats'], v)} />
            <ListField label="Aliases" value={listOf(['channels', 'teams', 'aliases'])} placeholder="Dat" hint="Names that address audee in a message, one per line" changed={f.changed(['channels', 'teams', 'aliases'])} onChange={(v) => f.set(['channels', 'teams', 'aliases'], v)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField label="History size" integer value={f.value(['channels', 'teams', 'history_size']) as number | undefined} hint={f.hint(['channels', 'teams', 'history_size'], 'Earlier messages given as context')} changed={f.changed(['channels', 'teams', 'history_size'])} onChange={(v) => (v === undefined ? f.remove(['channels', 'teams', 'history_size']) : f.set(['channels', 'teams', 'history_size'], v))} />
            <TextField label="Quiet after" mono value={f.dur(['channels', 'teams', 'quiet_after'])} validate={durationError} hint={f.hint(['channels', 'teams', 'quiet_after'], 'e.g. 4h')} changed={f.changed(['channels', 'teams', 'quiet_after'])} onChange={(v) => f.set(['channels', 'teams', 'quiet_after'], v.trim())} />
            <TextField label="Work hours start" mono value={f.str(['channels', 'teams', 'work_hours', 'start'])} validate={(v) => (CLOCK_RE.test(v) ? undefined : 'Use HH:MM')} hint={f.hint(['channels', 'teams', 'work_hours', 'start'], 'HH:MM, local time')} changed={f.changed(['channels', 'teams', 'work_hours', 'start'])} onChange={(v) => f.set(['channels', 'teams', 'work_hours', 'start'], v)} />
            <TextField label="Work hours end" mono value={f.str(['channels', 'teams', 'work_hours', 'end'])} validate={(v) => (CLOCK_RE.test(v) ? undefined : 'Use HH:MM')} hint={f.hint(['channels', 'teams', 'work_hours', 'end'], 'HH:MM, local time')} changed={f.changed(['channels', 'teams', 'work_hours', 'end'])} onChange={(v) => f.set(['channels', 'teams', 'work_hours', 'end'], v)} />
          </div>
          <fieldset>
            <legend className="label">Work days {f.changed(daysPath) && <span className="text-warn">· changed</span>}</legend>
            <div className="flex flex-wrap gap-x-4">
              {data.meta.weekdays.map((d) => (
                <Checkbox key={d} mono label={d} checked={days.includes(d)} onChange={(on) => f.set(daysPath, data.meta.weekdays.filter((w) => (w === d ? on : days.includes(w))))} />
              ))}
            </div>
          </fieldset>
        </div>
      </Section>

      <Section title="Classifier" description="The model that decides what each message is asking for.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <TextField label="Model" mono list="settings-models" value={f.str(['classifier', 'model'])} hint={f.hint(['classifier', 'model'])} changed={f.changed(['classifier', 'model'])} onChange={f.setText(['classifier', 'model'])} />
          <SelectField label="Effort" value={f.str(['classifier', 'effort'])} options={data.meta.efforts} hint={f.hint(['classifier', 'effort'])} changed={f.changed(['classifier', 'effort'])} onChange={(v) => f.set(['classifier', 'effort'], v)} />
          <SelectField label="Auth" value={f.str(['classifier', 'auth'])} options={AUTH} hint={f.hint(['classifier', 'auth'], 'api_key also uses the gateway')} changed={f.changed(['classifier', 'auth'])} onChange={(v) => f.set(['classifier', 'auth'], v)} />
          <TextField label="Timeout" mono value={f.dur(['classifier', 'timeout'])} validate={durationError} hint={f.hint(['classifier', 'timeout'], 'e.g. 3m')} changed={f.changed(['classifier', 'timeout'])} onChange={(v) => f.set(['classifier', 'timeout'], v.trim())} />
        </div>
      </Section>

      <Section title="Auth" description="Which credentials sessions run on. Secrets stay in the keychain, never in config.yaml.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField label="Owner sessions" value={f.str(['auth', 'owner'])} options={AUTH} hint={f.hint(['auth', 'owner'])} changed={f.changed(['auth', 'owner'])} onChange={(v) => f.set(['auth', 'owner'], v)} />
          <SelectField label="Teammate sessions" value={f.str(['auth', 'teammates'])} options={AUTH} hint={f.hint(['auth', 'teammates'], "subscription uses the owner's login")} changed={f.changed(['auth', 'teammates'])} onChange={(v) => f.set(['auth', 'teammates'], v)} />
          <TextField label="Gateway base URL" mono value={f.str(['auth', 'base_url'])} placeholder="Direct to Anthropic" validate={baseUrlErr} hint="Optional https gateway for API-key sessions" changed={f.changed(['auth', 'base_url'])} onChange={f.setText(['auth', 'base_url'])} />
          <TextField label="API key keychain item" mono value={f.str(['auth', 'api_key_keychain_item'])} hint={f.hint(['auth', 'api_key_keychain_item'])} changed={f.changed(['auth', 'api_key_keychain_item'])} onChange={f.setText(['auth', 'api_key_keychain_item'])} />
          <TextField label="Claude config dir" mono value={f.str(['auth', 'claude_config_dir'])} placeholder="~/.claude" hint={f.hint(['auth', 'claude_config_dir'], 'Login and settings for subscription sessions')} changed={f.changed(['auth', 'claude_config_dir'])} onChange={f.setText(['auth', 'claude_config_dir'])} />
        </div>
      </Section>

      <Section title="Concurrency" description="How many sessions run at once, overall and per lane.">
        <div className="space-y-5">
          <NumberField className="max-w-48" label="Max concurrent sessions" integer value={f.value(['concurrency', 'max_concurrent']) as number | undefined} hint={f.hint(['concurrency', 'max_concurrent'], 'Across all lanes')} changed={f.changed(['concurrency', 'max_concurrent'])} onChange={(v) => (v === undefined ? f.remove(['concurrency', 'max_concurrent']) : f.set(['concurrency', 'max_concurrent'], v))} />
          <Lanes draft={draft} effective={data.effective} />
        </div>
      </Section>

      <Section title="config.yaml" description={<span className="mono break-all">{data.path}</span>}>
        <p className="mb-2 text-xs text-subtle">Read-only. Shows the file as saved on disk, without unsaved changes.</p>
        <pre className="mono max-h-[28rem] overflow-auto rounded-lg bg-sunken p-4 text-xs leading-relaxed">{data.text}</pre>
      </Section>

      <Section title="Backups" description="Written before every save from this dashboard.">
        {data.backups.length === 0 ? (
          <Empty title="No backups yet">The first save writes one.</Empty>
        ) : (
          <ul className="max-h-64 divide-y divide-[var(--border)] overflow-auto">
            {data.backups.map((b) => (
              <li key={b} className="mono break-all py-2 text-xs">{b}</li>
            ))}
          </ul>
        )}
      </Section>

      <Confirm open={shadowConfirm} danger title="Turn on shadow mode?" confirmLabel="Turn on shadow mode" onConfirm={() => { setShadow(true); setShadowConfirm(false); }} onClose={() => setShadowConfirm(false)}>
        <p>Once saved, audee stops running jobs and stops replying, for everyone. It only classifies messages.</p>
        <p className="mt-2">Use it to test classification against Ciel without acting on anything.</p>
      </Confirm>
    </div>
  );
}

export function SettingsPage() {
  const { cfg, draft } = useConfigEditor();
  return (
    <>
      <PageHeader title="Settings" description="Channel, classifier, credentials and concurrency." actions={<RefreshButton onClick={cfg.reload} loading={cfg.loading} />} />
      {cfg.data === undefined ? (
        <div className="card p-4">{cfg.error !== undefined ? <ErrorState message={cfg.error} onRetry={cfg.reload} /> : <LoadingBlock rows={8} />}</div>
      ) : (
        <Content data={cfg.data} draft={draft} />
      )}
      <PendingBar draft={draft} onSaved={cfg.reload} />
    </>
  );
}
