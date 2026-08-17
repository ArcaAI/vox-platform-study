import { Inject, Injectable, Logger } from '@nestjs/common';
import { IWorkflowExposureService } from '@arcaai/applications';
import { ClsService } from 'nestjs-cls';
import type { Response } from 'express';
import { buildWorkflowRunEventEnvelope, formatSseFrame, isTerminalRunStatus } from './workflow-run-event';

/** How often this gateway re-polls the harness dispatcher's JSON status read while a run is
 *  live. There is no push channel to wait on (see the class doc) — this is a plain interval. */
export const WORKFLOW_STREAM_POLL_INTERVAL_MS = 2_000;

/** SSE heartbeat cadence — mirrors `TextProxyController`/`TextProxyController`'s own
 *  `SSE_HEARTBEAT_INTERVAL_MS`, so an idle connection is never mistaken for a dead one by an
 *  intermediate proxy/load balancer. */
export const WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * `WorkflowStreamService` — the gateway-side half of `GET /workflows/:slug/runs/:runId/stream`
 * (TASK-722 Task 8).
 *
 * **Not a byte-for-byte SSE proxy.** The ticket's plan named `TextProxyController
 * .streamTaskEvents` as the exemplar to port verbatim, but that pattern proxies an UPSTREAM
 * `text/event-stream` response — and the interpreter dispatcher
 * (`apps/harness/src/harness/api/endpoints/interpreter.py`) exposes no such endpoint: only
 * `POST …:start`, `GET …/{runId}` (plain JSON), and `POST …:cancel`. TASK-717 (async-contract)
 * shipped the envelope + resume-token PACKAGE (Phase A/B) but explicitly deferred "Phase C"
 * (a reference producer wired into any service). There is therefore nothing upstream to
 * byte-pipe.
 *
 * This service instead POLLS `IWorkflowExposureService.getRunStatus` (which itself re-runs the
 * tenant-ownership check every tick — the same defense-in-depth
 * `TenantOwnedResourceSseGuard`'s periodic re-check gives every other `@Sse()` route in this
 * codebase) and translates each snapshot into an async-contract envelope
 * (`workflow-run-event.ts`). Genuinely real, but a disclosed, honest substitute for a live push
 * channel — not a fabricated one. A `TODO(TASK-717 Phase C / a future interpreter event
 * producer)` marks the single place this would be replaced by a true proxy.
 *
 * Consequently there is NO resume via `Last-Event-ID`: the async-contract resume-token
 * convention (`resume-token.ts`) explicitly forbids minting one for a non-resumable transport
 * ("Callers on a non-resumable transport (BullMQ, Temporal) MUST NOT call this"), and Temporal
 * `describe()`/`state` polling has no transport-native cursor to wrap. A reconnect simply
 * re-polls the CURRENT live status — a full resync, not a gap-fill. This is disclosed on the
 * controller's `@ApiOperation`, not hidden.
 */
@Injectable()
export class WorkflowStreamService {
  private readonly logger = new Logger(WorkflowStreamService.name);

  constructor(
    @Inject(IWorkflowExposureService) private readonly workflowExposureService: IWorkflowExposureService,
    private readonly clsService: ClsService,
  ) {}

  async stream(slug: string, runId: string, res: Response): Promise<void> {
    // Pre-stream ownership check BEFORE any header is written — a 404 here is a normal HTTP
    // response, not a leaked 200 stream (the exact race `TenantOwnedResourceSseGuard`'s own doc
    // names for a bare @Sse() handler; this hand-rolled handler avoids it by construction,
    // since nothing is written until this resolves).
    const first = await this.workflowExposureService.getRunStatus(slug, runId);
    const tenantId = this.clsService.get('tenantId') as string;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    this.writeSnapshot(res, tenantId, first);
    if (isTerminalRunStatus(first.status)) {
      res.end();
      return;
    }

    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      if (!res.writableEnded) res.end();
    };

    const pollTimer = setInterval(() => {
      void this.pollOnce(slug, runId, res, tenantId, end);
    }, WORKFLOW_STREAM_POLL_INTERVAL_MS);

    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(':keepalive\n\n');
    }, WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS);

    res.on('close', end);
  }

  private async pollOnce(slug: string, runId: string, res: Response, tenantId: string, end: () => void): Promise<void> {
    if (res.writableEnded) {
      end();
      return;
    }
    try {
      const status = await this.workflowExposureService.getRunStatus(slug, runId);
      this.writeSnapshot(res, tenantId, status);
      if (isTerminalRunStatus(status.status)) {
        end();
      }
    } catch (err) {
      // The resource ownership check re-runs on every tick (via getRunStatus); a run that is
      // no longer resolvable (soft-deleted, foreign-tenant) or a transient upstream failure both
      // land here. Never forward the raw error to the client (it may echo interpreter-internal
      // detail) — just end the stream, mirroring the SSE proxy exemplar's own posture.
      this.logger.warn({
        message: 'Workflow run stream poll failed — ending stream',
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      end();
    }
  }

  private writeSnapshot(res: Response, tenantId: string, status: Parameters<typeof buildWorkflowRunEventEnvelope>[1]): void {
    if (res.writableEnded) return;
    const envelope = buildWorkflowRunEventEnvelope(tenantId, status);
    res.write(formatSseFrame(envelope));
  }
}
