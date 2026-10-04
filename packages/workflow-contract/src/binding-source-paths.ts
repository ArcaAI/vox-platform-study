/**
 * TASK-1036 §10.1 — the ONE picker source. Every place that takes data (an input binding, `{{`
 * in a prompt or template, a condition, an output field) offers the same four groups, always in
 * this order:
 *
 *  1. **Earlier steps** — ANCESTORS of the node only (a step that does not run before this one is
 *     never offered), in execution order, each declared output field by the step's LABEL
 *     (`Finalize note › data › case_note`), with the stored id path beside it
 *     (`nodes.n_finalize.outputs.data.case_note`). A structured output is opened one level.
 *  2. **Context** — the workflow's context schema (`schemaVariablePaths`, the same derivation the
 *     publish gate reads, so "what the editor suggests" and "what publish accepts" agree).
 *  3. **Consultation** — the platform read schema (`consultation-read-schema.ts`). Visible but
 *     disabled, with the reason, when the workflow is not consultation-bound.
 *  4. **Run & variables** — `vars.*` declared by `core.variable` steps, then `run.*`.
 *
 * Every item carries its type (the NodeIO vocabulary), its PHI class and a description. Given a
 * `targetType`, items are ranked match → convert → blocked within each group, the first match in
 * Earlier steps is the best match, a convertible item says how it converts, and a blocked one says
 * why — users learn the model instead of guessing (§10.1 "Type-aware ranking").
 *
 * Pure and total: an unknown node, a missing schema or an unknown agent yields fewer items, never
 * a throw.
 */
import { consultationReadPaths } from './consultation-read-schema';
import { RUN_SCOPE_FIELDS, edgeAncestors } from './bindings';
import { topologicalLevels } from './graph-algorithms';
import type { WorkflowGraph, WorkflowGraphNode } from './graph-model';
import { ioTypeOfJsonSchema, ioTypeOfVariableType, nodeIOFor, typeFits, type AgentIOResolver, type IoType, type PhiClass, type TypeFit } from './node-io';
import { schemaVariablePaths } from './schema-variable-paths';
import { effectiveSettings } from './workflow-settings';

export type BindingSourceGroupKey = 'steps' | 'context' | 'consultation' | 'run';

export interface BindingSourceItem {
  /** What the picker shows: `Label › field` for a step, the dotted path otherwise. */
  readonly path: string;
  /** What is stored: `nodes.<id>.outputs.<field>`, `context.…`, `consultation.…`, `vars.…`, `run.…`. */
  readonly raw: string;
  readonly type: IoType;
  readonly phiClass: PhiClass | null;
  readonly description: string;
  /** Present when a `targetType` was given. */
  readonly fit?: TypeFit;
  /** The first `match` in Earlier steps. */
  readonly bestMatch?: true;
  /** How a `convert` item converts. */
  readonly convertNote?: string;
  /** Why the item cannot be chosen. */
  readonly disabledReason?: string;
}

export interface BindingSourceGroup {
  readonly key: BindingSourceGroupKey;
  readonly label: string;
  readonly items: readonly BindingSourceItem[];
  /** Why the group is empty, when it is. */
  readonly emptyReason?: string;
}

export interface BindingSourceOptions {
  /** The workflow's context schema: a `ConsultationContextSchemaVersion.definition`, or an inline payload schema. */
  readonly contextSchema?: unknown;
  /** Agent tasks and output schemas by slug, so an agent step offers its exact outputs. */
  readonly agentOutputs?: AgentIOResolver;
  /** The type of the input being bound; enables ranking. */
  readonly targetType?: IoType;
}

const GROUP_LABELS: Readonly<Record<BindingSourceGroupKey, string>> = Object.freeze({
  steps: 'Earlier steps',
  context: 'Context',
  consultation: 'Consultation',
  run: 'Run & variables',
});

const FIT_ORDER: Readonly<Record<TypeFit, number>> = Object.freeze({ match: 0, convert: 1, blocked: 2 });

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function labelOf(node: WorkflowGraphNode): string {
  const label = asObject(node.config)?.label;
  return typeof label === 'string' && label.length > 0 ? label : node.id;
}

/** Ancestors in execution order: topological level, then id. */
function orderedAncestors(graph: WorkflowGraph, nodeId: string): WorkflowGraphNode[] {
  const ancestors = edgeAncestors(graph, nodeId);
  const nodes = (graph.nodes ?? []).filter((node) => ancestors.has(node.id) && node.type !== 'core.note');
  const levels = topologicalLevels(graph);
  const rank = new Map<string, number>();
  if ('levels' in levels) levels.levels.forEach((level, index) => level.forEach((id) => rank.set(id, index)));
  return nodes.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function stepItems(graph: WorkflowGraph, nodeId: string, agents: AgentIOResolver | undefined): BindingSourceItem[] {
  const items: BindingSourceItem[] = [];
  for (const node of orderedAncestors(graph, nodeId)) {
    const io = nodeIOFor(node, agents);
    const label = labelOf(node);
    for (const [field, output] of Object.entries(io?.outputs ?? {})) {
      const raw = `nodes.${node.id}.outputs.${field}`;
      items.push({ path: `${label} › ${field}`, raw, type: output.type, phiClass: output.phiClass ?? null, description: output.description });
      const properties = asObject(output.schema?.properties);
      for (const [key, schema] of Object.entries(properties ?? {})) {
        const description = asObject(schema)?.description;
        items.push({
          path: `${label} › ${field} › ${key}`,
          raw: `${raw}.${key}`,
          type: ioTypeOfJsonSchema(schema),
          phiClass: output.phiClass ?? null,
          description: typeof description === 'string' ? description : '',
        });
      }
    }
  }
  return items;
}

function contextItems(contextSchema: unknown): BindingSourceItem[] {
  return schemaVariablePaths(contextSchema, 'context').map((entry) => ({
    path: entry.path,
    raw: entry.path,
    type: ioTypeOfVariableType(entry.type),
    phiClass: entry.phiClass === 'PHI' || entry.phiClass === 'NON_PHI' ? entry.phiClass : null,
    description: entry.description ?? '',
  }));
}

function consultationItems(available: boolean): BindingSourceItem[] {
  return consultationReadPaths().map((entry) => ({
    path: entry.path,
    raw: entry.path,
    type: entry.type,
    phiClass: entry.phiClass,
    description: entry.description,
    ...(available ? {} : { fit: 'blocked' as const, disabledReason: 'This workflow is not started by a consultation.' }),
  }));
}

function runItems(graph: WorkflowGraph): BindingSourceItem[] {
  const items: BindingSourceItem[] = [];
  for (const node of graph.nodes ?? []) {
    if (node?.type !== 'core.variable') continue;
    const declared = asObject(node.config)?.variables;
    for (const entry of Array.isArray(declared) ? declared : []) {
      const variable = asObject(entry);
      if (typeof variable?.key !== 'string') continue;
      items.push({
        path: `vars.${variable.key}`,
        raw: `vars.${variable.key}`,
        type: variable.schema === undefined ? 'any' : ioTypeOfJsonSchema(variable.schema),
        phiClass: null,
        description: `A run variable declared by ${labelOf(node)}.`,
      });
    }
  }
  for (const [name, field] of Object.entries(RUN_SCOPE_FIELDS)) {
    items.push({ path: `run.${name}`, raw: `run.${name}`, type: field.type, phiClass: 'NON_PHI', description: field.description });
  }
  return items;
}

/** Stamp each item's fit for `target` and rank the group; an item already blocked keeps its reason. */
function ranked(items: readonly BindingSourceItem[], target: IoType | undefined, markBest: boolean): BindingSourceItem[] {
  if (target === undefined) return [...items];
  const fitted = items.map((item) => {
    if (item.disabledReason !== undefined) return item;
    const fit = typeFits(target, item.type);
    if (fit === 'convert') return { ...item, fit, convertNote: `Formatted as ${target}` };
    if (fit === 'blocked') return { ...item, fit, disabledReason: `Can't use ${item.type} here` };
    return { ...item, fit };
  });
  const sorted = fitted
    .map((item, index) => ({ item, index }))
    .sort((a, b) => FIT_ORDER[a.item.fit ?? 'blocked'] - FIT_ORDER[b.item.fit ?? 'blocked'] || a.index - b.index)
    .map((entry) => entry.item);
  if (markBest && sorted[0]?.fit === 'match') sorted[0] = { ...sorted[0], bestMatch: true };
  return sorted;
}

function group(key: BindingSourceGroupKey, items: BindingSourceItem[], emptyReason: string): BindingSourceGroup {
  return items.length === 0 ? { key, label: GROUP_LABELS[key], items, emptyReason } : { key, label: GROUP_LABELS[key], items };
}

/** The four picker groups for one node of the graph (§10.1). */
export function bindingSourcePaths(graph: WorkflowGraph, nodeId: string, options: BindingSourceOptions = {}): BindingSourceGroup[] {
  const consultationBound = effectiveSettings(graph).sources.includes('consultation');
  return [
    group('steps', ranked(stepItems(graph, nodeId, options.agentOutputs), options.targetType, true), 'Nothing runs before this step yet.'),
    group('context', ranked(contextItems(options.contextSchema), options.targetType, false), 'No context schema is bound to this workflow.'),
    group('consultation', ranked(consultationItems(consultationBound), options.targetType, false), 'The consultation read schema declares no fields.'),
    group('run', ranked(runItems(graph), options.targetType, false), 'No run fields are available.'),
  ];
}
