import {
  InvokeWorkflowRequest,
  IWorkflowExposureService,
  ReviewDecisionRequest,
  WorkflowReviewDecisionResponse,
  WorkflowReviewResponse,
  WorkflowInvokeResponse,
  WorkflowRunCancelResponse,
  WorkflowRunResponseMode,
  WorkflowRunStatusResponse,
  WorkflowSummaryListResponse,
  type WorkflowSchemaDescription,
} from '@arcaai/applications';
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Body,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CanCreate, CanList, CanRead, CanUpdate, RequiredScopes, RequiredSvcScopes } from '../../decorators';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';
import { StreamTicketService } from '../auth/stream-ticket.service';
import { WORKFLOW_RUN_TICKET_NAMESPACE } from '../streaming/workflow-ws.gateway';
import type { RequestWithAuth } from '../../types/request-with-auth';
import { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '@arcaai/applications';
import { deliverRun } from './deliver-run';
import { WorkflowRunCompletionService } from './workflow-run-completion.service';
import { WorkflowStreamService } from './workflow-stream.service';

/**
 * TASK-930 §4 — what `POST /workflows/:slug/runs/:runId/stream-ticket` answers.
 *
 * `expiresAt` is ABSOLUTE (epoch ms), not a duration: the ticket lives 30 seconds and a client
 * that computed a deadline from a relative number would be wrong by however long the response
 * spent in flight — on a 30-second budget that is not a rounding error. It is the same field
 * `IssueStreamTicketResponse` already carries, so both minting routes answer one shape.
 */
export interface WorkflowRunStreamTicketResponse {
  ticket: string;
  /** Epoch MILLISECONDS at which the ticket stops being redeemable. */
  expiresAt: number;
  /** Always `workflow_run:<runId>` — derived here, never accepted from the wire. */
  scope: string;
  /** The socket to open with it, query string already built and encoded. */
  url: string;
}

/**
 * `WorkflowsController` — the exposure plane: a tenant's
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
    // TASK-864 (G9) — optional so the existing unit fixtures construct unchanged; absent, a run's
    // terminal status is reconciled on the next status read, exactly as before.
    @Optional() private readonly runCompletion?: WorkflowRunCompletionService,
    // TASK-930 §4 — both are GLOBAL providers in production (`StreamTicketModule` is `@Global`,
    // `nestjs-cls` provides `ClsService` app-wide), and both are `@Optional()` here only so the
    // existing positional unit fixtures keep constructing. The ticket route refuses loudly when
    // either is absent rather than minting something unattributable.
    @Optional() private readonly streamTicketService?: StreamTicketService,
    @Optional() private readonly cls?: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @CanList('WorkflowDefinition')
  @RequiredScopes('workflow:definition:read')
  @RequiredSvcScopes('svc:workflow:definition:read')
  @ApiOperation({ summary: "The tenant's published + active, invokable workflows (slug + identity — no per-definition input schema exists yet)." })
  @ApiResponse({ status: 200, type: WorkflowSummaryListResponse })
  async list(): Promise<WorkflowSummaryListResponse> {
    return this.workflowExposureService.list();
  }

  @Post(':slug/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @CanCreate('WorkflowRun')
  @RequiredScopes('workflow:run:write')
  @RequiredSvcScopes('svc:workflow:run:write')
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
    // TASK-864 §3.4: `mode` reaches the service so it can be bounded by the definition's Output
    // protocols BEFORE a run starts (400 naming the declared protocols), rather than starting a
    // run and then failing to deliver it the way the caller asked.
    const started = await this.workflowExposureService.invoke(slug, dto, { idempotencyKey, apiKeyId: req.apiKey?.id, mode });
    // TASK-864 (G9): the terminal status is recorded by a background watcher, not by a reader.
    this.runCompletion?.watch(req.user?.tenantId ?? req.tenantId ?? '', started.runId);
    return deliverRun(this.workflowStreamService, slug, started, res, mode);
  }

  @Post(':slug/invoke')
  @HttpCode(HttpStatus.ACCEPTED)
  @CanCreate('WorkflowRun')
  @RequiredScopes('workflow:run:write')
  @RequiredSvcScopes('svc:workflow:run:write')
  // First `heavy`-tier consumer in the codebase ( limiting) — the pre-registered
  // `heavy` tier (20 req/60s, `rate-limit-config.service.ts`) is a deliberate, reviewed choice
  // for a surface that starts a durable Temporal workflow per call. Per-key `ApiKey.rateLimit`
  // is the control that reaches API-key traffic specifically (R-3) — set a conservative default
  // for workflow-scoped keys; this tier is the platform-wide backstop.
  @Throttle({ heavy: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: "DEPRECATED alias of POST :slug/runs. Start a run of the tenant's active published version of :slug.",
    description:
      'Superseded by `POST :slug/runs` , which is the same handler plus response modes. Retained because the ' +
      'shipped `@arcaai/vox-node` contract and the seeded examples call this path; it delegates verbatim and always ' +
      'answers `mode=async`. New integrations should use `:slug/runs`. ' +
      "If the published definition selects a cloud AI provider (via the tenant's own `smr.*` task-default " +
      "configuration — see AI Task Defaults), this run sends the tenant's data to that vendor. Public exposure " +
      'does NOT restrict provider choice:  R-4 (owner ruling, 2026-08-20) allows a publicly-exposed ' +
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

  @Get(':slug/schema')
  @CanRead('WorkflowDefinition')
  @RequiredScopes('workflow:definition:read')
  @RequiredSvcScopes('svc:workflow:definition:read')
  @ApiOperation({
    summary:
      'The published definition`s generated contract: input/output component schemas, trigger kinds, protocols, admitted modes, and an AsyncAPI fragment for its run events (TASK-864).',
  })
  @ApiParam({ name: 'slug' })
  @ApiResponse({ status: 200, description: 'The `WorkflowSchemaDescription` — what the developer portal renders per workflow.' })
  @ApiResponse({ status: 404, description: 'Unknown, unpublished, cross-tenant, or non-exposable slug.' })
  async getSchema(@Param('slug') slug: string): Promise<WorkflowSchemaDescription> {
    return this.workflowExposureService.describe(slug);
  }

  @Get(':slug/runs/:runId')
  @CanRead('WorkflowRun')
  @RequiredScopes('workflow:run:read')
  @RequiredSvcScopes('svc:workflow:run:read')
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
  @RequiredSvcScopes('svc:workflow:run:write')
  @ApiOperation({ summary: "Cancel a run — sends the interpreter's allow-listed cancel signal, never a caller-supplied signal name." })
  @ApiParam({ name: 'slug' })
  @ApiParam({ name: 'runId' })
  @ApiResponse({ status: 200, type: WorkflowRunCancelResponse })
  @ApiResponse({ status: 404, description: "Cross-tenant run id, or a runId that does not belong to slug's lineage." })
  async cancelRun(@Param('slug') slug: string, @Param('runId') runId: string): Promise<WorkflowRunCancelResponse> {
    return this.workflowExposureService.cancelRun(slug, runId);
  }

  /**
   * TASK-890 §3.9 — the HUMAN-REVIEW pair.
   *
   * A `core.humanReview` node parks a run on a person. Since TASK-864 the durable wait and its
   * two routes have existed on the INTERPRETER, reachable only with the internal service token,
   * so a tenant with a review in its graph had no way to release it except an operator
   * signalling Temporal by hand. These two routes are that proxy, and nothing more: the
   * decision is forwarded, the ownership check is the same one every other run route makes, and
   * the reviewer's identity is taken from the session — never from the wire.
   */
  @Get(':slug/runs/:runId/reviews/:nodeId')
  @CanRead('WorkflowRun')
  @RequiredScopes('workflow:run:read')
  @RequiredSvcScopes('svc:workflow:run:read')
  @ApiOperation({
    summary:
      'The live state of one Human-review node of a run: whether it is waiting, how many times it has escalated, and the decision if one was made.',
    description:
      'A graph may carry several review nodes, so a review is addressed by `(runId, nodeId)`. ' +
      '`exists: false` is a NORMAL 200 — the node has not been reached yet, or the review already settled and its durable child is gone. ' +
      'It is deliberately different from a 404, which means the RUN is not yours: a reviewer UI must be able to tell "nothing to decide here" ' +
      'from "you are looking at someone else\u2019s run". `decision` is `null` until a human sets it — a timeout never reads as an approval.',
  })
  @ApiParam({ name: 'slug' })
  @ApiParam({ name: 'runId' })
  @ApiParam({ name: 'nodeId', description: 'The graph node id of the `core.humanReview` node.' })
  @ApiResponse({ status: 200, type: WorkflowReviewResponse })
  @ApiResponse({ status: 403, description: 'Scope violation.' })
  @ApiResponse({ status: 404, description: "Cross-tenant run id, or a runId that does not belong to slug's lineage." })
  @ApiResponse({ status: 503, description: 'The interpreter could not be reached. Never reported as "no review".' })
  async getReview(@Param('slug') slug: string, @Param('runId') runId: string, @Param('nodeId') nodeId: string): Promise<WorkflowReviewResponse> {
    return this.workflowExposureService.getReview(slug, runId, nodeId);
  }

  @Post(':slug/runs/:runId/reviews/:nodeId/decide')
  @HttpCode(HttpStatus.OK)
  @CanUpdate('WorkflowRun')
  @RequiredScopes('workflow:run:write')
  @RequiredSvcScopes('svc:workflow:run:write')
  @ApiOperation({
    summary: 'Release a Human-review node with a decision — the graph resumes down the `approved` or `rejected` handle.',
    description:
      'Body `{ decision: "approved" | "rejected", comment?, editedPayload? }`. ' +
      '**`reviewerId` is not accepted** — the acting user is resolved from the session and stamped server-side, so a caller cannot attribute ' +
      'an approval to somebody else; sending the field is a 400 (the global pipe forbids undeclared properties). ' +
      '`editedPayload` is honoured only when the node was authored with `allowEdit`; the workflow drops it otherwise. ' +
      'A review is decided ONCE: a second decision on the same node is ignored by the durable child, so this route is safe to retry. ' +
      'Returns when the signal was SENT — the graph resumes on its own clock.',
  })
  @ApiParam({ name: 'slug' })
  @ApiParam({ name: 'runId' })
  @ApiParam({ name: 'nodeId', description: 'The graph node id of the `core.humanReview` node.' })
  @ApiResponse({ status: 200, type: WorkflowReviewDecisionResponse })
  @ApiResponse({ status: 400, description: 'A decision outside `approved` / `rejected`, or an undeclared body field such as `reviewerId`.' })
  @ApiResponse({ status: 403, description: 'Scope violation.' })
  @ApiResponse({
    status: 404,
    description: "Cross-tenant run id, a runId that does not belong to slug's lineage, or no review child under that nodeId.",
  })
  @ApiResponse({ status: 503, description: 'The interpreter could not be reached; no decision was recorded.' })
  async decideReview(
    @Param('slug') slug: string,
    @Param('runId') runId: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: ReviewDecisionRequest,
  ): Promise<WorkflowReviewDecisionResponse> {
    return this.workflowExposureService.decideReview(slug, runId, nodeId, dto);
  }

  /**
   * TASK-930 §4 — a single-use ticket for THIS run's socket.
   *
   * ## Why a second minting route rather than a scope on the first
   *
   * `POST /auth/stream-ticket` takes a scope STRING from the caller and is `@ForbidApiKey()` —
   * deliberately, because it is the credential-issuing plane and a credential authenticating
   * itself there is circular. The consequence was that `/ws/workflows` was reachable only by a
   * browser session: an API key or a service account, the two credentials that actually run
   * workflows unattended, could poll status or hold an SSE connection but never open the socket.
   *
   * This route inverts the shape that made that necessary. It takes no scope: the scope is
   * DERIVED from the path (`workflow_run:<runId>`), so nothing wider than the run in the URL can
   * be minted, and the ownership check that the auth controller performs for `workflow_run:`
   * tickets is the route's own `getRunStatus` — the same pre-stream check the SSE route and the
   * socket gateway make. Ownership is proved BEFORE the mint, so a foreign or unknown run is a
   * 404 (never a 403) and no ticket is ever issued for it.
   *
   * The ticket itself is the SAME kind, from the same service, with the same single-use 30-second
   * semantics; `workflow-ws.gateway.ts` is unchanged and cannot tell the two minting routes apart.
   */
  @Post(':slug/runs/:runId/stream-ticket')
  @HttpCode(HttpStatus.CREATED)
  @CanRead('WorkflowRun')
  // READ, not write: minting a ticket observes a run. Gating it behind `workflow:run:write`
  // would take the socket away from exactly the read-only credentials it exists to serve.
  @RequiredScopes('workflow:run:read')
  @RequiredSvcScopes('svc:workflow:run:read')
  @ApiOperation({
    summary: 'Mint a single-use, 30-second ticket for this run’s WebSocket stream.',
    description:
      'The API-key and service-account equivalent of `POST /auth/stream-ticket`, which is JWT-only. The scope is derived from the path ' +
      '(`workflow_run:<runId>`) and the run’s ownership is proved before the ticket is issued, so nothing broader than this run can be minted. ' +
      'Open the returned `url` — the ticket is consumed on first use and cannot be replayed.',
  })
  @ApiParam({ name: 'slug' })
  @ApiParam({ name: 'runId' })
  @ApiResponse({ status: 201, description: 'The ticket, its absolute expiry, its scope, and the socket URL to open with it.' })
  @ApiResponse({ status: 401, description: 'No caller identity to bind the ticket to.' })
  @ApiResponse({ status: 403, description: 'Scope violation.' })
  @ApiResponse({ status: 404, description: "Cross-tenant run id, or a runId that does not belong to slug's lineage." })
  async issueRunStreamTicket(@Param('slug') slug: string, @Param('runId') runId: string): Promise<WorkflowRunStreamTicketResponse> {
    if (!this.streamTicketService || !this.cls) {
      throw new ServiceUnavailableException('Stream tickets are not available on this instance.');
    }
    // FIRST: 404-over-403 ownership, through the same read every other run route makes.
    await this.workflowExposureService.getRunStatus(slug, runId);

    const user = this.cls.get('user');
    if (!user?.id) throw new UnauthorizedException('User context not available');
    // The ACTIVE (CLS) tenant wins, so a super admin's selected `X-Tenant-Id` — and a service
    // account's exchange-bound working tenant — both land on the ticket the socket reads back.
    const tenantId = this.cls.get('tenantId') || user.tenantId || null;

    const scope = `${WORKFLOW_RUN_TICKET_NAMESPACE}:${runId}`;
    const issued = await this.streamTicketService.issueTicket({
      userId: user.id,
      tenantId,
      scope,
      // Carried so a ticket minted under impersonation restores the claim on the socket request.
      impersonatedBy: user.impersonatedBy ?? null,
    });

    const query = new URLSearchParams({ slug, runId, ticket: issued.ticket });
    return { ticket: issued.ticket, expiresAt: issued.expiresAt, scope: issued.scope, url: `/ws/workflows?${query.toString()}` };
  }

  @Get(':slug/runs/:runId/stream')
  @CanRead('WorkflowRun')
  @RequiredScopes('workflow:run:read')
  @RequiredSvcScopes('svc:workflow:run:read')
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
  // async-contract forbids.
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
