'use client';

import { useId } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { AGENT_PARAMETER_SCHEMAS } from '@arcaai/workflow-contract';
import { Alert, AlertDescription, AlertTitle, Field, FieldContent, FieldDescription, FieldLabel } from '@arcaai/ui';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { useModelCatalogue, type CatalogueAsrProfile } from '@/shared/catalog';
// TASK-949 L1 — the schema walk moved to `shared/` so the workflow studio's read-only
// `AgentParametersView` reads the same per-task contract this editor does. A feature may not
// import another feature, and two copies of `setPath` would be two ways to drop a knob.
import { getPath, labelOf, props, setPath, type Schema, type Value } from '@/shared/agent-parameters';
import type { AgentTask } from '../api';
import { JsonField } from './json-field';
import { useTaskModelCatalogue } from './model-picker';
import { reasoningSupportFor, type ReasoningProviderSupport } from '@/shared/reasoning/reasoning-support';

/**
 * TASK-991 (owner decision OD-3, 2026-09-19) — the one line of copy a PLATFORM-MANAGED parameter
 * carries. Rendered from the contract's own `readOnly: true` annotation, never from a field name,
 * so the next platform-managed property reads the same without touching this file.
 *
 * The gateway refuses a tenant's change to such a field (403 `AGENT_PARAMETER_PLATFORM_MANAGED`);
 * disabling the control here is the courtesy half — it stops an admin composing an edit that was
 * never going to be accepted, and it says who owns the value instead of leaving a dead field.
 */
const PLATFORM_MANAGED_NOTE = 'Managed by the platform: the same for every tenant, and not editable here.';

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
 * agent references is not in it — an unrecognised slug must stay VISIBLE and (unless the
 * contract marks it `readOnly`, TASK-991) editable; it is never dropped.
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
  // TASK-991 (OD-3) — a PLATFORM-MANAGED reference: shown, never edited. `ScalarField` below
  // reads the same annotation, so the free-text fallback (catalogue loading/failed, or a slug the
  // tenant can no longer see) is locked too — an escape hatch that only opened while the
  // catalogue was in flight would be the whole lock.
  const readOnly = schema.readOnly === true;
  const note = readOnly ? PLATFORM_MANAGED_NOTE : undefined;
  const combinedDescription = [note, description].filter(Boolean).join(' — ');
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
        <SelectTrigger id={id} disabled={readOnly} aria-describedby={combinedDescription ? `${id}-desc` : undefined}>
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
      {combinedDescription ? (
        <p id={`${id}-desc`} className="text-muted-foreground text-xs">
          {combinedDescription}
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
  // TASK-991 (OD-3) — `readOnly: true` on the contract property means the PLATFORM owns the value
  // (`@arcaai/workflow-contract`). The control still shows what is stored — a value you cannot see
  // is worse than one you cannot change — it just cannot be edited, and says why in one line.
  const readOnly = schema.readOnly === true;
  const combinedDescription = [readOnly ? PLATFORM_MANAGED_NOTE : undefined, description, hint && value === undefined ? hint : undefined]
    .filter(Boolean)
    .join(' — ');

  if (enumValues) {
    // TASK-979 — mirror the boolean branch's TASK-977 fix: display the EFFECTIVE value (explicit
    // when present, else the schema's own declared `default`), not a bare presence check that
    // hides a default the gateway resolver actually applies (e.g.
    // `audioFrontEnd.diarization.backend` defaults to `'embedding'` server-side). A field with no
    // declared default keeps the existing "Default" placeholder untouched.
    const effectiveValue = value === undefined ? schema.default : value;
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{labelOf(name)}</Label>
        <Select value={effectiveValue === undefined ? '' : String(effectiveValue)} onValueChange={(next) => onChange(typeof enumValues[0] === 'number' ? Number(next) : next)}>
          <SelectTrigger id={id} disabled={readOnly} aria-describedby={combinedDescription ? `${id}-desc` : undefined}>
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
    // TASK-977 (L4 console half) — the displayed state is the EFFECTIVE value (explicit when
    // present, else the schema's own `default`, else off), not a bare `=== true`: the gateway
    // resolver honours `default: true` on `audioFrontEnd.resample`/`normalize`, so a field the
    // admin never touched must render ON, not OFF. Once touched, the switch writes an explicit
    // boolean — never `undefined` — so "off" on a default-true field persists as `false` rather
    // than round-tripping back to the schema default the server applies to an absent key.
    const effectiveValue = value === undefined ? schema.default === true : value === true;
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
        <div className="flex flex-col">
          <Label htmlFor={id}>{labelOf(name)}</Label>
          {combinedDescription ? <span className="text-muted-foreground text-xs">{combinedDescription}</span> : null}
        </div>
        <Switch id={id} checked={effectiveValue} disabled={readOnly} onCheckedChange={(checked) => onChange(checked)} />
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
          readOnly={readOnly}
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
          readOnly={readOnly}
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
        readOnly={readOnly}
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
 * TASK-970 (L3, F-2/F-4) — the bound model's reasoning-enforcement class, rendered next to
 * the toggle it qualifies. `unsupported` is deliberately an `Alert` (visually distinct,
 * `role="status"` rather than the default assertive `role="alert"` — see the precedent in
 * `playground-consultation/scribe/case-note-column.tsx`'s "newer draft" callout): it is a
 * real platform limitation worth noticing, not an error, and the owner's 2026-09-13 fail
 * posture is log-and-proceed, never a block on saving. `native-off`/`effort-only` are quiet,
 * positive notes — the two cases where the platform CAN speak to the engine.
 */
function ReasoningProviderSupportNote({ support }: { support: ReasoningProviderSupport | null | undefined }) {
  if (!support) return null;
  const { class: supportClass, providerLabel } = support;
  if (supportClass === 'unsupported') {
    return (
      <Alert role="status" className="[&>svg]:text-warning">
        <IconAlertTriangle aria-hidden />
        <AlertTitle>Not enforceable on {providerLabel}</AlertTitle>
        <AlertDescription>
          {providerLabel} has no way to receive this instruction for this model. The posture stays recorded on the agent, but the engine
          decides on its own — it may still reason, and bill for it, regardless of this switch.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <p className="text-muted-foreground text-xs">
      {supportClass === 'native-off'
        ? `${providerLabel} has a genuine off-switch for this model, so this posture reaches the engine as set.`
        : `${providerLabel} has no true off-switch for this model — "off" is approximated by asking for the engine's lowest reasoning effort, not a full stop.`}
    </p>
  );
}

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
 *
 * TASK-970 F-2 — the toggle's own description used to promise "the engine is instructed not
 * to reason and reasoning tokens are never billed", unconditionally. Measured: that promise
 * reached only 3 of 10 provider adapters; the other seven dropped it silently. The copy below
 * states what is actually true instead — the posture is always recorded on the agent, and
 * whether it reaches the engine depends on the bound model's provider, detailed by
 * `ReasoningProviderSupportNote` just below the toggle.
 */
function ReasoningField({
  id,
  value,
  onChange,
  providerSupport,
}: {
  id: string;
  value: unknown;
  onChange: (next: unknown) => void;
  /** The bound model's provider support class (TASK-970), or `null`/absent when unknown. */
  providerSupport?: ReasoningProviderSupport | null;
}) {
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
          <FieldDescription>
            An explicit posture recorded on the agent either way. Whether the bound engine can actually be instructed to honour it depends
            on the model&apos;s provider.
          </FieldDescription>
        </FieldContent>
        <Switch
          id={`${id}-enabled`}
          checked={enabled}
          onCheckedChange={(checked) => onChange(checked ? { enabled: true, ...(effort ? { effort } : {}) } : { enabled: false })}
        />
      </Field>
      <ReasoningProviderSupportNote support={providerSupport} />
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
  reasoningSupport,
}: {
  idPrefix: string;
  schema: Schema;
  path: string[];
  value: Value;
  onChange: (next: Value) => void;
  /** Dotted path → "inherits X from the model profile" (TASK-934); see `asrInheritHints`. */
  fieldHints?: Record<string, string>;
  /** TASK-970 — the bound model's reasoning-enforcement class, threaded down to `ReasoningField`. */
  reasoningSupport?: ReasoningProviderSupport | null;
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
              <SchemaFields
                idPrefix={idPrefix}
                schema={child}
                path={childPath}
                value={value}
                onChange={onChange}
                fieldHints={fieldHints}
                reasoningSupport={reasoningSupport}
              />
              {/* TASK-891 C4 — reasoning sits inside the SAME "Generation" fieldset as the
                  schema-driven temperature/maxTokens controls, next to them per the brief,
                  rather than as a disconnected section (see ReasoningField's docblock). */}
              {childPath.join('.') === 'generation' ? (
                <ReasoningField
                  id={`${id}-reasoning`}
                  value={getPath(value, [...childPath, 'reasoning'])}
                  onChange={(next) => onChange(setPath(value, [...childPath, 'reasoning'], next))}
                  providerSupport={reasoningSupport}
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
  const isTextGeneration = task === 'TEXT_GENERATION';
  // Called unconditionally (rules of hooks) — `task` is a prop and can change
  // across renders, so the hook itself must not be behind an `if`.
  const catalogue = useTaskModelCatalogue(task);
  // TASK-970 — resolved for every task now (not just SPEECH_TO_TEXT): TEXT_GENERATION needs
  // the same lookup to read the bound model's `provider` for the reasoning support note below.
  const selectedModel = modelId ? catalogue.models.find((model) => model.id === modelId) : undefined;
  const asrProfile = isSpeechToText ? (selectedModel?.asrProfile ?? null) : null;
  const profileSummary = isSpeechToText ? summarizeAsrProfile(asrProfile) : null;
  const fieldHints = isSpeechToText ? asrInheritHints(asrProfile) : undefined;
  // TASK-970 (F-2/F-4) — which of the three reasoning-enforcement cases the bound model's
  // provider is in, or `null` until a model is selected / its provider is unrecognised.
  const reasoningSupport = isTextGeneration ? reasoningSupportFor(selectedModel?.provider) : null;

  return (
    <div className="flex flex-col gap-4">
      {profileSummary ? <p className="text-muted-foreground text-xs">{profileSummary}</p> : null}
      <SchemaFields idPrefix={idPrefix} schema={schema} path={[]} value={value} onChange={onChange} fieldHints={fieldHints} reasoningSupport={reasoningSupport} />
    </div>
  );
}
