import { CONSULTATION_ROOT, consultationPathInfo, declaredConsultationReads } from '@arcaai/workflow-contract';
import type { WorkflowGraph } from '@arcaai/workflow-contract';

/**
 * TASK-1036 §9.3 / TASK-1038 — the pure rules of the declared-read route. The service does the
 * repository reads; these decide what a read may return.
 */

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The paths the read schema does not declare (`[]` = all known). */
export function unknownConsultationPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => typeof path !== 'string' || !path.startsWith(`${CONSULTATION_ROOT}.`) || consultationPathInfo(path) === undefined);
}

/** Every compiled node, top level and loop bodies. */
function compiledNodes(compiled: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walkStages = (stages: unknown): void => {
    if (!Array.isArray(stages)) return;
    for (const stage of stages) {
      for (const node of (asObject(stage)?.nodes as unknown[] | undefined) ?? []) {
        const object = asObject(node);
        if (object !== undefined) out.push(object);
      }
    }
  };
  walkStages(compiled.stages);
  for (const loop of Array.isArray(compiled.loops) ? compiled.loops : []) walkStages(asObject(asObject(loop)?.body)?.stages);
  return out;
}

/**
 * Was this artifact compiled WITH the data contract? Its top-level `settings` key is emitted
 * exactly when `emitDataContract` was on, and so are the per-node `consultationReads` — so its
 * presence is what makes the artifact's declared reads authoritative (an absent node entry then
 * means "this node reads nothing").
 */
function hasDataContract(compiled: Record<string, unknown>): boolean {
  return compiled.settings !== undefined || compiledNodes(compiled).some((node) => node.consultationReads !== undefined);
}

/**
 * The `consultation.*` paths `nodeId` declares in the run's workflow version: the compiled
 * artifact's `consultationReads` when the artifact carries the data contract; otherwise (an
 * artifact that predates it, or a sandbox draft with no persisted artifact) the reads the contract
 * derives from the stored graph (`declaredConsultationReads`).
 */
export function declaredReadsForNode(compiledConfig: unknown, graph: unknown, nodeId: string): string[] {
  const compiled = asObject(compiledConfig);
  if (compiled !== undefined && hasDataContract(compiled)) {
    const node = compiledNodes(compiled).find((candidate) => candidate.nodeId === nodeId);
    const reads = Array.isArray(node?.consultationReads) ? node.consultationReads : [];
    return reads.map((read) => asObject(read)?.path).filter((path): path is string => typeof path === 'string');
  }
  const authored = asObject(graph);
  if (authored === undefined || !Array.isArray(authored.nodes)) return [];
  return (declaredConsultationReads(authored as unknown as WorkflowGraph)[nodeId] ?? []).map((read) => read.path);
}

/** A path is declared when it, or a container above it, was declared. */
export function isPathDeclared(path: string, declared: readonly string[]): boolean {
  return declared.some((entry) => path === entry || path.startsWith(`${entry}.`));
}

/** The top-level read-model keys (`patient`, `notes`, …) a set of paths needs assembled. */
export function rootsOf(paths: readonly string[]): Set<string> {
  return new Set(paths.map((path) => path.split('.')[1]).filter((root): root is string => typeof root === 'string' && root.length > 0));
}

/** The value at `consultation.<a>.<b>…` in the assembled model; `null` when absent. */
export function pickPath(model: Readonly<Record<string, unknown>>, path: string): unknown {
  let cursor: unknown = model;
  for (const segment of path.split('.').slice(1)) {
    const object = asObject(cursor);
    if (object === undefined || !(segment in object)) return null;
    cursor = object[segment];
  }
  return cursor === undefined ? null : cursor;
}

/** How many of `paths` read PHI (per the read schema's per-field class) — audited, never the values. */
export function phiPathCount(paths: readonly string[]): number {
  return paths.filter((path) => consultationPathInfo(path)?.phiClass === 'PHI').length;
}

/**
 * Does `runId` belong to the consultation? A consultation-governed run is named by the
 * consultation's governing-engine marker (the current run, or the one a resume superseded); a run
 * started on another plane (sandbox, consultation-bound exposure) records its consultation in its
 * own `_metadata.consultationId`.
 */
export function runBelongsToConsultation(
  run: { runId: string; metaData?: Record<string, unknown> | null },
  consultation: { id: string; metadata?: unknown },
): boolean {
  if (asObject(run.metaData)?.consultationId === consultation.id) return true;
  const marker = asObject(asObject(consultation.metadata)?.governingEngine);
  return marker !== undefined && (marker.workflowRunId === run.runId || marker.supersededRunId === run.runId);
}
