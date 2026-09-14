import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { JobQueue } from '@arcaai/domains';
import {
  DnaIngestJobResponse,
  IDnaWritingStyleService,
  IngestDnaWritingSamplesRequest,
  type DnaJobRequestedBy,
  type IActiveUserContext,
} from '@arcaai/applications';
import { Authorize, RequiredScopes, RequiredSvcScopes } from '../../decorators';
import type { RequestWithAuth } from '../../types/request-with-auth';
import { DnaJobStatusResponseDto } from './dna-writing-style.dto';
import { getDnaJobStatus, type DnaJobAccess } from './dna-writing-style-job-stream';

/**
 * TASK-974 §4.1 — the DNA writing-sample INGEST surface.
 *
 * ─── Why a separate controller (D-4) ───────────────────────────────────────────────────────────
 *
 * `DnaWritingStyleController` is a NAMED `@ForbidApiKey()` exemption (policy A1,
 * `business-plane-apikey-exemptions-audit.ts`): it serves a clinician's personal writing MODEL,
 * and a long-lived static credential must not reach one. That exemption is still right, and
 * nothing here weakens it — this controller only SUBMITS writing samples and reads back the
 * status of the job it queued. It returns no profile, no style text and no redaction rule, so a
 * key that holds `dna-writing-style:ingest` gains no read of anything a clinician authored.
 *
 * Un-exempting the personal controller to add one machine-reachable route would have been the
 * alternative, and it would have opened nine routes to reach one.
 *
 * ─── The authorization shape ───────────────────────────────────────────────────────────────────
 *
 * Class-level bare `@Authorize()` plus both machine scopes. There is no `action + subject` pair
 * that expresses this surface's real rule — see the AUTH-NOTE on `ingest` — so the decorator
 * deliberately understates the gate and the service enforces it, which is rule 05's
 * "owner-scoped self-service" pattern with a machine caller added.
 */
@ApiBearerAuth()
@ApiTags('dna-writing-styles')
@Controller('dna-writing-styles/ingest')
@Authorize()
@RequiredScopes('dna-writing-style:ingest')
@RequiredSvcScopes('svc:dna-writing-style:ingest')
export class DnaWritingStyleIngestController {
  /** The longest `Idempotency-Key` this route accepts. It becomes part of a queue id, so it is bounded. */
  private static readonly MAX_IDEMPOTENCY_KEY_LENGTH = 200;

  constructor(
    @Inject(IDnaWritingStyleService)
    private readonly dnaService: IDnaWritingStyleService,
    private readonly cls: ClsService<IActiveUserContext>,
    @InjectQueue(JobQueue.GenerateDnaReport)
    private readonly dnaQueue: Queue,
  ) {}

  /**
   * WHICH credential is calling — read off the REQUEST, not CLS.
   *
   * CLS cannot answer this. `UnifiedAuthGuard.handleApiKeyAuth` publishes `{ id, tenantId }` into
   * CLS `user` with no roles and no key id (deliberately — `unified-auth.guard.apikey-principal-
   * shape.test.ts` pins that shape as load-bearing), so an API-key caller is indistinguishable
   * there from a JWT one whose roles happen to be empty. The request object carries all three
   * principals, which is why `WorkflowsController` reads `req.apiKey?.id` the same way.
   *
   * `principalId` is the CREDENTIAL's id, never the bound user's: it is what the job-status gate
   * compares a machine reader against, and two credentials of one tenant share their users.
   */
  private callerOf(req: RequestWithAuth): DnaJobRequestedBy {
    if (req.serviceAccount) return { credentialClass: 'service-account', principalId: req.serviceAccount.id };
    // L5/F1 — the key's BOUND HUMAN travels beside the credential id, because the service needs
    // both and they answer different questions: `principalId` is what the job-status gate
    // compares a machine reader against, `boundUserId` is the human the credential may not
    // exceed. `null` (not omitted) for an unbound key, so "no human" is a value rather than a
    // missing field the service could read as "not checked".
    if (req.apiKey) return { credentialClass: 'api-key', principalId: req.apiKey.id, boundUserId: req.apiKey.userId ?? null };
    return { credentialClass: 'jwt', principalId: req.user?.id ?? '' };
  }

  /**
   * The reader's identity as the job gate sees it: a machine by CREDENTIAL, a human by user id.
   *
   * The TENANT is the ACTIVE one, read from CLS exactly as `DnaWritingStyleController.jobAccess()`
   * reads it (L5/F2). Deriving it from the request instead looked equivalent and was not: a SUPER
   * ADMIN's session carries `tenantId: ''` and is elevated onto a working tenant only by
   * `ResolveActiveTenantInterceptor`, which publishes it to CLS — so the request-derived value was
   * empty, the gate compared it against the job's real tenant, and a super admin got a 404 on the
   * job they had just enqueued. The request object is still the ONLY source for which CREDENTIAL
   * is calling; CLS cannot answer that (see `callerOf`).
   */
  private jobAccessOf(req: RequestWithAuth): DnaJobAccess {
    const caller = this.callerOf(req);
    const tenantId = this.cls.get('tenantId') ?? null;
    return caller.credentialClass === 'jwt' ? { tenantId, doctorId: caller.principalId } : { tenantId, machinePrincipalId: caller.principalId };
  }

  /**
   * The caller's `Idempotency-Key`, or `undefined`.
   *
   * A blank header is ABSENT, not a key: `''` would otherwise derive one shared job id for every
   * caller who sent an empty header, and they would all join each other's batch.
   */
  private idempotencyKeyOf(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    if (raw.length > DnaWritingStyleIngestController.MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new BadRequestException(
        `Idempotency-Key must be at most ${DnaWritingStyleIngestController.MAX_IDEMPOTENCY_KEY_LENGTH} characters; this one is ${raw.length}.`,
      );
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  // AUTH-NOTE: the class-level bare `@Authorize()` UNDERSTATES this gate, deliberately, and the
  // real rule is imperative in `DnaWritingStyleService.ingestWritingSamples`. It cannot be a
  // decorator because it depends on WHO the caller is rather than on what they may do:
  //
  //   · a MACHINE must name a `clinicianUserId` — it is never itself a clinician (400
  //     `DNA_INGEST_CLINICIAN_REQUIRED`) — and an API KEY may name only the human it is BOUND to,
  //     unless that human is an administrator: scopes bind the credential, abilities bind the
  //     bound human, and a credential can never exceed its human (rule 05). A SERVICE ACCOUNT is
  //     bound to a working TENANT rather than to a person, so it may name any clinician of it;
  //   · a HUMAN who names nobody ingests their OWN samples, and must be acting as a clinician —
  //     an admin would otherwise build a writing-style profile under their own account (403);
  //   · a HUMAN who names somebody else needs SUPER_ADMIN or TENANT_ADMIN (400
  //     `DNA_INGEST_CLINICIAN_NOT_ALLOWED`) — a privilege rule with no CASL subject behind it;
  //   · the named clinician must belong to the caller's tenant, and a cross-tenant id is 404
  //     (`assertUserBelongsToTenant`), never 403 — the house posture, and these artifacts are
  //     PHI-derived.
  //
  // Requiring `create:DnaWritingStyleReport` on the route instead would lock out the clinicians
  // this surface exists for: they hold no such ability (only a tenant admin does), which is the
  // same reason the personal DNA routes declare a bare `@Authorize()`.
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ingest a time series of writing samples for a clinician and queue their DNA writing-style analysis',
    description:
      'Submits writing the platform has not seen — case notes, work notes, any prose the clinician authored — as a ' +
      'TIME SERIES, and queues the platform analyst over it. Each sample carries a `writtenAt`, which is what orders ' +
      'the corpus and what decides which samples survive when a batch exceeds the analysis budget (the oldest are ' +
      'dropped, whole). The response is a job handle, not a profile: poll `GET ingest/jobs/{jobId}`, then read the ' +
      "profile from the clinician's own DNA surfaces.\n\n" +
      'A machine caller (API key or service account) MUST name `clinicianUserId`. A clinician omits it to ingest ' +
      'their own samples; a tenant or super administrator may name any clinician of their tenant. Samples are ' +
      'PHI-redacted before they reach any model, and the profile that is stored is a closed-vocabulary summary — ' +
      'the submitted text itself is never persisted.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Retry-safe key (≤ 200 characters). Reusing it with the same credential joins the job the first attempt enqueued ' +
      'instead of starting a second analysis, for as long as that job is retained by the queue.',
  })
  @ApiResponse({ status: 202, description: 'Accepted and queued.', type: DnaIngestJobResponse })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, or the batch exceeds the total character budget (`DNA_INGEST_TOO_LARGE`), or the caller may ' +
      'not name this clinician (`DNA_INGEST_CLINICIAN_NOT_ALLOWED`), or a machine caller named none ' +
      '(`DNA_INGEST_CLINICIAN_REQUIRED`), or a `writtenAt` is not a date-time this platform can order a series by ' +
      '(`DNA_INGEST_WRITTEN_AT_INVALID`), or the `Idempotency-Key` header is too long.',
  })
  @ApiResponse({
    status: 403,
    description: 'Scope violation, or an administrator not acting as a clinician tried to ingest under their own account.',
  })
  @ApiResponse({ status: 404, description: 'The named clinician is not a member of this tenant (also returned for a clinician of another tenant).' })
  @ApiResponse({
    status: 409,
    description: '`DNA_STYLE_DISABLED` — DNA writing style is off for this clinician (tenant setting or their own opt-out), so nothing was queued.',
  })
  async ingest(
    @Body() dto: IngestDnaWritingSamplesRequest,
    @Req() req: RequestWithAuth,
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ): Promise<DnaIngestJobResponse> {
    return this.dnaService.ingestWritingSamples(dto, this.callerOf(req), this.idempotencyKeyOf(idempotencyKey));
  }

  // AUTH-NOTE: ownership, not permission, is the gate — the same shape as the personal DNA job
  // routes, with the machine half added. A human reads back only their own jobs; a MACHINE reads
  // back only the jobs its own credential enqueued (`requestedBy.principalId`), because a machine
  // acts "as" a bound user and two credentials of one tenant share their clinicians. Every
  // refusal is the same 404 a nonexistent job gets, so a foreign job cannot be probed for.
  //
  // No SSE here: a machine polls. Adding a stream needs a `@StreamScope` for the ticket path and
  // is deliberately deferred (follow-up F-1).
  @Get('jobs/:jobId')
  @ApiOperation({
    summary: 'Status of an ingest job',
    description:
      'Reports the queued analysis. A caller sees only their own jobs: a human their own, a machine those its own ' +
      'credential enqueued. Terminal states are `completed` and `failed`; on `completed` the clinician`s profile has ' +
      'been written and is readable from the DNA surfaces.',
  })
  @ApiParam({ name: 'jobId', description: 'The job id returned by `POST dna-writing-styles/ingest`.', type: String })
  @ApiResponse({ status: 200, description: 'Job status.', type: DnaJobStatusResponseDto })
  @ApiResponse({ status: 403, description: 'Scope violation.' })
  @ApiResponse({ status: 404, description: 'Unknown job (also returned for a job belonging to another caller or tenant).' })
  async getIngestJob(@Param('jobId') jobId: string, @Req() req: RequestWithAuth): Promise<DnaJobStatusResponseDto> {
    return getDnaJobStatus(this.dnaQueue, jobId, this.jobAccessOf(req));
  }
}
