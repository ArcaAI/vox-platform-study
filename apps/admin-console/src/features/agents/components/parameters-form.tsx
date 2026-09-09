'use client';

import { useId } from 'react';
import { AGENT_PARAMETER_SCHEMAS } from '@arcaai/workflow-contract';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@arcaai/ui';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { useModelCatalogue, type CatalogueAsrProfile } from '@/shared/catalog';
import type { AgentTask } from '../api';
import { JsonField } from './json-field';
import { useTaskModelCatalogue } from './model-picker';

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

/**
 * `hint` (TASK-934) — the ASR model profile's inherited value for THIS field
 * (`useTaskModelCatalogue`'s `asrProfile`, `../model-picker`), rendered only
 * while the agent leaves the field empty: an agent-authored value always wins
 * (OD-3), so once one is typed the inherited value stops applying and the
 * hint about it would be misleading.
 */
function ScalarField({
  id,
  name,
  schema,
  value,
  onChange,
  hint,
}: {
  id: string;
  name: string;
  schema: Schema;
  value: unknown;
  onChange: (next: unknown) => void;
  hint?: string;
}) {
  const type = schema.type as string | undefined;
  const description = typeof schema.description === 'string' ? schema.description : undefined;
  const enumValues = Array.isArray(schema.enum) ? (schema.enum as Array<string | number>) : undefined;
  const combinedDescription = hint && value === undefined ? [description, hint].filter(Boolean).join(' — ') : description;

  if (enumValues) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{labelOf(name)}</Label>
        <Select value={value === undefined ? '' : String(value)} onValueChange={(next) => onChange(typeof enumValues[0] === 'number' ? Number(next) : next)}>
          <SelectTrigger id={id} aria-describedby={combinedDescription ? `${id}-desc` : undefined}>
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
        {combinedDescription ? (
          <p id={`${id}-desc`} className="text-muted-foreground text-xs">
            {combinedDescription}
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
          {combinedDescription ? <span className="text-muted-foreground text-xs">{combinedDescription}</span> : null}
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
          aria-describedby={combinedDescription ? `${id}-desc` : undefined}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        />
        {combinedDescription ? (
          <p id={`${id}-desc`} className="text-muted-foreground text-xs">
            {combinedDescription}
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
          aria-describedby={combinedDescription ? `${id}-desc` : undefined}
          onChange={(event) => {
            const items = event.target.value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
            onChange(items.length ? items : undefined);
          }}
        />
        {combinedDescription ? (
          <p id={`${id}-desc`} className="text-muted-foreground text-xs">
            {combinedDescription}
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
        aria-describedby={combinedDescription ? `${id}-desc` : undefined}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
      />
      {combinedDescription ? (
        <p id={`${id}-desc`} className="text-muted-foreground text-xs">
          {combinedDescription}
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

/** `parameters.generation.reasoning.effort` — the pinned cross-lane contract (TASK-891 C1/C4). */
const REASONING_EFFORT_OPTIONS = ['minimal', 'low', 'medium', 'high'] as const;

/**
 * TASK-891 C4/OD-4 — reasoning/thinking control, authored PER AGENT (not a governed settings
 * descriptor): `parameters.generation.reasoning = { enabled: boolean, effort?: 'minimal' |
 * 'low' | 'medium' | 'high' }` is the pinned cross-lane contract shape (authored in
 * `packages/applications` by the agent-service lane, seeded by the data lane). Hand-rendered
 * here rather than through the generic `AGENT_PARAMETER_SCHEMAS` walker above: the shared JSON
 * Schema package (`@arcaai/workflow-contract`, `GENERATION_PROPERTY`) does not yet declare this
 * property and is outside this lane's boundary (`apps/admin-console/**`) to extend.
 *
 * "Disabled" is a real, explicit value — instructs the engine not to reason — never inferred
 * from absence, so the switch only ever writes `true` or `false`, matching OD-4's "disabled
 * means instruct the engine not to reason", not "unset".
 */
function ReasoningField({ id, value, onChange }: { id: string; value: unknown; onChange: (next: unknown) => void }) {
  const reasoning = value && typeof value === 'object' ? (value as { enabled?: unknown; effort?: unknown }) : {};
  const enabled = reasoning.enabled === true;
  const effort = typeof reasoning.effort === 'string' ? reasoning.effort : '';

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">Reasoning</legend>
      <p className="text-muted-foreground text-xs">
        Extended thinking for this agent&apos;s generations. Off by default — reasoning tokens are billed and add latency.
      </p>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${id}-enabled`}>Enable reasoning</FieldLabel>
          <FieldDescription>When off, the engine is instructed not to reason and reasoning tokens are never billed to this agent.</FieldDescription>
        </FieldContent>
        <Switch
          id={`${id}-enabled`}
          checked={enabled}
          onCheckedChange={(checked) => onChange(checked ? { enabled: true, ...(effort ? { effort } : {}) } : { enabled: false })}
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-effort`}>Reasoning effort</Label>
        <Select value={effort} onValueChange={(next) => onChange({ enabled: true, ...(next ? { effort: next } : {}) })} disabled={!enabled}>
          <SelectTrigger id={`${id}-effort`} aria-describedby={`${id}-effort-desc`}>
            <SelectValue placeholder="Engine default" />
          </SelectTrigger>
          <SelectContent>
            {REASONING_EFFORT_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {labelOf(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p id={`${id}-effort-desc`} className="text-muted-foreground text-xs">
          Only applies while reasoning is enabled; leave unset for the engine&apos;s own default.
        </p>
      </div>
    </fieldset>
  );
}

function SchemaFields({
  idPrefix,
  schema,
  path,
  value,
  onChange,
  fieldHints,
}: {
  idPrefix: string;
  schema: Schema;
  path: string[];
  value: Value;
  onChange: (next: Value) => void;
  /** Dotted path → "inherits X from the model profile" (TASK-934); see `asrInheritHints`. */
  fieldHints?: Record<string, string>;
}) {
  return (
    <>
      {Object.entries(props(schema)).map(([name, child]) => {
        const childPath = [...path, name];
        const id = `${idPrefix}-${childPath.join('-')}`;
        // TASK-891 C4 — `generation.reasoning` is rendered explicitly by `ReasoningField`
        // below, because a boolean + enum pair reads as a switch and a select, not as the
        // generic nested-object fieldset this walker emits. W4 hand-rendered it while the
        // shared schema still lacked the property; now that `GENERATION_PROPERTY` declares
        // it, skipping it here is what stops BOTH from rendering.
        if (childPath.join('.') === 'generation.reasoning') return null;
        const isObject = child.type === 'object';
        const hasProps = Object.keys(props(child)).length > 0;
        if (isObject && hasProps) {
          return (
            <fieldset key={name} className="flex flex-col gap-3 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{labelOf(name)}</legend>
              {typeof child.description === 'string' ? <p className="text-muted-foreground text-xs">{child.description}</p> : null}
              <SchemaFields idPrefix={idPrefix} schema={child} path={childPath} value={value} onChange={onChange} fieldHints={fieldHints} />
              {/* TASK-891 C4 — reasoning sits inside the SAME "Generation" fieldset as the
                  schema-driven temperature/maxTokens controls, next to them per the brief,
                  rather than as a disconnected section (see ReasoningField's docblock). */}
              {childPath.join('.') === 'generation' ? (
                <ReasoningField
                  id={`${id}-reasoning`}
                  value={getPath(value, [...childPath, 'reasoning'])}
                  onChange={(next) => onChange(setPath(value, [...childPath, 'reasoning'], next))}
                />
              ) : null}
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
        return (
          <ScalarField
            key={name}
            id={id}
            name={name}
            schema={child}
            value={getPath(value, childPath)}
            onChange={(next) => onChange(setPath(value, childPath, next))}
            hint={fieldHints?.[childPath.join('.')]}
          />
        );
      })}
    </>
  );
}

/**
 * TASK-934 (G-4) — the effective-value hint's summary line: what the currently
 * assigned model's `_metadata.asr` profile contributes, in the units an admin
 * reads directly off the ticket's own measurements ("final window 7 s ·
 * partial window 15 s · no-speech 0.4"). Only the members the profile actually
 * sets appear; `null`/empty ⇒ no line at all.
 */
function summarizeAsrProfile(profile: CatalogueAsrProfile | null): string | null {
  if (!profile) return null;
  const parts: string[] = [];
  if (profile.maxDecodeWindowSec !== undefined) parts.push(`final window ${profile.maxDecodeWindowSec} s`);
  if (profile.partialWindowSec !== undefined) parts.push(`partial window ${profile.partialWindowSec} s`);
  if (profile.decoding?.noSpeechThreshold !== undefined) parts.push(`no-speech ${profile.decoding.noSpeechThreshold}`);
  return parts.length > 0 ? `Model profile: ${parts.join(' · ')}` : null;
}

/**
 * TASK-934 (OD-3/OD-4) — per-field "what this field inherits when left empty".
 * Only `decoding.*` and `streaming.partialWindowSec` have a model-profile
 * counterpart (`maxDecodeWindowSec` has none at the agent level — it is
 * model-only geometry); `hotwords` is a list, not a single inherited value, so
 * it is left off the hint (its own description already explains the fold).
 */
function asrInheritHints(profile: CatalogueAsrProfile | null): Record<string, string> {
  if (!profile) return {};
  const hints: Record<string, string> = {};
  for (const [key, decodingValue] of Object.entries(profile.decoding ?? {})) {
    if (decodingValue === undefined || key === 'hotwords') continue;
    hints[`decoding.${key}`] = `inherits ${decodingValue} from the model profile`;
  }
  if (profile.partialWindowSec !== undefined) {
    hints['streaming.partialWindowSec'] = `inherits ${profile.partialWindowSec} from the model profile`;
  }
  return hints;
}

/**
 * Schema-driven parameters form over `AGENT_PARAMETER_SCHEMAS[task]` — the same contract the
 * gateway validates against, so a value the form can express is a value the server accepts.
 * Untouched knobs stay ABSENT (the runtime default wins), never written as `undefined`.
 *
 * TASK-934 (G-4) — for a `SPEECH_TO_TEXT` agent, `modelId` (the currently selected primary
 * model) resolves the model's ASR decode profile off the same catalogue `ModelPicker` reads,
 * and shows the effective value the agent would inherit for every decode field it leaves
 * unset (OD-3: agent → model profile → engine default).
 */
export function ParametersForm({ task, value, onChange, modelId }: { task: AgentTask; value: Value; onChange: (next: Value) => void; modelId?: string }) {
  const idPrefix = useId();
  const schema = AGENT_PARAMETER_SCHEMAS[task] as Schema;
  const isSpeechToText = task === 'SPEECH_TO_TEXT';
  // Called unconditionally (rules of hooks) — `task` is a prop and can change
  // across renders, so the hook itself must not be behind an `if`.
  const catalogue = useTaskModelCatalogue(task);
  const asrProfile = (isSpeechToText && modelId ? (catalogue.models.find((model) => model.id === modelId)?.asrProfile ?? null) : null) ?? null;
  const profileSummary = isSpeechToText ? summarizeAsrProfile(asrProfile) : null;
  const fieldHints = isSpeechToText ? asrInheritHints(asrProfile) : undefined;

  return (
    <div className="flex flex-col gap-4">
      {profileSummary ? <p className="text-muted-foreground text-xs">{profileSummary}</p> : null}
      <SchemaFields idPrefix={idPrefix} schema={schema} path={[]} value={value} onChange={onChange} fieldHints={fieldHints} />
    </div>
  );
}
