'use client';

/**
 * `InspectorPanel` — the node config editor. Descriptors compiled by
 * `toFieldDescriptors` (Task 8, `lib/schema-form.ts`) render through the `Field` family
 * (`field-renderers.tsx`); a node type with NO delivered config schema — the REAL registry
 * state today, see `contracts/registry.contract.md` — falls back whole-panel to the raw
 * `CodeEditor`, never a bare `<Textarea>` (rule 11).
 *
 * Server `ValidationReport` problems for the selected node are matched to a field by
 * `WorkflowFinding.path` and rendered via `FieldError`, distinguished from any future
 * client-side fast-fail problems by their `ruleId` prefix (`WF-*`) — this panel never
 * re-validates client-side; `jsonSchemaValueProblems` is not called here (README pitfall 1 /
 * Task 8's own discipline: the compiler only decides how to RENDER, never whether a value is
 * valid).
 *
 * item 2 does the mirror-image swap for DD-2's DOCUMENT binding: where the schema
 * DOES declare `documentTemplateId`, its two generated fields (a free-text UUID box and a bare
 * number box) are withheld and one `DocumentBindingField` renders in their place — a picker over
 * the tenant's servable templates plus a version pin that reports its own staleness. It is keyed
 * on the schema DECLARING the binding rather than on a node-type allow-list, so the next
 * generation node someone registers gets the control for free; and it is never offered on the
 * no-schema fallback, because a node type with no schema (`passthrough`) has no document shape to
 * bind.
 *
 * Task 19 adds a standalone `PromptTemplatePicker` section (`config.promptTemplateId`) — shown
 * whenever the schema does NOT already declare a field at that path (the real registry state
 * today: no delivered node type has a config schema at all, so `promptTemplateId` is otherwise
 * unreachable except by hand-editing raw JSON). If a future schema DOES declare
 * `promptTemplateId` itself, the generic `field-renderers.tsx` string control already renders it
 * and this section steps aside rather than offering a second, duplicate control for the same key.
 */
import { CodeEditor, Empty, EmptyDescription, EmptyMedia, EmptyTitle, Field, FieldDescription, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@arcaai/ui';
import { IconLayoutBoard } from '@tabler/icons-react';
import { useState } from 'react';
import { usePromptTemplateQuickView } from '@/shared/prompt-picker';
import { toFieldDescriptors, type FieldDescriptor } from '../../lib/schema-form';
import { triggerVariablePaths } from '../../lib/trigger-variable-paths';
import { useAgentOptions, useContextSchemaVersions } from '../../api/hooks';
import type { WorkflowFinding } from '../../api/types';
import type { GraphStoreNode } from '../../store/types';
import { AgentPickerField, DEFAULT_AGENT_TASK } from './agent-picker-field';
import { ContextSchemaRefField } from './context-schema-ref-field';
import { DocumentBindingField } from './document-binding-field';
import { FieldRenderer, type FieldRenderContext } from './field-renderers';
import { getAtPath, setAtPath } from './field-path';
import { GuardrailField } from './guardrail-field';
import { PromptTemplatePicker } from './prompt-template-picker';
import { PromptVariablesField } from './prompt-variables-field';
import { NO_SCHEMA_REASON } from './raw-json-field';

const PROMPT_TEMPLATE_PATH = 'promptTemplateId';
/** TASK-864 B1 — `core.agent`'s reference, rendered as the agent picker instead of a slug box. */
const AGENT_REF_PATH = 'agentRef';
const AGENT_SLUG_PATH = 'agentRef.slug';
/** TASK-864 B1 — `core.action`'s delegate key and the delegate's own sub-config. */
const ACTION_KEY_PATH = 'actionKey';
const ACTION_CONFIG_PATH = 'action';
const DOCUMENT_TEMPLATE_PATH = 'documentTemplateId';
const DOCUMENT_VERSION_PATH = 'documentVersionNumber';
/** The two schema-declared keys `DocumentBindingField` renders as ONE control. */
const DOCUMENT_BINDING_PATHS = new Set<string>([DOCUMENT_TEMPLATE_PATH, DOCUMENT_VERSION_PATH]);
/** TASK-890 §3.4 — `core.trigger`'s reference-or-inline schema binding, rendered as one control. */
const CONTEXT_SCHEMA_PATH = 'contextSchema';
/** TASK-890 §3.14 — the guardrail opt-out object, top-level on BOTH `core.agent` and `core.trigger`. */
const GUARDRAIL_PATH = 'guardrail';
/** TASK-890 §3.10 — `core.agent`'s per-node prompt-variable overrides, nested under `overrides`. */
const PROMPT_VARIABLES_PATH = 'overrides.promptVariables';

export interface InspectorPanelProps {
  node: GraphStoreNode | null;
  /** The registry node-type's config JSON Schema, or `undefined` when none is known — an
   *  always-possible state against the real registry today, not an edge case. */
  configSchema: unknown | undefined;
  /** Server findings for THIS node only (already filtered by `nodeId` — see
   *  `store/selectors.ts#findingsByNodeId`). */
  problems: WorkflowFinding[];
  onConfigChange: (config: Record<string, unknown>) => void;
  loading?: boolean;
  readOnly?: boolean;
  /** TASK-864 B1 — run-context references the CEL editor offers (`trigger`, `vars.*`, `nodes.<id>`). */
  references?: readonly string[];
  /** TASK-864 B1 — for a `core.action` node: the catalogue actions on offer (deprecated types that map onto `core.action`). */
  actionOptions?: ReadonlyArray<{ key: string; label: string }>;
  /** TASK-864 B1 — for a `core.action` node: the chosen delegate's own config schema (rendered under `action`). */
  actionSchema?: unknown;
  /**
   * TASK-890 §3.14 — the workflow's own `core.trigger` guardrail decision
   * (`config.guardrail.enabled`), for `core.agent`'s effective-value display. `undefined`/`null`
   * when the graph has no opinion yet — the node then inherits the agent's own default.
   */
  workflowGuardrailEnabled?: boolean | null;
  /**
   * TASK-890 black-box J4-F5 — what the workflow's `core.trigger` binds, so a `core.agent`'s
   * prompt-variable chips can offer this workflow's REAL `{{trigger.<kindKey>.<field>}}` paths
   * instead of a bare root. Absent/unbound ⇒ the field shows the kind-key hint instead.
   */
  triggerContextBinding?: { schemaId: string | null; versionNumber: number | null; inline: Record<string, unknown> | null };
}

function errorsForPath(problems: WorkflowFinding[], path: string): string[] {
  return problems.filter((problem) => (problem.path ?? '') === path).map((problem) => problem.message);
}

function flattenPaths(descriptors: FieldDescriptor[]): string[] {
  return descriptors.flatMap((descriptor) => {
    if (descriptor.kind === 'group') return [descriptor.path, ...flattenPaths(descriptor.fields)];
    if (descriptor.kind === 'discriminated') return [descriptor.path, ...descriptor.branches.flatMap((branch) => flattenPaths(branch.fields))];
    return [descriptor.path];
  });
}

function promptTemplateValue(config: Record<string, unknown>): string {
  const value = config[PROMPT_TEMPLATE_PATH];
  return typeof value === 'string' ? value : '';
}

function PromptTemplateSection({
  node,
  onConfigChange,
  problems,
  readOnly,
}: {
  node: GraphStoreNode;
  onConfigChange: (config: Record<string, unknown>) => void;
  problems: WorkflowFinding[];
  readOnly?: boolean;
}) {
  return (
    <PromptTemplatePicker
      id={`${node.id}-${PROMPT_TEMPLATE_PATH}`}
      value={promptTemplateValue(node.config)}
      onChange={(next) => {
        const { [PROMPT_TEMPLATE_PATH]: _omit, ...rest } = node.config;
        onConfigChange(next ? { ...rest, [PROMPT_TEMPLATE_PATH]: next } : rest);
      }}
      disabled={readOnly}
      errors={errorsForPath(problems, PROMPT_TEMPLATE_PATH)}
    />
  );
}

function WholeConfigJsonEditor({ node, onConfigChange }: { node: GraphStoreNode; onConfigChange: (config: Record<string, unknown>) => void }) {
  const [text, setText] = useState(() => JSON.stringify(node.config, null, 2));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">{NO_SCHEMA_REASON}</p>
      <CodeEditor
        aria-label={`${node.type} configuration (JSON)`}
        value={text}
        onChange={(next) => {
          setText(next);
          try {
            onConfigChange(JSON.parse(next));
          } catch {
            // Invalid JSON mid-edit — CodeEditor's own toolbar surfaces the parse error.
          }
        }}
      />
    </div>
  );
}

function ActionKeySection({
  node,
  options,
  onConfigChange,
  errors,
}: {
  node: GraphStoreNode;
  options: ReadonlyArray<{ key: string; label: string }>;
  onConfigChange: (config: Record<string, unknown>) => void;
  errors: string[];
}) {
  const id = `${node.id}-${ACTION_KEY_PATH}`;
  const value = getAtPath(node.config, ACTION_KEY_PATH);
  return (
    <Field data-invalid={errors.length > 0 ? 'true' : undefined}>
      <FieldLabel htmlFor={id}>Action *</FieldLabel>
      <FieldDescription>The platform action this node runs — its ports and sub-config follow the choice.</FieldDescription>
      <Select
        value={typeof value === 'string' ? value : ''}
        onValueChange={(next) => {
          // A new delegate has a new sub-config shape: reset `action` rather than carry stale keys.
          const { [ACTION_CONFIG_PATH]: _omit, ...rest } = node.config;
          onConfigChange(setAtPath(rest, ACTION_KEY_PATH, next));
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose an action" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {option.label} <span className="text-muted-foreground font-mono text-xs">{option.key}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {errors.length > 0 ? (
        <p role="alert" className="text-destructive text-sm">
          {errors.join(' ')}
        </p>
      ) : null}
    </Field>
  );
}

export function InspectorPanel({
  node,
  configSchema,
  problems,
  onConfigChange,
  loading,
  readOnly,
  references,
  actionOptions,
  actionSchema,
  workflowGuardrailEnabled,
  triggerContextBinding,
}: InspectorPanelProps) {
  // Hooks run unconditionally, ahead of every early return (rules of hooks) — `enabled` gates
  // the actual network read to `core.agent` nodes only. `useAgentOptions` is the SAME query
  // `AgentPickerField` already runs for this task, so this is a cache hit, not a second fetch.
  const isCoreAgentNode = node?.type === 'core.agent';
  const agentSlugValue = node && typeof getAtPath(node.config, AGENT_SLUG_PATH) === 'string' ? (getAtPath(node.config, AGENT_SLUG_PATH) as string) : '';
  const agentOptions = useAgentOptions(DEFAULT_AGENT_TASK, isCoreAgentNode);
  // TASK-890 J4-F5 — the version rows carry the definition itself, so the trigger's kind paths
  // come from the SAME read `ContextSchemaRefField` already performs (a cache hit, not a second
  // fetch). Disabled for every node type but `core.agent`, which is the only consumer.
  const referencedAgentForNode = isCoreAgentNode
    ? (agentOptions.data ?? []).find((agent) => agent.slug === (typeof getAtPath(node?.config ?? {}, AGENT_SLUG_PATH) === 'string' ? getAtPath(node?.config ?? {}, AGENT_SLUG_PATH) : ''))
    : undefined;
  const contextSchemaVersions = useContextSchemaVersions(isCoreAgentNode ? (triggerContextBinding?.schemaId ?? null) : null);
  // TASK-890 J4-F6 — the agent's bound template, read only when the agent declares no variables
  // of its own. `usePromptTemplateQuickView` is the shared picker's own cached read.
  const agentDeclaresVariables = Object.keys(referencedAgentForNode?.instruction?.variables ?? {}).length > 0;
  const boundTemplate = usePromptTemplateQuickView(
    isCoreAgentNode && !agentDeclaresVariables ? (referencedAgentForNode?.instruction?.promptTemplateId ?? null) : null,
  );

  if (!node) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <IconLayoutBoard aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No node selected</EmptyTitle>
        <EmptyDescription>Select a node on the canvas or in the list view to configure it.</EmptyDescription>
      </Empty>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-6 w-11" />
      </div>
    );
  }

  if (configSchema === undefined) {
    return (
      <div className="flex flex-col gap-4">
        <WholeConfigJsonEditor node={node} onConfigChange={onConfigChange} />
        <PromptTemplateSection node={node} onConfigChange={onConfigChange} problems={problems} readOnly={readOnly} />
      </div>
    );
  }

  const allDescriptors = toFieldDescriptors(configSchema);
  // The document binding's own two descriptors are withheld from the generic renderer, not
  // dropped: `DocumentBindingField` renders both keys, and their paths stay in `knownPaths` so a
  // server finding at either one is still routed to a field rather than to the graph-level list.
  // TASK-864 B1 does the same for `core.agent`'s `agentRef` (the picker) and `core.action`'s
  // `actionKey` + `action` (a select over the catalogue, then the DELEGATE's schema).
  const isCoreAgent = node.type === 'core.agent';
  const isCoreAction = node.type === 'core.action' && actionOptions !== undefined;
  const isCoreTrigger = node.type === 'core.trigger';
  const withheld = new Set<string>([
    ...DOCUMENT_BINDING_PATHS,
    ...(isCoreAgent ? [AGENT_REF_PATH, GUARDRAIL_PATH] : []),
    ...(isCoreAction ? [ACTION_KEY_PATH, ACTION_CONFIG_PATH] : []),
    ...(isCoreTrigger ? [CONTEXT_SCHEMA_PATH, GUARDRAIL_PATH] : []),
  ]);
  const descriptors = allDescriptors.filter((descriptor) => !withheld.has(descriptor.path));
  const hasDocumentBinding = allDescriptors.some((descriptor) => DOCUMENT_BINDING_PATHS.has(descriptor.path));
  // The delegate's schema, hoisted under `action.` so every generated path lands in the sub-config.
  const actionDescriptors = isCoreAction && actionSchema !== undefined ? toFieldDescriptors({ type: 'object', properties: { [ACTION_CONFIG_PATH]: actionSchema } }) : [];
  const knownPaths = new Set([...flattenPaths(allDescriptors), ...flattenPaths(actionDescriptors), AGENT_SLUG_PATH]);
  const graphLevelErrors = problems.filter((problem) => !knownPaths.has(problem.path ?? ''));

  // TASK-890 §3.6/§3.10 — the referenced agent's own declared prompt-variable names and
  // guardrail default, resolved from the SAME `useAgentOptions` read `AgentPickerField` uses
  // (no second route, §2.7 #6: `GET admin/agents` already returns the full `AgentResponse`).
  const referencedAgent = isCoreAgent ? (agentOptions.data ?? []).find((agent) => agent.slug === agentSlugValue) : undefined;
  const declaredVariableNames = referencedAgent?.instruction?.variables ? Object.keys(referencedAgent.instruction.variables) : [];
  const agentGuardrailEnabled = referencedAgent?.parameters?.guards?.enabled ?? null;
  // TASK-890 J4-F6 — the fallback list, used by the field ONLY when the agent declares none.
  const templateVariableNames = (boundTemplate.data?.declaredVariables ?? []).map((declaration) => declaration.name);
  // TASK-890 J4-F5 — the pinned version when the trigger pins one, else the schema's own latest
  // (the version list is newest-first); an inline schema is read directly.
  const boundVersion =
    triggerContextBinding?.versionNumber != null
      ? (contextSchemaVersions.data ?? []).find((row) => row.versionNumber === triggerContextBinding.versionNumber)
      : (contextSchemaVersions.data ?? [])[0];
  const triggerPaths = triggerVariablePaths({ definition: boundVersion?.definition, inline: triggerContextBinding?.inline });

  // TASK-890 §3.10 — `overrides.promptVariables` is nested inside `overrides`, so the top-level
  // `withheld` Set cannot reach it; `fieldOverrides` intercepts it wherever `FieldRenderer`
  // recurses into the `overrides` group.
  const fieldOverrides = isCoreAgent
    ? {
        [PROMPT_VARIABLES_PATH]: ({ errors: fieldErrors }: FieldRenderContext) => (
          <PromptVariablesField
            idPrefix={node.id}
            config={node.config}
            onConfigChange={onConfigChange}
            declaredVariableNames={declaredVariableNames}
            templateVariableNames={templateVariableNames}
            triggerPaths={triggerPaths}
            references={references}
            errors={fieldErrors}
            disabled={readOnly}
          />
        ),
      }
    : undefined;

  return (
    <fieldset disabled={readOnly} className="flex flex-col gap-4">
      {isCoreAgent ? (
        <AgentPickerField
          id={`${node.id}-${AGENT_SLUG_PATH}`}
          value={typeof getAtPath(node.config, AGENT_SLUG_PATH) === 'string' ? (getAtPath(node.config, AGENT_SLUG_PATH) as string) : ''}
          onChange={(slug) => onConfigChange(setAtPath(node.config, AGENT_SLUG_PATH, slug))}
          errors={[...errorsForPath(problems, AGENT_SLUG_PATH), ...errorsForPath(problems, AGENT_REF_PATH)]}
          disabled={readOnly}
        />
      ) : null}
      {isCoreTrigger ? (
        <ContextSchemaRefField
          idPrefix={node.id}
          config={node.config}
          onConfigChange={onConfigChange}
          errors={errorsForPath(problems, CONTEXT_SCHEMA_PATH)}
          disabled={readOnly}
        />
      ) : null}
      {isCoreAgent || isCoreTrigger ? (
        <GuardrailField
          idPrefix={node.id}
          scope={isCoreAgent ? 'node' : 'workflow'}
          config={node.config}
          onConfigChange={onConfigChange}
          workflowGuardrailEnabled={isCoreAgent ? workflowGuardrailEnabled : undefined}
          agentGuardrailEnabled={isCoreAgent ? agentGuardrailEnabled : undefined}
          errors={[...errorsForPath(problems, GUARDRAIL_PATH), ...errorsForPath(problems, `${GUARDRAIL_PATH}.enabled`)]}
          disabled={readOnly}
        />
      ) : null}
      {isCoreAction ? <ActionKeySection node={node} options={actionOptions} onConfigChange={onConfigChange} errors={errorsForPath(problems, ACTION_KEY_PATH)} /> : null}
      {actionDescriptors.map((descriptor) => (
        <FieldRenderer
          key={descriptor.path}
          descriptor={descriptor}
          config={node.config}
          onConfigChange={onConfigChange}
          errors={errorsForPath(problems, descriptor.path)}
          idPrefix={node.id}
          references={references}
        />
      ))}
      {descriptors.map((descriptor) => (
        <FieldRenderer
          key={descriptor.path}
          descriptor={descriptor}
          config={node.config}
          onConfigChange={onConfigChange}
          errors={errorsForPath(problems, descriptor.path)}
          idPrefix={node.id}
          references={references}
          fieldOverrides={fieldOverrides}
        />
      ))}
      {hasDocumentBinding ? (
        <DocumentBindingField
          idPrefix={node.id}
          config={node.config}
          onConfigChange={onConfigChange}
          templateErrors={errorsForPath(problems, DOCUMENT_TEMPLATE_PATH)}
          versionErrors={errorsForPath(problems, DOCUMENT_VERSION_PATH)}
        />
      ) : null}
      {!knownPaths.has(PROMPT_TEMPLATE_PATH) ? (
        <PromptTemplateSection node={node} onConfigChange={onConfigChange} problems={problems} readOnly={readOnly} />
      ) : null}
      {graphLevelErrors.length > 0 ? (
        <div role="alert" className="text-destructive text-sm">
          {graphLevelErrors.map((problem) => (
            <p key={`${problem.ruleId}-${problem.message}`}>{problem.message}</p>
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}
