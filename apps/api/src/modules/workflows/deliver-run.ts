import { GatewayTimeoutException } from '@nestjs/common';
import type { WorkflowInvokeResponse, WorkflowRunResponseMode, WorkflowRunStatusResponse } from '@arcaai/applications';
import type { Response } from 'express';
import type { WorkflowStreamService } from './workflow-stream.service';

/**
 * The blocking mode's hard ceiling (TASK-850 lane A step 7).
 *
 * ~60s, and it is a CEILING rather than a timeout on the work: the run keeps going when this
 * expires. The number is chosen against what sits in front of this gateway — 60s is the default
 * `proxy_read_timeout` for nginx and the default idle timeout for most managed load balancers,
 * so waiting longer would have the connection cut somewhere the caller cannot see, producing a
 * 502/504 with no `runId` in it and no way to recover the run. Answering first, with the run
 * handle, is what keeps the failure recoverable.
 */
export const BLOCKING_MODE_CEILING_MS = 60_000;

/**
 * Deliver a started run in the caller's chosen response mode — the one implementation both
 * invocation controllers use, so the unbound and consultation-bound planes cannot drift apart
 * in how they answer.
 *
 * `async` (the default) is the pre-existing 202 contract, unchanged.
 *
 * `blocking` waits on the run-event transport (never a poll — see `awaitTerminal`) and answers
 * the terminal status, or 504. The 504 body names the alternative rather than just failing: a
 * caller that hits the ceiling needs to know the run is alive, not to assume it died.
 *
 * `stream` hands the response to `WorkflowStreamService.stream`, the SAME SSE implementation
 * `GET :slug/runs/:runId/stream` uses, including `Last-Event-ID` resume. Building a second
 * streaming path here would mean two producers, two terminal definitions and two resume
 * semantics for one run.
 *
 * **Nothing here cancels.** No mode registers a `close` handler that signals the run, and that
 * omission is the durable-execution guarantee: a client that hangs up loses its view, not its
 * work.
 */
export async function deliverRun(
  streamService: WorkflowStreamService,
  slug: string,
  started: WorkflowInvokeResponse,
  res: Response,
  mode: WorkflowRunResponseMode | undefined,
): Promise<WorkflowInvokeResponse | WorkflowRunStatusResponse | void> {
  if (mode === 'stream') {
    // `stream()` writes its own headers and ends the response, so the handler returns nothing.
    await streamService.stream(slug, started.runId, res, undefined);
    return undefined;
  }

  if (mode === 'blocking') {
    const terminal = await streamService.awaitTerminal(slug, started.runId, BLOCKING_MODE_CEILING_MS);
    if (terminal === null) {
      throw new GatewayTimeoutException(
        `Run '${started.runId}' did not finish within ${Math.round(BLOCKING_MODE_CEILING_MS / 1000)}s. ` +
          `The run is still executing — switch to streaming (${started.streamUrl}) or poll ${started.statusUrl}.`,
      );
    }
    // A completed run is a 200, not the 202 the route's default status declares.
    res.status(200);
    return terminal;
  }

  return started;
}
