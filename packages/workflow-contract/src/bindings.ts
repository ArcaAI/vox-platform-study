/**
 * TASK-1036 §9.2 (OD-29, OD-18, D-C/D-D/D-E/D-G) — DATA MOVES BY BINDINGS.
 *
 * ## The model
 *
 * Every declared input of a node (`node-io.ts`) has at most one BINDING, authored on the node as
 * `config.inputs[<name>]`:
 *
 * | Binding | Example |
 * |---|---|
 * | `{ from: <path> }` | `nodes.transcribe.outputs.transcript`, `context.patient.age`, `consultation.notes.preSummary` |
 * | `{ value: <literal> }` | `{ value: "en" }` |
 * | `{ template: <text> }` | `"Summarise: {{nodes.transcribe.outputs.transcript}}"` |
 *
 * A path starts at one of five roots: `context.*` (the run input, typed by the context schema),
 * `consultation.*` (the platform read schema, `consultation-read-schema.ts`), `nodes.<id>.outputs.*`
 * (an EARLIER step's declared output), `vars.*` (a `core.variable` key) and `run.*` (run identity).
 * A `consultation.*` binding may say `at: 'runStart'`; it is read at node start otherwise (OD-30).
 *
 * Edges carry ORDER, and the console auto-maps on connect (OD-29). A binding the author wrote
 * SUPERSEDES whatever a data edge into the same input would have carried — the edge is then
 * ordering only.
 *
 * ## Legacy graphs translate, with the same data flow
 *
 * A graph saved before this model has no `inputs`; its data edges ARE its bindings.
 * `edgeImpliedBindings` translates each data edge into `nodes.<from>.outputs.<outputKey>` — the
 * exact runtime key the interpreter threads today (`_resolve_bound_inputs`) — under the target's
 * NodeIO input name. Fan-in (several producers into one input, D-E) is today LAST-WRITE-WINS in
 * `(toPort, fromNodeId)` order; the translation states the same rule explicitly as a COMPILED-only
 * `{ firstOf: [...] }` (first path that produced a value, latest producer first), and publish flags
 * it (`INPUT_MULTIPLE_PRODUCERS`: a WARNING on a legacy node, an ERROR once the node declares
 * inputs — OD-18 refuses fan-in into a single-value input; a Merge step combines values).
 *
 * ## Publish rules (`bindingIssues`)
 *
 * The NEW checks run on nodes that declare `inputs` — a legacy node is translated, never refused,
 * so every graph that published before keeps publishing. Two checks are graph-wide: the
 * consultation scope, and the `nodes.*` references in prompt-variable templates (no longer a
 * wildcard, D-G).
 *
 * | Code | Severity | When |
 * |---|---|---|
 * | `BINDING_UNKNOWN_PATH` | ERROR | the path names no root, step, output field, variable or schema field |
 * | `BINDING_NOT_ANCESTOR` | ERROR | a `nodes.<id>` step does not run before this one |
 * | `BINDING_TYPE_MISMATCH` | ERROR | `typeFits` says `blocked` |
 * | `BINDING_TYPE_CONVERTED` | INFO | `typeFits` says `convert` (never a `WorkflowFinding`) |
 * | `BINDING_UNKNOWN_INPUT` | ERROR | the node declares no such input |
 * | `REQUIRED_INPUT_UNBOUND` | ERROR | a required input has neither a binding nor a data edge |
 * | `INPUT_MULTIPLE_PRODUCERS` | ERROR / WARNING | several data edges feed one unbound input |
 * | `CONSULTATION_SCOPE_UNAVAILABLE` | ERROR | a node reads `consultation.*` and `sources` lacks `consultation` |
 *
 * Mirrored in Python (lane B1) against `tests/contracts/bindings.fixture.json`.
 */
import { CONSULTATION_ROOT, consultationPathInfo, nodeConsultationReads, type ConsultationReadAt } from './consultation-read-schema';
import { resolveInputPort, resolveOutputPort } from './core-contract';
import type { WorkflowGraph, WorkflowGraphNode } from './graph-model';
import { BINDING_JSON_SCHEMA } from './node-config-schemas';
import { agentTaskOf, ioTypeOfJsonSchema, nodeIOFor, typeFits, type AgentIOResolver, type IoType, type NodeIO, type PhiClass } from './node-io';
import { templateReferences } from './template';
import { effectiveSettings, type WorkflowSource } from './workflow-settings';

export { BINDING_JSON_SCHEMA };

// =============================================================================================
// Shape
// =============================================================================================

export const BINDING_ROOTS = Object.freeze(['context', 'consultation', 'nodes', 'vars', 'run'] as const);
export type BindingRoot = (typeof BINDING_ROOTS)[number];

export type FromBinding = { readonly from: string; readonly at?: ConsultationReadAt };
export type ValueBinding = { readonly value: unknown };
export type TemplateBinding = { readonly template: string };
export type Binding = FromBinding | ValueBinding | TemplateBinding;

/**
 * COMPILED-ONLY: the first of these paths that produced a value. Emitted only by the legacy
 * translation of a fan-in, never authored (`BINDING_JSON_SCHEMA` refuses it on a node).
 */
export type FirstOfBinding = { readonly firstOf: readonly string[] };
export type CompiledBinding = Binding | FirstOfBinding;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Whether `value` is an authored binding — exactly one of the three closed shapes. */
export function isBinding(value: unknown): value is Binding {
  const object = asObject(value);
  if (object === undefined) return false;
  const keys = Object.keys(object);
  if (keys.length === 1 && keys[0] === 'value') return true;
  if (keys.length === 1 && keys[0] === 'template') return typeof object.template === 'string';
  if (keys.includes('from')) {
    if (typeof object.from !== 'string' || object.from.length === 0) return false;
    if (!keys.every((key) => key === 'from' || key === 'at')) return false;
    return object.at === undefined || object.at === 'nodeStart' || object.at === 'runStart';
  }
  return false;
}

/** The run-identity fields `run.*` offers. Fixed by the platform; never PHI. */
export const RUN_SCOPE_FIELDS: Readonly<Record<string, { readonly type: IoType; readonly description: string }>> = Object.freeze({
  id: Object.freeze({ type: 'text', description: 'This run`s id.' }),
  tenantId: Object.freeze({ type: 'text', description: 'The tenant the run belongs to.' }),
  workflowSlug: Object.freeze({ type: 'text', description: 'The workflow`s slug.' }),
  workflowVersion: Object.freeze({ type: 'number', description: 'The published version number running.' }),
  startedAt: Object.freeze({ type: 'date', description: 'When the run started.' }),
  now: Object.freeze({ type: 'date', description: 'The time this step started.' }),
});

// =============================================================================================
// Graph helpers
// =============================================================================================

function liveNodes(graph: Pick<WorkflowGraph, 'nodes'>): WorkflowGraphNode[] {
  return (graph.nodes ?? []).filter(
    (node): node is WorkflowGraphNode => typeof node?.id === 'string' && typeof node?.type === 'string' && node.type !== 'core.note',
  );
}

/**
 * Every node with an edge path INTO `nodeId` — any edge, ordering and branch edges included —
 * excluding the node itself. "Runs before this one", which is what a binding may read.
 */
export function edgeAncestors(graph: Pick<WorkflowGraph, 'edges'>, nodeId: string): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const edge of graph.edges ?? []) {
    if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string') continue;
    const list = reverse.get(edge.to) ?? [];
    list.push(edge.from);
    reverse.set(edge.to, list);
  }
  const seen = new Set<string>();
  const queue = [...(reverse.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id) || id === nodeId) continue;
    seen.add(id);
    queue.push(...(reverse.get(id) ?? []));
  }
  return seen;
}

/**
 * The NodeIO input a LEGACY port of `node` feeds. Non-agent nodes name their inputs after their
 * ports; an agent's `in` is its task's primary text input (`message` for text generation, `text`
 * for speech and entity recognition). An unknown task translates `in` to `message` — the default
 * task — so a caller that compiles bindings must resolve agent tasks (`AgentIOResolver`).
 */
export function legacyInputName(node: Pick<WorkflowGraphNode, 'type' | 'config'>, toPort: string, agents?: AgentIOResolver): string {
  if (node.type !== 'core.agent' || toPort !== 'in') return toPort;
  const task = agentTaskOf(asObject(node.config), agents);
  return task === 'TEXT_TO_SPEECH' || task === 'NAMED_ENTITY_RECOGNITION' ? 'text' : 'message';
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface EdgeProducer {
  readonly path: string;
  readonly toPort: string;
  readonly fromNodeId: string;
  readonly edgeId: string;
}

/** Every data edge into `nodeId`, as the producer path it carries, grouped by NodeIO input name. */
function edgeProducers(graph: WorkflowGraph, node: WorkflowGraphNode, agents?: AgentIOResolver): Map<string, EdgeProducer[]> {
  const nodesById = new Map(liveNodes(graph).map((candidate) => [candidate.id, candidate]));
  const groups = new Map<string, EdgeProducer[]>();
  for (const edge of graph.edges ?? []) {
    if (edge?.to !== node.id) continue;
    const from = nodesById.get(edge.from);
    if (from === undefined) continue;
    const out = resolveOutputPort(from.type, asObject(from.config), edge.fromPort);
    if (out === undefined || out.primitive === 'control' || out.outputKey === undefined) continue;
    const into = resolveInputPort(node.type, asObject(node.config), edge.toPort);
    if (into === undefined || into.primitive === 'control') continue;
    const name = legacyInputName(node, edge.toPort, agents);
    const list = groups.get(name) ?? [];
    list.push({ path: `nodes.${edge.from}.outputs.${out.outputKey}`, toPort: edge.toPort, fromNodeId: edge.from, edgeId: edge.id });
    groups.set(name, list);
  }
  return groups;
}

/** Today's last-write-wins order, reversed: the producer that would have won comes first. */
function firstOfOrder(producers: readonly EdgeProducer[]): string[] {
  const sorted = producers.slice().sort((a, b) => (a.toPort === b.toPort ? byPath(a.fromNodeId, b.fromNodeId) : byPath(a.toPort, b.toPort)));
  const paths: string[] = [];
  for (const producer of sorted.reverse()) if (!paths.includes(producer.path)) paths.push(producer.path);
  return paths;
}

/** The bindings a node's DATA EDGES imply — the legacy translation, keyed by NodeIO input name. */
export function edgeImpliedBindings(graph: WorkflowGraph, nodeId: string, agents?: AgentIOResolver): Record<string, CompiledBinding> {
  const node = liveNodes(graph).find((candidate) => candidate.id === nodeId);
  if (node === undefined) return {};
  const out: Record<string, CompiledBinding> = {};
  for (const [name, producers] of edgeProducers(graph, node, agents)) {
    const paths = firstOfOrder(producers);
    out[name] = paths.length === 1 ? { from: paths[0] as string } : { firstOf: paths };
  }
  return out;
}

function authoredInputs(node: WorkflowGraphNode): Record<string, unknown> | undefined {
  return asObject(asObject(node.config)?.inputs);
}

/**
 * Every node's EFFECTIVE bindings: the edge-implied ones, overlaid by the authored `inputs` (an
 * authored binding supersedes the edge for that input). Nodes with nothing bound are absent.
 * Pure and total; invalid authored bindings are skipped (publish reports them).
 */
export function compiledBindings(graph: WorkflowGraph, agents?: AgentIOResolver): Record<string, Record<string, CompiledBinding>> {
  const out: Record<string, Record<string, CompiledBinding>> = {};
  for (const node of liveNodes(graph)) {
    const bindings: Record<string, CompiledBinding> = { ...edgeImpliedBindings(graph, node.id, agents) };
    for (const [name, binding] of Object.entries(authoredInputs(node) ?? {})) {
      if (isBinding(binding)) bindings[name] = binding;
    }
    if (Object.keys(bindings).length > 0) out[node.id] = bindings;
  }
  return out;
}

// =============================================================================================
// Path resolution
// =============================================================================================

export interface BindingIssueContext {
  /** Agent tasks and output schemas by slug. Without them an agent node is checked against the union of every task. */
  readonly agents?: AgentIOResolver;
  /** The trigger's derived payload schema. `undefined` / `null` = not known: `context.*` paths are admitted unchecked. */
  readonly contextPayloadSchema?: unknown;
  /** The effective `sources`; defaults to `effectiveSettings(graph).sources`. */
  readonly sources?: readonly WorkflowSource[];
}

export type BindingIssueCode =
  | 'BINDING_UNKNOWN_PATH'
  | 'BINDING_NOT_ANCESTOR'
  | 'BINDING_TYPE_MISMATCH'
  | 'BINDING_TYPE_CONVERTED'
  | 'BINDING_UNKNOWN_INPUT'
  | 'REQUIRED_INPUT_UNBOUND'
  | 'INPUT_MULTIPLE_PRODUCERS'
  | 'CONSULTATION_SCOPE_UNAVAILABLE';

export interface BindingIssue {
  readonly code: BindingIssueCode;
  readonly severity: 'ERROR' | 'WARNING' | 'INFO';
  readonly nodeId: string;
  /** The input concerned, when one is. */
  readonly input?: string;
  /** JSON pointer into the node's config. */
  readonly path: string;
  readonly message: string;
}

export interface ResolvedSource {
  readonly type: IoType;
  readonly phiClass: PhiClass | null;
}

type Resolution = { readonly ok: ResolvedSource } | { readonly code: 'BINDING_UNKNOWN_PATH' | 'BINDING_NOT_ANCESTOR'; readonly message: string };

/** Walks declared `properties`. `strict`: an undeclared field is unknown unless the object explicitly admits more. */
function walkSchema(schema: unknown, segments: readonly string[], strict: boolean): { schema: Record<string, unknown> } | 'unknown' | 'open' {
  let current = asObject(schema);
  for (const segment of segments) {
    if (current === undefined) return 'open';
    const properties = asObject(current.properties);
    if (properties !== undefined && Object.prototype.hasOwnProperty.call(properties, segment)) {
      current = asObject(properties[segment]);
      continue;
    }
    if (strict) return current.additionalProperties === true || asObject(current.additionalProperties) !== undefined ? 'open' : 'unknown';
    return properties !== undefined && current.additionalProperties === false ? 'unknown' : 'open';
  }
  return current === undefined ? 'open' : { schema: current };
}

interface ResolveScope {
  readonly graph: WorkflowGraph;
  readonly nodesById: ReadonlyMap<string, WorkflowGraphNode>;
  readonly ancestors: ReadonlySet<string>;
  readonly vars: ReadonlyMap<string, IoType>;
  readonly ctx: BindingIssueContext;
}

function label(node: WorkflowGraphNode): string {
  const named = asObject(node.config)?.label;
  return typeof named === 'string' && named.length > 0 ? `"${named}" (\`${node.id}\`)` : `\`${node.id}\``;
}

function resolveContextPath(segments: readonly string[], payloadSchema: unknown, path: string): Resolution {
  if (asObject(payloadSchema) === undefined) return { ok: { type: segments.length === 0 ? 'json' : 'any', phiClass: null } };
  let walked = walkSchema(payloadSchema, segments, false);
  // The sole-kind collapse: a definition whose only kind is `context` is read as that kind.
  const properties = asObject(asObject(payloadSchema)?.properties);
  if (walked === 'unknown' && properties !== undefined && Object.keys(properties).length === 1 && properties.context !== undefined) {
    walked = walkSchema(properties.context, segments, false);
  }
  if (walked === 'unknown') return { code: 'BINDING_UNKNOWN_PATH', message: `\`${path}\` is not declared by this workflow's context schema.` };
  return { ok: { type: walked === 'open' ? 'any' : ioTypeOfJsonSchema(walked.schema), phiClass: null } };
}

function resolveNodePath(segments: readonly string[], scope: ResolveScope, path: string): Resolution {
  const [nodeId, outputs, field, ...rest] = segments;
  const producer = nodeId === undefined ? undefined : scope.nodesById.get(nodeId);
  if (producer === undefined) return { code: 'BINDING_UNKNOWN_PATH', message: `\`${path}\`: there is no step \`${nodeId ?? ''}\` in this workflow.` };
  if (!scope.ancestors.has(producer.id)) {
    return {
      code: 'BINDING_NOT_ANCESTOR',
      message: `\`${path}\`: step ${label(producer)} does not run before this step, so its output is not available here. Connect it upstream first.`,
    };
  }
  if (outputs !== 'outputs' || field === undefined) {
    return {
      code: 'BINDING_UNKNOWN_PATH',
      message: `\`${path}\`: a step's data is read from its \`outputs\` — \`nodes.${producer.id}.outputs.<field>\`.`,
    };
  }
  const io = nodeIOFor(producer, scope.ctx.agents);
  const declared = io?.outputs[field];
  if (declared === undefined) {
    const offered = Object.keys(io?.outputs ?? {});
    return {
      code: 'BINDING_UNKNOWN_PATH',
      message: `\`${path}\`: step ${label(producer)} does not output \`${field}\` (it outputs ${offered.length > 0 ? offered.map((name) => `\`${name}\``).join(', ') : 'nothing'}).`,
    };
  }
  if (rest.length === 0) return { ok: { type: declared.type, phiClass: declared.phiClass ?? null } };
  if (declared.schema !== undefined) {
    const walked = walkSchema(declared.schema, rest, true);
    if (walked === 'unknown')
      return { code: 'BINDING_UNKNOWN_PATH', message: `\`${path}\`: \`${rest.join('.')}\` is not a field of ${label(producer)}'s \`${field}\`.` };
    return { ok: { type: walked === 'open' ? 'any' : ioTypeOfJsonSchema(walked.schema), phiClass: declared.phiClass ?? null } };
  }
  if (declared.type === 'json' || declared.type === 'any') return { ok: { type: 'any', phiClass: declared.phiClass ?? null } };
  return { code: 'BINDING_UNKNOWN_PATH', message: `\`${path}\`: \`${field}\` is ${declared.type}, which has no fields to read.` };
}

/** Resolve one binding/template path against the five roots, for the node whose ancestors are in `scope`. */
function resolvePath(path: string, scope: ResolveScope): Resolution {
  const [root, ...rest] = path.split('.');
  switch (root) {
    case 'context':
      return resolveContextPath(rest, scope.ctx.contextPayloadSchema, path);
    case CONSULTATION_ROOT: {
      const found = consultationPathInfo(path);
      if (found === undefined) return { code: 'BINDING_UNKNOWN_PATH', message: `\`${path}\` is not a field of the consultation read schema.` };
      return { ok: { type: found.type, phiClass: found.phiClass } };
    }
    case 'nodes':
      return resolveNodePath(rest, scope, path);
    case 'vars': {
      const key = rest[0];
      const type = key === undefined ? undefined : scope.vars.get(key);
      if (type === undefined) return { code: 'BINDING_UNKNOWN_PATH', message: `\`${path}\`: no \`core.variable\` step declares \`${key ?? ''}\`.` };
      return { ok: { type: rest.length > 1 ? 'any' : type, phiClass: null } };
    }
    case 'run': {
      const field = rest.length === 1 ? RUN_SCOPE_FIELDS[rest[0] as string] : undefined;
      if (field === undefined) {
        return {
          code: 'BINDING_UNKNOWN_PATH',
          message: `\`${path}\` is not a run field (${Object.keys(RUN_SCOPE_FIELDS)
            .map((name) => `\`run.${name}\``)
            .join(', ')}).`,
        };
      }
      return { ok: { type: field.type, phiClass: 'NON_PHI' } };
    }
    default:
      return {
        code: 'BINDING_UNKNOWN_PATH',
        message: `\`${path}\`: \`${root ?? ''}\` is not a binding root (${BINDING_ROOTS.map((name) => `\`${name}\``).join(', ')}).`,
      };
  }
}

function literalType(value: unknown): IoType {
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'list<json>';
  return 'json';
}

function declaredVars(nodes: readonly WorkflowGraphNode[]): Map<string, IoType> {
  const vars = new Map<string, IoType>();
  for (const node of nodes) {
    if (node.type !== 'core.variable') continue;
    const declared = asObject(node.config)?.variables;
    for (const entry of Array.isArray(declared) ? declared : []) {
      const variable = asObject(entry);
      if (typeof variable?.key !== 'string') continue;
      vars.set(variable.key, variable.schema === undefined ? 'any' : ioTypeOfJsonSchema(variable.schema));
    }
  }
  return vars;
}

// =============================================================================================
// The publish rules
// =============================================================================================

function scopeFor(
  graph: WorkflowGraph,
  nodeId: string,
  nodesById: ReadonlyMap<string, WorkflowGraphNode>,
  vars: ReadonlyMap<string, IoType>,
  ctx: BindingIssueContext,
): ResolveScope {
  return { graph, nodesById, ancestors: edgeAncestors(graph, nodeId), vars, ctx };
}

function checkType(
  issues: BindingIssue[],
  node: WorkflowGraphNode,
  input: string,
  pointer: string,
  target: IoType,
  source: IoType,
  what: string,
): void {
  const fit = typeFits(target, source);
  if (fit === 'match') return;
  if (fit === 'convert') {
    issues.push({
      code: 'BINDING_TYPE_CONVERTED',
      severity: 'INFO',
      nodeId: node.id,
      input,
      path: pointer,
      message: `\`${input}\` takes ${target}; ${what} is ${source} and will be formatted as ${target}.`,
    });
    return;
  }
  issues.push({
    code: 'BINDING_TYPE_MISMATCH',
    severity: 'ERROR',
    nodeId: node.id,
    input,
    path: pointer,
    message: `\`${input}\` takes ${target}, and ${what} is ${source}, which cannot be used here.`,
  });
}

function checkAuthoredNode(
  issues: BindingIssue[],
  graph: WorkflowGraph,
  node: WorkflowGraphNode,
  inputs: Record<string, unknown>,
  scope: ResolveScope,
  io: NodeIO | undefined,
): void {
  for (const [name, binding] of Object.entries(inputs)) {
    const pointer = `/inputs/${name}`;
    const declared = io?.inputs[name];
    if (io !== undefined && declared === undefined) {
      const offered = Object.keys(io.inputs);
      issues.push({
        code: 'BINDING_UNKNOWN_INPUT',
        severity: 'ERROR',
        nodeId: node.id,
        input: name,
        path: pointer,
        message: `step ${label(node)} has no input \`${name}\` (its inputs are ${offered.length > 0 ? offered.map((entry) => `\`${entry}\``).join(', ') : 'none'}).`,
      });
      continue;
    }
    if (!isBinding(binding)) continue; // the node-config schema reports a malformed binding
    const target = declared?.type ?? 'any';
    if ('from' in binding) {
      const resolved = resolvePath(binding.from, scope);
      if ('code' in resolved) {
        issues.push({ code: resolved.code, severity: 'ERROR', nodeId: node.id, input: name, path: `${pointer}/from`, message: resolved.message });
        continue;
      }
      checkType(issues, node, name, `${pointer}/from`, target, resolved.ok.type, `\`${binding.from}\``);
    } else if ('template' in binding) {
      let broken = false;
      for (const reference of templateReferences(binding.template)) {
        const resolved = resolvePath(reference.path, scope);
        if ('code' in resolved) {
          issues.push({
            code: resolved.code,
            severity: 'ERROR',
            nodeId: node.id,
            input: name,
            path: `${pointer}/template`,
            message: resolved.message,
          });
          broken = true;
        }
      }
      if (!broken) checkType(issues, node, name, `${pointer}/template`, target, 'text', 'a template');
    } else {
      checkType(issues, node, name, `${pointer}/value`, target, literalType(binding.value), 'the literal value');
    }
  }
}

function checkEdgeProducers(
  issues: BindingIssue[],
  graph: WorkflowGraph,
  node: WorkflowGraphNode,
  authored: Record<string, unknown> | undefined,
  agents?: AgentIOResolver,
): void {
  for (const [name, producers] of edgeProducers(graph, node, agents)) {
    if (authored !== undefined && Object.prototype.hasOwnProperty.call(authored, name)) continue;
    const paths = firstOfOrder(producers);
    if (paths.length < 2) continue;
    issues.push({
      code: 'INPUT_MULTIPLE_PRODUCERS',
      severity: authored === undefined ? 'WARNING' : 'ERROR',
      nodeId: node.id,
      input: name,
      path: `/inputs/${name}`,
      message:
        `\`${name}\` of step ${label(node)} is fed by ${paths.length} steps (${paths.map((path) => `\`${path}\``).join(', ')}); only one value can arrive. ` +
        (authored === undefined
          ? 'Today the latest producer that ran wins. Bind the input explicitly, or combine the values with a Merge step.'
          : 'Bind the input to one of them, or combine the values with a Merge step.'),
    });
  }
}

function checkRequired(
  issues: BindingIssue[],
  graph: WorkflowGraph,
  node: WorkflowGraphNode,
  authored: Record<string, unknown>,
  io: NodeIO | undefined,
  agents?: AgentIOResolver,
): void {
  if (io === undefined) return;
  const edgeBound = new Set(edgeProducers(graph, node, agents).keys());
  for (const [name, declared] of Object.entries(io.inputs)) {
    if (!declared.required || Object.prototype.hasOwnProperty.call(authored, name) || edgeBound.has(name)) continue;
    issues.push({
      code: 'REQUIRED_INPUT_UNBOUND',
      severity: 'ERROR',
      nodeId: node.id,
      input: name,
      path: `/inputs/${name}`,
      message: `step ${label(node)} needs \`${name}\` (${declared.type}): choose where it comes from.`,
    });
  }
}

/** `nodes.*` references in prompt-variable templates (the legacy `nodes.<id>.<key>` form is admitted). */
function checkPromptVariableNodes(issues: BindingIssue[], node: WorkflowGraphNode, scope: ResolveScope): void {
  const promptVariables = asObject(asObject(asObject(node.config)?.overrides)?.promptVariables);
  for (const [key, value] of Object.entries(promptVariables ?? {})) {
    if (typeof value !== 'string' || !value.includes('{{')) continue;
    for (const reference of templateReferences(value)) {
      const segments = reference.path.split('.');
      const root = segments[0];
      if (root === 'nodes' && segments[2] !== 'outputs') {
        const producer = segments[1] === undefined ? undefined : scope.nodesById.get(segments[1]);
        if (producer === undefined) {
          issues.push({
            code: 'BINDING_UNKNOWN_PATH',
            severity: 'ERROR',
            nodeId: node.id,
            path: `/overrides/promptVariables/${key}`,
            message: `\`${reference.path}\`: there is no step \`${segments[1] ?? ''}\` in this workflow.`,
          });
        } else if (!scope.ancestors.has(producer.id)) {
          issues.push({
            code: 'BINDING_NOT_ANCESTOR',
            severity: 'ERROR',
            nodeId: node.id,
            path: `/overrides/promptVariables/${key}`,
            message: `\`${reference.path}\`: step ${label(producer)} does not run before this step.`,
          });
        }
        continue;
      }
      if (root !== 'nodes' && root !== CONSULTATION_ROOT) continue; // other roots: PROMPT_VARIABLE_UNDECLARED's job
      const resolved = resolvePath(reference.path, scope);
      if ('code' in resolved)
        issues.push({
          code: resolved.code,
          severity: 'ERROR',
          nodeId: node.id,
          path: `/overrides/promptVariables/${key}`,
          message: resolved.message,
        });
    }
  }
}

/**
 * Every binding problem in the graph, ERROR / WARNING / INFO. `publishFindings` reports the ERROR
 * and WARNING ones; INFO (`BINDING_TYPE_CONVERTED`) is for the console, which shows how a value
 * converts.
 */
export function bindingIssues(graph: WorkflowGraph, ctx: BindingIssueContext = {}): BindingIssue[] {
  const issues: BindingIssue[] = [];
  const nodes = liveNodes(graph);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const vars = declaredVars(nodes);
  const sources = new Set<string>(ctx.sources ?? effectiveSettings(graph).sources);

  for (const node of nodes) {
    const scope = scopeFor(graph, node.id, nodesById, vars, ctx);
    const authored = authoredInputs(node);
    const io = nodeIOFor(node, ctx.agents);
    if (authored !== undefined) {
      checkAuthoredNode(issues, graph, node, authored, scope, io);
      checkRequired(issues, graph, node, authored, io, ctx.agents);
    }
    checkEdgeProducers(issues, graph, node, authored, ctx.agents);
    checkPromptVariableNodes(issues, node, scope);

    if (!sources.has('consultation')) {
      const reads = nodeConsultationReads(asObject(node.config));
      if (reads.length > 0) {
        issues.push({
          code: 'CONSULTATION_SCOPE_UNAVAILABLE',
          severity: 'ERROR',
          nodeId: node.id,
          path: '/inputs',
          message: `step ${label(node)} reads consultation data (${reads.map((read) => `\`${read.path}\``).join(', ')}), but this workflow is not started by a consultation. Add the consultation source in the workflow settings, or read the value from the context instead.`,
        });
      }
    }
  }
  return issues;
}

/** The type and PHI class a binding source path resolves to for `nodeId`, or why it cannot. */
export function resolveBindingSource(graph: WorkflowGraph, nodeId: string, path: string, ctx: BindingIssueContext = {}): Resolution {
  const nodes = liveNodes(graph);
  return resolvePath(path, scopeFor(graph, nodeId, new Map(nodes.map((node) => [node.id, node])), declaredVars(nodes), ctx));
}
