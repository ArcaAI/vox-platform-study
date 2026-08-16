import { Inject, Injectable, Logger } from '@nestjs/common';
import { IWorkflowSandboxRunService } from '@arcaai/applications';
import { ClsService } from 'nestjs-cls';
import type { Response } from 'express';
import { buildWorkflowSandboxRunEventEnvelope, formatSandboxRunSseFrame, isTerminalSandboxRunStatus } from './workflow-sandbox-run-event';

/** Mirrors `../workflows/workflow-stream.service.ts`'s poll interval exactly — same upstream,
 *  same reasoning (no push channel to wait on). */
export const WORKFLOW_SANDBOX_STREAM_POLL_INTERVAL_MS = 2_000;

/** Mirrors `../workflows/workflow-stream.service.ts`'s heartbeat cadence. */
export const WORKFLOW_SANDBOX_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * `WorkflowSandboxStreamService` — the gateway-side half of
 * `GET admin/workflow-definitions/:definitionId/sandbox-runs/:runId/stream` (TASK-721 Task 7).
 *
 * A near-verbatim sibling of `../workflows/workflow-stream.service.ts` (TASK-722 Task 8), for
 * the Workbench's definitionId-keyed sandbox runs instead of the exposure plane's slug-keyed
 * ones. See that class's doc comment for why this is a disclosed POLL BRIDGE (the interpreter
 * dispatcher has no live event-stream producer) rather than a byte-for-byte SSE proxy, and why
 * there is no resume via `Last-Event-ID` — a reconnect re-polls the CURRENT live status, a full
 * resync rather than a gap-fill.
 */
@Injectable()
export class WorkflowSandboxStreamService {
  private readonly logger = new Logger(WorkflowSandboxStreamService.name);

  constructor(
    @Inject(IWorkflowSandboxRunService) private readonly workflowSandboxRunService: IWorkflowSandboxRunService,
    private readonly clsService: ClsService,
  ) {}

  async stream(definitionId: string, runId: string, res: Response): Promise<void> {
    // Pre-stream ownership check BEFORE any header is written — same race-avoidance posture as
    // `WorkflowStreamService.stream` (nothing is written until this resolves).
    const first = await this.workflowSandboxRunService.getRunStatus(definitionId, runId);
    const tenantId = this.clsService.get('tenantId') as string;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    this.writeSnapshot(res, tenantId, first);
    if (isTerminalSandboxRunStatus(first.status)) {
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
      void this.pollOnce(definitionId, runId, res, tenantId, end);
    }, WORKFLOW_SANDBOX_STREAM_POLL_INTERVAL_MS);

    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(':keepalive\n\n');
    }, WORKFLOW_SANDBOX_STREAM_HEARTBEAT_INTERVAL_MS);

    res.on('close', end);
  }

  private async pollOnce(definitionId: string, runId: string, res: Response, tenantId: string, end: () => void): Promise<void> {
    if (res.writableEnded) {
      end();
      return;
    }
    try {
      const status = await this.workflowSandboxRunService.getRunStatus(definitionId, runId);
      this.writeSnapshot(res, tenantId, status);
      if (isTerminalSandboxRunStatus(status.status)) {
        end();
      }
    } catch (err) {
      // Never forward the raw error to the client — it may echo interpreter-internal detail.
      this.logger.warn({
        message: 'Workbench sandbox run stream poll failed — ending stream',
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      end();
    }
  }

  private writeSnapshot(res: Response, tenantId: string, status: Parameters<typeof buildWorkflowSandboxRunEventEnvelope>[1]): void {
    if (res.writableEnded) return;
    const envelope = buildWorkflowSandboxRunEventEnvelope(tenantId, status);
    res.write(formatSandboxRunSseFrame(envelope));
  }
}
