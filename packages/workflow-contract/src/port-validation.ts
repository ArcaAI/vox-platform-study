/**
 * Type-checked edge validation and the publish-time descriptor rules (TASK-809 Tasks 5 & 7).
 *
 * Closes defect D-5: `workflowGraphProblems` (`graph-model.ts:160`) checks only that
 * `fromPort`/`toPort` are non-empty strings, so `{ fromPort: 'banana', toPort: 'banana' }` was a
 * structurally valid edge. It stays that way on purpose — that function is the pure SHAPE check
 * and the package layering depends on it having no registry knowledge. Port typing needs the
 * registry, so it lives here.
 *
 * ## Why this is not wired into `validate()`
 *
 * Every graph authored before this ticket names its ports `in`/`out` untyped, for ordering and
 * data alike (see `node-ports.ts` §MIGRATION NOTE). Folding the check into `validate()`'s
 * default rule loop would retroactively invalidate every saved definition the moment this
 * package shipped. So it is invoked EXPLICITLY:
 *
 *   - `isValidConnection(...)` — the canvas predicate, one candidate edge at a time.
 *   - `workflowPublishProblems(...)` — the publish gate, whole graph.
 *
 * Migrating the seeded graphs to typed ports is a FOLLOW-ON LANE OF TASK-809 ITSELF (TASK-812 is
 * the endpoint stage, not the migration); wiring this gate into the gateway's publish path
 * belongs to whichever lane owns that path. Everything here is pure and total: it returns `problems: string[]` (the house idiom) and
 * never throws, whatever it is handed.
 */
import type { WorkflowGraph } from './graph-model';
import { EMPTY_PORTS, NODE_PORTS } from './node-ports';
import type { WorkflowNodeDescriptor } from './node-registry';
import { WORKFLOW_NODE_REGISTRY } from './node-registry';
import type { WorkflowPortDescriptor } from './port-model';
import { portPrimitiveSatisfies } from './port-model';

/** A caller may overlay descriptors (the gateway resolving a tenant's pinned registry, or a
 *  test exercising a rule against a synthetic node type) without mutating the module registry. */
export interface PortValidationOptions {
  readonly registry?: Readonly<Record<string, WorkflowNodeDescriptor>>;
}

function resolveRegistry(options?: PortValidationOptions): Readonly<Record<string, WorkflowNodeDescriptor>> {
  return options?.registry === undefined ? WORKFLOW_NODE_REGISTRY : { ...WORKFLOW_NODE_REGISTRY, ...options.registry };
}

function portsOf(
  descriptor: WorkflowNodeDescriptor | undefined,
  nodeType: string,
): { inputs: readonly WorkflowPortDescriptor[]; outputs: readonly WorkflowPortDescriptor[] } {
  if (descriptor !== undefined) return { inputs: descriptor.inputs, outputs: descriptor.outputs };
  return NODE_PORTS[nodeType] ?? EMPTY_PORTS;
}

function findPort(ports: readonly WorkflowPortDescriptor[], name: string): WorkflowPortDescriptor | undefined {
  return ports.find((candidate) => candidate.name === name);
}

/**
 * The canvas predicate (`workflow-canvas/types.ts`'s `isValidConnection` hook). Returns `true`
 * only when BOTH endpoints resolve to declared ports of the right direction AND the produced
 * type satisfies the consumed type. Everything else — unregistered node type, unknown port,
 * an edge drawn out of an input — is `false`, never a throw.
 */
export function isValidConnection(
  fromNodeType: string,
  fromPort: string,
  toNodeType: string,
  toPort: string,
  options?: PortValidationOptions,
): boolean {
  const registry = resolveRegistry(options);
  const fromDescriptor = registry[fromNodeType];
  const toDescriptor = registry[toNodeType];
  if (fromDescriptor === undefined || toDescriptor === undefined) return false;

  const source = findPort(portsOf(fromDescriptor, fromNodeType).outputs, fromPort);
  const target = findPort(portsOf(toDescriptor, toNodeType).inputs, toPort);
  if (source === undefined || target === undefined) return false;

  return portPrimitiveSatisfies(source.primitive, target.primitive);
}

/**
 * Every port problem in an authored graph, in one pass (never just the first — a caller
 * surfaces them all in one response rather than discovering them a round-trip at a time, the
 * same contract `workflowGraphProblems` keeps).
 *
 * Paths mirror that function's JSON-pointer style (`/edges/3/fromPort`) so a client can point at
 * the offending field.
 */
export function workflowEdgePortProblems(graph: WorkflowGraph, options?: PortValidationOptions): string[] {
  const registry = resolveRegistry(options);
  const problems: string[] = [];

  const nodeTypeById = new Map<string, string>();
  for (const node of graph.nodes ?? []) {
    if (typeof node?.id === 'string' && typeof node?.type === 'string') nodeTypeById.set(node.id, node.type);
  }

  (graph.edges ?? []).forEach((edge, index) => {
    const path = `/edges/${index}`;

    const fromType = nodeTypeById.get(edge?.from);
    const toType = nodeTypeById.get(edge?.to);
    if (fromType === undefined) {
      problems.push(`${path}/from: references unknown node ${JSON.stringify(edge?.from)}`);
      return;
    }
    if (toType === undefined) {
      problems.push(`${path}/to: references unknown node ${JSON.stringify(edge?.to)}`);
      return;
    }

    const fromDescriptor = registry[fromType];
    const toDescriptor = registry[toType];
    if (fromDescriptor === undefined) {
      problems.push(
        `${path}/from: node ${JSON.stringify(edge.from)} has unregistered type ${JSON.stringify(fromType)} — its ports cannot be resolved`,
      );
      return;
    }
    if (toDescriptor === undefined) {
      problems.push(`${path}/to: node ${JSON.stringify(edge.to)} has unregistered type ${JSON.stringify(toType)} — its ports cannot be resolved`);
      return;
    }

    const fromPorts = portsOf(fromDescriptor, fromType);
    const toPorts = portsOf(toDescriptor, toType);
    const source = findPort(fromPorts.outputs, edge.fromPort);
    const target = findPort(toPorts.inputs, edge.toPort);

    if (source === undefined) {
      // Naming an INPUT port as an edge source is the commonest authoring slip, so say so
      // rather than reporting a bare "unknown port".
      const asInput = findPort(fromPorts.inputs, edge.fromPort);
      const detail =
        asInput === undefined
          ? `declares no output port ${JSON.stringify(edge.fromPort)} (declared: ${JSON.stringify(fromPorts.outputs.map((p) => p.name))})`
          : `port ${JSON.stringify(edge.fromPort)} is an INPUT, so it cannot be an edge source`;
      problems.push(`${path}/fromPort: node type ${JSON.stringify(fromType)} ${detail}`);
    }
    if (target === undefined) {
      const asOutput = findPort(toPorts.outputs, edge.toPort);
      const detail =
        asOutput === undefined
          ? `declares no input port ${JSON.stringify(edge.toPort)} (declared: ${JSON.stringify(toPorts.inputs.map((p) => p.name))})`
          : `port ${JSON.stringify(edge.toPort)} is an OUTPUT, so it cannot be an edge target`;
      problems.push(`${path}/toPort: node type ${JSON.stringify(toType)} ${detail}`);
    }
    if (source === undefined || target === undefined) return;

    if (!portPrimitiveSatisfies(source.primitive, target.primitive)) {
      problems.push(
        `${path}: incompatible port types — ${fromType}[${source.name}] produces ${JSON.stringify(source.primitive)}, ` +
          `which does not satisfy ${toType}[${target.name}] expecting ${JSON.stringify(target.primitive)}`,
      );
    }
  });

  return problems;
}

/**
 * The two publish-time DESCRIPTOR rules, plus the node-type versioning rule, checked against one
 * descriptor. Total — returns `[]` for a conforming descriptor.
 *
 * | Rule | Why |
 * |---|---|
 * | a `lane: 'durable'` node MUST be `idempotent` | Temporal retries activities. A durable node that is not idempotent double-writes on a retry that the author never sees. |
 * | a `lane: 'realtime'` node MUST NOT be `externalWrite` | The realtime lane has a latency budget; an inline external write blows it and cannot be compensated on restart. |
 * | `key` suffix and `schemaVersion` must agree | A node type is a contract with every saved tenant graph. Reshaping a published node's ports in place silently breaks them; a breaking change becomes `agent.ner@2`, and the suffix must not lie about which version it is. |
 */
export function nodeDescriptorContractProblems(descriptor: WorkflowNodeDescriptor): string[] {
  const problems: string[] = [];

  if (descriptor.lane === 'durable' && !descriptor.idempotent) {
    problems.push(`${descriptor.key}: a lane:'durable' node MUST declare idempotent:true — Temporal retries activities`);
  }
  if (descriptor.lane === 'realtime' && descriptor.externalWrite) {
    problems.push(`${descriptor.key}: a lane:'realtime' node MUST NOT declare externalWrite:true — the realtime lane has a latency budget`);
  }

  const suffix = descriptor.key.includes('@') ? Number(descriptor.key.slice(descriptor.key.lastIndexOf('@') + 1)) : 1;
  if (!Number.isInteger(suffix) || suffix !== descriptor.schemaVersion) {
    problems.push(`${descriptor.key}: schemaVersion ${descriptor.schemaVersion} disagrees with the key's version suffix (${suffix})`);
  }

  if (descriptor.evalGate !== undefined && descriptor.evalGate.goldenSetId.length === 0) {
    problems.push(`${descriptor.key}: evalGate.goldenSetId must be a non-empty golden-set id — an eval gate with no golden set gates nothing`);
  }

  return problems;
}

/**
 * The publish gate: every port problem in the graph, every descriptor-contract violation among
 * the node types it uses, and every UNSATISFIED GUARD ATTACHMENT.
 *
 * `requires[]` is checked **per node INSTANCE**, not per type: two `generate.text` nodes in one
 * graph each need their own attached guard, because a guard wired to one of them says nothing
 * about the other. A guard counts as attached when an edge connects the instance to a node of
 * the required type in EITHER direction — a pre-guard and a post-guard are both attachments.
 *
 * Every descriptor in the shipped registry declares `requires: []`, so this imposes nothing
 * today; the `guard.*` node types the target catalogue names do not exist yet, and assigning
 * real guard requirements before they do would make every seeded graph unpublishable. The
 * MECHANISM is what this ticket owes; the POLICY belongs to the lane that adds the guards.
 */
export function workflowPublishProblems(graph: WorkflowGraph, options?: PortValidationOptions): string[] {
  const registry = resolveRegistry(options);
  const problems: string[] = [...workflowEdgePortProblems(graph, options)];

  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const typeById = new Map<string, string>();
  for (const node of nodes) {
    if (typeof node?.id === 'string' && typeof node?.type === 'string') typeById.set(node.id, node.type);
  }

  const seenTypes = new Set<string>();
  for (const node of nodes) {
    const descriptor = registry[node?.type];
    if (descriptor === undefined) continue;

    if (!seenTypes.has(node.type)) {
      seenTypes.add(node.type);
      problems.push(...nodeDescriptorContractProblems(descriptor));
    }

    if (descriptor.requires.length === 0) continue;
    const neighbourTypes = new Set<string>();
    for (const edge of edges) {
      if (edge?.from === node.id) {
        const neighbour = typeById.get(edge.to);
        if (neighbour !== undefined) neighbourTypes.add(neighbour);
      }
      if (edge?.to === node.id) {
        const neighbour = typeById.get(edge.from);
        if (neighbour !== undefined) neighbourTypes.add(neighbour);
      }
    }
    for (const required of descriptor.requires) {
      if (!neighbourTypes.has(required)) {
        problems.push(
          `/nodes: node ${JSON.stringify(node.id)} (${node.type}) requires an attached ${JSON.stringify(required)} guard, and none is connected to this instance`,
        );
      }
    }
  }

  return problems;
}
