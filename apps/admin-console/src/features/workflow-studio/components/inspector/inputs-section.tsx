'use client';

/**
 * `InputsSection` — TASK-1036 §8.4 item 5 / §10.1 "Inputs come from the prompt".
 *
 * Replaces the free-text `overrides.promptVariables` map (and the per-port upstream-node pickers)
 * with ONE row per declared input:
 *
 *  - the node's task inputs (NodeIO: a text agent's `message` / `context`, an ASR agent's
 *    `audio`, …) — bound in `config.inputs` (OD-29);
 *  - the variables of the agent's pinned prompt — bound in `overrides.promptVariables`, the map
 *    the runtime already renders (a picked field is stored as `{{path}}`).
 *
 * Each row: name, type, Required / Optional, the binding as a scope-coloured chip shown by label
 * (stored by id), Change (the four-group picker), "Use a fixed value", a template ("text with
 * fields"), an ordered coalesce (`firstOf`, "Add a fallback"), and Clear. An unbound required
 * input is red ("can't run without it") — the canvas raises the same problem; an unbound optional
 * one says it renders empty (OD-10). An input fed by a legacy data link is shown bound, "from a
 * link", until the author binds it explicitly.
 */
import { useState } from 'react';
import { Badge, Button, Input, cn } from '@arcaai/ui';
import { TemplateEditor, type VariablePath } from '@arcaai/ui/components/custom/template-editor';
import { IconPlus, IconX } from '@tabler/icons-react';
import type { AgentIOResolver, Binding, WorkflowSettings } from '@arcaai/workflow-contract';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';
import { inputRows, withPromptVariable, type InputRow, type PromptVariableInfo } from '../../lib/inputs-model';
import { pickerGroups, type PickerGroup } from '../../lib/picker-model';
import { ioTypeLabel } from '../../lib/composer-io';
import { BindingChip } from './binding-chip';
import { FieldPicker } from './field-picker';

export interface ComposerGraph {
  nodes: readonly GraphStoreNode[];
  edges: readonly GraphStoreEdge[];
  settings?: WorkflowSettings;
}

export interface InputsSectionProps {
  node: GraphStoreNode;
  graph: ComposerGraph;
  agents: AgentIOResolver;
  promptVariables: readonly PromptVariableInfo[];
  /** "the prompt “SOAP note” v4" — where the variable rows come from. */
  promptSource?: string;
  contextSchema?: unknown;
  contextSchemaName?: string | null;
  contextSchemaVersion?: number | null;
  samples?: Readonly<Record<string, unknown>>;
  onConfigChange: (config: Record<string, unknown>) => void;
  disabled?: boolean;
  /** Server findings for one input (`/inputs/<name>`, `/overrides/promptVariables/<name>`). */
  errorsFor?: (row: InputRow) => string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `config` with input `name` bound (or unbound) — `config.inputs` for task inputs, the prompt-variable map otherwise. */
export function withRowBinding(config: Record<string, unknown>, row: Pick<InputRow, 'origin' | 'name'>, binding: Binding | null): Record<string, unknown> {
  if (row.origin === 'prompt') return withPromptVariable(config, row.name, binding);
  const current = isRecord(config.inputs) ? config.inputs : {};
  const { [row.name]: _previous, ...others } = current;
  const inputs = binding === null ? others : { ...others, [row.name]: binding };
  const { inputs: _inputs, ...rest } = config;
  return Object.keys(inputs).length > 0 ? { ...rest, inputs } : rest;
}

/** The picker groups flattened into TemplateEditor options (labelled, grouped, ranked). */
export function groupsToVariablePaths(groups: readonly PickerGroup[]): VariablePath[] {
  return groups.flatMap((group) =>
    group.items.map((item) => ({
      path: item.raw,
      label: item.path,
      type: item.type,
      phiClass: item.phiClass,
      description: item.description,
      group: group.label,
      scope: group.key,
      ...(item.bestMatch ? { bestMatch: true } : {}),
      ...(item.convertNote ? { convertNote: item.convertNote } : {}),
      ...(item.disabledReason ? { disabledReason: item.disabledReason } : {}),
      ...(item.sample ? { sample: item.sample } : {}),
    })),
  );
}

function RowStatus({ row }: { row: InputRow }) {
  if (row.status === 'missing') return <p className="text-destructive text-sm">Required: this step can’t run without it.</p>;
  if (row.status === 'empty') return <p className="text-muted-foreground text-xs">Optional: renders empty when not set.</p>;
  if (row.implied) return <p className="text-muted-foreground text-xs">From a link on the canvas. Choose a field to set it explicitly.</p>;
  return null;
}

type InputRowItemProps = InputsSectionProps & { row: InputRow };

function InputRowItem({ row, node, graph, agents, onConfigChange, disabled, contextSchema, contextSchemaName, contextSchemaVersion, samples, errorsFor }: InputRowItemProps) {
  const [fixedMode, setFixedMode] = useState(false);
  const binding = row.binding;
  const isValue = binding !== null && 'value' in binding;
  const isTemplate = binding !== null && 'template' in binding;
  const isFirstOf = binding !== null && 'firstOf' in binding;
  const nameId = `${node.id}-input-${row.key}`;

  const groups = pickerGroups({
    nodes: graph.nodes,
    edges: graph.edges,
    settings: graph.settings,
    nodeId: node.id,
    agents,
    contextSchema: contextSchema,
    contextSchemaName: contextSchemaName,
    contextSchemaVersion: contextSchemaVersion,
    targetType: row.type,
    purpose: row.origin === 'prompt' ? 'template' : 'binding',
    samples: samples,
  });
  const phi = groups.some((group) => group.items.some((item) => binding !== null && 'from' in binding && item.raw === binding.from && item.phiClass === 'PHI'));
  const write = (next: Binding | null) => onConfigChange(withRowBinding(node.config, row, next));
  const errors = errorsFor?.(row) ?? [];

  return (
    <li
      aria-labelledby={nameId}
      data-status={row.status}
      className={cn(
        'flex flex-col gap-1.5 rounded-md border p-2',
        row.status === 'missing' || errors.length > 0 ? 'border-destructive/60 bg-destructive/5' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span id={nameId} className="font-mono text-sm font-medium">
          {row.name}
        </span>
        <Badge variant="outline" className="px-1 font-mono text-[10px]" title={ioTypeLabel(row.type)}>
          {row.type}
        </Badge>
        <Badge variant={row.required ? 'destructive' : 'secondary'} className="px-1 text-[10px]">
          {row.required ? 'Required' : 'Optional'}
        </Badge>
      </div>

      {binding !== null && !isValue && !isTemplate ? (
        <div className="flex flex-wrap items-center gap-1">
          <BindingChip binding={binding} nodes={graph.nodes} phi={phi} />
          {!row.implied ? (
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Clear ${row.name}`} title="Clear" disabled={disabled} onClick={() => write(null)}>
              <IconX aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}

      {isValue || (fixedMode && binding === null) ? (
        <div className="flex items-center gap-1">
          <Input
            aria-label={`Fixed value for ${row.name}`}
            value={isValue ? String((binding as { value: unknown }).value ?? '') : ''}
            disabled={disabled}
            onChange={(event) => write(event.target.value === '' ? null : { value: row.type === 'number' && /^-?\d+(\.\d+)?$/.test(event.target.value) ? Number(event.target.value) : event.target.value })}
            className="h-8"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Clear ${row.name}`}
            title="Clear"
            disabled={disabled}
            onClick={() => {
              setFixedMode(false);
              write(null);
            }}
          >
            <IconX aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      {isTemplate ? (
        <div className="flex flex-col gap-1">
          <TemplateEditor
            aria-label={`Text for ${row.name}`}
            value={(binding as { template: string }).template}
            onChange={(next) => write({ template: next })}
            paths={groupsToVariablePaths(pickerGroups({ nodes: graph.nodes, edges: graph.edges, settings: graph.settings, nodeId: node.id, agents, contextSchema: contextSchema, purpose: 'template', samples: samples }))}
            minLines={2}
            readOnly={disabled}
            placeholder="Type text, and {{ or / to insert a field"
          />
          <Button type="button" variant="link" size="sm" className="self-start px-0" aria-label={`Clear ${row.name}`} disabled={disabled} onClick={() => write(null)}>
            Remove text
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        <FieldPicker
          groups={groups}
          targetType={row.type}
          disabled={disabled}
          triggerVariant={binding === null ? 'outline' : 'ghost'}
          triggerLabel={
            binding === null ? (
              <>
                <IconPlus aria-hidden="true" />
                <span>
                  Choose a field<span className="sr-only"> for {row.name}</span>
                </span>
              </>
            ) : (
              <span>
                Change<span className="sr-only"> {row.name}</span>
              </span>
            )
          }
          onPick={(item) => write({ from: item.raw })}
          onFixedValue={() => {
            setFixedMode(true);
            if (binding !== null) write(null);
          }}
        />
        {binding !== null && 'from' in binding ? (
          <FieldPicker
            groups={groups}
            targetType={row.type}
            disabled={disabled}
            triggerVariant="ghost"
            triggerLabel={
              <span>
                Add a fallback<span className="sr-only"> for {row.name}</span>
              </span>
            }
            onPick={(item) => (item.raw === binding.from ? undefined : write({ firstOf: [binding.from, item.raw] }))}
          />
        ) : null}
        {isFirstOf && (binding as { firstOf: string[] }).firstOf.length < 8 ? (
          <FieldPicker
            groups={groups}
            targetType={row.type}
            disabled={disabled}
            triggerVariant="ghost"
            triggerLabel={
              <span>
                Add a fallback<span className="sr-only"> for {row.name}</span>
              </span>
            }
            onPick={(item) => {
              const paths = (binding as { firstOf: string[] }).firstOf;
              if (!paths.includes(item.raw)) write({ firstOf: [...paths, item.raw] });
            }}
          />
        ) : null}
        {row.type === 'text' && binding === null ? (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => write({ template: '' })}>
            Write text<span className="sr-only"> for {row.name}</span>
          </Button>
        ) : null}
      </div>

      <RowStatus row={row} />
      {errors.map((message) => (
        <p key={message} className="text-destructive text-sm">
          {message}
        </p>
      ))}
    </li>
  );
}

export function InputsSection(props: InputsSectionProps) {
  const { node, graph, agents, promptVariables, promptSource } = props;
  const rows = inputRows({ node, nodes: graph.nodes, edges: graph.edges, agents, promptVariables });
  if (rows.length === 0) return null;
  const missing = rows.filter((row) => row.status === 'missing').length;
  return (
    <section aria-labelledby={`${node.id}-inputs-heading`} className="flex flex-col gap-2" data-slot="inputs-section">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id={`${node.id}-inputs-heading`} className="text-sm font-medium">
          Inputs ({rows.length})
        </h3>
        {missing > 0 ? <span className="text-destructive text-xs">{missing} required not set</span> : null}
      </div>
      {promptSource && rows.some((row) => row.origin === 'prompt') ? (
        <p className="text-muted-foreground text-xs">Found in {promptSource}. Optional inputs render empty when not set.</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <InputRowItem key={row.key} row={row} {...props} />
        ))}
      </ul>
    </section>
  );
}
