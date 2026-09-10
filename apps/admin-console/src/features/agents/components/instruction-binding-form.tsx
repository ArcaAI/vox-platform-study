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
import { useId, useState } from 'react';
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
  Textarea,
} from '@arcaai/ui';
import { useContextSchemaOptions } from '@/shared/catalog';
import { PromptTemplatePicker, type PromptPickerTemplate } from '@/shared/prompt-picker';
import {
  instructionForm,
  readFragments,
  type AgentPromptVariableBinding,
  type PromptFragment,
} from '../api';
import {
  FragmentListEditor,
  fragmentRowsFromFragments,
  fragmentsFromRows,
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

export function InstructionBindingForm({ value, onChange, disabled }: InstructionBindingFormProps) {
  const idPrefix = useId();
  const [template, setTemplate] = useState<PromptPickerTemplate | null>(null);
  const schemas = useContextSchemaOptions();
  const declared = template?.declaredVariables ?? [];

  function patch(next: Partial<InstructionBindingValue>) {
    onChange({ ...value, ...next });
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
          <div className="flex items-center gap-2">
            <RadioGroupItem id={`${idPrefix}-mode-fragments`} value="fragments" disabled={disabled} />
            <Label htmlFor={`${idPrefix}-mode-fragments`}>Composable fragments (conditional)</Label>
          </div>
        </RadioGroup>
      </fieldset>

      {value.mode === 'template' ? (
        <>
          <PromptTemplatePicker
            id={`${idPrefix}-template`}
            value={value.promptTemplateId}
            onChange={(id) => patch({ promptTemplateId: id, promptVersionNumber: null, variables: {} })}
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
              />
              <VariableBindingsFieldset idPrefix={idPrefix} declared={declared} variables={value.variables} onChange={(variables) => patch({ variables })} disabled={disabled} />
            </>
          ) : null}
        </>
      ) : null}

      {value.mode === 'inline' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-system-prompt`}>
            System prompt <span aria-hidden>*</span>
          </Label>
          <Textarea
            id={`${idPrefix}-system-prompt`}
            rows={8}
            maxLength={50000}
            value={value.systemPrompt}
            disabled={disabled}
            onChange={(event) => patch({ systemPrompt: event.target.value })}
          />
        </div>
      ) : null}

      {value.mode === 'fragments' ? (
        <FragmentListEditor
          fragments={value.fragments}
          onFragmentsChange={(fragments) => patch({ fragments })}
          variables={value.variables}
          onVariablesChange={(variables) => patch({ variables })}
          disabled={disabled}
        />
      ) : null}

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
