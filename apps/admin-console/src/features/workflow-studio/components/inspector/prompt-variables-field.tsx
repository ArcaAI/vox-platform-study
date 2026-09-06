'use client';

/**
 * `PromptVariablesField` — `core.agent.overrides.promptVariables` (TASK-890 §3.10): values for
 * the bound agent's instruction-template variables. `CORE_AGENT_SCHEMA.overrides.promptVariables`
 * declares `additionalProperties` with no `properties`, so `toFieldDescriptors` falls back to a
 * raw-json box (`schema-form.ts`'s unsupported-construct branch) — an admin would hand-edit a
 * JSON object with no idea which names the agent's template actually declares. This withholds
 * that path (`inspector-panel.tsx`, the same way `AgentPickerField` withholds `agentRef`) and
 * renders one row per DECLARED name instead.
 *
 * "Declared" comes from `Agent.instruction.variables`' KEYS (`AgentOption.instruction.variables`
 * — OD-K's binding map, `{ name: { value } | { path } }`), never invented here. A prior override
 * for a name the CURRENT agent does not declare (a stale value from before the agent was
 * switched, or one authored against an undeclared name on purpose — the runtime interpolation is
 * generic, so it still works) is never silently dropped: it renders under "Other overrides" with
 * its own remove control, matching the disclosure discipline `DocumentBindingField` uses for an
 * unknown template id.
 */
import { useId, useState } from 'react';
import { Button, Field, FieldDescription, FieldLabel, FieldLegend, FieldSet, Input } from '@arcaai/ui';
import { IconTrash } from '@tabler/icons-react';
import { getAtPath, setAtPath } from './field-path';

const PROMPT_VARIABLES_PATH = 'overrides.promptVariables';

/** The run-context namespace roots every `{{...}}` reference is one of (README §3.3) — a
 *  skeleton token an admin completes with the leaf path, mirroring the CEL editor's quick
 *  inserts but fenced for template interpolation rather than bare CEL. */
const NAMESPACE_ROOT_CHIPS = ['trigger', 'context', 'vars', 'nodes'] as const;

function readVariables(config: Record<string, unknown>): Record<string, string> {
  const value = getAtPath(config, PROMPT_VARIABLES_PATH);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

function writeVariables(config: Record<string, unknown>, variables: Record<string, string>): Record<string, unknown> {
  return setAtPath(config, PROMPT_VARIABLES_PATH, variables);
}

export interface PromptVariablesFieldProps {
  idPrefix: string;
  config: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => void;
  /** The referenced agent's declared variable NAMES (`instruction.variables`' keys). Empty when no agent is chosen yet. */
  declaredVariableNames?: readonly string[];
  /** Run-context references the graph offers (`trigger`, `vars.<key>`, `nodes.<id>`) — the same list the CEL editor uses. */
  references?: readonly string[];
  errors?: string[];
  disabled?: boolean;
}

function VariableRow({
  id,
  name,
  value,
  onChange,
  onRemove,
  chips,
  disabled,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (next: string) => void;
  onRemove?: () => void;
  chips: readonly { label: string; token: string }[];
  disabled?: boolean;
}) {
  function insert(token: string) {
    onChange(value.length === 0 || /\s$/.test(value) ? `${value}${token}` : `${value} ${token}`);
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{name}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input id={id} value={value} placeholder="Uses the agent's own value" disabled={disabled} className="font-mono text-xs" onChange={(event) => onChange(event.target.value)} />
        {onRemove ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${name}`} onClick={onRemove} disabled={disabled}>
            <IconTrash aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1" aria-label={`Insert a reference into ${name}`}>
        {chips.map((chip) => (
          <Button key={chip.token} type="button" variant="secondary" size="xs" className="font-mono" disabled={disabled} onClick={() => insert(chip.token)}>
            {chip.label}
          </Button>
        ))}
      </div>
    </Field>
  );
}

export function PromptVariablesField({ idPrefix, config, onConfigChange, declaredVariableNames = [], references = [], errors, disabled }: PromptVariablesFieldProps) {
  const uid = useId();
  const [newName, setNewName] = useState('');
  const variables = readVariables(config);
  const declared = new Set(declaredVariableNames);
  const otherNames = Object.keys(variables).filter((name) => !declared.has(name));

  const chips = [
    ...NAMESPACE_ROOT_CHIPS.map((root) => ({ label: root, token: `{{${root}.}}` })),
    ...references.map((reference) => ({ label: reference, token: `{{${reference}}}` })),
  ];

  function setVariable(name: string, value: string) {
    const next = { ...variables };
    if (value.length === 0) delete next[name];
    else next[name] = value;
    onConfigChange(writeVariables(config, next));
  }

  function removeVariable(name: string) {
    const { [name]: _omit, ...rest } = variables;
    onConfigChange(writeVariables(config, rest));
  }

  function addCustomOverride() {
    const name = newName.trim();
    if (!name) return;
    onConfigChange(writeVariables(config, { ...variables, [name]: variables[name] ?? '' }));
    setNewName('');
  }

  return (
    <FieldSet data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
      <FieldLegend variant="label">Prompt variable overrides</FieldLegend>
      <FieldDescription>
        Override the agent&apos;s bound value for a variable it declares. Leave a row blank to use the agent&apos;s own value.
      </FieldDescription>

      {declaredVariableNames.map((name) => (
        <VariableRow
          key={name}
          id={`${idPrefix}-${uid}-${name}`}
          name={name}
          value={variables[name] ?? ''}
          onChange={(next) => setVariable(name, next)}
          chips={chips}
          disabled={disabled}
        />
      ))}

      {otherNames.length > 0 ? (
        <div className="flex flex-col gap-4 border-t pt-3">
          <FieldLegend variant="label">Other overrides</FieldLegend>
          <FieldDescription>Overrides for a variable name this agent does not currently declare.</FieldDescription>
          {otherNames.map((name) => (
            <VariableRow
              key={name}
              id={`${idPrefix}-${uid}-other-${name}`}
              name={name}
              value={variables[name] ?? ''}
              onChange={(next) => setVariable(name, next)}
              onRemove={() => removeVariable(name)}
              chips={chips}
              disabled={disabled}
            />
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-2 border-t pt-3">
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-${uid}-new-name`}>Variable name</FieldLabel>
          <Input
            id={`${idPrefix}-${uid}-new-name`}
            value={newName}
            disabled={disabled}
            className="font-mono text-xs"
            onChange={(event) => setNewName(event.target.value)}
          />
        </Field>
        <Button type="button" variant="outline" size="sm" onClick={addCustomOverride} disabled={disabled || newName.trim().length === 0}>
          Add
        </Button>
      </div>
    </FieldSet>
  );
}
