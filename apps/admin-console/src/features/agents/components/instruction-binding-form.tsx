'use client';

/**
 * TASK-890 §3.4/§3.6/§3.10, extended by TASK-947 §4.1/OD-12 — the TEXT_GENERATION Instruction
 * step, now covering all three mutually exclusive instruction forms behind one "Instruction
 * source" choice:
 *   - `template` — the shared `<PromptTemplatePicker>` (quick view + deep link), a version pin
 *     (follow the template's own approved version, or pin one), and a per-declared-variable
 *     binding (a static value, or a context path resolved through the render scope BEFORE the
 *     bare-name overlay — §3.3).
 *   - `inline` — a single system prompt.
 *   - `fragments` (TASK-947) — an ordered list of prompt fragments, each a template reference or
 *     an inline body, each with an optional CEL `when` condition; see `FragmentListEditor`.
 * The context-schema picker (TENANT rows only, `useContextSchemaOptions`) governs what
 * `{{context.*}}` resolves against for this agent and applies regardless of instruction form —
 * an inline or fragment body can reference `{{context.*}}` exactly as a template can. Shared by
 * the create wizard and the edit-draft form so the two cannot drift (rule 13 — features never
 * import each other; this lives inside the `agents` feature and consumes the SHARED
 * picker/catalogue, never a copy of either).
 */
import { useId, useMemo, useState } from 'react';
import {
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@arcaai/ui';
import { useContextSchemaDefinition, useContextSchemaOptions } from '@/shared/catalog';
import {
  TemplateField,
  contextCompletionPaths,
  declaredNamespaces,
  findingsAt,
  templateLint,
  variableNamePaths,
  withPlatformPaths,
} from '@/shared/template-editor';
import { PromptTemplatePicker, usePromptTemplateOptions, type PromptPickerTemplate } from '@/shared/prompt-picker';
import {
  instructionForm,
  readFragments,
  type AgentFinding,
  type AgentPromptVariableBinding,
  type PromptFragment,
} from '../api';
import {
  FragmentListEditor,
  fragmentRowsFromFragments,
  fragmentsFromRows,
  type FragmentAssist,
  type FragmentRow,
} from './fragment-list-editor';
import { VariableBindingsFieldset } from './variable-bindings-fieldset';
import { VersionPinControl } from './version-pin-control';

export type InstructionMode = 'template' | 'inline' | 'fragments';

export interface InstructionBindingValue {
  mode: InstructionMode;
  promptTemplateId: string | null;
  /** `null` ⇒ follow the template's own approved version. Only meaningful when `mode === 'template'`. */
  promptVersionNumber: number | null;
  /** ONE agent-level map — the union of every fragment template's declared variables in `fragments` mode (OD-8). */
  variables: Record<string, AgentPromptVariableBinding>;
  /** Only meaningful when `mode === 'inline'`. */
  systemPrompt: string;
  /** Only meaningful when `mode === 'fragments'`. */
  fragments: FragmentRow[];
  contextSchemaId: string | null;
  /** `null` ⇒ follow the schema's own pinned version. */
  contextSchemaVersionNumber: number | null;
}

export interface InstructionBindingFormProps {
  value: InstructionBindingValue;
  onChange: (next: InstructionBindingValue) => void;
  disabled?: boolean;
  /** The agent's latest publish findings — each is rendered at the field its `path` names. */
  findings?: readonly AgentFinding[];
  /** The schema a workflow node lends this agent when it binds none of its own (read-only here). */
  inheritedContextSchema?: { id: string; versionNumber: number } | null;
  /** The caller renders the context-schema choice itself (the create wizard does, in step 1). */
  hideContextSchema?: boolean;
  /**
   * TASK-1036 W2/W3 — the simple editor: a library prompt is pinned to its approved version when
   * chosen (changeable, never clearable), and composable fragments are offered only to an agent
   * that already uses them. The advanced form is the default so existing call sites are unchanged.
   */
  simple?: boolean;
}

/**
 * What the editors below complete and lint against: the effective schema's `context.*` /
 * `trigger.*` paths, the platform's own `context.*` names, and every bare variable name the
 * instruction binds.
 */
function useSchemaAssist(
  value: InstructionBindingValue,
  extraNames: readonly string[],
  findings: readonly AgentFinding[],
  inherited: InstructionBindingFormProps['inheritedContextSchema'],
): FragmentAssist {
  const schemaId = value.contextSchemaId ?? inherited?.id ?? null;
  const versionNumber = value.contextSchemaId ? value.contextSchemaVersionNumber : (inherited?.versionNumber ?? null);
  const { definition } = useContextSchemaDefinition(schemaId, versionNumber);
  const names = useMemo(() => [...Object.keys(value.variables), ...extraNames], [value.variables, extraNames]);
  return useMemo(() => {
    // Plus the platform's own `context.*` names, which publish admits for every TEXT_GENERATION prompt.
    const paths = [...withPlatformPaths(contextCompletionPaths(definition)), ...variableNamePaths(names)];
    // A bound schema whose definition has not arrived yet admits its roots rather than flagging them.
    const pending = schemaId !== null && definition === null;
    const declared = declaredNamespaces({
      definition,
      variables: names,
      openRoots: pending ? ['input', 'context', 'trigger'] : ['input'],
      platform: true,
    });
    return { paths, lint: templateLint(declared), findings };
  }, [definition, names, schemaId, findings]);
}

/**
 * TASK-947 — the inverse pair used by both the create wizard and the edit-draft form so a
 * TEXT_GENERATION instruction round-trips through the editor state for all three forms:
 * `instructionToBinding(json)` seeds the editor, `instructionFromBinding(state)` serializes it
 * back. `contextSchemaId`/`contextSchemaVersionNumber` live on `Agent` itself (not inside
 * `instruction`), so they are passed in separately and copied straight into the result.
 */
export function instructionToBinding(
  instruction: Record<string, unknown> | null,
  contextSchemaId: string | null,
  contextSchemaVersionNumber: number | null,
): InstructionBindingValue {
  const form = instructionForm(instruction);
  const promptTemplateId = instruction && typeof instruction.promptTemplateId === 'string' ? instruction.promptTemplateId : null;
  const promptVersionNumber = instruction && typeof instruction.promptVersionNumber === 'number' ? instruction.promptVersionNumber : null;
  const rawVariables = instruction?.variables;
  const variables = rawVariables && typeof rawVariables === 'object' ? (rawVariables as Record<string, AgentPromptVariableBinding>) : {};
  const systemPrompt = instruction && typeof instruction.systemPrompt === 'string' ? instruction.systemPrompt : '';
  return {
    mode: form === 'fragments' || form === 'inline' ? form : 'template',
    promptTemplateId,
    promptVersionNumber,
    variables,
    systemPrompt,
    fragments: fragmentRowsFromFragments(readFragments(instruction)),
    contextSchemaId,
    contextSchemaVersionNumber,
  };
}

/** The inverse of `instructionToBinding` — `undefined` when there is nothing to persist yet (e.g. no template chosen). */
export function instructionFromBinding(value: InstructionBindingValue): Record<string, unknown> | undefined {
  if (value.mode === 'fragments') {
    const fragments: PromptFragment[] = fragmentsFromRows(value.fragments);
    if (fragments.length === 0) return undefined;
    const instruction: Record<string, unknown> = { fragments };
    if (Object.keys(value.variables).length > 0) instruction.variables = value.variables;
    return instruction;
  }
  if (value.mode === 'template') {
    if (!value.promptTemplateId) return undefined;
    const instruction: Record<string, unknown> = { promptTemplateId: value.promptTemplateId };
    if (value.promptVersionNumber !== null) instruction.promptVersionNumber = value.promptVersionNumber;
    if (Object.keys(value.variables).length > 0) instruction.variables = value.variables;
    return instruction;
  }
  return { systemPrompt: value.systemPrompt };
}

const NO_FINDINGS: readonly AgentFinding[] = [];

export function InstructionBindingForm({ value, onChange, disabled, findings = NO_FINDINGS, inheritedContextSchema, hideContextSchema, simple = false }: InstructionBindingFormProps) {
  const idPrefix = useId();
  const [template, setTemplate] = useState<PromptPickerTemplate | null>(null);
  const schemas = useContextSchemaOptions();
  const declared = template?.declaredVariables ?? [];
  const declaredNames = useMemo(() => (template?.declaredVariables ?? []).map((declaration) => declaration.name), [template]);
  const assist = useSchemaAssist(value, declaredNames, findings, inheritedContextSchema);

  function patch(next: Partial<InstructionBindingValue>) {
    onChange({ ...value, ...next });
  }

  // TASK-1036 W3 — the approved version is stamped when a template is CHOSEN (never when a stored
  // agent merely loads it), so a saved `null` is not rewritten behind the author's back. Read from
  // the picker's own cached list (same query key), so no second fetch.
  const promptOptions = usePromptTemplateOptions();
  function choosePrompt(id: string | null) {
    const approved = simple ? ((promptOptions.data ?? []).find((candidate) => candidate.id === id)?.approvedVersionNumber ?? null) : null;
    patch({ promptTemplateId: id, promptVersionNumber: approved, variables: {} });
  }

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Instruction source</legend>
        <RadioGroup value={value.mode} onValueChange={(mode) => patch({ mode: mode as InstructionMode })} aria-label="Instruction source">
          <div className="flex items-center gap-2">
            <RadioGroupItem id={`${idPrefix}-mode-template`} value="template" disabled={disabled} />
            <Label htmlFor={`${idPrefix}-mode-template`}>Approved prompt template</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id={`${idPrefix}-mode-inline`} value="inline" disabled={disabled} />
            <Label htmlFor={`${idPrefix}-mode-inline`}>Inline system prompt</Label>
          </div>
          {!simple || value.mode === 'fragments' ? (
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${idPrefix}-mode-fragments`} value="fragments" disabled={disabled} />
              <Label htmlFor={`${idPrefix}-mode-fragments`}>Composable fragments (conditional)</Label>
            </div>
          ) : null}
        </RadioGroup>
      </fieldset>

      {value.mode === 'template' ? (
        <>
          <PromptTemplatePicker
            id={`${idPrefix}-template`}
            value={value.promptTemplateId}
            onChange={choosePrompt}
            onTemplateChange={setTemplate}
            disabled={disabled}
          />
          {value.promptTemplateId && template ? (
            <>
              <VersionPinControl
                idPrefix={idPrefix}
                approvedVersionNumber={template.approvedVersionNumber}
                currentVersionNumber={template.currentVersionNumber}
                value={value.promptVersionNumber}
                onChange={(promptVersionNumber) => patch({ promptVersionNumber })}
                disabled={disabled}
                required={simple}
              />
              <VariableBindingsFieldset
                idPrefix={idPrefix}
                declared={declared}
                variables={value.variables}
                onChange={(variables) => patch({ variables })}
                disabled={disabled}
                paths={assist.paths}
              />
            </>
          ) : null}
          <FieldFindings findings={findingsAt(assist.findings, 'instruction')} label="Prompt template" />
        </>
      ) : null}

      {value.mode === 'inline' ? (
        <TemplateField
          label="System prompt"
          required
          value={value.systemPrompt}
          onChange={(systemPrompt) => patch({ systemPrompt })}
          paths={assist.paths}
          lint={assist.lint}
          findings={[...findingsAt(assist.findings, 'instruction'), ...findingsAt(assist.findings, 'instruction.systemPrompt')]}
          minLines={8}
          disabled={disabled}
        />
      ) : null}

      {value.mode === 'fragments' ? (
        <FragmentListEditor
          fragments={value.fragments}
          onFragmentsChange={(fragments) => patch({ fragments })}
          variables={value.variables}
          onVariablesChange={(variables) => patch({ variables })}
          disabled={disabled}
          assist={assist}
        />
      ) : null}

      {hideContextSchema ? null : (
        <ContextSchemaField idPrefix={idPrefix} value={value} onChange={patch} disabled={disabled} options={schemas.options} isLoading={schemas.isLoading} />
      )}
    </div>
  );
}

/** A server finding list for a field that is not itself a `TemplateField` (the template picker). */
function FieldFindings({ findings, label }: { findings: readonly AgentFinding[]; label: string }) {
  if (findings.length === 0) return null;
  return (
    <ul aria-label={`Publish findings for ${label}`} className="flex flex-col gap-1">
      {findings.map((finding, index) => (
        <li key={`${finding.code}-${index}`} className={finding.severity === 'ERROR' ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
          <span className="font-mono">{finding.code}</span> — {finding.message}
        </li>
      ))}
    </ul>
  );
}

/**
 * The context-schema choice (schema + follow-latest / pinned version). Exported so the create
 * wizard can ask it FIRST, before the instruction, since it decides what every editor suggests.
 */
export function ContextSchemaField({
  idPrefix,
  value,
  onChange,
  disabled,
  options,
  isLoading,
}: {
  idPrefix: string;
  value: Pick<InstructionBindingValue, 'contextSchemaId' | 'contextSchemaVersionNumber'>;
  onChange: (next: Partial<Pick<InstructionBindingValue, 'contextSchemaId' | 'contextSchemaVersionNumber'>>) => void;
  disabled?: boolean;
  options: { value: string; label: string }[];
  isLoading: boolean;
}) {
  const patch = onChange;
  const schemas = { options, isLoading };
  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-context-schema`}>Context schema</FieldLabel>
        <FieldDescription>Governs what {'{{context.*}}'} resolves against for this agent. Leave unset for none.</FieldDescription>
        <Select
          value={value.contextSchemaId ?? '__none__'}
          onValueChange={(next) => patch({ contextSchemaId: next === '__none__' ? null : next, contextSchemaVersionNumber: null })}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-context-schema`} className="w-full">
            <SelectValue placeholder={schemas.isLoading ? 'Loading…' : 'None'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {schemas.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {value.contextSchemaId ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Schema version</legend>
          <RadioGroup
            value={value.contextSchemaVersionNumber === null ? 'latest' : 'pinned'}
            onValueChange={(mode) => patch({ contextSchemaVersionNumber: mode === 'latest' ? null : 1 })}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${idPrefix}-schema-latest`} value="latest" disabled={disabled} />
              <Label htmlFor={`${idPrefix}-schema-latest`}>Follow latest</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${idPrefix}-schema-pin`} value="pinned" disabled={disabled} />
              <Label htmlFor={`${idPrefix}-schema-pin`}>Pin version</Label>
              {value.contextSchemaVersionNumber !== null ? (
                <Input
                  id={`${idPrefix}-context-schema-version`}
                  type="number"
                  min={1}
                  className="w-20"
                  aria-label="Pinned schema version number"
                  value={value.contextSchemaVersionNumber}
                  disabled={disabled}
                  onChange={(event) => patch({ contextSchemaVersionNumber: Number(event.target.value) || 1 })}
                />
              ) : null}
            </div>
          </RadioGroup>
        </fieldset>
      ) : null}
    </div>
  );
}
