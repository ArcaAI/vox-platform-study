import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import {
  HarnessGatewayService,
  HarnessInternalService,
  IWorkflowRunService,
  TenantSettingsService,
  createWorkerSession,
  deliveredRunResultFrom,
  interpreterSessionId,
  isDeliveredRunResult,
  terminalStatusOf,
} from '@arcaai/applications';
import type { DeliveredRunResult, IActiveUserContext } from '@arcaai/applications';
import { RESUME_FROM_BEGINNING, parseStoredRunEvent } from '@arcaai/async-contract';
import { ClsService } from 'nestjs-cls';
import { runCompletedCountsFromPayload, runCompletedCountsFromStages } from './run-completed-counts';
import type { RunCompletedCounts } from './run-completed-counts';
import { RunEventStreamHub } from './run-event-stream-hub';
import { RunEventFold, terminalOutcomeOf } from './run-protocol-delivery';
import { terminalCheckIntervalMs } from './run-stream-delivery';
import { runEventStreamKey } from './workflow-run-event';

export { runCompletedCountsFromPayload, runCompletedCountsFromStages } from './run-completed-counts';
export type { RunCompletedCounts } from './run-completed-counts';

/** How long ONE watcher stays attached before giving up — a run's own ceiling, not a poll interval. */
export const RUN_COMPLETION_WATCH_CEILING_MS = 6 * 60 * 60 * 1000;
/** A single read waits this long for new entries before re-checking liveness. */
const RUN_COMPLETION_BLOCK_MS = 15_000;
/** R-2 — backoff after a failed read: doubles from the floor to the cap, reset on success. */
export const RUN_COMPLETION_RETRY_FLOOR_MS = 250;
export const RUN_COMPLETION_RETRY_CAP_MS = 30_000;
/** Watchers per process. A run past the cap is reconciled by the next status read, as before. */
export const RUN_COMPLETION_MAX_WATCHERS = 256;

/**
 * `WorkflowRunCompletionService` — TASK-864 §3.3, the fix for finding G9.
 *
 * Until now a run's TERMINAL status reached the read model only when someone READ it
 * (`getRunStatus` → `syncTerminalStatus`): a fire-and-forget `mode=async` run with no reader
 * stayed `RUNNING` forever, and no run-completed webhook could ever fire. This service is the
 * background consumer that closes that: after every invoke it attaches a watcher to the run's
 * event stream (`wf:run:<runId>:events`, the SAME transport the SSE route reads — one producer,
 * one terminal definition), detached from any HTTP connection, and on `workflow.run.completed`
 * calls `recordRunFinished` inside a CLS context carrying the run's tenant — which is what makes
 * the resulting `WorkflowRun` sys-event fan out to that tenant's webhooks.
 *
 * Process-local and bounded rather than a BullMQ job: the transport is already durable
 * (Temporal + the retained stream), a watcher is one blocking `XREAD` on a dedicated connection,
 * and a run that outlives the ceiling or a restart is still reconciled by the next status read,
 * exactly as before. Recorded as a deviation from the ticket's "BullMQ processor" wording.
 *
 * TASK-1038: reads go through the shared `RunEventStreamHub` (R-1 — a watcher no longer holds a
 * place in a per-service connection queue). A failed read is RETRIED with exponential backoff
 * instead of silently ending the watcher (R-2), and an idle watcher re-asks the harness for the
 * run's status every `workflowRuns.streamTerminalCheckSeconds`, so a completion event that was
 * lost still reaches the read model. The completed event's `payload.result` — the delivered
 * output, inline or as a claim-check ref — is persisted as `WorkflowRun.resultRef` (D-I).
 */
@Injectable()
export class WorkflowRunCompletionService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkflowRunCompletionService.name);
  private readonly watching = new Map<string, Promise<void>>();
  private readonly shutdown = new AbortController();

  constructor(
    @Inject(IWorkflowRunService) private readonly workflowRunService: IWorkflowRunService,
    private readonly cls: ClsService<IActiveUserContext>,
    // TASK-1038 — the shared multiplexed reader. `@Optional()`: absent (or no Redis), no watcher
    // is attached and the next status read reconciles the run, exactly as before.
    @Optional() private readonly hub?: RunEventStreamHub,
    // TASK-946 OD-4 — the consultation lifecycle's single writer for this outcome. `@Optional()`
    // so a Nest context without the harness-internal plane still records run terminality; absent
    // ⇒ a failed consultation run leaves the consultation to the 24h timeout sweep, which is the
    // pre-existing behaviour rather than a new failure.
    @Optional() private readonly harnessInternal?: HarnessInternalService,
    // TASK-1038 R-2 — the idle re-check asks the harness directly; there is no slug or caller
    // here, so the exposure plane's `getRunStatus` is not the right door. Absent ⇒ no re-check.
    @Optional() private readonly harnessGateway?: HarnessGatewayService,
    @Optional() private readonly settings?: TenantSettingsService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.shutdown.abort();
  }

  /** Attach a watcher for `runId`. Idempotent; never throws; returns whether one is attached. */
  watch(tenantId: string, runId: string, consultationId?: string | null): boolean {
    if (this.shutdown.signal.aborted || this.watching.has(runId)) return this.watching.has(runId);
    if (this.watching.size >= RUN_COMPLETION_MAX_WATCHERS) return false;
    const hub = this.hub;
    if (!hub?.available()) return false;
    const task = this.consume(hub, tenantId, runId, consultationId ?? null)
      .catch((err) => this.logger.warn({ message: 'run completion watcher failed', runId, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => this.watching.delete(runId));
    this.watching.set(runId, task);
    return true;
  }

  /** Exposed for tests and the status route's own reconciliation. */
  get activeWatchers(): number {
    return this.watching.size;
  }

  private async consume(hub: RunEventStreamHub, tenantId: string, runId: string, consultationId: string | null): Promise<void> {
    const streamKey = runEventStreamKey(runId);
    const deadline = Date.now() + RUN_COMPLETION_WATCH_CEILING_MS;
    const checkEveryMs = terminalCheckIntervalMs(this.settings);
    const signal = this.shutdown.signal;
    let lastCheck = Date.now();
    let backoffMs = 0;
    let cursor = RESUME_FROM_BEGINNING;
    const fold = new RunEventFold();

    while (!signal.aborted && Date.now() < deadline) {
      let entries;
      try {
        entries = await hub.read(streamKey, cursor, {
          timeoutMs: Math.min(RUN_COMPLETION_BLOCK_MS, checkEveryMs, Math.max(1, deadline - Date.now())),
          signal,
        });
        backoffMs = 0;
      } catch (err) {
        // R-2 — a transient Redis failure used to END the watcher, leaving the run `RUNNING` in
        // the read model until someone happened to read it. Retry instead; the stream is durable.
        backoffMs = Math.min(RUN_COMPLETION_RETRY_CAP_MS, Math.max(RUN_COMPLETION_RETRY_FLOOR_MS, backoffMs * 2));
        this.logger.warn({
          message: 'run completion watcher read failed — retrying',
          runId,
          backoffMs,
          error: err instanceof Error ? err.message : String(err),
        });
        await abortableSleep(backoffMs, signal);
        continue;
      }

      for (const entry of entries) {
        cursor = entry.id;
        // TASK-1038 B3a — producers write protocol v2 from this release; the node events are
        // folded for the TASK-982 counts (`run.completed` does not carry them), and a pre-v2
        // `workflow.run.completed` of a run that started before the deploy still ends the watch.
        const parsed = parseStoredRunEvent(runId, entry.fields);
        if (parsed.kind === 'event') fold.apply(parsed.event);
        const outcome = terminalOutcomeOf(runId, entry.fields);
        if (outcome === null) continue;
        const status = terminalStatusOf(outcome.status);
        if (status === null) return;
        void hub.expireAfterTerminal(runId);
        const counts = outcome.legacyPayload ? runCompletedCountsFromPayload(outcome.legacyPayload) : (fold.counts() ?? {});
        await this.recordTerminal(
          tenantId,
          runId,
          status,
          outcome.reason ?? outcome.status,
          outcome.occurredAt,
          consultationId,
          counts,
          deliveredRunResultFrom({ result: outcome.result }),
        );
        return;
      }

      if (entries.length === 0 && !signal.aborted && Date.now() - lastCheck >= checkEveryMs) {
        lastCheck = Date.now();
        if (await this.reconcileFromHarness(hub, tenantId, runId, consultationId, fold)) return;
      }
    }
  }

  /**
   * R-2 — the terminal fallback. The run's completion event never reached its stream (or was
   * trimmed away); ask the harness. A terminal answer is recorded with what the harness knows —
   * no result, which stays as it is rather than being invented.
   *
   * TASK-1036 (lane B6b) — the TASK-982 counts are no longer dropped on this path: the node events
   * this watcher folded are the run's own record (whole-run only, `fold.counts()`); failing that,
   * the harness state query's settled `stages` are. Neither ⇒ the columns stay untouched.
   */
  private async reconcileFromHarness(
    hub: RunEventStreamHub,
    tenantId: string,
    runId: string,
    consultationId: string | null,
    fold?: RunEventFold,
  ): Promise<boolean> {
    if (!this.harnessGateway) return false;
    // swallow-ok: the idle re-check is a fallback; an unreachable harness means "ask again next interval", never a terminal status.
    const upstream = await this.harnessGateway.getWorkflowRun(runId).catch(() => null);
    const status = terminalStatusOf(upstream?.status);
    if (!upstream || status === null) return false;
    this.logger.warn({
      message: 'run reached a terminal state without a completion event on its stream — recording it from the harness',
      runId,
      status,
    });
    void hub.expireAfterTerminal(runId);
    const folded = fold?.counts();
    const counts = folded && (folded.nodeCount ?? 0) > 0 ? folded : runCompletedCountsFromStages(upstream.stages);
    await this.recordTerminal(tenantId, runId, status, String(upstream.status), upstream.endedAt ?? new Date().toISOString(), consultationId, counts);
    return true;
  }

  /**
   * Apply ONE run's terminal outcome. The watcher loop's only side effect, and the seam this
   * service's tests drive directly (there is no other way to reach it without a live Redis).
   *
   * TWO INDEPENDENT WRITES, deliberately. The read-model row and the consultation's lifecycle
   * are different systems of record, and on 2026-09-10 the failure of the first is exactly what
   * left the second stranded. Each is therefore attempted and logged on its own: a run row that
   * cannot be resolved must not stop a consultation from reaching a terminal state, and a
   * consultation that refuses the transition must not lose the run's terminal status.
   *
   * TASK-982 — the four settled-node counts now ride the SAME `workflow.run.completed` payload
   * (`apps/harness/.../interpreter/activities.py::_envelope_for`) and are passed through verbatim
   * to `recordRunFinished`; `undefined` (an older interpreter build, or a field the payload never
   * carried) leaves the corresponding column/bag entry untouched, exactly as before this change.
   */
  async recordTerminal(
    tenantId: string,
    runId: string,
    status: 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT',
    reason: string,
    endedAt: string,
    consultationId: string | null,
    counts: RunCompletedCounts = {},
    // TASK-1038 D-I — the run's delivered output from the completed event, already validated by
    // `deliveredRunResultFrom`. `undefined` leaves `WorkflowRun.resultRef` untouched.
    result?: DeliveredRunResult,
  ): Promise<void> {
    // A CLS context carrying the run's tenant: `broadcastSysEvent` stamps `tenantId` from CLS,
    // and the webhook matcher finds a tenant's subscriptions by it. Without this the event would
    // carry the SYSTEM tenant and fan out to no one — the same reason the delivery processor
    // opens a worker session.
    await this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ tenantId, kind: 'workflow-run-completion' }));

      try {
        await this.workflowRunService.recordRunFinished({
          tenantId,
          // `recordRunFinished` resolves BOTH conventional session keys (TASK-946 D3), so a
          // consultation-dispatched run — anchored as `wf-<runId>` — reaches its own row.
          sessionId: interpreterSessionId(runId),
          runId,
          status,
          endedAt: new Date(endedAt),
          terminalReason: reason,
          consultationId,
          nodeCount: counts.nodeCount,
          failedNodeCount: counts.failedNodeCount,
          degradedNodeCount: counts.degradedNodeCount,
          skippedNodeCount: counts.skippedNodeCount,
          ...(isDeliveredRunResult(result) ? { resultRef: result as unknown as Record<string, unknown> } : {}),
        });
      } catch (err) {
        this.logger.warn({
          message: 'run terminal status could not be recorded on the run read model',
          runId,
          status,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // TASK-946 OD-4 — a governed consultation whose run ended with no clinical result reaches
      // `CLOSED_INCOMPLETE` instead of sitting in `DRAINING` until the 24h sweep. `COMPLETED`
      // (SUCCEEDED/DEGRADED) changes nothing: `persistDraft`/`finalizeAssurance` own success.
      // `CANCELED` is likewise left alone — whoever cancelled the run owns what happens next.
      if (consultationId && (status === 'FAILED' || status === 'TIMED_OUT')) {
        try {
          await this.harnessInternal?.failGovernedRun(consultationId, { tenantId, runId, status, reason, at: new Date(endedAt) });
        } catch (err) {
          this.logger.warn({
            message: 'governed consultation could not be closed after its run failed — it falls back to the session-timeout sweep',
            runId,
            consultationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // The SUCCESSFUL half of the same marker. `persistDraft` / `finalizeAssurance` already own
      // what a completed run MEANS for the consultation's lifecycle; what they do not carry is
      // that the RUN reached a terminal state at all, so the marker read back by every
      // consultation surface said `RUNNING` for a run that had finished hours earlier.
      //
      // The write itself is delegated: `Consultation.metadata`'s marker shape belongs to
      // `@arcaai/applications` (`governing-engine.ts`), and a second writer here would drift from
      // `governingRunOf`. Its own method never throws, so this try/catch only covers a broken
      // stub. `CANCELED` is deliberately absent — whoever cancelled the run owns what follows.
      if (consultationId && status === 'COMPLETED') {
        try {
          await this.harnessInternal?.recordGovernedRunCompleted(consultationId, {
            tenantId,
            runId,
            // ABSENT counts are read as "no warnings", never as unknown: an interpreter build
            // that emits none must not make every run look degraded, or look suspiciously clean.
            degraded: (counts.degradedNodeCount ?? 0) > 0,
            at: new Date(endedAt),
          });
        } catch (err) {
          this.logger.warn({
            message: 'governed run completed but its outcome could not be stamped on the consultation — the run row still carries it',
            runId,
            consultationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
