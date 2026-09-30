import { useId, useState, type KeyboardEvent } from 'react';
import { Badge, Button, Input, Label, NativeSelect, Switch } from '@/components/ui';
import { cn } from '@/lib/utils';
import { getAt, pathKey, type Path } from '@/lib/path';
import { emptyValue, type Field } from './fields';

export interface SchemaFormProps {
  fields: readonly Field[];
  value: unknown;
  onChange: (path: Path, value: unknown) => void;
  /** Validation messages keyed by dotted path. */
  errors: ReadonlyMap<string, string>;
  /** Dotted paths the last AI edit changed, including parent groups. */
  changed: ReadonlySet<string>;
  /** Increments on each AI edit so the highlight replays. */
  changeRevision: number;
}

type Ctx = Omit<SchemaFormProps, 'fields'>;

const humanize = (option: string) => option.replaceAll('_', ' ');

function errorsUnder(errors: ReadonlyMap<string, string>, key: string): string[] {
  const out: string[] = [];
  for (const [k, message] of errors) if (k === key || k.startsWith(`${key}.`)) out.push(message);
  return out;
}

function Highlight({ active, revision }: { active: boolean; revision: number }) {
  return active ? (
    <span
      key={revision}
      aria-hidden
      className="flash pointer-events-none absolute -inset-1.5 -z-10 rounded-md"
    />
  ) : null;
}

function FieldMessage({ field, messages }: { field: Field; messages: string[] }) {
  if (messages.length > 0) {
    return (
      <p className="text-xs font-medium text-destructive" role="alert">
        {messages.join(' · ')}
      </p>
    );
  }
  return field.description !== undefined ? (
    <p className="text-xs text-muted-foreground">{field.description}</p>
  ) : null;
}

function TagsInput({
  id,
  value,
  placeholder,
  invalid,
  onChange,
}: {
  id: string;
  value: readonly string[];
  placeholder: string | undefined;
  invalid: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const next = draft.trim();
    if (next !== '' && !value.includes(next)) onChange([...value, next]);
    setDraft('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div
      className={cn(
        'flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border bg-card px-2 py-1.5',
        invalid ? 'border-destructive' : 'border-border',
      )}
    >
      {value.map((tag, i) => (
        <Badge key={`${tag}-${i}`} variant="default" className="font-mono">
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </Badge>
      ))}
      <input
        id={id}
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

function Control({ field, path, ctx, id }: { field: Field; path: Path; ctx: Ctx; id: string }) {
  const key = pathKey(path);
  const value = getAt(ctx.value, path);
  const invalid = errorsUnder(ctx.errors, key).length > 0;
  const set = (next: unknown) => ctx.onChange(path, next);

  switch (field.kind) {
    case 'boolean':
      return (
        <Switch id={id} checked={value === true} onCheckedChange={set} aria-label={field.label} />
      );
    case 'number':
      return (
        <Input
          id={id}
          type="number"
          aria-invalid={invalid}
          value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
          step={field.integer ? 1 : 'any'}
          {...(field.min !== undefined ? { min: field.min } : {})}
          {...(field.max !== undefined ? { max: field.max } : {})}
          onChange={(e) => set(e.target.value === '' ? Number.NaN : Number(e.target.value))}
        />
      );
    case 'text':
      return (
        <Input
          id={id}
          aria-invalid={invalid}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          onChange={(e) => set(e.target.value)}
        />
      );
    case 'date':
      return (
        <Input
          id={id}
          type="date"
          aria-invalid={invalid}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => set(e.target.value)}
        />
      );
    case 'select':
      return (
        <NativeSelect
          id={id}
          aria-invalid={invalid}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => set(e.target.value)}
        >
          {field.options.map((o) => (
            <option key={o} value={o}>
              {humanize(o)}
            </option>
          ))}
        </NativeSelect>
      );
    case 'multiselect': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div id={id} role="group" className="flex flex-wrap gap-2">
          {field.options.map((o) => {
            const on = selected.includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  set(
                    on
                      ? selected.filter((s) => s !== o)
                      : field.options.filter((x) => x === o || selected.includes(x)),
                  )
                }
                className={cn(
                  'rounded-full border px-3 py-1 text-sm transition-colors',
                  on
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted',
                )}
              >
                {humanize(o)}
              </button>
            );
          })}
        </div>
      );
    }
    case 'tags':
      return (
        <TagsInput
          id={id}
          value={Array.isArray(value) ? (value as string[]) : []}
          placeholder={field.placeholder}
          invalid={invalid}
          onChange={set}
        />
      );
    case 'group':
    case 'repeater':
      return null;
  }
}

function FieldView({ field, prefix, ctx }: { field: Field; prefix: Path; ctx: Ctx }) {
  const id = useId();
  const path = [...prefix, ...field.path];
  const key = pathKey(path);
  const highlighted = ctx.changed.has(key);

  if (field.kind === 'group') {
    return (
      <fieldset className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold">{field.label}</legend>
        {field.fields.map((child) => (
          <FieldView key={child.key} field={child} prefix={prefix} ctx={ctx} />
        ))}
      </fieldset>
    );
  }

  if (field.kind === 'repeater') {
    const items = Array.isArray(getAt(ctx.value, path))
      ? (getAt(ctx.value, path) as unknown[])
      : [];
    const full = field.maxItems !== undefined && items.length >= field.maxItems;
    return (
      <div className="grid gap-3 sm:col-span-2">
        <div className="flex items-center justify-between">
          <div>
            <Label>{field.label}</Label>
            <FieldMessage
              field={field}
              messages={ctx.errors.has(key) ? [ctx.errors.get(key) ?? ''] : []}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={full}
            onClick={() => ctx.onChange(path, [...items, emptyValue(field.itemSchema)])}
          >
            + Add
          </Button>
        </div>
        {items.length === 0 && (
          <p className="rounded-md border border-dashed border-border p-3 text-center text-sm text-muted-foreground">
            Nothing added yet.
          </p>
        )}
        {items.map((_, index) => (
          <div
            key={index}
            className="relative isolate grid items-start gap-3 rounded-lg border border-border bg-muted/40 p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
          >
            <Highlight active={ctx.changed.has(`${key}.${index}`)} revision={ctx.changeRevision} />
            {field.itemFields.map((child) => (
              <FieldView key={child.key} field={child} prefix={[...path, index]} ctx={ctx} />
            ))}
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Remove item ${index + 1}`}
              className="mt-6"
              onClick={() =>
                ctx.onChange(
                  path,
                  items.filter((__, j) => j !== index),
                )
              }
            >
              ×
            </Button>
          </div>
        ))}
      </div>
    );
  }

  const wide = field.kind === 'multiselect' || field.kind === 'tags';
  return (
    <div className={cn('relative isolate grid content-start gap-1.5', wide && 'sm:col-span-2')}>
      <Highlight active={highlighted} revision={ctx.changeRevision} />
      <Label htmlFor={id}>{field.label}</Label>
      <Control field={field} path={path} ctx={ctx} id={id} />
      <FieldMessage field={field} messages={errorsUnder(ctx.errors, key)} />
    </div>
  );
}

export function SchemaForm({ fields, ...ctx }: SchemaFormProps) {
  return (
    <form className="grid gap-5 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} noValidate>
      {fields.map((field) => (
        <div
          key={field.key}
          className={cn((field.kind === 'group' || field.kind === 'repeater') && 'sm:col-span-2')}
        >
          <FieldView field={field} prefix={[]} ctx={ctx} />
        </div>
      ))}
    </form>
  );
}
