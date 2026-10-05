import {
  InvokeWorkflowRequest,
  IWorkflowExposureService,
  ReviewDecisionRequest,
  WorkflowReviewDecisionResponse,
  WorkflowReviewResponse,
  WorkflowInvokeResponse,
  WorkflowRunCancelResponse,
  WorkflowRunResponseMode,
  WorkflowRunResultRefResponse,
  WorkflowRunStatusResponse,
  WorkflowSummaryListResponse,
  WorkflowEntryGateService,
  type WorkflowSchemaDescription,
} from '@arcaai/applications';
import {
  Controller,
  Get,
  GoneException,
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
import { RUN_PROTOCOL_HEADER } from '@arcaai/async-contract';
import { CanCreate, CanList, CanRead, CanUpdate, RequiredScopes, RequiredSvcScopes } from '../../decorators';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';
import { StreamTicketService } from '../auth/stream-ticket.service';
import { WORKFLOW_RUN_TICKET_NAMESPACE } from '../streaming/workflow-ws.gateway';
import type { RequestWithAuth } from '../../types/request-with-auth';
import { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '@arcaai/applications';
import { deliverRun } from './deliver-run';
import { resolveRunProtocol } from './run-protocol-delivery';
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
  /**
   * TASK-1038 B3a (G12) — the SSE stream to open with the SAME ticket instead (protocol v2
   * selected), for a browser app on an API key: `EventSource` cannot send `X-API-Key`, and the
   * route's `@StreamScope('workflow_run', runId)` accepts this ticket. The ticket is single-use:
   * open ONE of `url` / `sseUrl`.
   */
  sseUrl: string;
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
    // TASK-1036 (OD-4) — the socket ticket is refused unless the workflow's settings admit `socket`.
    // Optional so the positional unit fixtures keep constructing; absent, the settings are not read.
    @Optional() private readonly entryGate?: WorkflowEntryGateService,
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
      '**Idempotency**: send `Idempotency-Key` and a retry with the same body JOINS the existing run instead of starting (and billing) a ' +
      'second — the run id is derived from (tenant, slug, key) and Temporal refuses a duplicate execution under it. The same key with a ' +
      'different body is 409 `IDEMPOTENCY_KEY_REUSED`. ' +
      '**Disconnecting never cancels the run**: it is a durable execution, so abandoning the HTTP request abandons only your view of it. ' +
      'To run a workflow AGAINST A CONSULTATION, use `POST /consultations/{consultationId}/workflows/{slug}/runs` — a consultation ' +
      'graph is not invocable here, and consultation identity is never accepted in the request body.',
  })
  @ApiParam({ name: 'slug' })
  @ApiQuery({ name: 'mode', required: false, enum: ['async', 'blocking', 'stream'], description: 'Response mode. Default `async`.' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retry-safe key. The same value and body joins the existing run.' })
  @ApiResponse({ status: 202, type: WorkflowInvokeResponse, description: '`mode=async` — the run handle.' })
  @ApiResponse({ status: 200, type: WorkflowRunStatusResponse, description: '`mode=blocking` — the terminal run status.' })
  @ApiResponse({
    status: 400,
    description:
      'Reserved run-identity field supplied in `input` (e.g. `consultationId`) — it is never accepted here. Also, for a ' +
      'service-account caller on a workflow whose trigger schema declares a user-identity field: the supplied staff ' +
      'identifier is unusable (`USER_IDENTITY_INVALID`), or no department could be resolved to provision the clinician ' +
      'in (`USER_IDENTITY_DEPARTMENT_UNRESOLVED`).',
  })
  @ApiResponse({
    status: 404,
    description:
      'Unknown, unpublished, cross-tenant, or non-exposable slug. Also the answer when a service-account caller supplies ' +
      'a staff identifier this tenant does not have (`USER_IDENTITY_UNKNOWN`) or whose user cannot act ' +
      '(`USER_IDENTITY_NOT_USABLE`).',
  })
  @ApiResponse({ status: 403, description: 'Scope violation.' })
  @ApiResponse({
    status: 409,
    description:
      'The supplied staff identifier is ambiguous (`USER_IDENTITY_AMBIGUOUS` — more than one user in this tenant carries ' +
      'it), or provisioning a new clinician would exceed the tenant’s `maxUsers` allowance. Service-account callers on a ' +
      'STANDALONE run only — a consultation-bound run takes its clinician from the consultation row. ' +
      '`IDEMPOTENCY_KEY_REUSED` — the `Idempotency-Key` already started a run with a different body.',
  })
  @ApiResponse({ status: 429, description: 'monthlyWorkflowInvocations quota exhausted.' })
  @ApiResponse({
    status: 503,
    description: 'The identity resolver is not configured, so a run that names a clinician cannot be started (`USER_IDENTITY_RESOLVER_UNAVAILABLE`).',
  })
  @ApiResponse({ status: 504, description: '`mode=blocking` ceiling reached — the run continues; switch to streaming or poll `statusUrl`.' })
  async startRun(
    @Param('slug') slug: string,
    @Body() dto: InvokeWorkflowRequest,
    @Req() req: RequestWithAuth,
    @Res({ passthrough: true }) res: Response,
    @Query('mode') mode?: WorkflowRunResponseMode,
    @Headers('Idempotency-Key') idempotencyKey?: string,
    @Headers(RUN_PROTOCOL_HEADER) protocolHeader?: string,
    @Query('protocol') protocol?: string,
  ): Promise<WorkflowInvokeResponse | WorkflowRunStatusResponse | void> {
    // TASK-1038 B3a — an unsupported protocol is a 400 BEFORE a run is started (and billed).
    if (mode === 'stream') resolveRunProtocol({ header: protocolHeader, query: protocol });
    // TASK-864 §3.4: `mode` reaches the service so it can be bounded by the definition's Output
    // protocols BEFORE a run starts (400 naming the declared protocols), rather than starting a
    // run and then failing to deliver it the way the caller asked.
    const started = await this.workflowExposureService.invoke(slug, dto, { idempotencyKey, apiKeyId: req.apiKey?.id, mode });
    // TASK-864 (G9): the terminal status is recorded by a background watcher, not by a reader.
    this.runCompletion?.watch(req.user?.tenantId ?? req.tenantId ?? '', started.runId);
    return deliverRun(this.workflowStreamService, slug, started, res, mode, { protocolHeader, protocol });
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
  @ApiResponse({
    status: 404,
    description: 'Unknown, unpublished, or cross-tenant slug; or an unknown/unusable staff identifier (TASK-950 — see `POST :slug/runs`).',
  })
  @ApiResponse({ status: 403, description: 'Scope violation.' })
  @ApiResponse({
    status: 409,
    description: 'Ambiguous staff identifier, or the `maxUsers` allowance would be exceeded (TASK-950 — see `POST :slug/runs`).',
  })
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

  /**
   * TASK-1038 D-I — what the run DELIVERED, for the caller that started it.
   *
   * `WorkflowRun.resultRef` was always null before this ticket (no terminal path persisted the
   * output), so a business-plane caller could watch a run finish and never read what it made.
   * The completion watcher now persists the result the harness puts on `workflow.run.completed`,
   * and this route serves it: small results inline, large ones (claim-checked by the harness) as
   * a short-lived signed URL — never the bucket and key themselves. Same authorisation as the
   * status route; every read is audited by the service, because the output is PHI.
   */
  @Get(':slug/runs/:runId/result')
  @CanRead('WorkflowRun')
  @RequiredScopes('workflow:run:read')
  @RequiredSvcScopes('svc:workflow:run:read')
  @ApiOperation({
    summary: 'The result a finished run delivered: the JSON value inline, or a short-lived signed URL for a large result.',
    description:
      'Answers once the run is terminal. The `X-Hope-Result-Kind` header says which shape the 200 carries: `inline` — the body IS the ' +
      'delivered JSON value; `ref` — `{ url, expiresAt, sizeBytes, sha256 }`, a signed GET URL valid until `expiresAt` (request the route ' +
      'again for a fresh one). 204 means the run ended and delivered nothing; 410 means it delivered a result that has passed the ' +
      "tenant's result retention (`workflowRuns.resultRetentionDays`). A run that is still going is a 409 carrying its current status.",
  })
  @ApiParam({ name: 'slug' })
  @ApiParam({ name: 'runId' })
  @ApiResponse({
    status: 200,
    description: '`X-Hope-Result-Kind: inline` — the delivered JSON value; `ref` — a signed URL (schema below).',
    type: WorkflowRunResultRefResponse,
  })
  @ApiResponse({ status: 204, description: 'The run is terminal and delivered no result.' })
  @ApiResponse({ status: 404, description: "Cross-tenant run id, or a runId that does not belong to slug's lineage." })
  @ApiResponse({ status: 409, description: '`RUN_NOT_TERMINAL` — the run has not finished; the body carries its current `status`.' })
  @ApiResponse({ status: 410, description: 'The result existed and has passed its retention window.' })
  @ApiResponse({ status: 503, description: 'A stored result exists but no object storage is configured to sign its URL.' })
  async getRunResult(@Param('slug') slug: string, @Param('runId') runId: string, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    const result = await this.workflowExposureService.getRunResult(slug, runId);
    switch (result.kind) {
      case 'inline':
        res.setHeader('X-Hope-Result-Kind', 'inline');
        return result.value;
      case 'ref':
        res.setHeader('X-Hope-Result-Kind', 'ref');
        return { url: result.url, expiresAt: result.expiresAt, sizeBytes: result.sizeBytes, sha256: result.sha256 };
      case 'expired':
        throw new GoneException({
          code: 'RESULT_EXPIRED',
          message: `The result of run '${runId}' has passed its retention window.`,
          expiredAt: result.expiredAt,
        });
      default:
        res.status(HttpStatus.NO_CONTENT);
        return undefined;
    }
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
  @ApiResponse({
    status: 201,
    description:
      'The ticket, its absolute expiry, its scope, and the URLs to open with it: `url` (WebSocket) or `sseUrl` (SSE, protocol v2). The ticket is single-use — open one.',
  })
  @ApiResponse({ status: 400, description: 'MODE_UNSUPPORTED — the workflow’s settings enable neither the `sse` nor the `socket` connection.' })
  @ApiResponse({ status: 401, description: 'No caller identity to bind the ticket to.' })
  @ApiResponse({ status: 403, description: 'Scope violation.' })
  @ApiResponse({ status: 404, description: "Cross-tenant run id, or a runId that does not belong to slug's lineage." })
  async issueRunStreamTicket(@Param('slug') slug: string, @Param('runId') runId: string): Promise<WorkflowRunStreamTicketResponse> {
    if (!this.streamTicketService || !this.cls) {
      throw new ServiceUnavailableException('Stream tickets are not available on this instance.');
    }
    // FIRST: 404-over-403 ownership, through the same read every other run route makes.
    const run = await this.workflowExposureService.getRunStatus(slug, runId);
    // TASK-1036 (OD-4), TASK-1038 E2 (fix 1) — the ticket opens EITHER lane (`url` = socket,
    // `sseUrl` = SSE; the browser `useRun` mints it for an EventSource), so it is minted when the
    // run's workflow version admits `sse` OR `socket`. Each lane is enforced again where the ticket
    // is redeemed: `socket` by `WorkflowWsGateway`, `sse` by `streamRunStatus` below.
    await this.entryGate?.assertAnyEntryAllowed(slug, run.workflowVersionNumber, ['sse', 'socket']);

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
    const sseQuery = new URLSearchParams({ protocol: '2', ticket: issued.ticket });
    return {
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
      scope: issued.scope,
      url: `/ws/workflows?${query.toString()}`,
      sseUrl: `/api/v1/workflows/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/stream?${sseQuery.toString()}`,
    };
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
  @ApiHeader({
    name: 'Last-Event-ID',
    required: false,
    description:
      'Resume cursor: the `seq` of the last event received (protocol v2), or a legacy opaque token (accepted for one release). Omit on a first connect.',
  })
  @ApiHeader({
    name: RUN_PROTOCOL_HEADER,
    required: false,
    description: 'Set to `2` to select run protocol v2. Absent = the legacy frame shapes (one release).',
  })
  @ApiQuery({
    name: 'protocol',
    required: false,
    description: '`2` selects run protocol v2 — for clients that cannot set headers (EventSource). Any other value is a 400.',
  })
  @ApiQuery({
    name: 'after',
    required: false,
    description: 'Protocol v2 resume cursor (`seq`) for a client that cannot set headers. The header wins.',
  })
  @ApiQuery({
    name: 'lastEventId',
    required: false,
    description: 'Legacy fallback for a client that cannot set headers. The header wins when both are present.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Unsupported run protocol (`RUN_PROTOCOL_UNSUPPORTED`), a v2 cursor that is not a decimal seq (`RUN_CURSOR_INVALID`), or `MODE_UNSUPPORTED` — a `?ticket=` request for a workflow whose settings do not enable the `sse` connection.',
  })
  @ApiResponse({ status: 404, description: "Cross-tenant run id, or a runId that does not belong to slug's lineage." })
  async streamRunStatus(
    @Param('slug') slug: string,
    @Param('runId') runId: string,
    @Res() res: Response,
    // The SSE spec sends this header on reconnect by itself; the query parameters are the manual
    // escape hatch for a client that cannot set headers. NEVER a JWT — this is a stream cursor,
    // not a credential.
    @Headers('Last-Event-ID') lastEventIdHeader?: string,
    @Query('lastEventId') lastEventIdQuery?: string,
    @Headers(RUN_PROTOCOL_HEADER) protocolHeader?: string,
    @Query('protocol') protocol?: string,
    @Query('after') after?: string,
    // `@Req` rather than `@Query('ticket')`: the ticket is consumed by `JwtAuthGuard`, never read
    // here as a value — only its PRESENCE says this request redeemed a run ticket.
    @Req() req?: { query?: Record<string, unknown> },
  ): Promise<void> {
    // TASK-1038 E2 (fix 1) — a run ticket is minted when the workflow admits `sse` OR `socket`; the
    // SSE lane is enforced HERE, where the SSE stream redeems it. A bearer request is unchanged.
    if (this.entryGate && req?.query?.ticket !== undefined) {
      const run = await this.workflowExposureService.getRunStatus(slug, runId);
      await this.entryGate.assertEntryAllowed(slug, run.workflowVersionNumber, 'sse');
    }
    await this.workflowStreamService.stream(slug, runId, res, lastEventIdHeader, { protocolHeader, protocol, after, legacyQuery: lastEventIdQuery });
  }
}
