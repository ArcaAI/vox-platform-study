'use client';

/**
 * `GuardrailField` — the guardrail opt-out tri-state (TASK-890 §3.14, round 3 D-1/D-R):
 * inherit / on / off, ABSENT means inherit at every level — never "unset false"
 * (`@arcaai/workflow-contract`'s own `resolveGuardrailDecision` doc). Two scopes render this
 * SAME control:
 *
 *   - `scope="node"` — `core.agent`'s `config.guardrail.enabled`, precedence
 *     node > workflow > agent > ON.
 *   - `scope="workflow"` — `core.trigger`'s `config.guardrail.enabled`, the per-workflow
 *     default every `core.agent` node inherits absent its own opinion.
 *
 * The effective value is computed with the CONTRACT's own pure function — never re-derived —
 * so the console can never disagree with the publish gate or either runtime about what a graph
 * actually does. It is advisory only: the real enforcement point is `publishFindings`
 * (`GUARDRAIL_OPTED_OUT`, a WARNING, never blocking) and the compiled `policyBindings.guardrail`
 * / `compiledConfig.guardrail`; this field cannot itself make an unsafe graph publishable or
 * refuse a safe one.
 */
import { resolveGuardrailDecision, type GuardrailDecisionSource } from '@arcaai/workflow-contract';
import { Badge, Field, FieldDescription, FieldLabel, FieldLegend, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui';
import { getAtPath, setAtPath } from './field-path';

const GUARDRAIL_ENABLED_PATH = 'guardrail.enabled';

type TriState = 'inherit' | 'true' | 'false';

const SOURCE_LABEL: Record<GuardrailDecisionSource, string> = {
  node: 'node override',
  workflow: 'workflow default',
  agent: 'agent default',
  default: 'default',
};

export interface GuardrailFieldProps {
  idPrefix: string;
  config: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => void;
  scope: 'node' | 'workflow';
  /** `scope: 'node'` only — the workflow's own `core.trigger` guardrail decision (absent = no opinion). */
  workflowGuardrailEnabled?: boolean | null;
  /** `scope: 'node'` only — the referenced agent's own default (`parameters.guards.enabled`). */
  agentGuardrailEnabled?: boolean | null;
  errors?: string[];
  disabled?: boolean;
}

function readTriState(config: Record<string, unknown>): boolean | undefined {
  const value = getAtPath(config, GUARDRAIL_ENABLED_PATH);
  return typeof value === 'boolean' ? value : undefined;
}

function writeTriState(config: Record<string, unknown>, next: TriState): Record<string, unknown> {
  if (next === 'inherit') {
    const { guardrail: _omit, ...rest } = config;
    return rest;
  }
  return setAtPath(config, GUARDRAIL_ENABLED_PATH, next === 'true');
}

export function GuardrailField({
  idPrefix,
  config,
  onConfigChange,
  scope,
  workflowGuardrailEnabled,
  agentGuardrailEnabled,
  errors,
  disabled,
}: GuardrailFieldProps) {
  const id = `${idPrefix}-guardrail`;
  const own = readTriState(config);
  const value: TriState = own === undefined ? 'inherit' : own ? 'true' : 'false';

  const decision =
    scope === 'node'
      ? resolveGuardrailDecision({ node: own, workflow: workflowGuardrailEnabled, agent: agentGuardrailEnabled })
      : resolveGuardrailDecision({ workflow: own });

  return (
    <FieldSet data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
      <FieldLegend variant="label">Guardrail</FieldLegend>
      <FieldDescription>
        {scope === 'node'
          ? "Whether platform guardrail screens this node's call. Absent inherits the workflow default, then the agent's own default, then ON."
          : "This workflow's default. A core.agent node without its own opinion inherits this; absent, it inherits the agent's own default, then ON."}
      </FieldDescription>
      <Field>
        <FieldLabel htmlFor={id}>{scope === 'node' ? 'This node' : 'Workflow default'}</FieldLabel>
        <Select value={value} onValueChange={(next) => onConfigChange(writeTriState(config, next as TriState))} disabled={disabled}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">Inherit</SelectItem>
            <SelectItem value="true">On</SelectItem>
            <SelectItem value="false">Off</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <FieldDescription>
        Effective: {decision.enabled ? 'on' : 'off'} — {SOURCE_LABEL[decision.source]}
      </FieldDescription>
      {!decision.enabled ? (
        <Badge variant="secondary" className="w-fit">
          Guardrail off — screening will not run for {scope === 'node' ? 'this node' : 'runs that inherit this default'}
        </Badge>
      ) : null}
    </FieldSet>
  );
}
