import { effectiveSettings, WORKFLOW_CONNECTIONS, WORKFLOW_SOURCES } from '@arcaai/workflow-contract';
import type { WorkflowConnection, WorkflowGraph, WorkflowSource } from '@arcaai/workflow-contract';

/**
 * TASK-1036 §3.5 (OD-4) — which entry points a PUBLISHED workflow admits, for the exposure plane.
 *
 * A PURE helper: lane B3a's `workflow-exposure.service.ts` calls it in place of reading the
 * legacy `core.trigger.kinds` / `core.output.protocols` directly. Resolution order:
 *
 *  1. `compiledConfig.settings` — what the compiler FROZE at publish (emitted under the data
 *     contract, `workflows.emitDataContract`). The published artifact is the authority.
 *  2. The stored graph's own `settings` (a version published before the data contract was on).
 *  3. The legacy trigger kinds / output protocols (D-4, one release), from the graph, or from the
 *     compiled trigger/output configs when only the artifact is at hand.
 *
 * Nothing readable admits nothing — the exposure plane answers its usual 404.
 */

export interface ExposureSettings {
  connections: WorkflowConnection[];
  sources: WorkflowSource[];
  /** `compiled` = frozen at publish; `settings` = the graph's `settings`; `legacy` = derived from trigger/output. */
  origin: 'compiled' | 'settings' | 'legacy';
}

/** An entry point: a caller connection (`api`, `webhook`, `sse`, `socket`) or a platform source (`consultation`, `schedule`). */
export type WorkflowEntry = WorkflowConnection | WorkflowSource;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function vocabularyList<T extends string>(value: unknown, vocabulary: readonly T[]): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const present = new Set(value.filter((entry): entry is string => typeof entry === 'string'));
  return vocabulary.filter((name) => present.has(name));
}

function isCompiled(value: Record<string, unknown>): boolean {
  return Array.isArray(value.stages);
}

/** The compiled artifact's nodes as a graph the contract's legacy derivation can read. */
function graphOfCompiled(compiled: Record<string, unknown>): Pick<WorkflowGraph, 'nodes'> {
  const nodes: WorkflowGraph['nodes'] = [];
  for (const stage of compiled.stages as unknown[]) {
    for (const raw of (asObject(stage)?.nodes as unknown[] | undefined) ?? []) {
      const node = asObject(raw);
      if (node === undefined || typeof node.nodeId !== 'string' || typeof node.type !== 'string') continue;
      nodes.push({ id: node.nodeId, type: node.type, config: asObject(node.config) ?? {} } as WorkflowGraph['nodes'][number]);
    }
  }
  return { nodes };
}

/**
 * The entry points a workflow admits. Accepts `{ compiledConfig?, graph? }` (a definition row's two
 * columns) or a bare compiled config / graph (`compiledOrGraph`).
 */
export function effectiveExposureSettings(source: unknown): ExposureSettings {
  const object = asObject(source);
  if (object === undefined) return { connections: [], sources: [], origin: 'legacy' };

  let compiled: Record<string, unknown> | undefined;
  let graph: Record<string, unknown> | undefined;
  if (isCompiled(object)) compiled = object;
  else if (Array.isArray(object.nodes)) graph = object;
  else {
    compiled = asObject(object.compiledConfig);
    if (compiled !== undefined && !isCompiled(compiled)) compiled = undefined;
    graph = asObject(object.graph);
    if (graph !== undefined && !Array.isArray(graph.nodes)) graph = undefined;
  }

  const frozen = asObject(compiled?.settings);
  if (frozen !== undefined) {
    const connections = vocabularyList(frozen.connections, WORKFLOW_CONNECTIONS);
    const sources = vocabularyList(frozen.sources, WORKFLOW_SOURCES);
    if (connections !== undefined && sources !== undefined) return { connections, sources, origin: 'compiled' };
  }

  if (graph !== undefined) {
    const settings = effectiveSettings(graph as unknown as WorkflowGraph);
    return { connections: settings.connections, sources: settings.sources, origin: settings.origin };
  }
  if (compiled !== undefined) {
    const settings = effectiveSettings(graphOfCompiled(compiled));
    return { connections: settings.connections, sources: settings.sources, origin: 'legacy' };
  }
  return { connections: [], sources: [], origin: 'legacy' };
}

/** Whether `entry` may start (or, for `sse` / `socket`, stream) a run under `settings`. */
export function isWorkflowEntryAllowed(settings: Pick<ExposureSettings, 'connections' | 'sources'>, entry: WorkflowEntry): boolean {
  return (settings.connections as readonly string[]).includes(entry) || (settings.sources as readonly string[]).includes(entry);
}
