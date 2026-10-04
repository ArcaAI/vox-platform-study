/**
 * TASK-1036 §8.4 items 2-3, §9.2 (OD-29), §10.1 "Auto-mapping" — what one link MEANS.
 *
 * Edges carry ORDER; bindings move DATA (OD-29). So a link the author draws becomes two facts:
 *
 *  1. a wire edge between real sockets — the ORDERING pair (`next → after`) whenever the link also
 *     writes a binding, so the edge never implies a second, unintended binding of its own (a data
 *     edge `out → in` would also feed the target's legacy primary input); the data pair only when
 *     no binding is written and the edge is all there is (legacy behaviour, unchanged);
 *  2. a binding in the target's `config.inputs`, picked by type: the best `typeFits` pair between
 *     the source's outputs and the target's inputs (exact type, then a match, then a conversion;
 *     a free input before one already fed; the declared order last). A dragged handle pins its end.
 *
 * Fan-in is refused (OD-18): a second producer into an input that already has one is NOT linked;
 * the refusal carries an ordered-coalesce offer (`{ firstOf: [...] }`, Q1) the canvas shows as
 * "Use first available". A branch link carries the router's input (Q3, OD-19).
 *
 * Every candidate wire still goes through `checkPortCompatibility` (the port lattice), exactly as
 * `socket-resolution.ts` documents — this module chooses, it never widens.
 */
import {
  edgeImpliedBindings,
  typeFits,
  type AgentIOResolver,
  type Binding,
  type FirstOfBinding,
  type IoType,
  type TypeFit,
  type WorkflowGraph,
  type WorkflowSettings,
} from '@arcaai/workflow-contract';
import type { WorkflowNodeDescriptor } from '../api/types';
import type { ConnectRequest, GraphStoreEdge, GraphStoreNode } from '../store/types';
import { canvasPortsOf, hasExactIo, nodeIoOf, parsePortHandle } from './composer-io';
import { branchHandlesOf } from './core-ports';
import { nodeDisplayName } from './node-identity';
import { checkPortCompatibility } from './port-compatibility';
import { resolvePrimarySockets } from './socket-resolution';

const MAX_FIRST_OF = 8;

/** The contract's graph shape, built from the store's. */
export function contractGraphOf(nodes: readonly GraphStoreNode[], edges: readonly GraphStoreEdge[], settings?: WorkflowSettings): WorkflowGraph & { settings?: WorkflowSettings } {
  return {
    version: 1,
    nodes: nodes.map((node) => ({ id: node.id, type: node.type, config: node.config, ...(node.parentId ? { parentId: node.parentId } : {}) })),
    edges: edges.map((edge) => ({ id: edge.id, from: edge.source, fromPort: edge.sourceHandle, to: edge.target, toPort: edge.targetHandle })),
    ...(settings ? { settings } : {}),
  } as WorkflowGraph & { settings?: WorkflowSettings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every path a binding reads (`from` / `firstOf`); templates and literals read none here. */
export function bindingPaths(binding: unknown): string[] {
  if (!isRecord(binding)) return [];
  if (typeof binding.from === 'string') return [binding.from];
  if (Array.isArray(binding.firstOf)) return binding.firstOf.filter((path): path is string => typeof path === 'string');
  return [];
}

/** The target's EFFECTIVE bindings: what its data edges imply, overlaid by what was authored. */
export function effectiveBindings(
  nodes: readonly GraphStoreNode[],
  edges: readonly GraphStoreEdge[],
  nodeId: string,
  agents: AgentIOResolver,
): Record<string, { binding: Binding; implied: boolean }> {
  const out: Record<string, { binding: Binding; implied: boolean }> = {};
  for (const [name, binding] of Object.entries(edgeImpliedBindings(contractGraphOf(nodes, edges), nodeId, agents))) {
    out[name] = { binding, implied: true };
  }
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const authored = node?.config.inputs;
  if (isRecord(authored)) {
    for (const [name, binding] of Object.entries(authored)) out[name] = { binding: binding as Binding, implied: false };
  }
  return out;
}

export interface PlanConnectionInput {
  nodes: readonly GraphStoreNode[];
  edges: readonly GraphStoreEdge[];
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>;
  agents: AgentIOResolver;
  source: string;
  target: string;
  /** `out`, `out:<field>`, a branch handle id, or nothing (a keyboard "Connect to…"). */
  sourceHandle?: string | null;
  /** `in`, `in:<field>`, or nothing. */
  targetHandle?: string | null;
  /** Insert-on-edge: bindings of the target that read THIS step may be re-pointed at the new one. */
  replaceProducer?: string;
}

export interface PlannedBinding {
  input: string;
  binding: Binding;
}

export type ConnectionPlan =
  | {
      ok: true;
      /** `null` = the two steps are already linked; only the binding is written. */
      request: ConnectRequest | null;
      binding?: PlannedBinding;
      /** `transcript → message` — what the link carries. */
      label?: string;
      fit?: TypeFit;
      /** A link made for order only, and what the author still has to choose. */
      note?: string;
    }
  | {
      ok: false;
      reason: string;
      /** OD-18 / Q1 — "Use first available": link anyway and bind the input as an ordered coalesce. */
      coalesce?: { request: ConnectRequest | null; input: string; binding: FirstOfBinding; label: string };
    };

interface Candidate {
  input: string;
  inputType: IoType;
  required: boolean;
  inputIndex: number;
  output: string;
  outputIndex: number;
  path: string;
  fit: Exclude<TypeFit, 'blocked'>;
  exact: boolean;
  free: boolean;
  untyped: boolean;
}

/**
 * Lower is better: exact type, then a match, then a conversion; free inputs first; then declared
 * order. An UNTYPED source (`any` — a router's carried-through input) fits everything equally, so
 * it goes to the target's MAIN input, the first declared (Q3: "into the target's primary input").
 */
function rank(candidate: Candidate): number[] {
  return [
    candidate.untyped ? 0 : candidate.exact ? 0 : candidate.fit === 'match' ? 1 : 2,
    candidate.free ? 0 : 1,
    candidate.output === candidate.input ? 0 : 1,
    candidate.required ? 0 : 1,
    candidate.inputIndex,
    candidate.outputIndex,
  ];
}

function better(a: Candidate, b: Candidate): boolean {
  const ra = rank(a);
  const rb = rank(b);
  for (let index = 0; index < ra.length; index += 1) {
    if ((ra[index] as number) !== (rb[index] as number)) return (ra[index] as number) < (rb[index] as number);
  }
  return false;
}

/** The output a branch handle carries: the loop's item/result, else the router's input (Q3). */
function branchOutput(sourceType: string, handle: string, outputs: Record<string, { type: IoType }>): { name: string; type: IoType } | null {
  if (sourceType === 'core.loop') {
    const name = handle === 'each' ? 'item' : handle === 'done' ? 'result' : null;
    return name && outputs[name] ? { name, type: outputs[name].type } : null;
  }
  return outputs.input ? { name: 'input', type: outputs.input.type } : null;
}

function wireFor(
  input: PlanConnectionInput,
  source: GraphStoreNode,
  target: GraphStoreNode,
  branch: string | null,
  bindingWritten: boolean,
): ConnectRequest | null {
  const endpoint = (node: GraphStoreNode, handle: string) => ({ type: node.type, handle, config: node.config });
  if (branch === null && bindingWritten) {
    const ordering = checkPortCompatibility(input.descriptorByType, endpoint(source, 'next'), endpoint(target, 'after'));
    if (ordering.ok) return { source: source.id, sourceHandle: 'next', target: target.id, targetHandle: 'after' };
  }
  const sockets = resolvePrimarySockets(input.descriptorByType, { type: source.type, config: source.config }, { type: target.type, config: target.config }, branch);
  return sockets ? { source: source.id, sourceHandle: sockets.sourceHandle, target: target.id, targetHandle: sockets.targetHandle } : null;
}

function alreadyLinked(edges: readonly GraphStoreEdge[], source: string, target: string): boolean {
  return edges.some((edge) => edge.source === source && edge.target === target);
}

/** Plans one link. Pure: the caller commits it through the store's `connect`. */
export function planConnection(input: PlanConnectionInput): ConnectionPlan {
  const { nodes, edges, agents } = input;
  const source = nodes.find((node) => node.id === input.source);
  const target = nodes.find((node) => node.id === input.target);
  if (!source || !target) return { ok: false, reason: 'Both steps must be on the canvas.' };
  if (source.id === target.id) return { ok: false, reason: 'A step cannot connect to itself.' };
  if (target.type === 'core.trigger') return { ok: false, reason: 'Start is the entry point: nothing can link into it.' };
  if (source.type === 'core.output') return { ok: false, reason: 'End is the exit: nothing can link out of it.' };

  const sourceName = nodeDisplayName(source);
  const targetName = nodeDisplayName(target);
  const sourceField = parsePortHandle(input.sourceHandle);
  const targetField = parsePortHandle(input.targetHandle);
  const branchIds = [...branchHandlesOf(source.type, source.config), ...(source.type === 'core.loop' ? ['each', 'done'] : [])];
  const branch = input.sourceHandle && sourceField === null && branchIds.includes(input.sourceHandle) ? input.sourceHandle : null;

  const sourceIo = nodeIoOf(source, agents);
  const sourceOutputs = (sourceIo?.outputs ?? {}) as Record<string, { type: IoType }>;
  const targetPorts = canvasPortsOf(target, agents);
  const targetInputs = hasExactIo(target, agents) ? (targetPorts?.inputs ?? []) : [];

  const existing = effectiveBindings(nodes, edges, target.id, agents);
  const isFree = (name: string): boolean => {
    const current = existing[name];
    if (!current) return true;
    if (input.replaceProducer === undefined) return false;
    const paths = bindingPaths(current.binding);
    return paths.length > 0 && paths.every((path) => path.startsWith(`nodes.${input.replaceProducer}.`));
  };

  // Candidate outputs: the branch's carried value, the dragged field, or every declared output.
  let outputs: Array<{ name: string; type: IoType }>;
  if (branch !== null) {
    const carried = branchOutput(source.type, branch, sourceOutputs);
    outputs = carried ? [carried] : [];
  } else if (sourceField !== null) {
    const declared = sourceOutputs[sourceField.field];
    if (!declared) return { ok: false, reason: `${sourceName} has no output “${sourceField.field}”.` };
    outputs = [{ name: sourceField.field, type: declared.type }];
  } else {
    outputs = hasExactIo(source, agents) ? Object.entries(sourceOutputs).map(([name, field]) => ({ name, type: field.type })) : [];
  }
  const inputs = targetField !== null ? targetInputs.filter((port) => port.name === targetField.field) : targetInputs;
  if (targetField !== null && inputs.length === 0) return { ok: false, reason: `${targetName} has no input “${targetField.field}”.` };

  let best: Candidate | null = null;
  let blockedReason: string | null = null;
  inputs.forEach((port, inputIndex) => {
    outputs.forEach((output, outputIndex) => {
      const fit = typeFits(port.type, output.type);
      if (fit === 'blocked') {
        blockedReason ??= `${targetName} needs ${port.type} for “${port.name}”, and ${sourceName} gives ${output.type} (“${output.name}”).`;
        return;
      }
      const candidate: Candidate = {
        input: port.name,
        inputType: port.type,
        required: port.required,
        inputIndex,
        output: output.name,
        outputIndex,
        path: `nodes.${source.id}.outputs.${output.name}`,
        fit,
        exact: port.type === output.type,
        free: isFree(port.name),
        untyped: output.type === 'any',
      };
      if (best === null || better(candidate, best)) best = candidate;
    });
  });

  const dragged = sourceField !== null && targetField !== null;
  const chosen = best as Candidate | null;
  if (chosen === null) {
    if (dragged) return { ok: false, reason: blockedReason ?? `${sourceName} has nothing ${targetName} can use there.` };
    const request = wireFor(input, source, target, branch, false);
    if (request === null) return { ok: false, reason: `${sourceName} and ${targetName} cannot be linked.` };
    const required = targetInputs.filter((port) => port.required && isFree(port.name)).map((port) => `“${port.name}” (${port.type})`);
    return {
      ok: true,
      request: alreadyLinked(edges, source.id, target.id) ? null : request,
      ...(required.length > 0 ? { note: `Linked for order only: choose where ${targetName} gets ${required.join(', ')}.` } : {}),
    };
  }

  const label = `${chosen.output} → ${chosen.input}`;
  const request = alreadyLinked(edges, source.id, target.id) ? null : wireFor(input, source, target, branch, true);
  if (request === null && !alreadyLinked(edges, source.id, target.id)) return { ok: false, reason: `${sourceName} and ${targetName} cannot be linked.` };

  if (!chosen.free) {
    const current = existing[chosen.input]?.binding;
    const paths = bindingPaths(current);
    const reason = `“${chosen.input}” of ${targetName} already has a value${paths.length > 0 ? ` from ${paths.join(', ')}` : ''}. Only one value can arrive.`;
    if (paths.length === 0 || paths.includes(chosen.path) || paths.length >= MAX_FIRST_OF) return { ok: false, reason };
    return { ok: false, reason, coalesce: { request, input: chosen.input, binding: { firstOf: [...paths, chosen.path] }, label } };
  }

  return { ok: true, request, binding: { input: chosen.input, binding: { from: chosen.path } }, label, fit: chosen.fit };
}

export interface EdgeMapping {
  label: string;
  sourceField: string;
  targetField: string;
}

/**
 * What each link carries, for its label (`transcript → message`) and for which typed handles it
 * is drawn between. Read off the target's EFFECTIVE bindings, so a legacy data edge and an
 * authored binding read the same way. Absent = an ordering-only link.
 */
export function edgeMappingLabels(nodes: readonly GraphStoreNode[], edges: readonly GraphStoreEdge[], agents: AgentIOResolver): Map<string, EdgeMapping> {
  const byTarget = new Map<string, Record<string, { binding: Binding; implied: boolean }>>();
  const out = new Map<string, EdgeMapping>();
  for (const edge of edges) {
    let bindings = byTarget.get(edge.target);
    if (!bindings) {
      bindings = effectiveBindings(nodes, edges, edge.target, agents);
      byTarget.set(edge.target, bindings);
    }
    const pairs: Array<[string, string]> = [];
    const prefix = `nodes.${edge.source}.outputs.`;
    for (const [input, { binding }] of Object.entries(bindings)) {
      for (const path of bindingPaths(binding)) {
        if (path.startsWith(prefix)) pairs.push([path.slice(prefix.length).split('.')[0] as string, input]);
      }
      if (isRecord(binding) && typeof binding.template === 'string' && binding.template.includes(`{{${prefix}`)) pairs.push(['template', input]);
    }
    if (pairs.length === 0) continue;
    const [first] = pairs as [[string, string]];
    out.set(edge.id, { label: pairs.map(([field, input]) => `${field} → ${input}`).join(', '), sourceField: first[0], targetField: first[1] });
  }
  return out;
}
