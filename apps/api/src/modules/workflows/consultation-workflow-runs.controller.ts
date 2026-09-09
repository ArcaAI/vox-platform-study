import {
  InvokeWorkflowRequest,
  IWorkflowExposureService,
  WorkflowInvokeResponse,
  WorkflowRunResponseMode,
  WorkflowRunStatusResponse,
  WorkflowSummaryListResponse,
} from '@arcaai/applications';
import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Authorize, RequiredScopes, RequiredSvcScopes } from '../../decorators';
import type { RequestWithAuth } from '../../types/request-with-auth';
import { deliverRun } from './deliver-run';
import { WorkflowStreamService } from './workflow-stream.service';

/**
 * `ConsultationWorkflowRunsController` — the CONSULTATION-BOUND invocation plane.
 *
 * ## Why this is a second route family and not a body field
 *
 * A consultation workflow can write real clinical rows: eleven of the palette's thirty node types
 * declare `externalWrite`, and `consultation.persistDraft` reaches the same `persist_draft`
 * activity the live consultation workflow uses. Finding **C-8** is what happens when the target
 * of those writes is named by the caller: `POST /workflows/:slug/invoke` forwards `dto.input`
 * verbatim into `InterpreterInput.payload` with `sandbox: false`, and the interpreter's
 * external-write suppression is sandbox-only — so a `consultationId` in the body would let any
 * key-holder write into any live consultation. That is why `EXPOSURE_ALLOWED_PALETTES` refuses
 * the palette outright, and why simply widening it was not an option.
 *
 * states the invariant that resolves it, and this controller is that invariant
 * expressed as a URL:
 *
 *   > consultation identity comes from the URL and is re-resolved against the caller's tenant —
 *   > never from a caller-composed payload.
 *
 * `:consultationId` is a PATH parameter. `WorkflowExposureService` re-resolves it through
 * `IConsultationService.getById` (tenant-scoped ⇒ a foreign or unknown id is a 404) and freezes
 * the result into the run's `subject`, a field no request shape can write. A caller that puts
 * `consultationId` in `input` gets a 400, and the harness dispatcher strips those keys from the
 * payload regardless of who sent it. There is no path left from a request body to a write target.
 *
 * ## Authorization
 *
 * Two independent gates that compose as AND, per rule 05:
 *
 *   * `@Authorize(['execute', 'ConsultationWorkflow'])` — the ABILITY, bound to the human. A
 *     separate subject from `WorkflowRun` because "may run a workflow" and "may run one that
 *     writes into a consultation" are different powers.
 *   * `@RequiredScopes('workflows:execute')` — the SCOPE, bound to the credential. Deliberately
 *     NOT under the `workflow:` prefix the other three workflow scopes share: scope matching is
 *     by prefix, so a key holding bare `workflow` would otherwise inherit this plane for free.
 *   * `@RequiredSvcScopes('svc:workflows:execute')` — the same scope for the MACHINE class.
 *     Added by TASK-933 on an explicit owner decision (2026-09-09): the platform service account
 *     holds every permission `@arcaai/vox-node` needs to drive a realtime consultation, and this
 *     plane is one of them. It SUPERSEDES the recorded refusal in
 *     `service-account-scopes.registry.ts` (fourth family), whose reasoning — "it writes real
 *     `ContextItem` rows against a patient's consultation" — remains TRUE and is exactly why the
 *     grant is its own named scope in its own family rather than a side effect of any other.
 *     The plural/singular split above does the same work for the machine namespace: a
 *     `svc:workflow:*` holder does NOT reach `svc:workflows:execute`.
 *
 * Cross-tenant `consultationId` or `slug` -> 404, never 403 (rule 05 §Errors).
 */
@ApiBearerAuth()
@ApiTags('workflows')
@Controller('consultations/:consultationId/workflows')
export class ConsultationWorkflowRunsController {
  constructor(
    @Inject(IWorkflowExposureService) private readonly workflowExposureService: IWorkflowExposureService,
    private readonly workflowStreamService: WorkflowStreamService,
  ) {}

  @Get()
  @Authorize(['execute', 'ConsultationWorkflow'])
  @RequiredScopes('workflows:execute')
  @RequiredSvcScopes('svc:workflows:execute')
  @ApiOperation({
    summary: 'The published workflows runnable AGAINST a consultation.',
    description:
      'The consultation-bound catalogue. Wider than `GET /workflows` — it also lists `consultation`-palette definitions — ' +
      'and it is filtered with the SAME predicate the invoke gate enforces, so a slug listed here is a slug that runs here. ' +
      'A graph whose every node is `lane: realtime` is excluded: the durable interpreter skips those, so invoking one would ' +
      'report success for work that never happened.',
  })
  @ApiParam({ name: 'consultationId' })
  @ApiResponse({ status: 200, type: WorkflowSummaryListResponse })
  @ApiResponse({ status: 404, description: 'Unknown or cross-tenant consultation.' })
  @ApiResponse({ status: 403, description: 'Scope or ability violation.' })
  async list(@Param('consultationId') _consultationId: string): Promise<WorkflowSummaryListResponse> {
    // `_consultationId` is not passed down: listing what COULD run is not a per-consultation
    // answer, and re-resolving the id here would make discovery an existence oracle over
    // consultation ids for a caller who cannot actually invoke anything. The id stays in the URL
    // so the client's two calls (list, then run) share one shape, and the binding is resolved
    // exactly once — on the write.
    return this.workflowExposureService.list({ consultationBound: true });
  }

  @Post(':slug/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Authorize(['execute', 'ConsultationWorkflow'])
  @RequiredScopes('workflows:execute')
  @RequiredSvcScopes('svc:workflows:execute')
  // Same `heavy` tier as the unbound plane — each call starts a durable Temporal workflow.
  @Throttle({ heavy: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Run a published workflow against THIS consultation.',
    description:
      'The clinical invocation entry point: the run may read and write this consultation, and nothing else. The consultation ' +
      'is identified by the URL and re-resolved server-side against your tenant — supplying `consultationId` (or any other ' +
      'reserved run-identity field) in `input` is a 400, never a silent override. ' +
      '`?mode=` and `Idempotency-Key` behave exactly as on `POST /workflows/{slug}/runs`, including the ~60s blocking ceiling ' +
      'and the guarantee that disconnecting never cancels the run.',
  })
  @ApiParam({ name: 'consultationId' })
  @ApiParam({ name: 'slug' })
  @ApiQuery({ name: 'mode', required: false, enum: ['async', 'blocking', 'stream'], description: 'Response mode. Default `async`.' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retry-safe key. The same value joins the existing run.' })
  @ApiResponse({ status: 202, type: WorkflowInvokeResponse, description: '`mode=async` — the run handle.' })
  @ApiResponse({ status: 200, type: WorkflowRunStatusResponse, description: '`mode=blocking` — the terminal run status.' })
  @ApiResponse({ status: 400, description: 'A reserved run-identity field was supplied in `input`.' })
  @ApiResponse({ status: 404, description: 'Unknown/cross-tenant consultation or slug, or a definition not runnable on this plane.' })
  @ApiResponse({ status: 403, description: 'Scope or ability violation.' })
  @ApiResponse({ status: 429, description: 'monthlyWorkflowInvocations quota exhausted.' })
  @ApiResponse({ status: 504, description: '`mode=blocking` ceiling reached — the run continues.' })
  async startRun(
    @Param('consultationId') consultationId: string,
    @Param('slug') slug: string,
    @Body() dto: InvokeWorkflowRequest,
    @Req() req: RequestWithAuth,
    @Res({ passthrough: true }) res: Response,
    @Query('mode') mode?: WorkflowRunResponseMode,
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ): Promise<WorkflowInvokeResponse | WorkflowRunStatusResponse | void> {
    const started = await this.workflowExposureService.invoke(slug, dto, {
      idempotencyKey,
      apiKeyId: req.apiKey?.id,
      // The ONLY place this option is ever set, and it comes from the URL. See the class doc.
      consultationId,
    });
    return deliverRun(this.workflowStreamService, slug, started, res, mode);
  }
}
