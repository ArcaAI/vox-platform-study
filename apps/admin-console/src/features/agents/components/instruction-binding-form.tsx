'use client';

/**
 * TASK-890 §3.4/§3.6/§3.10 — the TEXT_GENERATION Instruction step: the shared
 * `<PromptTemplatePicker>` (quick view + deep link), a version pin (follow the template's own
 * approved version, or pin one), a per-declared-variable binding (a static value, or a context
 * path resolved through the render scope BEFORE the bare-name overlay — §3.3), and the
 * context-schema picker (TENANT rows only, `useContextSchemaOptions`) that governs what
 * `{{context.*}}` resolves against for this agent. Shared by the create wizard and the edit-draft
 * form so the two cannot drift (rule 13 — features never import each other; this lives inside the
 * `agents` feature and consumes the SHARED picker/catalogue, never a copy of either).
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
} from '@arcaai/ui';
import { useContextSchemaOptions } from '@/shared/catalog';
import { PromptTemplatePicker, type PromptPickerTemplate } from '@/shared/prompt-picker';
import type { AgentPromptVariableBinding } from '../api';

export interface InstructionBindingValue {
  promptTemplateId: string | null;
  /** `null` ⇒ follow the template's own approved version. */
  promptVersionNumber: number | null;
  variables: Record<string, AgentPromptVariableBinding>;
  contextSchemaId: string | null;
  /** `null` ⇒ follow the schema's own pinned version. */
  contextSchemaVersionNumber: number | null;
}

export interface InstructionBindingFormProps {
  value: InstructionBindingValue;
  onChange: (next: InstructionBindingValue) => void;
  disabled?: boolean;
}

function bindingIsContext(binding: AgentPromptVariableBinding | undefined): boolean {
  return !!binding && typeof binding.path === 'string';
}

export function InstructionBindingForm({ value, onChange, disabled }: InstructionBindingFormProps) {
  const idPrefix = useId();
  const [template, setTemplate] = useState<PromptPickerTemplate | null>(null);
  const schemas = useContextSchemaOptions();
  const declared = template?.declaredVariables ?? [];

  function patch(next: Partial<InstructionBindingValue>) {
    onChange({ ...value, ...next });
  }

  function setVariable(name: string, binding: AgentPromptVariableBinding | undefined) {
    const variables = { ...value.variables };
    if (binding === undefined) delete variables[name];
    else variables[name] = binding;
    patch({ variables });
  }

  return (
    <div className="flex flex-col gap-4">
      <PromptTemplatePicker
        id={`${idPrefix}-template`}
        value={value.promptTemplateId}
        onChange={(id) => patch({ promptTemplateId: id, promptVersionNumber: null, variables: {} })}
        onTemplateChange={setTemplate}
        disabled={disabled}
      />

      {value.promptTemplateId && template ? (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Version</legend>
            <RadioGroup
              value={value.promptVersionNumber === null ? 'approved' : 'pinned'}
              onValueChange={(mode) =>
                patch({ promptVersionNumber: mode === 'approved' ? null : (template.approvedVersionNumber ?? template.currentVersionNumber) })
              }
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem id={`${idPrefix}-follow`} value="approved" disabled={disabled} />
                <Label htmlFor={`${idPrefix}-follow`}>
                  Follow approved{template.approvedVersionNumber != null ? ` (v${template.approvedVersionNumber})` : ''}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id={`${idPrefix}-pin`} value="pinned" disabled={disabled} />
                <Label htmlFor={`${idPrefix}-pin`}>Pin a version</Label>
                {value.promptVersionNumber !== null ? (
                  <Input
                    id={`${idPrefix}-pin-number`}
                    type="number"
                    min={1}
                    className="w-20"
                    aria-label="Pinned version number"
                    value={value.promptVersionNumber}
                    disabled={disabled}
                    onChange={(event) => patch({ promptVersionNumber: Number(event.target.value) || 1 })}
                  />
                ) : null}
              </div>
            </RadioGroup>
          </fieldset>

          {declared.length > 0 ? (
            <fieldset className="flex flex-col gap-3 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">Variable bindings</legend>
              {declared.map((declaration) => {
                const binding = value.variables[declaration.name];
                const isContext = bindingIsContext(binding);
                const fieldId = `${idPrefix}-var-${declaration.name}`;
                return (
                  <div key={declaration.name} className="flex flex-col gap-1.5">
                    <Label htmlFor={fieldId}>
                      {declaration.name}
                      {declaration.required ? (
                        <span aria-hidden className="text-destructive">
                          {' '}
                          *
                        </span>
                      ) : null}
                    </Label>
                    <div className="flex gap-2">
                      <Select
                        value={isContext ? 'context' : 'static'}
                        onValueChange={(next) => setVariable(declaration.name, next === 'context' ? { path: '' } : { value: '' })}
                        disabled={disabled}
                      >
                        <SelectTrigger aria-label={`${declaration.name} binding kind`} className="w-40 shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="static">Static value</SelectItem>
                          <SelectItem value="context">Context path</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        id={fieldId}
                        className="flex-1"
                        placeholder={isContext ? 'context.patientAge' : (declaration.default ?? declaration.type)}
                        value={isContext ? (binding?.path ?? '') : binding?.value !== undefined ? String(binding.value) : ''}
                        disabled={disabled}
                        onChange={(event) => {
                          const text = event.target.value;
                          if (isContext) setVariable(declaration.name, text ? { path: text } : undefined);
                          else setVariable(declaration.name, text ? { value: text } : undefined);
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </fieldset>
          ) : null}
        </>
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
