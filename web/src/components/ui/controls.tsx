import { useId, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function SwitchRow({ checked, onChange, label, hint, changed }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode; changed?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="min-w-0">
        <div className="text-[0.8125rem] font-medium">
          {label}
          {changed && <ChangedDot />}
        </div>
        {hint !== undefined && <div className="hint mt-0.5">{hint}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export const ChangedDot = () => <span className="ml-1.5 inline-block size-1.5 rounded-full bg-[var(--warn-strong)] align-middle" aria-label="changed" title="Unsaved change" />;

type FieldProps = { label: string; hint?: ReactNode; error?: string; children: (id: string, describedBy: string | undefined) => ReactNode; className?: string };

export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={className}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children(id, hint !== undefined || error !== undefined ? hintId : undefined)}
      {error !== undefined ? (
        <div id={hintId} className="hint !text-danger">
          {error}
        </div>
      ) : (
        hint !== undefined && (
          <div id={hintId} className="hint">
            {hint}
          </div>
        )
      )}
    </div>
  );
}

type TextProps = { label: string; value: string; onChange: (v: string) => void; hint?: ReactNode; placeholder?: string; changed?: boolean; list?: string; mono?: boolean; className?: string; validate?: (v: string) => string | undefined };

export function TextField({ label, value, onChange, hint, placeholder, changed, list, mono, className, validate }: TextProps) {
  const [local, setLocal] = useState<string | null>(null);
  const shown = local ?? value;
  const error = validate?.(shown);
  return (
    <Field label={label} hint={hint} {...(error !== undefined ? { error } : {})} {...(className !== undefined ? { className } : {})}>
      {(id, describedBy) => (
        <input
          id={id}
          className={`input ${mono ? 'mono' : ''} ${changed ? 'is-changed' : ''}`}
          value={shown}
          placeholder={placeholder}
          list={list}
          aria-describedby={describedBy}
          aria-invalid={error !== undefined}
          onChange={(e) => {
            const v = e.target.value;
            setLocal(v);
            if (validate?.(v) === undefined) onChange(v);
          }}
          onBlur={() => setLocal(null)}
        />
      )}
    </Field>
  );
}

type NumberProps = { label: string; value: number | undefined; onChange: (v: number | undefined) => void; hint?: ReactNode; placeholder?: string; changed?: boolean; min?: number; step?: number; integer?: boolean; className?: string };

export function NumberField({ label, value, onChange, hint, placeholder, changed, min = 0, step = 1, integer, className }: NumberProps) {
  const [local, setLocal] = useState<string | null>(null);
  const shown = local ?? (value === undefined ? '' : String(value));
  const parsed = shown.trim() === '' ? undefined : Number(shown);
  const bad = parsed !== undefined && (!Number.isFinite(parsed) || parsed <= 0 || (integer === true && !Number.isInteger(parsed)));
  return (
    <Field label={label} hint={hint} {...(bad ? { error: integer ? 'Use a whole number above 0' : 'Use a number above 0' } : {})} {...(className !== undefined ? { className } : {})}>
      {(id, describedBy) => (
        <input
          id={id}
          type="number"
          inputMode={integer ? 'numeric' : 'decimal'}
          min={min}
          step={step}
          className={`input num ${changed ? 'is-changed' : ''}`}
          value={shown}
          placeholder={placeholder}
          aria-describedby={describedBy}
          aria-invalid={bad}
          onChange={(e) => {
            const v = e.target.value;
            setLocal(v);
            const n = v.trim() === '' ? undefined : Number(v);
            if (n === undefined) onChange(undefined);
            else if (Number.isFinite(n) && n > 0 && (!integer || Number.isInteger(n))) onChange(n);
          }}
          onBlur={() => setLocal(null)}
        />
      )}
    </Field>
  );
}

type SelectProps = { label: string; value: string; options: Array<string | { value: string; label: string }>; onChange: (v: string) => void; hint?: ReactNode; changed?: boolean; className?: string };

export function SelectField({ label, value, options, onChange, hint, changed, className }: SelectProps) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const known = opts.some((o) => o.value === value);
  return (
    <Field label={label} hint={hint} {...(className !== undefined ? { className } : {})}>
      {(id, describedBy) => (
        <select id={id} className={`input ${changed ? 'is-changed' : ''}`} value={value} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)}>
          {!known && <option value={value}>{value === '' ? 'Choose…' : `${value} (unknown)`}</option>}
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function ListField({ label, value, onChange, hint, placeholder, changed, className }: { label: string; value: string[]; onChange: (v: string[]) => void; hint?: ReactNode; placeholder?: string; changed?: boolean; className?: string }) {
  const [local, setLocal] = useState<string | null>(null);
  const shown = local ?? value.join('\n');
  return (
    <Field label={label} hint={hint ?? 'One per line'} {...(className !== undefined ? { className } : {})}>
      {(id, describedBy) => (
        <textarea
          id={id}
          rows={Math.min(6, Math.max(2, value.length + 1))}
          className={`input mono text-[0.8125rem] ${changed ? 'is-changed' : ''}`}
          value={shown}
          placeholder={placeholder}
          aria-describedby={describedBy}
          onChange={(e) => {
            setLocal(e.target.value);
            onChange(e.target.value.split('\n').map((s) => s.trim()).filter((s) => s !== ''));
          }}
          onBlur={() => setLocal(null)}
        />
      )}
    </Field>
  );
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} aria-hidden="true" />;
}

export function Checkbox({ checked, onChange, label, disabled, mono }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; mono?: boolean }) {
  return (
    <label className={`inline-flex min-h-7 cursor-pointer items-center gap-2 text-[0.8125rem] ${disabled ? 'opacity-50' : ''} ${mono ? 'mono' : ''}`}>
      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 break-all">{label}</span>
    </label>
  );
}
