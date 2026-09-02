import {
  InvokeWorkflowRequest,
  IWorkflowExposureService,
  WorkflowInvokeResponse,
  WorkflowRunCancelResponse,
  WorkflowRunResponseMode,
  WorkflowRunStatusResponse,
  WorkflowSummaryListResponse,
} from '@arcaai/applications';
import { Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Body, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CanCreate, CanList, CanRead, CanUpdate, RequiredScopes } from '../../decorators';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';
import type { RequestWithAuth } from '../../types/request-with-auth';
import { deliverRun } from './deliver-run';
import { WorkflowStreamService } from './workflow-stream.service';

/**
 * `WorkflowsController` — the exposure plane (TASK-722): a tenant's
 * PUBLISHED workflow versions become products, invokable over REST with
 * scoped API keys.
 *
 * ONE generic route family (S-1) — `/api/v1/workflows/:slug/…` — never
 * per-workflow generated routes. Every route carries BOTH an authorization
 * decorator (the deny-by-default boot audit, rule 05) AND `@RequiredScopes`
 * (independent, additive gates — the former the JWT/CASL path, the latter
 * the API-key path; `unified-auth.guard.ts` enforces only ONE per
 * authentication method actually used on a given request).
 *
 * `tenantId` NEVER appears as a route/query/body parameter here (S-3) — the
 * service resolves it exclusively from CLS. Cross-tenant / unpublished /
 * nonexistent `slug` or `runId` -> 404 (never 403, rule 05 §Errors); a scope
 * violation on the API-key path -> 403 (`UnifiedAuthGuard.enforceApiKeyScopes`).
 */
@ApiBearerAuth()
@ApiTags('workflows')
@Controller('workflows')
export class WorkflowsController {
  constructor(
    @Inject(IWorkflowExposureService) private readonly workflowExposureService: IWorkflowExposureService,
    private readonly workflowStreamService: WorkflowStreamService,
  ) {}

  @Get()
  @CanList('WorkflowDefinition')
  @RequiredScopes('workflow:definition:read')
  @ApiOperation({ summary: "The tenant's published + active, invokable workflows (slug + identity — no per-definition input schema exists yet)." })
  @ApiResponse({ status: 200, type: WorkflowSummaryListResponse })
  async list(): Promise<WorkflowSummaryListResponse> {
    return this.workflowExposureService.list();
  }

  @Post(':slug/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @CanCreate('WorkflowRun')
  @RequiredScopes('workflow:run:write')
  @Throttle({ heavy: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: "Start a run of the tenant's active published version of :slug. The canonical invocation entry point.",
    description:
      'The handler every non-clinical invocation surface converges on — REST, webhook relay, `@arcaai/vox` and `@arcaai/vox-node`. ' +
      '**Response mode** is chosen with `?mode=`: `async` (default) answers 202 with `runId` + `statusUrl` + `streamUrl`; ' +
      '`blocking` waits for the run to finish and answers 200 with the terminal status, or **504** at a hard ceiling of ~60s ' +
      'with a pointer to streaming; `stream` answers `text/event-stream` directly, the same snapshot-then-delta contract as ' +
      '`GET :slug/runs/:runId/stream`. ' +
      '**Idempotency**: send `Idempotency-Key` and a retry JOINS the existing run instead of starting (and billing) a second — ' +
      'the run id is derived from (tenant, slug, key) and Temporal refuses a duplicate execution under it. ' +
      '**Disconnecting never cancels the run**: it is a durable execution, so abandoning the HTTP request abandons only your view of it. ' +
      'To run a workflow AGAINST A CONSULTATION, use `POST /consultations/{consultationId}/workflows/{slug}/runs` — a consultation ' +
      'graph is not invocable here, and consultation identity is never accepted in the request body.',
  })
  @ApiParam({ name: 'slug' })
  @ApiQuery({ name: 'mode', required: false, enum: ['async', 'blocking', 'stream'], description: 'Response mode. Default `async`.' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retry-safe key. The same value joins the existing run.' })
  @ApiResponse({ status: 202, type: WorkflowInvokeResponse, description: '`mode=async` — the run handle.' })
  @ApiResponse({ status: 200, type: WorkflowRunStatusResponse, description: '`mode=blocking` — the terminal run status.' })
  @ApiResponse({ status: 400, description: 'Reserved run-identity field supplied in `input` (e.g. `consultationId`) — it is never accepted here.' })
  @ApiResponse({ status: 404, description: 'Unknown, unpublished, cross-tenant, or non-exposable slug.' })
  @ApiResponse({ status: 403, description: 'Scope violation.' })
  @ApiResponse({ status: 429, description: 'monthlyWorkflowInvocations quota exhausted.' })
  @ApiResponse({ status: 504, description: '`mode=blocking` ceiling reached — the run continues; switch to streaming or poll `statusUrl`.' })
  async startRun(
    @Param('slug') slug: string,
    @Body() dto: InvokeWorkflowRequest,
    @Req() req: RequestWithAuth,
    @Res({ passthrough: true }) res: Response,
    @Query('mode') mode?: WorkflowRunResponseMode,
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ): Promise<WorkflowInvokeResponse | WorkflowRunStatusResponse | void> {
    const started = await this.workflowExposureService.invoke(slug, dto, { idempotencyKey, apiKeyId: req.apiKey?.id });
    return deliverRun(this.workflowStreamService, slug, started, res, mode);
  }

  @Post(':slug/invoke')
  @HttpCode(HttpStatus.ACCEPTED)
  @CanCreate('WorkflowRun')
  @RequiredScopes('workflow:run:write')
  // First `heavy`-tier consumer in the codebase (README §2 §Rate limiting) — the pre-registered
  // `heavy` tier (20 req/60s, `rate-limit-config.service.ts`) is a deliberate, reviewed choice
  // for a surface that starts a durable Temporal workflow per call. Per-key `ApiKey.rateLimit`
  // is the control that reaches API-key traffic specifically (R-3) — set a conservative default
  // for workflow-scoped keys; this tier is the platform-wide backstop.
  @Throttle({ heavy: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: "DEPRECATED alias of POST :slug/runs. Start a run of the tenant's active published version of :slug.",
    description:
      'Superseded by `POST :slug/runs` (TASK-850), which is the same handler plus response modes. Retained because the ' +
      'shipped `@arcaai/vox-node` contract and the seeded examples call this path; it delegates verbatim and always ' +
      'answers `mode=async`. New integrations should use `:slug/runs`. ' +
      "If the published definition selects a cloud AI provider (via the tenant's own `smr.*` task-default " +
      "configuration — see AI Task Defaults), this run sends the tenant's data to that vendor. Public exposure " +
      'does NOT restrict provider choice: TASK-720 R-4 (owner ruling, 2026-08-20) allows a publicly-exposed ' +
      'workflow to select a cloud provider — the tenant carries that egress risk, consistent with the ' +
      "platform's BYO-first posture. Configure/disclose provider choice where the tenant sets it (AI Task " +
      'Defaults), not only here.',
  })
  @ApiParam({ name: 'slug' })
  @ApiResponse({ status: 202, type: WorkflowInvokeResponse })
  @ApiResponse({ status: 404, description: 'Unknown, unpublished, or cross-tenant slug.' })
  @ApiResponse({ status: 403, description: 'Scope violation.' })
  @ApiResponse({ status: 429, description: 'monthlyWorkflowInvocations quota exhausted.' })
  async invoke(
    @Param('slug') slug: string,
    @Body() dto: InvokeWorkflowRequest,
    @Req() req: RequestWithAuth,
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ): Promise<WorkflowInvokeResponse> {
    return this.workflowExposureService.invoke(slug, dto, { idempotencyKey, apiKeyId: req.apiKey?.id });
  }

  @Get(':slug/runs/:runId')
  @CanRead('WorkflowRun')
  @RequiredScopes('workflow:run:read')
  @ApiOperation({ summary: 'Live run status + result (queried from the interpreter dispatcher).' })
  @ApiParam({ name: 'slug' })
  @ApiParam({ name: 'runId' })
  @ApiResponse({ status: 200, type: WorkflowRunStatusResponse })
  @ApiResponse({ status: 404, description: "Cross-tenant run id, or a runId that does not belong to slug's lineage." })
  async getRunStatus(@Param('slug') slug: string, @Param('runId') runId: string): Promise<WorkflowRunStatusResponse> {
    return this.workflowExposureService.getRunStatus(slug, runId);
  }

  @Post(':slug/runs/:runId/cancel')
  @HttpCode(HttpStatus.OK)
  @CanUpdate('WorkflowRun')
  @RequiredScopes('workflow:run:write')
  @ApiOperation({ summary: "Cancel a run — sends the interpreter's allow-listed cancel signal, never a caller-supplied signal name." })
  @ApiParam({ name: 'slug' })
  @ApiParam({ name: 'runId' })
  @ApiResponse({ status: 200, type: WorkflowRunCancelResponse })
  @ApiResponse({ status: 404, description: "Cross-tenant run id, or a runId that does not belong to slug's lineage." })
  async cancelRun(@Param('slug') slug: string, @Param('runId') runId: string): Promise<WorkflowRunCancelResponse> {
    return this.workflowExposureService.cancelRun(slug, runId);
  }

  @Get(':slug/runs/:runId/stream')
  @CanRead('WorkflowRun')
  @RequiredScopes('workflow:run:read')
  @StreamScope({ namespace: 'workflow_run', param: 'runId' })
  @ApiOperation({
    summary: 'SSE progress + result. Accepts `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` (scope `workflow_run:<runId>`).',
    description:
      "Snapshot-then-delta. The first frame is a `workflow.run.progress`/`workflow.run.completed` snapshot of current status; every frame after it is an event PUSHED by the interpreter as it happens (node started/completed/failed, run completed), carried on the run event stream. Each pushed frame's `id` is an opaque resume token — echo it back as `Last-Event-ID` to resume exactly where you left off. The snapshot frame carries no `id` (there is no stream position to name). If your position has aged out of the retained window, the stream re-sends a snapshot rather than silently skipping the gap.",
  })
  @ApiParam({ name: 'slug' })
  @ApiParam({ name: 'runId' })
  // Declared explicitly rather than left to the Swagger plugin's inference, which emits every
  // header/query parameter as `required: true` (see the `Idempotency-Key` header on `invoke`).
  // Both of these are OPTIONAL by construction — a first connect sends neither — and documenting
  // a resume cursor as mandatory would tell a client to invent one, which is the exact thing
  // async-contract §3.6 forbids.
  @ApiHeader({ name: 'Last-Event-ID', required: false, description: 'Opaque resume token from a previous frame’s `id`. Omit on a first connect.' })
  @ApiQuery({
    name: 'lastEventId',
    required: false,
    description: 'Fallback for a client that cannot set headers. The header wins when both are present.',
  })
  @ApiResponse({ status: 404, description: "Cross-tenant run id, or a runId that does not belong to slug's lineage." })
  async streamRunStatus(
    @Param('slug') slug: string,
    @Param('runId') runId: string,
    @Res() res: Response,
    // The SSE spec sends this header on reconnect by itself; the query parameter is the manual
    // escape hatch for a client that cannot set headers (the same fallback `apps/text`'s stream
    // endpoint offers). NEVER a JWT — this is a stream cursor, not a credential.
    @Headers('Last-Event-ID') lastEventIdHeader?: string,
    @Query('lastEventId') lastEventIdQuery?: string,
  ): Promise<void> {
    await this.workflowStreamService.stream(slug, runId, res, lastEventIdHeader ?? lastEventIdQuery);
  }
}
