'use client';

import { useId } from 'react';
import { AGENT_PARAMETER_SCHEMAS } from '@arcaai/workflow-contract';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@arcaai/ui';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { useModelCatalogue } from '@/shared/catalog';
import type { AgentTask } from '../api';
import { JsonField } from './json-field';

type Schema = Record<string, unknown>;
type Value = Record<string, unknown>;

function props(schema: Schema): Record<string, Schema> {
  return (schema.properties as Record<string, Schema> | undefined) ?? {};
}

function labelOf(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function getPath(value: Value, path: string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Value)[key];
  }
  return cursor;
}

/** Immutable set; deletes the key (and empty parents) when `next` is undefined so untouched knobs stay absent. */
function setPath(value: Value, path: string[], next: unknown): Value {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const copy: Value = { ...value };
  if (rest.length === 0) {
    if (next === undefined || next === '') delete copy[head];
    else copy[head] = next;
    return copy;
  }
  const child = setPath(((copy[head] as Value | undefined) ?? {}) as Value, rest, next);
  if (Object.keys(child).length === 0) delete copy[head];
  else copy[head] = child;
  return copy;
}

/**
 * TASK-887 — a registry-model REFERENCE, picked rather than typed.
 *
 * The agent parameter schemas annotate such properties with `modelTaskType` (a schema
 * annotation, not a validation keyword): it says which `AiModel` rows are selectable here.
 * `audioFrontEnd.diarization.embeddingModelSlug` is the first — the model it names IS the
 * vector space the tenant's users enrol their voice profiles in, so a typo there is not a
 * validation error, it is a silently unmatchable set of profiles.
 *
 * Falls back to the plain text input while the catalogue is loading or if the row a saved
 * agent references is not in it — an unrecognised slug must stay editable, never be dropped.
 *
 * TASK-890 — reads `GET admin/ai-models/catalogue` (`read:AiModel`), not `admin/ai-models`
 * (`manage:all` since TASK-890 L1 — a tenant admin's read would 403).
 */
function ModelSlugField({
  id,
  name,
  schema,
  taskType,
  value,
  onChange,
}: {
  id: string;
  name: string;
  schema: Schema;
  taskType: string;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const catalogue = useModelCatalogue({ taskType });
  const description = typeof schema.description === 'string' ? schema.description : undefined;
  const options = catalogue.data?.models ?? [];
  const current = value === undefined ? '' : String(value);
  const knownSlug = current === '' || options.some((model) => model.slug === current);

  if (catalogue.isPending || catalogue.isError || !knownSlug) {
    return <ScalarField id={id} name={name} schema={schema} value={value} onChange={onChange} />;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{labelOf(name)}</Label>
      <Select value={current} onValueChange={(next) => onChange(next === '' ? undefined : next)}>
        <SelectTrigger id={id} aria-describedby={description ? `${id}-desc` : undefined}>
          <SelectValue placeholder={options.length ? 'Default' : `No ${taskType} models available`} />
        </SelectTrigger>
        <SelectContent>
          {options.map((model) => (
            <SelectItem key={model.slug} value={model.slug}>
              {model.name} ({model.slug})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? (
        <p id={`${id}-desc`} className="text-muted-foreground text-xs">
          {description}
        </p>
      ) : null}
    </div>
  );
}

function ScalarField({ id, name, schema, value, onChange }: { id: string; name: string; schema: Schema; value: unknown; onChange: (next: unknown) => void }) {
  const type = schema.type as string | undefined;
  const description = typeof schema.description === 'string' ? schema.description : undefined;
  const enumValues = Array.isArray(schema.enum) ? (schema.enum as Array<string | number>) : undefined;

  if (enumValues) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{labelOf(name)}</Label>
        <Select value={value === undefined ? '' : String(value)} onValueChange={(next) => onChange(typeof enumValues[0] === 'number' ? Number(next) : next)}>
          <SelectTrigger id={id} aria-describedby={description ? `${id}-desc` : undefined}>
            <SelectValue placeholder="Default" />
          </SelectTrigger>
          <SelectContent>
            {enumValues.map((option) => (
              <SelectItem key={String(option)} value={String(option)}>
                {String(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {description ? (
          <p id={`${id}-desc`} className="text-muted-foreground text-xs">
            {description}
          </p>
        ) : null}
      </div>
    );
  }
  if (type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
        <div className="flex flex-col">
          <Label htmlFor={id}>{labelOf(name)}</Label>
          {description ? <span className="text-muted-foreground text-xs">{description}</span> : null}
        </div>
        <Switch id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked ? true : undefined)} />
      </div>
    );
  }
  if (type === 'number' || type === 'integer') {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{labelOf(name)}</Label>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={value === undefined ? '' : String(value)}
          min={typeof schema.minimum === 'number' ? schema.minimum : undefined}
          max={typeof schema.maximum === 'number' ? schema.maximum : undefined}
          step={type === 'integer' ? 1 : 'any'}
          aria-describedby={description ? `${id}-desc` : undefined}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        />
        {description ? (
          <p id={`${id}-desc`} className="text-muted-foreground text-xs">
            {description}
          </p>
        ) : null}
      </div>
    );
  }
  if (type === 'array') {
    const list = Array.isArray(value) ? (value as unknown[]).map(String) : [];
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{labelOf(name)}</Label>
        <Input
          id={id}
          value={list.join(', ')}
          placeholder="comma-separated"
          aria-describedby={description ? `${id}-desc` : undefined}
          onChange={(event) => {
            const items = event.target.value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
            onChange(items.length ? items : undefined);
          }}
        />
        {description ? (
          <p id={`${id}-desc`} className="text-muted-foreground text-xs">
            {description}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{labelOf(name)}</Label>
      <Input
        id={id}
        value={value === undefined ? '' : String(value)}
        maxLength={typeof schema.maxLength === 'number' ? schema.maxLength : undefined}
        aria-describedby={description ? `${id}-desc` : undefined}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
      />
      {description ? (
        <p id={`${id}-desc`} className="text-muted-foreground text-xs">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/**
 * TASK-890 §3.10/§3.14 (OD-R clause 3) — `parameters.guards.enabled`, the AGENT-level default of
 * the node > workflow > agent > `true` precedence `resolveGuardrailDecision` implements. ABSENT
 * MEANS ON: guardrail is platform-managed and screening is the floor a tenant opts OUT of, per
 * agent — never a switch to remember to turn on. A `false` here is a publish WARNING
 * (`GUARDRAIL_OPTED_OUT`), a per-call usage attribute (`guardrail: 'opted_out'`), and a TEXT
 * response `reason`, so the omission is attributable, not merely permitted.
 */
function GuardrailScreeningField({ id, value, onChange }: { id: string; value: unknown; onChange: (next: unknown) => void }) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>Guardrail screening</FieldLabel>
        <FieldDescription>Platform guardrail runs on this agent&apos;s input and output; a node or workflow can override.</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={value !== false} onCheckedChange={(checked) => onChange(checked ? undefined : false)} />
    </Field>
  );
}

function SchemaFields({ idPrefix, schema, path, value, onChange }: { idPrefix: string; schema: Schema; path: string[]; value: Value; onChange: (next: Value) => void }) {
  return (
    <>
      {Object.entries(props(schema)).map(([name, child]) => {
        const childPath = [...path, name];
        const id = `${idPrefix}-${childPath.join('-')}`;
        const isObject = child.type === 'object';
        const hasProps = Object.keys(props(child)).length > 0;
        if (isObject && hasProps) {
          return (
            <fieldset key={name} className="flex flex-col gap-3 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{labelOf(name)}</legend>
              {typeof child.description === 'string' ? <p className="text-muted-foreground text-xs">{child.description}</p> : null}
              <SchemaFields idPrefix={idPrefix} schema={child} path={childPath} value={value} onChange={onChange} />
            </fieldset>
          );
        }
        if (isObject) {
          // A free-form tenant-authored JSON object (e.g. `responseSchema`).
          const current = getPath(value, childPath);
          return (
            <JsonField
              key={name}
              label={labelOf(name)}
              description={typeof child.description === 'string' ? child.description : undefined}
              value={current && typeof current === 'object' ? (current as Value) : null}
              onChange={(next) => onChange(setPath(value, childPath, next ?? undefined))}
              rows={6}
            />
          );
        }
        // TASK-890 §3.10/§3.14 (OD-R) — the agent-level guardrail default gets its own labelled
        // copy rather than the generic boolean renderer's bare "Enabled": this switch is the
        // bottom of the node > workflow > agent > `true` precedence, so what it says has to name
        // that, not just the JSON key.
        if (childPath.join('.') === 'guards.enabled') {
          return <GuardrailScreeningField key={name} id={id} value={getPath(value, childPath)} onChange={(next) => onChange(setPath(value, childPath, next))} />;
        }
        // TASK-887 — a property annotated with `modelTaskType` is a registry REFERENCE, so
        // the admin picks from the tenant's catalogue instead of typing a slug.
        const modelTaskType = typeof child.modelTaskType === 'string' ? child.modelTaskType : undefined;
        if (modelTaskType) {
          return (
            <ModelSlugField
              key={name}
              id={id}
              name={name}
              schema={child}
              taskType={modelTaskType}
              value={getPath(value, childPath)}
              onChange={(next) => onChange(setPath(value, childPath, next))}
            />
          );
        }
        return <ScalarField key={name} id={id} name={name} schema={child} value={getPath(value, childPath)} onChange={(next) => onChange(setPath(value, childPath, next))} />;
      })}
    </>
  );
}

/**
 * Schema-driven parameters form over `AGENT_PARAMETER_SCHEMAS[task]` — the same contract the
 * gateway validates against, so a value the form can express is a value the server accepts.
 * Untouched knobs stay ABSENT (the runtime default wins), never written as `undefined`.
 */
export function ParametersForm({ task, value, onChange }: { task: AgentTask; value: Value; onChange: (next: Value) => void }) {
  const idPrefix = useId();
  const schema = AGENT_PARAMETER_SCHEMAS[task] as Schema;
  return (
    <div className="flex flex-col gap-4">
      <SchemaFields idPrefix={idPrefix} schema={schema} path={[]} value={value} onChange={onChange} />
    </div>
  );
}
