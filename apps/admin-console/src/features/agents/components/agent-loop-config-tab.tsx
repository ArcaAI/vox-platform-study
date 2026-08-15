'use client';

/**
 * Loop config tab — the constrained goal/tool/guardrail authoring
 * surface for the seven `DepartmentAgent` fields, D8: NOT a rule
 * builder and NOT a free-text prompt box. Every pickable value comes from a
 * closed catalogue (role, guardrail profile, tool allowlist, the seven
 * action-registry keys) or the tenant's own RESOLVED consultation context
 * schema (subscribed kinds / write scope) — never free text. Free-text prompt
 * authoring stays on the bound Agent Template (Settings tab), untouched here.
 *
 * Mounted as a fourth `DetailDrawer` tab alongside Settings/Version/History
 * (see `agent-detail-drawer.tsx`). Hosted inside the same `<Tabs>` context; the
 * parent remounts this component (via a `key` on the agent's id+updatedAt)
 * whenever the underlying row changes, exactly like `SettingsForm`.
 */

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { ToggleGroup, ToggleGroupItem } from '@arcaai/ui/components/shadcn/toggle-group';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { ErrorState } from '@/shared/state/error-state';
import { useDepartmentAgents, useResolvedContextSchema, useUpdateDepartmentAgent } from '../api/hooks';
import type { DepartmentAgent, DepartmentAgentRole, GuardrailProfile, ResolvedContextEntry, UpdateDepartmentAgentRequest } from '../api/types';
import {
  actionOverlap,
  AGENT_ACTION_KEYS,
  AGENT_ACTION_LABELS,
  AGENT_BUDGET_FIELDS,
  AGENT_ROLE_OPTIONS,
  buildBudgetsHarnessOverridesPayload,
  buildGoalPayload,
  buildSubscribedKindsPayload,
  buildToolConfigPayload,
  buildWriteScopePayload,
  C25_CONFIRM_PHRASE,
  GOAL_MAX_SUCCESS_CRITERIA,
  GUARDRAIL_PROFILE_KEYS,
  GUARDRAIL_PROFILE_LABELS,
  goalObjectiveProblem,
  goalSuccessCriterionProblem,
  LIVE_TOOL_KEYS,
  LIVE_TOOL_LABELS,
  parseGoal,
  parseSubscribedKinds,
  parseToolConfig,
  parseWriteScope,
  type SelectedKind,
  type ToolTriState,
  weakensClinicalCheck,
} from './agent-loop-config-fields';

const TOOL_TRI_STATES: ToolTriState[] = ['inherit', 'on', 'off'];

function toolTriLabel(tri: ToolTriState): string {
  if (tri === 'inherit') return 'Inherit';
  return tri === 'on' ? 'On' : 'Off';
}

const NO_GUARDRAIL_PROFILE = '__none__';

function SectionHeading({ id, title, hint }: { id: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

/** Role select + the "another PRIMARY already exists" inline warning (surfaced before save, not just on failure). */
function RoleSection({
  uid,
  role,
  onRoleChange,
  existingPrimary,
}: {
  uid: string;
  role: DepartmentAgentRole;
  onRoleChange: (role: DepartmentAgentRole) => void;
  existingPrimary: DepartmentAgent | null;
}) {
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-role`}>
      <SectionHeading id={`${uid}-role`} title="Role" hint="At most one PRIMARY agent per department — the PRIMARY owns the note and gate exclusively." />
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-role-select`}>Loop role</Label>
        <Select value={role} onValueChange={(next) => onRoleChange(next as DepartmentAgentRole)}>
          <SelectTrigger id={`${uid}-role-select`} className="w-full max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGENT_ROLE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {role === 'PRIMARY' && existingPrimary ? (
        <p className="text-destructive text-sm">
          &ldquo;{existingPrimary.name}&rdquo; is already PRIMARY in this department. Saving will be rejected until its role changes first.
        </p>
      ) : null}
    </Card>
  );
}

/** Subscribed kinds — picked from the resolved context schema, with an optional single field=value filter per kind. */
function SubscribedKindsSection({
  uid,
  availableKinds,
  schemaUnresolved,
  selected,
  onToggle,
  onFilterChange,
}: {
  uid: string;
  availableKinds: ResolvedContextEntry[];
  schemaUnresolved: boolean;
  selected: SelectedKind[];
  onToggle: (key: string, checked: boolean) => void;
  onFilterChange: (key: string, field: string, value: string) => void;
}) {
  const selectedByKey = new Map(selected.map((entry) => [entry.key, entry]));
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-kinds`}>
      <SectionHeading
        id={`${uid}-kinds`}
        title="Subscribed kinds"
        hint="Context kinds this agent listens for, picked from the department's context schema — never free text."
      />
      {schemaUnresolved ? (
        <p className="text-muted-foreground text-sm">
          No consultation context schema is configured for this department yet. Referencing a kind fails closed until one is published.
        </p>
      ) : availableKinds.length === 0 ? (
        <p className="text-muted-foreground text-sm">The resolved schema declares no kinds.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {availableKinds.map((kind) => {
            const id = `${uid}-kind-${kind.key}`;
            const entry = selectedByKey.get(kind.key);
            const checked = !!entry;
            return (
              <li key={kind.key} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Checkbox id={id} checked={checked} onCheckedChange={(next) => onToggle(kind.key, next === true)} />
                  <Label htmlFor={id} className="font-mono text-xs font-normal">
                    {kind.label ?? kind.key} <span className="text-muted-foreground">({kind.key})</span>
                  </Label>
                </div>
                {checked ? (
                  <div className="ml-6 flex flex-wrap items-center gap-2">
                    <Label htmlFor={`${id}-filter-field`} className="text-muted-foreground text-xs font-normal">
                      Filter (optional)
                    </Label>
                    <Input
                      id={`${id}-filter-field`}
                      aria-label={`Filter field for ${kind.key}`}
                      placeholder="field"
                      className="h-7 w-28 text-xs"
                      value={entry?.filter ? Object.keys(entry.filter)[0] : ''}
                      onChange={(event) => onFilterChange(kind.key, event.target.value, entry?.filter ? Object.values(entry.filter)[0] : '')}
                    />
                    <span aria-hidden className="text-muted-foreground text-xs">
                      =
                    </span>
                    <Input
                      id={`${id}-filter-value`}
                      aria-label={`Filter value for ${kind.key}`}
                      placeholder="value"
                      className="h-7 w-28 text-xs"
                      value={entry?.filter ? Object.values(entry.filter)[0] : ''}
                      onChange={(event) => onFilterChange(kind.key, entry?.filter ? Object.keys(entry.filter)[0] : '', event.target.value)}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Write scope — output kinds this agent may produce, picked from the resolved schema's declared outputs. */
function WriteScopeSection({
  uid,
  availableOutputs,
  schemaUnresolved,
  selected,
  onToggle,
}: {
  uid: string;
  availableOutputs: ResolvedContextEntry[];
  schemaUnresolved: boolean;
  selected: string[];
  onToggle: (key: string, checked: boolean) => void;
}) {
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-outputs`}>
      <SectionHeading id={`${uid}-outputs`} title="Write scope" hint="Output kinds this agent may produce." />
      {schemaUnresolved ? (
        <p className="text-muted-foreground text-sm">No context schema is configured for this department yet.</p>
      ) : availableOutputs.length === 0 ? (
        <p className="text-muted-foreground text-sm">The resolved schema declares no outputs.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {availableOutputs.map((output) => {
            const id = `${uid}-output-${output.key}`;
            return (
              <li key={output.key} className="flex items-center gap-2">
                <Checkbox id={id} checked={selected.includes(output.key)} onCheckedChange={(next) => onToggle(output.key, next === true)} />
                <Label htmlFor={id} className="font-mono text-xs font-normal">
                  {output.label ?? output.key} <span className="text-muted-foreground">({output.key})</span>
                </Label>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Constrained goal (D8): a length-capped objective + bounded success criteria — structurally not a system prompt. */
function GoalSection({
  uid,
  objective,
  onObjectiveChange,
  successCriteria,
  onCriteriaChange,
}: {
  uid: string;
  objective: string;
  onObjectiveChange: (value: string) => void;
  successCriteria: string[];
  onCriteriaChange: (next: string[]) => void;
}) {
  const objectiveProblem = objective.length > 0 ? goalObjectiveProblem(objective) : null;
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-goal`}>
      <SectionHeading
        id={`${uid}-goal`}
        title="Goal"
        hint="A short objective plus success checks — not a system prompt. Free-text prompt authoring stays on the Agent Template."
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-goal-objective`}>Objective</Label>
        <Textarea
          id={`${uid}-goal-objective`}
          value={objective}
          onChange={(event) => onObjectiveChange(event.target.value)}
          maxLength={280}
          rows={2}
          placeholder="e.g. Summarize the visit into a SOAP note."
        />
        <p className="text-muted-foreground text-xs">{objective.length}/280</p>
        {objectiveProblem ? <p className="text-destructive text-sm">{objectiveProblem}</p> : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Success criteria</Label>
        {successCriteria.map((criterion, index) => {
          const problem = criterion.length > 0 ? goalSuccessCriterionProblem(criterion) : null;
          return (
            <div key={index} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Success criterion ${index + 1}`}
                  value={criterion}
                  maxLength={200}
                  onChange={(event) => {
                    const next = [...successCriteria];
                    next[index] = event.target.value;
                    onCriteriaChange(next);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Remove success criterion ${index + 1}`}
                  onClick={() => onCriteriaChange(successCriteria.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </div>
              {problem ? <p className="text-destructive text-sm">{problem}</p> : null}
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={successCriteria.length >= GOAL_MAX_SUCCESS_CRITERIA}
          onClick={() => onCriteriaChange([...successCriteria, ''])}
        >
          Add success criterion
        </Button>
      </div>
    </Card>
  );
}

/**
 * Tool allowlist — closed catalogue of exactly three named tools, each pinned
 * tri-state: Inherit (`enabled: null`, follow the platform/env
 * default) / On / Off. Mirrors the inherit/on/off `ToggleGroup` pattern of
 * `pipeline-policy/components/scope-row-editor.tsx`.
 */
function ToolAllowlistSection({
  uid,
  toolStates,
  onChange,
}: {
  uid: string;
  toolStates: Record<(typeof LIVE_TOOL_KEYS)[number], ToolTriState>;
  onChange: (key: (typeof LIVE_TOOL_KEYS)[number], tri: ToolTriState) => void;
}) {
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-tools`}>
      <SectionHeading id={`${uid}-tools`} title="Tool allowlist" hint="Which live-loop tools this agent may use — Inherit follows the platform/env default." />
      <ul className="flex flex-col gap-3">
        {LIVE_TOOL_KEYS.map((tool) => (
          <li key={tool} className="flex flex-col gap-1.5">
            <span className="text-sm font-normal">{LIVE_TOOL_LABELS[tool]}</span>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-label={LIVE_TOOL_LABELS[tool]}
              value={toolStates[tool]}
              onValueChange={(next) => {
                // Radix reports '' when the active item is re-clicked; a pin always has a state.
                if (next) onChange(tool, next as ToolTriState);
              }}
            >
              {TOOL_TRI_STATES.map((tri) => (
                <ToggleGroupItem key={tri} value={tri} className="font-mono text-xs">
                  {toolTriLabel(tri)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Guardrail profile — a closed catalogue selection, never an authored boundary. */
function GuardrailProfileSection({
  uid,
  value,
  onChange,
}: {
  uid: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-guardrail`}>
      <SectionHeading id={`${uid}-guardrail`} title="Guardrail profile" hint="Selects a named profile from a closed platform catalogue." />
      <Select value={value || NO_GUARDRAIL_PROFILE} onValueChange={(next) => onChange(next === NO_GUARDRAIL_PROFILE ? '' : next)}>
        <SelectTrigger id={`${uid}-guardrail-select`} className="w-full max-w-xs" aria-label="Guardrail profile">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_GUARDRAIL_PROFILE}>None — platform default</SelectItem>
          {GUARDRAIL_PROFILE_KEYS.map((profile) => (
            <SelectItem key={profile} value={profile}>
              {GUARDRAIL_PROFILE_LABELS[profile as GuardrailProfile]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Card>
  );
}

/** Always/never actions — the D11 compliance envelope, mutually exclusive by construction. */
function ActionEnvelopeSection({
  uid,
  alwaysActions,
  neverActions,
  onSetAlways,
  onSetNever,
}: {
  uid: string;
  alwaysActions: string[];
  neverActions: string[];
  onSetAlways: (action: string, checked: boolean) => void;
  onSetNever: (action: string, checked: boolean) => void;
}) {
  const overlap = actionOverlap(alwaysActions, neverActions);
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-envelope`}>
      <SectionHeading
        id={`${uid}-envelope`}
        title="Compliance envelope"
        hint="Always = runs unconditionally, outside the agent's discretion. Never = a hard exclusion it cannot reason its way into."
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-left text-xs">
              <th scope="col" className="pb-1 font-normal">
                Action
              </th>
              <th scope="col" className="pb-1 font-normal">
                Always
              </th>
              <th scope="col" className="pb-1 font-normal">
                Never
              </th>
            </tr>
          </thead>
          <tbody>
            {AGENT_ACTION_KEYS.map((action) => {
              const alwaysId = `${uid}-always-${action}`;
              const neverId = `${uid}-never-${action}`;
              return (
                <tr key={action}>
                  <td className="py-1 pr-2 font-mono text-xs">{AGENT_ACTION_LABELS[action]}</td>
                  <td className="py-1 pr-2">
                    <Checkbox id={alwaysId} aria-label={`Always: ${AGENT_ACTION_LABELS[action]}`} checked={alwaysActions.includes(action)} onCheckedChange={(next) => onSetAlways(action, next === true)} />
                  </td>
                  <td className="py-1">
                    <Checkbox id={neverId} aria-label={`Never: ${AGENT_ACTION_LABELS[action]}`} checked={neverActions.includes(action)} onCheckedChange={(next) => onSetNever(action, next === true)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {overlap.length > 0 ? <p className="text-destructive text-sm">Cannot be both always and never: {overlap.join(', ')}</p> : null}
    </Card>
  );
}

/**
 * Budgets — the `maxRegen`/`gateSlaSeconds`/`gateEscalationSeconds` subset of
 * `harnessOverrides`. Tenant-writable: they are the "4 pipeline-shape knobs"
 * `TENANT_TIER_HARNESS_OVERRIDE_KEYS` (`packages/applications/src/services/
 * departmentAgent/constants.ts`) already grants a tenant admin on an agent's
 * `harnessOverrides`, and the SAME keys are tenant-writable — not
 * `SUPER_ADMIN_ONLY_POLICY_KEYS` — on the `HarnessPolicy` resource itself
 * (`harness-policy.service.ts`). This tab used to lock them behind
 * `session.isElevated` on the `TENANT_LOCKED_POLICY_KEYS` precedent, which
 * locks a DIFFERENT key set (`safetyEnabled`/`phiEnabled`/`phiFailClosed`/
 * `safetyProvider`/`safetyModel`) — that was a UI guarantee the server never
 * enforced for these three keys. See the Decisions section.
 */
function BudgetsSection({ uid, values, onChange }: { uid: string; values: Record<string, string>; onChange: (key: string, value: string) => void }) {
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-budgets`}>
      <SectionHeading id={`${uid}-budgets`} title="Budgets" />
      <div className="grid gap-3 sm:grid-cols-3">
        {AGENT_BUDGET_FIELDS.map((field) => {
          const id = `${uid}-budget-${field.key}`;
          return (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label htmlFor={id} className="text-xs">
                {field.label}
              </Label>
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={0}
                value={values[field.key] ?? ''}
                onChange={(event) => onChange(field.key, event.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function LoopConfigTab({ agent, etag, onSaved, onReload }: { agent: DepartmentAgent; etag: string | null; onSaved: () => void; onReload: () => void }) {
  const uid = useId();
  const updateAgent = useUpdateDepartmentAgent();
  const schemaQuery = useResolvedContextSchema(agent.departmentId);
  const siblingsQuery = useDepartmentAgents({ departmentId: agent.departmentId, limit: 200 });

  const [role, setRole] = useState<DepartmentAgentRole>(agent.role ?? 'SPECIALIST');
  const [selectedKinds, setSelectedKinds] = useState<SelectedKind[]>(() => parseSubscribedKinds(agent.subscribedKinds));
  const [selectedOutputs, setSelectedOutputs] = useState<string[]>(() => parseWriteScope(agent.writeScope));
  const initialGoal = parseGoal(agent.goal);
  const [objective, setObjective] = useState(initialGoal.objective);
  const [successCriteria, setSuccessCriteria] = useState<string[]>(initialGoal.successCriteria);
  const [toolStates, setToolStates] = useState<Record<(typeof LIVE_TOOL_KEYS)[number], ToolTriState>>(() => parseToolConfig(agent.toolConfig));
  const [guardrailProfile, setGuardrailProfile] = useState(agent.guardrailProfile ?? '');
  const [alwaysActions, setAlwaysActions] = useState<string[]>(agent.alwaysActions ?? []);
  const [neverActions, setNeverActions] = useState<string[]>(agent.neverActions ?? []);
  const [budgets, setBudgets] = useState<Record<string, string>>(() => {
    const existing = (agent.harnessOverrides ?? {}) as Record<string, unknown>;
    const draft: Record<string, string> = {};
    for (const field of AGENT_BUDGET_FIELDS) {
      const value = existing[field.key];
      draft[field.key] = typeof value === 'number' ? String(value) : '';
    }
    return draft;
  });

  const [pendingReasons, setPendingReasons] = useState<string[] | null>(null);

  const occError =
    updateAgent.error instanceof GatewayError && (updateAgent.error.isVersionConflict || updateAgent.error.isMissingPrecondition) ? updateAgent.error : null;

  const schemaUnresolved = !schemaQuery.isPending && schemaQuery.data?.definition == null;
  const availableKinds = schemaQuery.data?.definition?.kinds ?? [];
  const availableOutputs = schemaQuery.data?.definition?.outputs ?? [];

  const existingPrimary = (siblingsQuery.data?.data ?? []).find((sibling) => sibling.id !== agent.id && sibling.role === 'PRIMARY') ?? null;

  function toggleKind(key: string, checked: boolean) {
    setSelectedKinds((prev) => (checked ? [...prev, { key }] : prev.filter((entry) => entry.key !== key)));
  }

  function changeKindFilter(key: string, field: string, value: string) {
    setSelectedKinds((prev) =>
      prev.map((entry) => {
        if (entry.key !== key) return entry;
        if (!field.trim() && !value.trim()) return { key };
        return { key, filter: { [field]: value } };
      }),
    );
  }

  function toggleOutput(key: string, checked: boolean) {
    setSelectedOutputs((prev) => (checked ? [...prev, key] : prev.filter((entry) => entry !== key)));
  }

  function setToolTri(tool: (typeof LIVE_TOOL_KEYS)[number], tri: ToolTriState) {
    setToolStates((prev) => ({ ...prev, [tool]: tri }));
  }

  function setAlways(action: string, checked: boolean) {
    setAlwaysActions((prev) => (checked ? [...new Set([...prev, action])] : prev.filter((entry) => entry !== action)));
    if (checked) setNeverActions((prev) => prev.filter((entry) => entry !== action));
  }

  function setNever(action: string, checked: boolean) {
    setNeverActions((prev) => (checked ? [...new Set([...prev, action])] : prev.filter((entry) => entry !== action)));
    if (checked) setAlwaysActions((prev) => prev.filter((entry) => entry !== action));
  }

  function buildPatch(): UpdateDepartmentAgentRequest {
    const patch: UpdateDepartmentAgentRequest = {
      role,
      subscribedKinds: buildSubscribedKindsPayload(selectedKinds),
      writeScope: buildWriteScopePayload(selectedOutputs),
      goal: buildGoalPayload(objective, successCriteria),
      guardrailProfile: guardrailProfile.trim() ? guardrailProfile : null,
      alwaysActions: alwaysActions.length > 0 ? alwaysActions : null,
      neverActions: neverActions.length > 0 ? neverActions : null,
      toolConfig: buildToolConfigPayload(toolStates),
    };
    const numericBudgets: { maxRegen?: number; gateSlaSeconds?: number; gateEscalationSeconds?: number } = {};
    for (const field of AGENT_BUDGET_FIELDS) {
      const raw = budgets[field.key];
      if (raw !== undefined && raw.trim() !== '') numericBudgets[field.key] = Number(raw);
    }
    patch.harnessOverrides = buildBudgetsHarnessOverridesPayload(agent.harnessOverrides, numericBudgets);
    return patch;
  }

  function save() {
    if (!etag) return;
    updateAgent.mutate(
      { id: agent.id, patch: buildPatch(), etag },
      {
        onSuccess: () => {
          toast.success('Loop configuration saved');
          onSaved();
        },
        onError: (error) => {
          if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
          toast.error(error instanceof GatewayError ? error.message : 'Could not save the loop configuration.');
        },
      },
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // C25: a clinical-check weakening is a speed bump with a
    // record, not a blocker. The record itself is the automatic
    // `DepartmentAgentVersion` snapshot the server writes on every
    // loop-config-affecting save — this dialog is the acknowledgement gate.
    const reasons = weakensClinicalCheck({
      currentGuardrailProfile: agent.guardrailProfile,
      nextGuardrailProfile: guardrailProfile.trim() ? guardrailProfile : null,
      currentNeverActions: agent.neverActions,
      nextNeverActions: neverActions.length > 0 ? neverActions : null,
    });
    if (reasons.length > 0) {
      setPendingReasons(reasons);
      return;
    }
    save();
  }

  if (schemaQuery.isPending || siblingsQuery.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-hidden>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (schemaQuery.error) {
    return <ErrorState error={schemaQuery.error} onRetry={() => void schemaQuery.refetch()} />;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {occError ? (
        <Card className="border-destructive gap-2 p-4">
          <p className="text-destructive text-sm">This agent changed after you loaded it.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => {
              onReload();
              updateAgent.reset();
            }}
          >
            Reload latest
          </Button>
        </Card>
      ) : null}

      <RoleSection uid={uid} role={role} onRoleChange={setRole} existingPrimary={existingPrimary} />
      <SubscribedKindsSection
        uid={uid}
        availableKinds={availableKinds}
        schemaUnresolved={schemaUnresolved}
        selected={selectedKinds}
        onToggle={toggleKind}
        onFilterChange={changeKindFilter}
      />
      <WriteScopeSection uid={uid} availableOutputs={availableOutputs} schemaUnresolved={schemaUnresolved} selected={selectedOutputs} onToggle={toggleOutput} />
      <GoalSection uid={uid} objective={objective} onObjectiveChange={setObjective} successCriteria={successCriteria} onCriteriaChange={setSuccessCriteria} />
      <ToolAllowlistSection uid={uid} toolStates={toolStates} onChange={setToolTri} />
      <GuardrailProfileSection uid={uid} value={guardrailProfile} onChange={setGuardrailProfile} />
      <ActionEnvelopeSection uid={uid} alwaysActions={alwaysActions} neverActions={neverActions} onSetAlways={setAlways} onSetNever={setNever} />
      <BudgetsSection uid={uid} values={budgets} onChange={(key, value) => setBudgets((prev) => ({ ...prev, [key]: value }))} />

      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button type="submit" disabled={!etag || updateAgent.isPending}>
          {updateAgent.isPending ? <Spinner /> : null}
          Save loop configuration
        </Button>
      </div>

      <ConfirmDialog
        open={pendingReasons !== null}
        onOpenChange={(open) => !open && setPendingReasons(null)}
        title="Weakening a clinical check"
        description={
          <span className="flex flex-col gap-2">
            <span>This change weakens a clinical check:</span>
            <ul className="list-disc pl-5">
              {(pendingReasons ?? []).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <span>The change is saved as a new, immutable agent config version regardless — this only records your acknowledgement.</span>
          </span>
        }
        confirmLabel="Save anyway"
        typeToConfirm={C25_CONFIRM_PHRASE}
        onConfirm={() => {
          setPendingReasons(null);
          save();
        }}
        isPending={updateAgent.isPending}
      />
    </form>
  );
}

export { NO_GUARDRAIL_PROFILE };

/** Small badge for the Agent Catalog list rows and the drawer header. */
export function AgentRoleBadge({ role }: { role: DepartmentAgentRole | undefined }) {
  if (role !== 'PRIMARY') return null;
  return <Badge variant="secondary">Primary</Badge>;
}
