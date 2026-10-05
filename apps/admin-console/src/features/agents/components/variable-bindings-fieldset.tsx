'use client';

/**
 * TASK-947 — the "Variable bindings" fieldset, extracted out of `InstructionBindingForm`
 * (TASK-890 §3.6) so it can be reused by `FragmentListEditor` over the UNION of declared
 * variables across every template-sourced fragment (ticket §4.1/OD-8: `instruction.variables`
 * stays ONE agent-level map, whichever of the three instruction forms is in use). A static value
 * is a plain input; a context path is a `TemplateEditor` (CEL mode) completing the effective
 * schema's paths, so a path is picked rather than guessed.
 */
import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui';
import { TemplateEditor, type VariablePath } from '@arcaai/ui/components/custom/template-editor';
import type { PromptPickerVariableDeclaration } from '@/shared/prompt-picker';
import type { AgentPromptVariableBinding } from '../api';

function bindingIsContext(binding: AgentPromptVariableBinding | undefined): boolean {
  return !!binding && typeof binding.path === 'string';
}

export interface VariableBindingsFieldsetProps {
  idPrefix: string;
  declared: PromptPickerVariableDeclaration[];
  variables: Record<string, AgentPromptVariableBinding>;
  onChange: (variables: Record<string, AgentPromptVariableBinding>) => void;
  disabled?: boolean;
  /** TASK-947 — one conflict line per name declared with a different `type` by two fragment templates. */
  conflicts?: string[];
  /** Completion vocabulary for a context-path binding (the effective schema's `context.*` / `trigger.*` paths). */
  paths?: readonly VariablePath[];
}

/** A path binding names a ROOTED path; bare variable names are not bindable targets. */
function bindablePaths(paths: readonly VariablePath[]): VariablePath[] {
  return paths.filter((entry) => entry.path.includes('.'));
}

export function VariableBindingsFieldset({ idPrefix, declared, variables, onChange, disabled, conflicts, paths = [] }: VariableBindingsFieldsetProps) {
  if (declared.length === 0 && (!conflicts || conflicts.length === 0)) return null;

  function setVariable(name: string, binding: AgentPromptVariableBinding | undefined) {
    const next = { ...variables };
    if (binding === undefined) delete next[name];
    else next[name] = binding;
    onChange(next);
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">Variable bindings</legend>
      {conflicts?.length ? (
        <ul className="flex flex-col gap-0.5" aria-label="Variable conflicts">
          {conflicts.map((conflict) => (
            <li key={conflict} className="text-destructive text-sm">
              {conflict}
            </li>
          ))}
        </ul>
      ) : null}
      {declared.map((declaration) => {
        const binding = variables[declaration.name];
        const isContext = bindingIsContext(binding);
        const fieldId = `${idPrefix}-var-${declaration.name}`;
        const labelId = `${fieldId}-label`;
        return (
          <div key={declaration.name} className="flex flex-col gap-1.5">
            <Label id={labelId} htmlFor={fieldId}>
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
              {isContext ? (
                <TemplateEditor
                  className="flex-1"
                  mode="cel"
                  minLines={1}
                  aria-labelledby={labelId}
                  value={binding?.path ?? ''}
                  paths={bindablePaths(paths)}
                  readOnly={disabled}
                  placeholder="Type context. to pick a field"
                  onChange={(text) => setVariable(declaration.name, { path: text })}
                />
              ) : (
                <Input
                  id={fieldId}
                  className="flex-1"
                  placeholder={declaration.default ?? declaration.type}
                  value={binding?.value !== undefined ? String(binding.value) : ''}
                  disabled={disabled}
                  onChange={(event) => {
                    const text = event.target.value;
                    setVariable(declaration.name, text ? { value: text } : undefined);
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}
