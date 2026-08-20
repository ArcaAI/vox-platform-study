/**
 * The workflow canvas graph, exactly as a tenant authors it (`WorkflowDefinition.graph`,
 * TASK-715). This is the SOURCE the validator (§validate.ts) checks and the compiler
 * (§compiler.ts) turns into a `compiledConfig`. It is never executed directly — see
 * `packages/database/src/prisma/db_main/workflow-definition.prisma`.
 *
 * The id grammar mirrors `AGENT_KIND_KEY_PATTERN`
 * (`packages/applications/src/services/departmentAgent/constants.ts:177`), "a platform-wide
 * convention" for tenant-authored keys.
 */

/** Client-authored canvas coordinates (Workflow Studio, TASK-719). Purely presentational —
 *  never read by the compiler/interpreter — but it is a first-class sibling of `config`, not
 *  smuggled inside it: `compileNode`/`compileGate` (`compiler.ts`) copy `node.config` verbatim
 *  into `CompiledNode.config`, so nesting layout under a reserved config key would leak client
 *  bookkeeping into the interpreter's input contract. */
export interface WorkflowNodePosition {
  x: number;
  y: number;
}

export interface WorkflowGraphNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  /** Canvas layout, optional — absent for a graph authored before Workflow Studio's layout
   *  persistence landed, or for one built entirely through the list/tree editor. */
  position?: WorkflowNodePosition;
}

export interface WorkflowGraphEdge {
  id: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export interface WorkflowGraph {
  version: 1;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

/** Platform-wide tenant-authored-key grammar (mirrors `AGENT_KIND_KEY_PATTERN`). */
export const WORKFLOW_NODE_ID_PATTERN = /^[a-z0-9_]{2,48}$/;

/** Authoring bounds — untrusted input walked on every validate/compile call. */
export const MAX_GRAPH_NODES = 256;
export const MAX_GRAPH_EDGES = 1024;
export const MAX_GRAPH_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Structural problems with an AUTHORED graph document — shape, id grammar, bounds,
 * duplicate ids, dangling edge endpoints. Does NOT check acyclicity, reachability, or any
 * rule-class predicate (those are `ACYCLIC` / `REACHABLE_FROM_ENTRY` / rule-set predicates
 * over an already shape-valid graph — see `predicates/`).
 *
 * Total and non-throwing (the house `problems: string[]` idiom — see
 * `packages/json-schema-subset/src/json-schema-subset.ts`): a caller surfaces every problem
 * in one response rather than discovering them one round-trip at a time.
 */
export function workflowGraphProblems(value: unknown): string[] {
  const problems: string[] = [];

  if (!isPlainObject(value)) {
    problems.push('/: graph must be a JSON object');
    return problems;
  }

  if (value.version !== 1) {
    problems.push(`/version: expected 1, got ${JSON.stringify(value.version)}`);
  }

  const rawNodes = Array.isArray(value.nodes) ? value.nodes : undefined;
  if (rawNodes === undefined) {
    problems.push('/nodes: must be an array');
  }
  const rawEdges = Array.isArray(value.edges) ? value.edges : undefined;
  if (rawEdges === undefined) {
    problems.push('/edges: must be an array');
  }
  if (rawNodes === undefined || rawEdges === undefined) {
    return problems;
  }

  if (rawNodes.length > MAX_GRAPH_NODES) {
    problems.push(`/nodes: exceeds the maximum of ${MAX_GRAPH_NODES} nodes`);
  }
  if (rawEdges.length > MAX_GRAPH_EDGES) {
    problems.push(`/edges: exceeds the maximum of ${MAX_GRAPH_EDGES} edges`);
  }

  const seenNodeIds = new Set<string>();
  const validNodeIds = new Set<string>();
  rawNodes.forEach((node: unknown, index: number) => {
    const path = `/nodes/${index}`;
    if (!isPlainObject(node)) {
      problems.push(`${path}: node must be a JSON object`);
      return;
    }
    if (!isPlainString(node.id) || !WORKFLOW_NODE_ID_PATTERN.test(node.id)) {
      problems.push(`${path}/id: must match ${WORKFLOW_NODE_ID_PATTERN.source} (got ${JSON.stringify(node.id)})`);
    } else {
      if (seenNodeIds.has(node.id)) {
        problems.push(`${path}/id: duplicate node id ${JSON.stringify(node.id)}`);
      }
      seenNodeIds.add(node.id);
      validNodeIds.add(node.id);
    }
    if (!isPlainString(node.type) || node.type.length === 0) {
      problems.push(`${path}/type: must be a non-empty string`);
    }
    if (node.config !== undefined && !isPlainObject(node.config)) {
      problems.push(`${path}/config: must be a JSON object when present`);
    }
    if (node.position !== undefined) {
      const position = node.position;
      if (!isPlainObject(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) {
        problems.push(`${path}/position: must be an object with finite numeric x/y when present`);
      }
    }
  });

  const seenEdgeIds = new Set<string>();
  rawEdges.forEach((edge: unknown, index: number) => {
    const path = `/edges/${index}`;
    if (!isPlainObject(edge)) {
      problems.push(`${path}: edge must be a JSON object`);
      return;
    }
    if (!isPlainString(edge.id) || edge.id.length === 0) {
      problems.push(`${path}/id: must be a non-empty string`);
    } else {
      if (seenEdgeIds.has(edge.id)) {
        problems.push(`${path}/id: duplicate edge id ${JSON.stringify(edge.id)}`);
      }
      seenEdgeIds.add(edge.id);
    }
    for (const field of ['from', 'to'] as const) {
      const endpoint = edge[field];
      if (!isPlainString(endpoint) || endpoint.length === 0) {
        problems.push(`${path}/${field}: must be a non-empty string`);
      } else if (!validNodeIds.has(endpoint)) {
        problems.push(`${path}/${field}: references unknown node ${JSON.stringify(endpoint)}`);
      }
    }
    for (const field of ['fromPort', 'toPort'] as const) {
      if (!isPlainString(edge[field]) || (edge[field] as string).length === 0) {
        problems.push(`${path}/${field}: must be a non-empty string`);
      }
    }
  });

  return problems;
}
