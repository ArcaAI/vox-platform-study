import type { GoverningRunSummary } from '@arcaai/types';
/**
 * which agentic-loop engine GOVERNS a consultation.
 *
 * ## The defect this closes
 *
 * The platform has two agentic-loop engines that both write the consultation's
 * draft `ContextItem`:
 *
 *   * **Substrate A** — `ConsultationLoopWorkflow` + `HarnessDocWorkflow`,
 *     signal-with-started lazily by `LoopContextSignalService.handleContextAdded`
 *     on the first context item.
 *   * **Substrate B** — the `WorkflowInterpreter` running a tenant-authored
 *     `consultation`-palette graph, dispatched at consultation OPEN by
 *     `ConsultationWorkflowDispatchService`.
 *
 * Substrate B's `consultation.persistDraft` node calls the SAME `persist_draft`
 * activity `HarnessDocWorkflow` uses. Dispatch was conditional but NOT
 * exclusive, so the moment a `WorkflowAssignment` existed both engines ran and
 * both wrote one document, with no coordination between them.
 *
 * ## Why a persisted marker, and not a lookup
 *
 * The decision must survive: a consultation opened under a tenant workflow has
 * to be recognised as such on a LATER `ContextAdded` signal, in a DIFFERENT
 * process, after a restart. The two candidates were:
 *
 *   1. Query `WorkflowRun` for a row with `trigger: 'consultation open'`.
 *      **Not implementable.** `WorkflowRun` has no consultation linkage at all —
 *      neither the Prisma model (`workflow-run.prisma`) nor `RecordRunStartedInput`
 *      carries a `consultationId`, so there is no key to join on. Adding one is a
 *      `packages/database` schema change this ticket does not own.
 *   2. A durable marker on the consultation row. `Consultation.metadata` is an
 *      existing `Json?` column ("Flexible metadata (scheduling info, external
 *      refs, etc.)") that nothing in `services/consultation/**` reads today, so
 *      the marker needs no migration and no cross-boundary request.
 *
 * (2) is what this module implements. It is deliberately a NAMESPACED key inside
 * the existing object rather than a wholesale replacement: client-supplied
 * metadata from `OpenConsultationRequest` must survive untouched.
 *
 * ## Known limitation, filed rather than hidden
 *
 * `metadata` is client-writable at open, so a caller could in principle post a
 * forged marker and suppress Substrate A for its OWN consultation (denying
 * itself documentation — it cannot reach another tenant's rows). Requiring a
 * non-empty `workflowRunId` raises the bar but does not close it. The real fix is
 * a first-class, platform-owned column on `Consultation`; that is a
 * `packages/database` change and is filed as a requested contract in the ticket
 * README.
 */

import type { JsonObject } from '@arcaai/domains';

/** The one value that means "a tenant-authored workflow governs this consultation". */
export const TENANT_WORKFLOW_GOVERNS_MARKER = 'tenant-workflow';

/** The namespaced key the marker lives under inside `Consultation.metadata`. */
export const GOVERNING_ENGINE_METADATA_KEY = 'governingEngine';

export interface GoverningEngineMarker {
  /** The interpreter run that took ownership. Required — see the forgery note above. */
  readonly workflowRunId: string;
  /** The definition the assignment cascade resolved to, for observability. */
  readonly workflowDefinitionSlug: string;
  /** When the decision was taken, ISO-8601. */
  readonly decidedAt?: string;
  /**
   * The run's TERMINAL outcome, stamped by the gateway's completion watcher.
   *
   * Absent means the run has not reached a terminal state that anything observed — which is the
   * same fact a marker written before this field existed states, so both read as `RUNNING`.
   * Only the PERSISTED vocabulary appears here: the interpreter's own `SUCCEEDED` / `DEGRADED`
   * are folded to `COMPLETED` + the `degraded` flag before they get this far.
   */
  readonly runStatus?: GoverningRunStatus;
  /** True when a COMPLETED run finished with at least one degraded or skipped-for-cause node. */
  readonly degraded?: boolean;
  /** The interpreter's own terminal reason. PHI-free; absent when the envelope carried none. */
  readonly terminalReason?: string;
  /** When the run ended, ISO-8601. */
  readonly endedAt?: string;
}

/** The persisted run vocabulary. Never `SUCCEEDED`/`DEGRADED` — those are interpreter words. */
export type GoverningRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT';

const GOVERNING_RUN_STATUSES: readonly GoverningRunStatus[] = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT'];

/** The governing run of a consultation — the canonical shape lives in `@arcaai/types`. */
export type { GoverningRunSummary } from '@arcaai/types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `true` when the consultation's metadata carries a WELL-FORMED Substrate-B
 * marker. A malformed or partial marker reads as ABSENT — the fail-safe
 * direction is "Substrate A governs", never "nobody governs".
 */
export function tenantWorkflowGoverns(metadata: unknown): boolean {
  return readGoverningEngineMarker(metadata) !== null;
}

/**
 * the marker's CONTENTS, for the discovery route, or `null` when no
 * well-formed marker is present.
 *
 * `tenantWorkflowGoverns` is defined in terms of this rather than beside it on
 * purpose: discovery reporting "the default engine governs" while the loop gate
 * stands Substrate A down (or the reverse) would be a lie in the one place a
 * caller looks to find out which engine is writing their document. One
 * well-formedness rule, one place, two readers.
 *
 * A partial marker reads as ABSENT, matching the gate's fail-safe direction:
 * "Substrate A governs", never "nobody governs".
 */
export function readGoverningEngineMarker(metadata: unknown): GoverningEngineMarker | null {
  if (!isPlainObject(metadata)) return null;

  const marker = metadata[GOVERNING_ENGINE_METADATA_KEY];
  if (!isPlainObject(marker)) return null;

  if (marker.engine !== TENANT_WORKFLOW_GOVERNS_MARKER) return null;
  if (typeof marker.workflowRunId !== 'string' || marker.workflowRunId.length === 0) return null;

  return {
    workflowRunId: marker.workflowRunId,
    workflowDefinitionSlug: typeof marker.workflowDefinitionSlug === 'string' ? marker.workflowDefinitionSlug : '',
    decidedAt: typeof marker.decidedAt === 'string' ? marker.decidedAt : undefined,
    // Each read independently, and each ABSENT rather than defaulted, because a marker written
    // before these fields existed must not claim an outcome it never observed. `governingRunOf`
    // below is the one place absence is turned into a rendered value.
    ...(isGoverningRunStatus(marker.runStatus) ? { runStatus: marker.runStatus } : {}),
    ...(marker.degraded === true ? { degraded: true } : {}),
    ...(typeof marker.terminalReason === 'string' ? { terminalReason: marker.terminalReason } : {}),
    ...(typeof marker.endedAt === 'string' ? { endedAt: marker.endedAt } : {}),
  };
}

function isGoverningRunStatus(value: unknown): value is GoverningRunStatus {
  return typeof value === 'string' && (GOVERNING_RUN_STATUSES as readonly string[]).includes(value);
}

/**
 * The consultation's governing run, as every surface renders it — or `null` when the default
 * engine governs.
 *
 * Pure, and derived from the PERSISTED marker rather than from a live harness call, so a
 * consultation GET costs nothing extra and one harness outage cannot make every read fail.
 *
 * The three defaults are the whole point of having one function:
 *
 *   * no `runStatus` -> `RUNNING`. A run that has not been observed to end, and a marker written
 *     before the field existed, are indistinguishable and must render identically;
 *   * no `degraded` -> `false`. "Nobody has told us otherwise" is not "there were warnings";
 *   * `failureReason` is `terminalReason ?? null`, NEVER a fabricated sentence. A failed run with
 *     no reason on its envelope says nothing rather than something invented.
 */
export function governingRunOf(metadata: unknown): GoverningRunSummary | null {
  const marker = readGoverningEngineMarker(metadata);
  if (marker === null) return null;

  return {
    workflowDefinitionSlug: marker.workflowDefinitionSlug,
    workflowRunId: marker.workflowRunId,
    status: marker.runStatus ?? 'RUNNING',
    degraded: marker.degraded === true,
    decidedAt: marker.decidedAt ?? '',
    failureReason: marker.terminalReason ?? null,
  };
}

/**
 * Merge the marker into existing metadata, preserving every other key.
 *
 * A non-object existing value (never produced by `OpenConsultationRequest`,
 * whose `metadata` is `@IsObject()`) is not carried forward — there is no
 * lossless place to put it, and inventing one would be worse than the loud,
 * documented drop.
 */
export function withGoverningEngineMarker(metadata: unknown, marker: GoverningEngineMarker): JsonObject {
  return {
    ...(isPlainObject(metadata) ? metadata : {}),
    [GOVERNING_ENGINE_METADATA_KEY]: {
      engine: TENANT_WORKFLOW_GOVERNS_MARKER,
      workflowRunId: marker.workflowRunId,
      workflowDefinitionSlug: marker.workflowDefinitionSlug,
      decidedAt: marker.decidedAt ?? new Date().toISOString(),
      // The terminal fields are written only when there is something to say, so a marker
      // stamped at DISPATCH is byte-identical to the one this wrote before they existed.
      ...(marker.runStatus ? { runStatus: marker.runStatus } : {}),
      ...(marker.degraded === true ? { degraded: true } : {}),
      ...(marker.terminalReason ? { terminalReason: marker.terminalReason } : {}),
      ...(marker.endedAt ? { endedAt: marker.endedAt } : {}),
    },
  };
}
