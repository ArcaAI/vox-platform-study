import type {
  IActiveUserContext,
  IBlobStorageService as IBlobStorageServiceType,
  StorageDescriptor,
  SttLanguageModeCatalog,
} from '@arcaai/applications';
import {
  AsrAgentResolverService,
  AsrLanguageCapabilityService,
  Authorize,
  BATCH_TRANSCRIPTION_DEFAULTS,
  BatchTranscriptionLimitsService,
  CreateBatchJobRequest,
  CreateJobRequest,
  CreateStreamingJobRequest,
  IBlobStorageService,
  IEntitlementsService,
  ITenantBucketService,
  IUserRoleAssignmentService,
  JobIdempotencyService,
  jsonSchemaValueProblems,
  requestedLanguageMode,
  resolveEffectiveLanguageMode,
  StreamingSessionService,
  TranscriptionJobService,
  TranscriptionRealtimeService,
} from '@arcaai/applications';
import type { LanguageModeSource, ResolvedAsrJobSelection, ResolvedAsrSession, ResolvedAsrSpec } from '@arcaai/applications';
import { TenantBucketPurpose } from '@arcaai/domains';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { probeAudioDurationSeconds } from './audio-duration';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';
import { StreamTicketService } from '../auth/stream-ticket.service';
import type { MessageEvent } from '@nestjs/common';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Headers,
  HttpException,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  HttpStatus,
  Optional,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  Sse,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { uuidv7 } from 'uuidv7';
import { StreamSessionTenantBindingService, TenantOwnedResource } from '../../common';
import {
  ALLOWED_AUDIO_MIMES,
  AGENT_SLUG_PATTERN,
  AUDIO_BUCKET,
  BatchTranscribeResponse,
  BatchTranscriptionLimitsResponse,
  CreateStreamSessionRequest,
  MAX_STREAM_SESSION_CONTEXT_BYTES,
  MAX_UPLOAD_HARD_CEILING,
  StreamSessionResponse,
  TranscribeFileRequest,
} from './dto';
import { RequiredScopes, RequiredSvcScopes } from '../../decorators';
import type { RequestWithAuth } from '../../types/request-with-auth';

/**
 * TASK-991 W2-1 — the roles that may transcribe on ANOTHER clinician's behalf.
 *
 * Mirrors `DNA_INGEST_ADMIN_ROLES` (`dna-writing-style.service.ts`) deliberately: "who may act
 * for whom" is ONE platform rule, and a second spelling of it would drift from the first.
 */
const TRANSCRIPTION_ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN'];

/**
 * WHICH credential class is transcribing, plus the human an API key is bound to.
 *
 * The three classes answer "who owns this job?" differently, and no `action + subject` pair can
 * express the difference — which is why the rule is imperative and carries an AUTH-NOTE.
 */
type TranscribeCaller =
  { credentialClass: 'service-account' } | { credentialClass: 'api-key'; boundUserId: string | null } | { credentialClass: 'jwt' };

/** RFC 7232 §3.2 — `If-None-Match` is a list compared WEAKLY, so `W/"x"` matches `"x"`. */
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => candidate.trim() === '*' || opaque(candidate) === opaque(etag));
}

@ApiBearerAuth()
@Authorize()
@ApiTags('transcription-jobs')
@Controller('audio/transcription-jobs')
// the STT job surface the gateway conformance review named as
// reachable with no authorization check at all (21 routes, 0 scopes). ONE
// class-level scope, deliberately the STRONGER of the declared `stt:*` pair —
// the same coarse-grained choice made for `/admin/*`: a uniformly
// scoped class is mechanically exhaustive, where a per-verb read/write split
// across 20 methods risks leaving one silently ungated. Splitting the GETs onto
// `stt:transcription:read` is a precision follow-up, never a widening.
@RequiredScopes('stt:transcription:write')
// the standalone speech-to-text feature, reachable by the THIRD
// credential class as well. The `svc:` scope is renamespaced from the very
// `stt:transcription:write` above (`STANDALONE_FEATURE_SCOPE_SOURCES`), so a
// machine identity reaches exactly the routes a scoped tenant key does.
//
// SVC-NOTE — AMENDED BY TASK-933 §3.3 (owner decision, 2026-09-09). This note used to record
// that four routes — `stream/session/:sessionId/{DELETE,refresh-ticket,switch-to-fallback,
// switch-to-primary}` — stayed 404 for a machine by design, because
// `assertStreamSessionOwnership` compared the session's owner to a CLS `user.id` that a service
// account deliberately never has. The consequence was that a machine could CREATE a streaming
// session and then not connect to it, refresh it or close it: it minted a ticket owned by `''`
// and a binding owned by `null`, which the WS handshake then correctly refused.
//
// The rule is now: **the session owner is the ACTING PRINCIPAL** — `cls.user?.id` for a human,
// `cls.serviceAccount?.id` for a machine — resolved once by `resolveStreamOwnerId()` and used by
// every link in the chain (session record, ticket, binding, and the interceptor's ownership
// check). A session is NEVER created ownerless: the `?? ''` / `?? null` fallbacks are gone, and
// a caller with no principal at all is a 400 rather than a session nobody can open.
//
// `SttWsGateway` is untouched on purpose. Its handshake is a pure string equality between the
// ticket's user and the binding's owner, so it needs no notion of WHICH class the principal
// belongs to — it keeps refusing every id that is not the owner, machine or human, and its
// `ws-gateway-owner-audit` classification stays `enforced`.
//
// What did NOT change: a machine is still never recorded as a CLINICIAN. `Consultation.doctorId`
// and every job's `userId` come from the consultation row (TASK-933 §3.2); the id below owns a
// SOCKET, which is a transport fact, not a clinical one.
@RequiredSvcScopes('svc:stt:transcription:write')
export class TranscriptionJobController {
  private readonly logger = new Logger(TranscriptionJobController.name);

  private async dispatchBatchJob(params: {
    jobId: string;
    tenantId: string;
    audioUri: string;
    consultationId?: string;
    mediaId?: string;
    language?: string;
    userId?: string;
    audioBucketName?: string;
    storage?: StorageDescriptor | null;
    /** The resolved spec the worker assembles the engine chain from (carries its own fallback) — the job's one selector. */
    resolvedSpec: ResolvedAsrSpec;
    /** TASK-1004 — the effective spoken-language mode + its tier (request > consultation), as kwargs. */
    languageMode?: string;
    languageModeSource?: LanguageModeSource;
  }): Promise<void> {
    const service = this.realtimeService as unknown as {
      dispatchDramatiqJob: (args: typeof params) => Promise<void>;
    };
    await service.dispatchDramatiqJob(params);
  }

  constructor(
    private readonly jobService: TranscriptionJobService,
    private readonly realtimeService: TranscriptionRealtimeService,
    private readonly sessionService: StreamingSessionService,
    private readonly cls: ClsService<IActiveUserContext>,
    @Inject(IBlobStorageService) private readonly blobStorage: IBlobStorageServiceType,
    @Inject(ITenantBucketService) private readonly tenantBucketService: ITenantBucketService,
    private readonly streamTicketService: StreamTicketService,
    // Persists sessionId → tenantId on create
    // and clears it on close, so the `@TenantOwnedResource('StreamSession')`
    // route guard on `closeStreamSession` can 404 cross-tenant probes.
    private readonly streamSessionTenantBinding: StreamSessionTenantBindingService,
    // Hard-blocks a new streaming session when the
    // caller's tenant is at/over its resolved `maxConcurrentSessions` (no-op
    // while the entitlements kill-switch is OFF).
    @Inject(IEntitlementsService)
    private readonly entitlements: IEntitlementsService,
    // Resolves the admin-configurable `stt.batch.*` ceilings.
    // Optional so positional test construction and a stack without the settings
    // module still work — the ceilings then apply at their CODE DEFAULTS. The
    // limit is never SKIPPED when this is absent, only made non-configurable.
    @Optional() private readonly batchLimits?: BatchTranscriptionLimitsService,
    // TASK-861 — the ONE resolution path from "start transcribing" to a runnable
    // `ResolvedAsrSpec` (explicit agentSlug → governing workflow → assignment
    // cascade → spec + cloud credentials). It is the ONLY selector (TASK-1006).
    // Optional + trailing so positional test construction keeps compiling; when
    // absent every transcription route answers 503 — never an engine guess.
    @Optional() private readonly asrResolver?: AsrAgentResolverService,
    // TASK-991 W2-1 — the two tenant-scoped identity reads the machine-caller rule needs:
    // `findActiveAssignmentForUserInTenant` (is the NAMED clinician a member of this tenant?) and
    // `fetchAllByUserId` (does the human an API key is bound to administer it?). Optional +
    // TRAILING so the positional unit-test construction in `__tests__/` keeps compiling; absent,
    // the machine path fails CLOSED with a 503 rather than accepting an unverified clinician.
    @Optional() @Inject(IUserRoleAssignmentService) private readonly roleAssignments?: IUserRoleAssignmentService,
    // TASK-1004 — the per-agent language capability (chain-judged catalog + ETag cache). Optional +
    // TRAILING for the same positional-fixture reason; absent, `language-modes` answers the
    // catalog-wide payload exactly as before.
    @Optional() private readonly languageCapability?: AsrLanguageCapabilityService,
    // TASK-1038 B3a — `Idempotency-Key` on `POST transcribe`. Optional + TRAILING for the
    // positional fixtures; absent, the header is ignored (every call starts a job, as before).
    @Optional() private readonly jobIdempotency?: JobIdempotencyService,
  ) {}

  /**
   * TASK-861 — resolve the ASR Agent (explicit slug, governing workflow, or the
   * assignment cascade) into the spec + credentials one session / job runs on.
   * Fails CLOSED when the resolver is not wired: guessing an engine is worse
   * than refusing.
   */
  private async resolveAsrAgent(
    tenantId: string,
    agentSlug?: string | null,
    consultationId?: string | null,
    requestedMode?: string | null,
    // TASK-1042 (C1) — a session for a STANDALONE workflow run (never with a consultation).
    workflowSlug?: string | null,
  ): Promise<ResolvedAsrSession> {
    if (!this.asrResolver) {
      throw new ServiceUnavailableException('ASR agent resolution is not configured on this gateway');
    }
    // TASK-1004 — an explicit agent on a consultation-bound request that declared no mode is the
    // one case whose consultation is not read for agent resolution; ask for that read so the
    // session can inherit the consultation's mode. Without an agentSlug the resolver reads the
    // consultation anyway (tier 2/3), so the flag would be noise there.
    const inheritConsultationLanguage = Boolean(agentSlug && consultationId && !requestedMode);
    return this.asrResolver.resolve({
      tenantId,
      agentSlug: agentSlug ?? null,
      departmentId: null,
      consultationId: consultationId ?? null,
      ...(inheritConsultationLanguage ? { inheritConsultationLanguage } : {}),
      ...(workflowSlug ? { workflowSlug } : {}),
    });
  }

  /**
   * TASK-1004 — the mode (and its tier) a session or job SENDS to STT: request > consultation.
   * The agent's own default and `auto` are deliberately NOT sent — STT applies the spec's mode
   * itself and stamps `agent`/`default` on the receipt, exactly as before this ticket. Language
   * is a decoding input only; the agent was resolved before this and is never revisited.
   */
  private effectiveLanguage(
    requestedMode: string | null,
    resolved?: ResolvedAsrSession,
  ): { languageMode?: string; languageModeSource?: LanguageModeSource } {
    const effective = resolveEffectiveLanguageMode({ request: requestedMode, consultation: resolved?.consultationLanguageMode ?? null });
    return effective.source === 'request' || effective.source === 'consultation'
      ? { languageMode: effective.mode, languageModeSource: effective.source }
      : {};
  }

  /**
   * The effective batch ceilings for the caller's tenant, or the code defaults
   * when the resolver is not wired. Never throws — see
   * `BatchTranscriptionLimitsService` for why these fail open.
   */
  private async resolveBatchLimits(tenantId: string) {
    return (await this.batchLimits?.resolve(tenantId)) ?? { ...BATCH_TRANSCRIPTION_DEFAULTS };
  }

  /**
   * Refuse a new batch job when the OWNER already holds `maxActive` in flight.
   * QUEUED + PROCESSING are the only in-flight states — finished, failed and
   * cancelled jobs never consume a slot, however many of them there are.
   *
   * 429 (not 409): this is "too much at once, retry later", and it is what the
   * SDK's queue backs off on.
   *
   * TASK-991 W2-1 — `ownerId` is passed in rather than read from CLS, because the owner of a
   * machine-submitted job is the NAMED clinician and CLS holds no user for a machine. The knob is
   * `maxActiveJobsPerUser`, so the count must be that clinician's, not the credential's.
   */
  private async assertBatchConcurrency(maxActive: number, ownerId: string): Promise<void> {
    const counts = await this.jobService.getStatusCountsForOwner(ownerId);
    const inFlight = (counts?.queued ?? 0) + (counts?.processing ?? 0);
    if (inFlight >= maxActive) {
      throw new HttpException(
        `You already have ${inFlight} transcription job(s) in progress (maximum ${maxActive}). Wait for one to finish before uploading another.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * The caller's ACTIVE tenant, resolved in the canonical order used
   * everywhere else in the gateway — `ClsTenantContextProvider.getTenantId()`
   * (`src/database/tenant-context.provider.ts`) and the sibling admin
   * controllers: the CLS `tenantId` key FIRST, then the JWT-derived identity.
   *
   * The `tenantId` key is where `ContextInterceptor` elevates a SUPER_ADMIN's
   * selected working tenant from the `x-tenant-id` header; a super admin's own
   * JWT carries `tenantId: ''`, so reading `user.tenantId` alone rejected every
   * super-admin caller with a 400 (BUG-012). `??` (not `||`) matches the
   * provider exactly, and the explicit length check keeps an empty-string claim
   * from leaking through as a tenant — a caller with no active tenant still
   * fails closed here.
   *
   * No new trust is granted: the only way the CLS `tenantId` diverges from
   * `user.tenantId` is that audited super-admin elevation, which
   * `resolveActiveTenant` already restricts to elevated callers with an empty
   * JWT tenant and a well-formed UUID (a forged header from a tenant-bound
   * caller is rejected as 400 before the handler runs).
   */
  private getTenantId(): string {
    const active = this.cls.get('tenantId') ?? this.cls.get('user')?.tenantId;
    if (!active || active.length === 0) {
      throw new BadRequestException('Tenant context is required. Ensure you are authenticated with a tenant-scoped user.');
    }
    return active;
  }

  /**
   * The caller's identity, used to owner-scope the end-user
   * list/stats/status reads so a user only ever sees the jobs THEY created.
   * The tenant-wide view lives on the admin surface
   * (`/admin/audio/transcription-jobs`).
   */
  private getUserId(): string {
    const user = this.cls.get('user');
    if (!user?.id) {
      throw new BadRequestException('User context is required. Ensure you are authenticated.');
    }
    return user.id;
  }

  /**
   * TASK-933 §3.3 — WHO owns a live streaming session.
   *
   * A session is a socket, a ticket and a binding, and all three must name the same principal or
   * the WS handshake refuses the connection. A human is their CLS `user`; a service account is
   * on its own CLS key by design (`UnifiedAuthGuard` never writes a machine onto `user`), so the
   * resolution has to ask for both.
   *
   * THROWS rather than defaulting. The previous `?? ''` (ticket) and `?? null` (binding) turned
   * "no principal" into a session that existed and could never be opened — a failure that
   * surfaced two calls later, at the WebSocket, as a generic auth close. `UnifiedAuthGuard`
   * cannot actually deliver an authenticated request with neither key, so reaching this throw is
   * a bug; making it loud and immediate is the point.
   *
   * This id owns a TRANSPORT. It is never written to `Consultation.doctorId` and never becomes a
   * job's clinician — see the SVC-NOTE above.
   */
  private resolveStreamOwnerId(): string {
    const ownerId = this.cls.get('user')?.id ?? (this.cls.get('serviceAccount') as { id?: string } | undefined)?.id;
    if (!ownerId || typeof ownerId !== 'string') {
      throw new BadRequestException('A streaming session must have an owner. Ensure you are authenticated as a user or a service account.');
    }
    return ownerId;
  }

  /**
   * TASK-991 W2-1 — WHICH credential is calling, read off the REQUEST with CLS as the machine
   * fallback.
   *
   * CLS cannot tell an API key from a JWT: `UnifiedAuthGuard.handleApiKeyAuth` publishes
   * `{ id, tenantId }` into CLS `user` with no roles and no key id (a shape
   * `unified-auth.guard.apikey-principal-shape.test.ts` pins as load-bearing), so the request
   * object is the only source that can — the same read `DnaWritingStyleIngestController.callerOf`
   * makes, for the same reason.
   *
   * It CAN tell a MACHINE from a human, and that is the CLS fallback below: `req` is optional on
   * the handler (the positional unit tests construct calls without one), and a missing request
   * must never let a machine pass as a person. The fallback reads `user` FIRST — the guard never
   * writes a machine onto `user`, so a CLS user means a human, which is the same precedence
   * `resolveStreamOwnerId` applies. The worst a missing `req` can then do is demote an API key to
   * the JWT branch, which is the NARROWER of the two rules.
   */
  private callerOf(req?: RequestWithAuth): TranscribeCaller {
    if (req?.serviceAccount) return { credentialClass: 'service-account' };
    if (req?.apiKey) return { credentialClass: 'api-key', boundUserId: req.apiKey.userId ?? null };
    if (!this.cls.get('user') && this.cls.get('serviceAccount')) return { credentialClass: 'service-account' };
    return { credentialClass: 'jwt' };
  }

  /**
   * TASK-991 W2-1 — WHO owns the transcription job this request creates.
   *
   * The defect this replaces: the handler resolved its owner through `getUserId()`, which reads
   * CLS `user` — a key `UnifiedAuthGuard` never populates for a machine — so every service-account
   * call answered `400 "User context is required"` while `route-manifest.json` advertised the route
   * to service accounts (`svc:stt:transcription:write`, `forbidServiceAccount: false`). The
   * platform promised a route it then refused.
   *
   * The rule, which is the one `POST dna-writing-styles/ingest` already states (same field name, so
   * an integrator learns "name the clinician" once):
   *
   *   · a SERVICE ACCOUNT must NAME the clinician (`clinicianUserId`, 400
   *     `TRANSCRIBE_CLINICIAN_REQUIRED`) — it binds to a working TENANT, not to a person, and a
   *     machine is never recorded as the clinician;
   *   · an API KEY may name only the human it is BOUND to, unless that human administers THIS
   *     tenant: scopes bind the credential, abilities bind the bound human, and a credential never
   *     exceeds its human (rule 05);
   *   · a HUMAN naming nobody — or naming themselves — is the owner, exactly as before; naming
   *     someone else needs SUPER_ADMIN / TENANT_ADMIN (400 `TRANSCRIBE_CLINICIAN_NOT_ALLOWED`);
   *   · any clinician NAMED by anyone must belong to the caller's tenant, and a foreign id is 404,
   *     never 403 — the house posture, and a recording is PHI.
   *
   * WHY A THIRD HELPER, and not a reuse of one of the two above. This controller now carries
   * `getUserId()` (strict: throws when there is no CLS user), `resolveStreamOwnerId()` (lenient:
   * falls back to the service-account id) and this one, and that reads like drift until you ask
   * what each one ANSWERS:
   *
   *   · `resolveStreamOwnerId` answers who owns a TRANSPORT. A machine owning its own socket is
   *     correct and deliberate (TASK-933): the ticket, the binding and the WS handshake all
   *     compare that one id, and a session owned by somebody who is not the connecting party
   *     cannot be opened at all;
   *   · `getUserId` answers whose jobs to SHOW on the owner-scoped reads (`GET /`, cancel, retry).
   *     It stays strict on purpose — a machine has no jobs of its own, and widening it to the
   *     service-account id would scope those reads to an id that never appears in `createdBy`;
   *   · this one answers who the CLINICAL artifact belongs to, and that must be a human. Reusing
   *     `resolveStreamOwnerId` here would have made the route succeed while still seeding no voice
   *     profiles — a service account owns no enrolments, so every speaker would come back as a
   *     generic `Speaker N`. A route that works and transcribes worse is the harder bug to find.
   */
  private async resolveTranscriptionOwner(tenantId: string, named: string | undefined, req?: RequestWithAuth): Promise<string> {
    const caller = this.callerOf(req);

    if (caller.credentialClass === 'service-account') {
      if (!named) {
        throw new BadRequestException({
          code: 'TRANSCRIBE_CLINICIAN_REQUIRED',
          message:
            'A service account has no clinician of its own. Name the clinician this recording belongs to with `clinicianUserId`; ' +
            'a machine is never recorded as the clinician.',
        });
      }
      await this.assertClinicianOfTenant(named, tenantId);
      return named;
    }

    // Both HUMAN classes keep today's behaviour when they name nobody — or name themselves. For an
    // API key the CLS user IS the human it is bound to, so this branch is unchanged for it too.
    const callerId = this.getUserId();
    if (!named || named === callerId) return callerId;

    if (!(await this.mayActForAnotherClinician(caller, tenantId))) {
      throw new BadRequestException({
        code: 'TRANSCRIBE_CLINICIAN_NOT_ALLOWED',
        message:
          caller.credentialClass === 'api-key'
            ? 'This API key may transcribe only for the clinician it is bound to. A key bound to a tenant or super administrator may ' +
              'name any clinician of its tenant; mint the key against that principal, or submit under the clinician`s own key.'
            : 'Only a tenant or super administrator may transcribe on another clinician`s behalf. Omit `clinicianUserId` to transcribe ' +
              'as yourself.',
      });
    }
    await this.assertClinicianOfTenant(named, tenantId);
    return named;
  }

  /**
   * May this caller name a clinician who is not itself? Consulted ONLY when one was named, so the
   * ordinary path costs no read.
   *
   * A JWT caller's roles are in the token, so the check is free. An API KEY's bound human has
   * none in CLS (see `callerOf`), so their assignments are read — and the read is confined to
   * THIS tenant, explicitly: a user who administers tenant B is nobody in tenant A, so the
   * cross-tenant `findActiveRolesForUser` would have been a widening. Fails CLOSED on an
   * unreadable role list and on an unbound key.
   */
  private async mayActForAnotherClinician(caller: TranscribeCaller, tenantId: string): Promise<boolean> {
    if (caller.credentialClass === 'jwt') {
      return (this.cls.get('user')?.roles ?? []).some((role) => TRANSCRIPTION_ADMIN_ROLES.includes(role));
    }
    const boundUserId = caller.credentialClass === 'api-key' ? caller.boundUserId : null;
    const roleAssignments = this.roleAssignments;
    if (!boundUserId || !roleAssignments) return false;

    try {
      const assignments = await roleAssignments.fetchAllByUserId({ userId: boundUserId, page: 0, limit: 100 });
      return assignments.data.some(
        (assignment) => assignment.tenantId === tenantId && (assignment.Roles ?? []).some((role) => TRANSCRIPTION_ADMIN_ROLES.includes(role.name)),
      );
    } catch (err) {
      this.logger.warn({
        message: 'Could not read the roles of the API-key principal; refusing the named clinician',
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Is the NAMED clinician a member of the caller's tenant? 404 if not — never 403, and never a
   * message that distinguishes "no such user" from "a user of another tenant". The user id space
   * is not the caller's to probe.
   *
   * An ENABLED role assignment in this tenant IS tenant membership — the same "role half" that
   * carries this meaning in `assertUserBelongsToTenant`, reached here through the service token
   * because a controller holds no repositories. `findActiveAssignmentForUserInTenant` filters
   * `tenantId` explicitly in its own WHERE, so the answer does not depend on the CLS-driven
   * Prisma tenant-scope extension being active for this credential class.
   *
   * Fails CLOSED (503) when the service is not wired: accepting an unverified clinician would
   * write another tenant's user onto a PHI recording.
   */
  private async assertClinicianOfTenant(clinicianUserId: string, tenantId: string): Promise<void> {
    if (!this.roleAssignments) {
      throw new ServiceUnavailableException('Clinician verification is not configured on this gateway');
    }
    const assignment = await this.roleAssignments.findActiveAssignmentForUserInTenant(clinicianUserId, tenantId);
    if (!assignment) {
      throw new NotFoundException(`User ${clinicianUserId} not found`);
    }
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a transcription job' })
  async create(@Body() dto: CreateJobRequest) {
    // TASK-861 — the same resolution as `POST …/transcribe`: explicit `agentSlug`, else the
    // tenant's assigned ASR agent, keys the job to a `ResolvedAsrSpec`. The gateway never guesses,
    // and (TASK-1012 L-7) never takes a caller's `agentVersionId` / `resolvedSpec`.
    const { agentSlug, ...rest } = dto;
    return this.jobService.create({ ...rest, ...(await this.resolveJobAgent(agentSlug, dto.consultationId)) });
  }

  @Post('batch')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a batch transcription job' })
  async createBatch(@Body() dto: CreateBatchJobRequest) {
    const { agentSlug, ...rest } = dto;
    return this.jobService.createBatchJob({ ...rest, ...(await this.resolveJobAgent(agentSlug, dto.consultationId)) });
  }

  @Post('streaming')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a streaming transcription job' })
  async createStreaming(@Body() dto: CreateStreamingJobRequest) {
    const { agentSlug, ...rest } = dto;
    return this.jobService.createStreamingJob({ ...rest, ...(await this.resolveJobAgent(agentSlug, dto.consultationId)) });
  }

  /**
   * TASK-1012 L-7 — the ONE selection for the three job-create routes: the resolved ASR agent
   * (`agentSlug`, else the assignment cascade). Spread LAST over the request, so a caller-supplied
   * `agentVersionId` / `resolvedSpec` that slipped past the pipe is overwritten, never honoured.
   */
  private async resolveJobAgent(agentSlug: string | undefined, consultationId: string | undefined): Promise<ResolvedAsrJobSelection> {
    const resolved = await this.resolveAsrAgent(this.getTenantId(), agentSlug, consultationId);
    return { agentVersionId: resolved.spec.agent.versionId, resolvedSpec: resolved.spec as unknown as Record<string, unknown> };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get transcription job status counts (caller-owned jobs)' })
  async getStats() {
    // Owner-scoped: the caller's jobs only.
    return this.jobService.getStatusCountsForOwner(this.getUserId());
  }

  @Get('status/:status')
  @ApiOperation({ summary: 'Get transcription jobs by status (caller-owned jobs)' })
  @ApiParam({ name: 'status', description: 'Job status filter' })
  async getByStatus(@Param('status') status: string) {
    // Owner-scoped: the caller's jobs only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.jobService.getByStatusForOwner(this.getUserId(), status as any);
  }

  @Post('transcribe')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Upload audio file for batch transcription via worker',
    description:
      'The speech-to-text agent is resolved in order: an explicit agentSlug on the request, else the speech-to-text node ' +
      "of the consultation's governing workflow, else the department then tenant assignment.",
  })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: 'Batch job created and queued', type: BatchTranscribeResponse })
  @ApiResponse({
    status: 400,
    description:
      'Missing/unsupported file, file too large, a recording over the duration ceiling, a machine caller that named no clinician ' +
      '(`TRANSCRIBE_CLINICIAN_REQUIRED`), or a caller that may not name the clinician it did (`TRANSCRIBE_CLINICIAN_NOT_ALLOWED`).',
  })
  @ApiResponse({ status: 404, description: 'The named clinician is not a member of this tenant (also returned for a clinician of another tenant).' })
  @ApiResponse({ status: 429, description: 'The owner already holds the maximum number of in-flight batch jobs.' })
  // The interceptor limit is a STATIC hard ceiling — a decorator cannot read a
  // per-tenant setting. The admin-configurable `stt.batch.maxFileSizeMb` is
  // enforced in the handler below; this only stops a multi-GB body from being
  // buffered before that check can run.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_HARD_CEILING } }))
  // AUTH-NOTE: the class-level `@Authorize()` + `stt:transcription:write` / `svc:stt:transcription:write`
  // say a caller MAY transcribe. They cannot say WHOSE recording this is, and this route has to
  // know: the job's owner is a CLINICIAN, and a machine credential is not one. The rule is
  // therefore imperative, in `resolveTranscriptionOwner` above — a service account must NAME the
  // clinician (400 `TRANSCRIBE_CLINICIAN_REQUIRED`), an API key may name only its bound human
  // unless that human administers this tenant, a human keeps owning their own jobs, and any named
  // clinician outside the tenant is 404 (404-over-403). It is the rule `POST
  // dna-writing-styles/ingest` already states, under the same field name.
  //
  // Why the field EARNS its place rather than being ceremony: the owner is what seeds enrolled
  // VOICE PROFILES. `TranscriptionRealtimeService.resolveVoiceProfiles` returns `[]` the moment
  // `params.userId` is absent (`transcriptionRealtime.service.ts:330`), so a machine-submitted
  // recording would run diarization with no enrolled speakers to match against — a silently worse
  // transcript, not an error. Naming the clinician is what makes that path reachable at all for a
  // machine caller. The job ROW's own `createdBy` is a separate stamp that this gateway cannot yet
  // set for a machine — see the KNOWN GAP at the `createBatchJob` call below.
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Retry-safe key (TASK-1038): the same key with the same upload (audio bytes + fields) returns the same job without a second upload or dispatch; a different upload under the same key is a 409.',
  })
  @ApiResponse({
    status: 409,
    description:
      '`IDEMPOTENCY_KEY_REUSED` — this Idempotency-Key was used with a different upload; `IDEMPOTENCY_KEY_IN_FLIGHT` — the first request is still starting.',
  })
  async transcribeFile(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: TranscribeFileRequest,
    @Req() req?: RequestWithAuth,
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ): Promise<BatchTranscribeResponse> {
    // 1. Validate file
    if (!file?.buffer) {
      throw new BadRequestException('Audio file is required');
    }
    if (!ALLOWED_AUDIO_MIMES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported audio type: ${file.mimetype}`);
    }

    // TASK-1038 B3a — `Idempotency-Key`: a retried upload (a dropped response, a mobile reconnect)
    // must not upload, persist and dispatch the recording twice. The fingerprint is the audio's
    // own hash plus every submitted field, so "the same request" means the same recording.
    if (idempotencyKey && this.jobIdempotency) {
      const principalId = this.cls.get('user')?.id ?? (this.cls.get('serviceAccount') as { id?: string } | undefined)?.id ?? 'anonymous';
      const { value } = await this.jobIdempotency.run(
        { operation: 'transcribe', tenantId: this.getTenantId(), principalId, key: idempotencyKey },
        { audioSha256: createHash('sha256').update(file.buffer).digest('hex'), mimetype: file.mimetype, filename: file.originalname, body },
        () => this.transcribeFileOnce(file, body, req),
      );
      return value;
    }
    return this.transcribeFileOnce(file, body, req);
  }

  /** The upload → job row → worker dispatch of ONE transcription (see `transcribeFile`). */
  private async transcribeFileOnce(file: Express.Multer.File, body: TranscribeFileRequest, req?: RequestWithAuth): Promise<BatchTranscribeResponse> {
    // TASK-1004 — the explicit mode, normalized; 400 LANGUAGE_MODE_UNKNOWN before any I/O.
    const requestedMode = requestedLanguageMode(body);

    const tenantId = this.getTenantId();

    // 1b. Admin-configurable ceilings. Every rejection below happens
    // BEFORE object storage, the job row, and the worker dispatch — an upload
    // that is going to be refused must not cost a 200 MB write first. These run
    // ahead of agent resolution (1c) for the same reason: they are pure
    // in-process checks, so a refused upload never costs a DB round-trip.
    const limits = await this.resolveBatchLimits(tenantId);

    const maxBytes = limits.maxFileSizeMb * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new BadRequestException(`File size ${(file.size / (1024 * 1024)).toFixed(1)} MB exceeds the maximum of ${limits.maxFileSizeMb} MB`);
    }

    // DURATION is the requirement ("each recording at most 60 minutes"); size is
    // only a proxy for it. Read from the container header, never from the
    // client-declared MIME type.
    const durationSeconds = probeAudioDurationSeconds(file.buffer, file.mimetype);
    if (durationSeconds === null) {
      // FAIL-CLOSED (owner decision): a duration that cannot be
      // established is not evidence of a recording within the limit. Typically a
      // live/streamed capture whose container never recorded its own length.
      throw new BadRequestException(
        `Could not determine the duration of ${file.originalname || 'the uploaded file'}. ` +
          `Re-export it with duration metadata (for example as WAV, FLAC, MP3 or M4A) and upload again.`,
      );
    }
    const durationMinutes = durationSeconds / 60;
    if (durationMinutes > limits.maxDurationMinutes) {
      throw new BadRequestException(
        `Recording is ${durationMinutes.toFixed(1)} min long, which exceeds the maximum of ${limits.maxDurationMinutes} min`,
      );
    }

    // TASK-991 W2-1 — WHO this job belongs to, resolved ONCE and used by the in-flight cap below
    // and by the worker dispatch. It sits exactly where the old `getUserId()` call sat (inside
    // `assertBatchConcurrency`), so the ordering of every existing refusal is unchanged: the pure
    // in-process file checks above still run first and still cost no I/O.
    const ownerId = await this.resolveTranscriptionOwner(tenantId, body.clinicianUserId, req);

    // In-flight cap — the server-side counterpart of the client's per-batch
    // limit. Without it "5 per batch" is bypassed by sending five batches.
    await this.assertBatchConcurrency(limits.maxActiveJobsPerUser, ownerId);

    // 1c. Resolve WHAT runs the job (TASK-861): explicit `agentSlug`, else the
    //     consultation's governing workflow, else the tenant's assigned agent —
    //     a `ResolvedAsrSpec` the job is keyed to and reproducible from. It is
    //     the only selector (TASK-1006); the gateway never guesses an engine.
    const resolved = await this.resolveAsrAgent(tenantId, body.agentSlug, body.consultationId, requestedMode);
    const mediaId = uuidv7();

    // 2. Create batch job in DB (status: QUEUED) — keyed to the agent version +
    //    spec snapshot (never a credential).
    //
    //    KNOWN GAP (TASK-991 W2-1, cross-package): the ROW's `createdBy` is stamped inside
    //    `TranscriptionJobService.create` from `this.requestUserId` (CLS `user.id`), which is null
    //    for a service account — `CreateBatchJobRequest` carries no owner field for the gateway to
    //    pass, so the row falls back to the system-user default. The job therefore runs, streams
    //    and reads back by id (that route is tenant-gated) for a machine caller, but it does not
    //    yet appear in the NAMED clinician's owner-scoped list. Closing it means an owner field on
    //    `CreateBatchJobRequest` honoured by that service, which lives in `packages/applications`.
    const job = await this.jobService.createBatchJob({
      agentVersionId: resolved.spec.agent.versionId,
      resolvedSpec: resolved.spec as unknown as Record<string, unknown>,
      mediaId,
      consultationId: body.consultationId,
    });

    // 3. Resolve the tenant's default audio bucket: configured purpose →
    //    `recordings` slug (default) → legacy `audio` slug → global
    //    constant.
    let uploadBucket = AUDIO_BUCKET;
    try {
      const tenantBucket =
        (await this.tenantBucketService.getBucketByPurpose(TenantBucketPurpose.AUDIO)) ??
        (await this.tenantBucketService.getBucketBySlug('recordings')) ??
        (await this.tenantBucketService.getBucketBySlug('audio'));
      if (tenantBucket) {
        uploadBucket = tenantBucket.name;
      }
    } catch (err) {
      this.logger.warn(`Failed to resolve tenant bucket, using default: ${err}`);
    }

    // 4. Build MinIO path (must match STT-v2 StoragePathResolver.audio_path)
    const now = new Date();
    const year = now.getUTCFullYear().toString();
    const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
    const safeName = this.sanitizeFilename(file.originalname);

    const pathSegment = body.consultationId
      ? `${year}/${month}/consultations/${body.consultationId}/${job.id}/raw/${safeName}`
      : `${year}/${month}/jobs/${job.id}/raw/${safeName}`;

    const audioUri = `s3://${uploadBucket}/${pathSegment}`;

    try {
      // 5. Upload audio to the tenant-resolved store (S3/MinIO or Azure)
      await this.blobStorage.putObject({
        bucket: uploadBucket,
        key: pathSegment,
        body: file.buffer,
        contentType: file.mimetype,
      });

      this.logger.log(`Uploaded audio to ${audioUri} for job ${job.id}`);

      // 6. Resolve a per-tenant storage descriptor so a DEDICATED (S3/Azure)
      //    tenant's worker connects to the right backend. `null` for SHARED
      //    tenants — the worker then uses its env-default client + bucket name.
      const storage = await this.blobStorage.resolveDescriptor(uploadBucket).catch((err) => {
        this.logger.warn(`Failed to resolve storage descriptor for ${uploadBucket}: ${err}`);
        return null;
      });

      // 7. Dispatch Dramatiq message to stt_batch queue. The worker assembles
      //    the engine chain from `resolvedSpec` (which carries its own fallback)
      //    and reads nothing from Postgres. Credentials never enter the queue
      //    message: the worker pulls them at execution
      //    (`GET internal/stt/provider-overrides`, from `AiProviderConnection`).
      //
      //    TASK-991 W2-1 — `userId` is the RESOLVED owner, not `cls.user?.id`. It is what
      //    `TranscriptionRealtimeService.resolveVoiceProfiles` keys enrolled voice profiles on, so
      //    a machine-submitted recording now diarizes against the named clinician's enrolments
      //    instead of against nothing.
      await this.dispatchBatchJob({
        jobId: job.id,
        tenantId,
        audioUri,
        consultationId: body.consultationId,
        mediaId,
        language: body.language,
        userId: ownerId,
        audioBucketName: uploadBucket,
        storage,
        resolvedSpec: resolved.spec,
        // TASK-1004 — request > consultation (off the resolver's own read), as named kwargs.
        ...this.effectiveLanguage(requestedMode, resolved),
      });
    } catch (error) {
      // If upload or dispatch fails, mark the job as failed
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch transcription setup failed for job ${job.id}: ${errorMessage}`);
      await this.jobService.failJob(job.id, errorMessage, 'SETUP_ERROR').catch(() => {});
      throw error instanceof HttpException ? error : new InternalServerErrorException(`Batch transcription setup failed: ${errorMessage}`);
    }

    // 6. Return job details + SSE URL immediately
    const sseUrl = `/api/v1/audio/transcription-jobs/${job.id}/stream`;

    return {
      id: job.id,
      status: job.status,
      sseUrl,
      audioUri,
      agentSlug: resolved.spec.agent.slug,
      agentVersionId: resolved.spec.agent.versionId,
    };
  }

  /**
   * Sanitize filename to match STT-v2's StoragePathResolver._sanitize_filename.
   */
  private sanitizeFilename(filename: string): string {
    let name = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
    name = name
      .replace(/\s/g, '_')
      .replace(/[&]/g, '_')
      .replace(/['"?#%*:|\u003c\u003e]/g, '');
    if (name.length > 200) {
      const dotIdx = name.lastIndexOf('.');
      if (dotIdx > 0) {
        const ext = name.slice(dotIdx);
        name = name.slice(0, 190) + ext;
      } else {
        name = name.slice(0, 200);
      }
    }
    return name || 'audio';
  }

  @Get('consultation/:consultationId')
  @ApiOperation({ summary: 'Get transcription jobs by consultation (caller-owned jobs)' })
  @ApiParam({ name: 'consultationId', description: 'Consultation ID' })
  async getByConsultation(@Param('consultationId') consultationId: string) {
    // EU-02 — owner-scoped: only the caller's OWN jobs for this consultation.
    // The tenant-wide view lives on the admin surface.
    return this.jobService.getByConsultationForOwner(this.getUserId(), consultationId);
  }

  /**
   * The batch ceilings a client must respect. Read-only, non-admin,
   * and declared BEFORE `@Get(':id')` so the literal path is not parsed as a job
   * id. Exists so the SDK enforces the SAME numbers the gateway does instead of
   * hardcoding "5" and "60" a second time — an operator who lowers a knob moves
   * both sides at once.
   */
  @Get('limits')
  @ApiOperation({ summary: 'Batch upload ceilings (recordings per batch, minutes per recording, size, in-flight jobs)' })
  @ApiResponse({ status: 200, description: 'Effective batch limits for the caller’s tenant' })
  async getBatchLimits(): Promise<BatchTranscriptionLimitsResponse> {
    const limits = await this.resolveBatchLimits(this.getTenantId());
    return {
      maxFilesPerBatch: limits.maxFilesPerBatch,
      maxDurationMinutes: limits.maxDurationMinutes,
      maxFileSizeBytes: limits.maxFileSizeMb * 1024 * 1024,
      maxActiveJobsPerUser: limits.maxActiveJobsPerUser,
      allowedMimeTypes: [...ALLOWED_AUDIO_MIMES],
    };
  }

  @Get('language-modes')
  @ApiOperation({
    summary: 'List selectable spoken-language modes, judged against an ASR agent’s engine chain',
    description:
      'Backend-authoritative catalog (STT owns the capability matrix). TASK-1004: each mode carries `levels` ' +
      '(per engine of the agent’s chain, primary first: `native` | `degraded` | `unsupported`) and `effective` for the chain, plus ' +
      '`agentSlug` / `engines`. `agentSlug` defaults to the caller’s resolved ASR agent; with no agent assigned the catalog-wide payload ' +
      'is returned unchanged. Strong `ETag`; send it back as `If-None-Match` for a 304. Language never chooses the engine.',
  })
  @ApiQuery({ name: 'agentSlug', required: false, description: 'ASR agent to judge the catalog against. Default: the caller’s resolved agent.' })
  @ApiResponse({ status: 200, description: 'Language-mode catalog' })
  @ApiResponse({ status: 304, description: 'Not modified — the `If-None-Match` validator is current.' })
  @ApiResponse({ status: 400, description: '`agentSlug` is not a slug.' })
  @ApiResponse({ status: 404, description: 'The named agent is unknown, unpublished, or another tenant’s.' })
  async getLanguageModes(
    @Query('agentSlug') agentSlug?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<SttLanguageModeCatalog | undefined> {
    if (agentSlug !== undefined && !AGENT_SLUG_PATTERN.test(agentSlug)) {
      throw new BadRequestException('agentSlug must be a slug ([A-Za-z0-9-])');
    }
    if (!this.languageCapability) return this.sessionService.getLanguageModes();

    // TASK-1004 — per TENANT (its default agent, its BYO chain), so never shared across tenants;
    // the capability service caches under `(tenantId, agentSlug)`.
    const { catalog, etag } = await this.languageCapability.catalogFor(this.getTenantId(), agentSlug ?? null);
    // `no-transform` so an intermediary may not rewrite the body and weaken the validator
    // (RFC 9110 §8.8.1 — the TASK-983 ingress lesson).
    res?.setHeader('Cache-Control', 'private, no-cache, no-transform');
    res?.setHeader('ETag', etag);
    if (ifNoneMatchHits(ifNoneMatch, etag)) {
      res?.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return catalog;
  }

  @Post('stream/session')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a WebSocket streaming session',
    description:
      'The speech-to-text agent is resolved in order: an explicit agentSlug on the request, else the speech-to-text node ' +
      "of the consultation's governing workflow, else the department then tenant assignment. A governing workflow that " +
      'names more than one speech-to-text agent, or one that can no longer serve, is refused with 409 ' +
      'WORKFLOW_ASR_AGENT_UNAVAILABLE. TASK-1042: `workflowSlug` opens a session for a STANDALONE workflow run ' +
      "(bind it with input.<audio>.sttSessionId on POST /workflows/{slug}/runs); the agent then comes from that workflow's " +
      'speech-to-text step.',
  })
  @ApiResponse({ status: 201, description: 'Streaming session created', type: StreamSessionResponse })
  // TASK-951 R2 — the two refusals `context` introduces. Documented here because a client that
  // cannot tell "too big" from "wrong shape" cannot fix either one.
  @ApiResponse({
    status: 400,
    description:
      '`CONTEXT_SCHEMA_VIOLATION` — `context` does not satisfy the schema the resolved ASR agent binds. ' +
      '`STREAM_SESSION_TARGET_CONFLICT` (TASK-1042) — both `workflowSlug` and `consultationId` were sent.',
  })
  @ApiResponse({ status: 413, description: '`CONTEXT_TOO_LARGE` — `context` exceeds 4096 bytes of canonical JSON' })
  // TASK-1042 (C1) — an unknown workflow, and the existing workflow-ASR refusal.
  @ApiResponse({ status: 404, description: '`workflowSlug` names no published workflow of this tenant' })
  @ApiResponse({
    status: 409,
    description:
      '`WORKFLOW_ASR_AGENT_UNAVAILABLE` — the governing or named workflow has more than one speech-to-text agent, or one that cannot serve',
  })
  async createStreamSession(@Body() body: CreateStreamSessionRequest): Promise<StreamSessionResponse> {
    const sessionId = uuidv7();
    const tenantId = this.getTenantId();
    // TASK-1042 (C1) — a session feeds a consultation OR a standalone workflow run, never both.
    // Refused before any quota, resolution or STT I/O.
    if (body.workflowSlug && body.consultationId) {
      throw new BadRequestException({
        code: 'STREAM_SESSION_TARGET_CONFLICT',
        message: 'A streaming session targets a consultation or a standalone workflow run: send consultationId or workflowSlug, not both.',
      });
    }
    // TASK-1004 — the caller's explicit mode (`languageMode` > `language`), normalized; a value
    // that names no mode is 400 LANGUAGE_MODE_UNKNOWN here, before any quota, resolution or STT I/O.
    const requestedMode = requestedLanguageMode(body);
    // TASK-933 — resolved ONCE, up front, and used by all three writes below. Resolving it here
    // also means an ownerless caller is refused BEFORE any STT or bucket I/O runs.
    const ownerId = this.resolveStreamOwnerId();
    const sampleRate = body.sampleRate ?? 16000;
    // TASK-951 R2 — the session's creation instant. Taken HERE, once, so the value the client is
    // told, the value stored on the binding, and the value every transcript echoes are the same
    // number. Segment times are relative to the session, so this is the only thing that lets a
    // caller running one session per microphone put them on a single timeline.
    const sessionEpochMs = Date.now();
    // The SIZE bound runs before anything else — it needs no tenant read, no agent resolution and
    // no STT round trip, so an oversized body is refused without consuming any of them.
    const context = this.assertStreamContextWithinBound(body.context);

    // HARD-BLOCK a new session when the tenant is at/
    // over its resolved `maxConcurrentSessions` (live socket-registry count).
    // Runs before any STT / bucket I/O so an over-capacity caller is rejected
    // early with a typed 429. No-op while the entitlements kill-switch is OFF.
    await this.entitlements.assertConcurrencyQuota(tenantId);

    // Bucket resolution: the tenant's default audio bucket (configured
    // purpose → `recordings` slug → legacy `audio` slug) so STT-v2 writes
    // audio to the tenant's bucket instead of the global 'hope-audio', plus a
    // storage descriptor for DEDICATED (S3/Azure) tenants.
    const resolveAudioBucket = async (): Promise<{ audioBucketName: string | undefined; storage: StorageDescriptor | null }> => {
      try {
        const tenantBucket =
          (await this.tenantBucketService.getBucketByPurpose(TenantBucketPurpose.AUDIO)) ??
          (await this.tenantBucketService.getBucketBySlug('recordings')) ??
          (await this.tenantBucketService.getBucketBySlug('audio'));
        const audioBucketName = tenantBucket?.name;
        const storage = audioBucketName ? await this.blobStorage.resolveDescriptor(audioBucketName) : null;
        return { audioBucketName, storage };
      } catch (err) {
        this.logger.warn(`Failed to resolve tenant audio bucket for streaming: ${err}`);
        return { audioBucketName: undefined, storage: null };
      }
    };

    // Agent resolution (TASK-861) runs in parallel with the bucket resolution —
    // independent reads; a rejected resolution (a foreign slug is a 404) still
    // rejects the whole step before anything is forwarded to STT.
    const [resolved, { audioBucketName, storage }] = await Promise.all([
      this.resolveAsrAgent(tenantId, body.agentSlug, body.consultationId, requestedMode, body.workflowSlug),
      resolveAudioBucket(),
    ]);

    // TASK-1002 — which tier resolved this session's ASR agent, so an operator can answer
    // "which tier won" from Grafana without reading Redis.
    this.logger.log({
      message: 'stt.asr_agent_resolved',
      consultationId: body.consultationId ?? null,
      agentSlug: resolved.spec.agent.slug,
      agentVersionId: resolved.spec.agent.versionId,
      source: resolved.spec.agent.source,
      workflowDefinitionSlug: resolved.workflowDefinitionSlug ?? null,
    });

    // TASK-951 R2 (D-8) — the context gate, once the agent that governs it is known. It runs
    // BEFORE the STT session is created so a refused request leaves nothing behind upstream.
    this.assertStreamContextConforms(context, resolved);

    // TASK-951 R2 (clarified) — and, from the SAME resolved artifact, the schema the session's
    // live `metadata` frames will be judged against. Resolved here rather than in the gateway
    // because this is the only point on the STT entry path that holds the agent.
    const metadataSchema = this.resolveStreamMetadataSchema(resolved);

    // The fallback + credentials for this session: the spec's own `fallback`
    // block (autoSwitch + threshold are the agent's governance) and the
    // credentials the resolver bound to the chain from `AiProviderConnection`.
    // The fallback engine itself rides INSIDE `resolvedSpec`; no pointer to it
    // is sent beside the spec (TASK-1006).
    const { providerOverrides } = resolved;
    const autoSwitchEnabled = resolved.spec.fallback.autoSwitch;
    const consecutiveFailureThreshold = resolved.spec.fallback.switchAfterConsecutiveFailures;

    // Pre-start default-provider selection. Fail-closed: opening
    // directly on the fallback engine requires a resolved fallback —
    // never silently start on primary (mirrors the C3 switch guard).
    if (body.startOn === 'fallback' && !resolved.spec.fallback.spec) {
      throw new ConflictException(`Agent '${resolved.spec.agent.slug}' declares no fallback engine`);
    }

    const sessionPayload = {
      sessionId,
      tenantId,
      resolvedSpec: resolved.spec,
      consultationId: body.consultationId,
      sampleRate,
      // TASK-1004 — ONE carrier: the normalized mode and the tier that declared it (request >
      // consultation, the latter inherited off the resolver's own consultation read — no extra
      // round trip). The raw `language` is never forwarded: every accepted value IS a mode now.
      ...this.effectiveLanguage(requestedMode, resolved),
      userId: ownerId,
      audioBucketName,
      storage,
      ...(providerOverrides ? { providerOverrides } : {}),
      // Spread on `!== undefined`, NOT truthiness — `false` is the whole point
      // of `autoSwitchEnabled`, and a truthy guard would drop
      // exactly the tenant choice that matters.
      ...(autoSwitchEnabled !== undefined ? { autoSwitchEnabled } : {}),
      ...(consecutiveFailureThreshold !== undefined ? { consecutiveFailureThreshold } : {}),
      ...(body.startOn ? { startOn: body.startOn } : {}),
      // Dual-/multi-mic source count for STT usage repricing.
      ...(body.channelCount !== undefined ? { channelCount: body.channelCount } : {}),
    } as Parameters<StreamingSessionService['createSession']>[0];

    const result = await this.sessionService.createSession(sessionPayload);

    if (!result) {
      throw new ServiceUnavailableException('STT streaming service at capacity');
    }

    // Three independent writes (parallelized):
    //  - Persist the sessionId → { tenantId, userId } mapping so
    //    the global `TenantOwnedResourceInterceptor` can 404 cross-tenant AND
    //    cross-user probes against `DELETE /stream/session/:sessionId` and its
    //    siblings. Default 24h TTL matches the longest reasonable
    //    streaming-session lifetime.
    //  - Persist session meta (negotiated sampleRate) so
    //    the WS gateway forwards audio at the real rate, not hardcoded 16000.
    //  - Mint a one-shot stream ticket scoped to this session.
    //    The SDK appends it to the WS URL; the gateway consumes it on first
    //    open and rejects (4401) every subsequent attempt.
    //
    // TASK-985 M-64 — COMPENSATE a failure here, because the STT session already exists.
    //
    // These three writes run AFTER `createSession` succeeded, so a rejection (a Redis blip, a
    // ticket-mint failure) used to propagate straight out of the handler with nothing undone:
    // the client got a 500, and the admitted STT session went on holding its GPU slot and its
    // model pin until STT's own 300 s idle reaper — a session nobody would ever connect to,
    // because the ticket it needed is exactly what failed to mint.
    //
    // `interrupted: true` is the correct flag: the session was aborted before it served a
    // single frame. It produces no spurious ledger row, because `usageSegments` drops
    // zero-duration segments. The compensation is best-effort and its own failure is swallowed
    // — the caller must see the ORIGINAL error, not a cleanup error that would send them
    // debugging the wrong hop.
    const postCreateWrites = Promise.all([
      this.streamTicketService.issueTicket({
        userId: ownerId,
        tenantId,
        scope: `stt_session:${result.sessionId}`,
      }),
      // The binding records the OWNING USER as well as the tenant: a live
      // session belongs to one clinician, and every gate downstream (ticket
      // mint, refresh-ticket, WS handshake, close/switch) compares against it.
      this.streamSessionTenantBinding.bind(result.sessionId, tenantId, ownerId),
      // TASK-951 R2 — the echo rides on the SAME meta record the gateway already reads once at
      // handshake, so the WS path costs no extra Redis round trip and cannot see a context that
      // disagrees with the sampleRate it was negotiated with.
      this.streamSessionTenantBinding.bindSessionMeta(result.sessionId, {
        sampleRate,
        ...(context ? { context } : {}),
        sessionEpochMs,
        // TASK-951 R2 (clarified) — the schema the session's `{type:'metadata'}` frames are
        // judged against, FROZEN here beside the sampleRate. The WS gateway cannot resolve an
        // agent or read a schema row on a control frame, and it must not: what a live session
        // accepts is decided once, at create, and never changes under the caller.
        ...(metadataSchema ? { metadataSchema } : {}),
        // TASK-1004 — the create-time language receipt, frozen beside the sampleRate so the WS
        // handshake's ONE meta read also gives `ready` its receipt.
        ...(result.languageResolution ? { languageResolution: result.languageResolution } : {}),
      }),
    ]);

    let issuedTicket: Awaited<ReturnType<StreamTicketService['issueTicket']>>;
    try {
      [issuedTicket] = await postCreateWrites;
    } catch (error) {
      await this.sessionService.removeSession(result.sessionId, /* interrupted */ true, tenantId).catch(() => {});
      // Drop the binding too: a half-written binding is a session id that can still mint a
      // ticket against an upstream that no longer exists, which is the false-resume path.
      await this.streamSessionTenantBinding.clear(result.sessionId).catch(() => {});
      throw error;
    }

    // Preseed contract — capture voiceProfileSeeded if the
    // streaming service surfaces it.
    const voiceProfileSeeded = result.voiceProfileSeeded ?? false;

    return {
      sessionId: result.sessionId,
      status: result.status,
      wsUrl: '/ws/stt/stream',
      maxConcurrent: result.maxConcurrent,
      currentActive: result.currentActive,
      ticket: issuedTicket.ticket,
      ticketExpiresAt: issuedTicket.expiresAt,
      voiceProfileSeeded,
      // The engine STT actually opened on. Spread only when STT echoed it, so an
      // older STT yields an unchanged response rather than a null field the SDK
      // would have to distinguish from "opened on primary".
      ...(result.activeEngine ? { activeEngine: result.activeEngine } : {}),
      // TASK-861 — the agent identity the session resolved to.
      // TASK-1002 — plus which tier resolved it (`agentSource`).
      agentSlug: resolved.spec.agent.slug,
      agentVersionId: resolved.spec.agent.versionId,
      agentSource: resolved.spec.agent.source,
      // TASK-951 R2 — what the session will echo, confirmed at create rather than discovered on
      // the first utterance.
      ...(context ? { context } : {}),
      sessionEpochMs,
      // TASK-1004 — what the session was asked for and what its serving engine applied.
      ...(result.languageResolution ? { languageResolution: result.languageResolution } : {}),
    };
  }

  /**
   * TASK-951 R2 (D-8) — the SIZE half of the `context` gate.
   *
   * Measured on the canonical JSON in UTF-8 BYTES, not `.length`: the field carries client labels
   * that may be non-ASCII, and a character count would admit an object several times the intended
   * Redis/wire cost. Returns the object unchanged so the caller reads as a pipeline.
   */
  private assertStreamContextWithinBound(context?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (context === undefined) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
    if (bytes > MAX_STREAM_SESSION_CONTEXT_BYTES) {
      throw new PayloadTooLargeException({
        code: 'CONTEXT_TOO_LARGE',
        message: `Session context is ${bytes} bytes; the maximum is ${MAX_STREAM_SESSION_CONTEXT_BYTES}.`,
      });
    }
    return context;
  }

  /**
   * TASK-951 R2 (D-8) — the SCHEMA half of the `context` gate.
   *
   * Checked against the resolved ASR agent's FROZEN `compiledConfig.contextSchema.payloadSchema`
   * — the envelope `{ [kindKey]: payload }` verbatim, the same artifact
   * `AgentInvocationService.contextProblems` uses for the invocation plane, so a tenant that
   * publishes one schema gets one answer about what its vocabulary admits on both planes.
   *
   * An agent that binds NO schema declares no vocabulary, so there is nothing to refuse: the
   * object is accepted on the size bound alone. That is deliberate and matches the invocation
   * plane's `[]` for the same case — "this agent has no opinion" must not read as
   * "everything is invalid".
   */
  private assertStreamContextConforms(context: Record<string, unknown> | undefined, resolved?: ResolvedAsrSession): void {
    if (context === undefined) return;
    const payloadSchema = resolved?.contextSchema?.payloadSchema;
    if (!payloadSchema) return;

    const problems = jsonSchemaValueProblems(payloadSchema, context, '');
    if (problems.length > 0) {
      throw new BadRequestException({
        code: 'CONTEXT_SCHEMA_VIOLATION',
        message: `The supplied context does not satisfy the schema agent '${resolved?.spec.agent.slug}' binds (version ${
          resolved?.contextSchema?.versionNumber ?? 'unknown'
        }).`,
        problems,
      });
    }
  }

  /**
   * TASK-951 R2 (clarified) — the schema ONE live `{type:'metadata'}` object must satisfy, or
   * `undefined`.
   *
   * The session-level `context` above is judged against the WHOLE envelope
   * (`{ [kindKey]: payload }`), because that is what the client sends. A `metadata` frame is
   * not an envelope — it is ONE kind's payload, the kind the tenant's schema marked
   * `streamContext`. So the schema to judge it by is that kind's own `fields`, which is exactly
   * what `payloadSchema.properties[kindKey]` holds
   * (`payloadSchemaFromDefinition` keys the envelope by kind and stores each kind's `fields` as
   * its value).
   *
   * Read STRUCTURALLY: `openBindings` is frozen into the compiled artifact by the publish path
   * and rides as an intersection on the applications-side alias, so `@arcaai/types`'
   * `AgentCompiledConfig['contextSchema']` — which is what `ResolvedAsrSession` names — does not
   * declare it. That is the same way every other consumer of the key reads it.
   *
   * `undefined` at any step is NOT a refusal: an agent with no schema, a schema with no
   * `streamContext` kind, or a kind with no declared `fields` all mean "this tenant has no
   * opinion about how a client labels its audio", and the size bound alone governs.
   */
  private resolveStreamMetadataSchema(resolved?: ResolvedAsrSession): Record<string, unknown> | undefined {
    const contextSchema = resolved?.contextSchema as
      { payloadSchema?: unknown; openBindings?: { streamContext?: { kindKey?: unknown } } } | undefined;

    const kindKey = contextSchema?.openBindings?.streamContext?.kindKey;
    if (typeof kindKey !== 'string' || kindKey.length === 0) return undefined;

    const payloadSchema = contextSchema?.payloadSchema;
    if (payloadSchema === null || typeof payloadSchema !== 'object' || Array.isArray(payloadSchema)) return undefined;

    const properties = (payloadSchema as { properties?: unknown }).properties;
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return undefined;

    const kindSchema = (properties as Record<string, unknown>)[kindKey];
    if (kindSchema === null || typeof kindSchema !== 'object' || Array.isArray(kindSchema)) return undefined;

    return kindSchema as Record<string, unknown>;
  }

  /**
   * Because `sessionId` is opaque to Prisma (the STT session row lives in
   * STT / Redis, not the gateway DB), `@TenantOwnedResource` cannot use
   * any of the repository-backed resolvers. Instead, `createStreamSession`
   * now writes a gateway-side `sessionId → tenantId` binding via
   * `StreamSessionTenantBindingService`, and the decorator's `'StreamSession'`
   * branch reads it. Cross-tenant probes 404 with no existence leak
   * (DEF-C3), matching the posture every other resource model uses.
   *
   * The binding is best-effort cleared after the downstream
   * `removeSession` succeeds; the binding's TTL (default 24h) is the
   * fallback when this clear is skipped (e.g. removeSession throws).
   *
   * Alternative designs that were considered and rejected:
   *   - Reshape the URL to `/jobs/:id/stream-session/:sessionId` so the
   *     parent jobId carries the tenant scope. Out of scope — would break
   *     the live SDK contract.
   *   - Modify STT to return `tenantId` on its status endpoint.
   *     Out of scope — touches `apps/stt` (sibling Python service).
   */
  @Delete('stream/session/:sessionId')
  @HttpCode(204)
  @TenantOwnedResource({ modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' })
  @ApiOperation({ summary: 'Close a WebSocket streaming session' })
  @ApiParam({ name: 'sessionId', description: 'Streaming session ID' })
  async closeStreamSession(@Param('sessionId') sessionId: string): Promise<void> {
    // the CLS tenant this route already authorised against is the
    // session's owner — thread it so the internal DELETE is attributable.
    await this.sessionService.removeSession(sessionId, false, this.getTenantId());
    await this.streamSessionTenantBinding.clear(sessionId);
  }

  /**
   * Mint a fresh single-use stream ticket for an existing
   * session. The SDK calls this from `SttWebSocketClient.attemptReconnect`
   * before reopening the WebSocket, since each ticket is one-shot and gets
   * consumed by the previous connection.
   *
   * This is the second `stt_session:<sessionId>` mint (the
   * first is `POST /auth/stream-ticket`), so it carries the same
   * `StreamSession` ownership guard as the sibling DELETE route: the
   * interceptor 404s any caller whose tenant doesn't match the session's
   * binding (no existence leak), keeping mint + WS handshake two
   * independent gates on this path too.
   */
  @Post('stream/session/:sessionId/refresh-ticket')
  @HttpCode(200)
  @TenantOwnedResource({ modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' })
  @ApiOperation({ summary: 'Refresh the stream ticket for a live streaming session' })
  @ApiParam({ name: 'sessionId', description: 'Streaming session ID' })
  async refreshStreamTicket(@Param('sessionId') sessionId: string): Promise<{ ticket: string; ticketExpiresAt: number }> {
    if (!sessionId?.trim()) {
      throw new BadRequestException('sessionId is required');
    }

    const tenantId = this.getTenantId();

    const issued = await this.streamTicketService.issueTicket({
      // TASK-933 — the SAME resolution the binding was written with, so the reconnect handshake
      // compares like with like. The interceptor has already proved this caller owns the session.
      userId: this.resolveStreamOwnerId(),
      tenantId,
      scope: `stt_session:${sessionId}`,
    });

    return { ticket: issued.ticket, ticketExpiresAt: issued.expiresAt };
  }

  /**
   * Manual mid-session switch to the session's fallback engine (the ASR
   * agent's `fallback` block, frozen into its resolved spec) — the end-user
   * "I don't want this provider" affordance. Guarded exactly like
   * `closeStreamSession` (`@TenantOwnedResource` 404s cross-tenant probes with no
   * existence leak). Fail-CLOSED on selection: a session whose agent declares no
   * fallback gets a 409 (never a silent no-op). The seamless swap itself runs
   * in apps/stt's `EngineSwitchController`; a 409 from there (already on
   * fallback, or none declared) is surfaced as a 409, a 404 (unknown session)
   * as a 404.
   */
  @Post('stream/session/:sessionId/switch-to-fallback')
  @HttpCode(200)
  @TenantOwnedResource({ modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' })
  @ApiOperation({ summary: "Switch a live streaming session to its ASR agent's fallback engine" })
  @ApiParam({ name: 'sessionId', description: 'Streaming session ID' })
  @ApiResponse({ status: 200, description: 'Switch requested; the session continues on the fallback engine.' })
  @ApiResponse({ status: 409, description: "The session's ASR agent declares no fallback engine, or the session is already on it." })
  async switchStreamSessionToFallback(@Param('sessionId') sessionId: string): Promise<{ switched: true }> {
    if (!sessionId?.trim()) {
      throw new BadRequestException('sessionId is required');
    }
    const tenantId = this.getTenantId();

    // Fail-closed selection guard. TASK-861: the fallback is a property of the
    // SESSION (its resolved spec), not of the tenant, so the runtime is the
    // authority — apps/stt answers 409 when the session declares none, mapped
    // below.
    try {
      await this.sessionService.switchToFallback(sessionId, tenantId);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        throw new ConflictException('Session is already on the fallback engine, or no fallback is available');
      }
      if (status === 404) {
        throw new NotFoundException(`Streaming session ${sessionId} not found`);
      }
      throw err;
    }
    return { switched: true };
  }

  /**
   * Manual mid-session switch BACK to the SDK-configured primary pipeline
   * the primary-direction counterpart of
   * `switchStreamSessionToFallback`, so native SDK consumers get a 2-way
   * pipeline↔default toggle. Guarded exactly like `closeStreamSession`
   * (`@TenantOwnedResource` 404s cross-tenant probes with no existence leak).
   * No fallback-config precheck applies here — that is a fallback-direction
   * concern; the primary pipeline is whatever the session was created with.
   * The seamless swap runs in apps/stt's `EngineSwitchController`; a 409 from
   * there (already on primary / the primary engine was never loaded) is
   * surfaced as a 409, a 404 (unknown session) as a 404.
   */
  @Post('stream/session/:sessionId/switch-to-primary')
  @HttpCode(200)
  @TenantOwnedResource({ modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' })
  @ApiOperation({ summary: 'Switch a live streaming session back to its primary pipeline' })
  @ApiParam({ name: 'sessionId', description: 'Streaming session ID' })
  @ApiResponse({ status: 200, description: 'Switch requested; the session continues on the primary engine.' })
  @ApiResponse({ status: 409, description: 'The session is already on the primary pipeline, or the primary engine was never loaded.' })
  async switchStreamSessionToPrimary(@Param('sessionId') sessionId: string): Promise<{ switched: true }> {
    if (!sessionId?.trim()) {
      throw new BadRequestException('sessionId is required');
    }

    try {
      await this.sessionService.switchProvider(sessionId, 'primary', this.getTenantId());
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        throw new ConflictException('Session is already on the primary pipeline, or the primary engine is not available');
      }
      if (status === 404) {
        throw new NotFoundException(`Streaming session ${sessionId} not found`);
      }
      throw err;
    }
    return { switched: true };
  }

  @Get(':id')
  @TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })
  @ApiOperation({ summary: 'Get transcription job by ID' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async getById(@Param('id') id: string) {
    const job = await this.jobService.getById(id);
    if (!job) {
      throw new NotFoundException(`Transcription job ${id} not found`);
    }
    return job;
  }

  // @StreamScope lets single-use tickets from
  // POST /auth/stream-ticket (scope `transcription_job:<id>`) authenticate this
  // SSE route; the @TenantOwnedResource pre-stream tenant assertion is unchanged.
  @Get(':id/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })
  @StreamScope({ namespace: 'transcription_job', param: 'id' })
  @ApiOperation({
    summary: 'Stream transcription job events via SSE',
    description:
      'Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by ' +
      '`POST /auth/stream-ticket` with scope `transcription_job:<id>`.',
  })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  streamJob(@Param('id') id: string): Observable<MessageEvent> {
    if (!id?.trim()) {
      throw new BadRequestException('A valid transcription job ID is required');
    }
    return this.realtimeService.subscribeToJob(id.trim());
  }

  @Post(':id/cancel')
  @TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })
  @ApiOperation({ summary: 'Cancel a transcription job' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async cancel(@Param('id') id: string) {
    // EU-01 — creator-scoped: a same-tenant peer cannot cancel a job they did
    // not create. (The @TenantOwnedResource interceptor enforces the tenant
    // boundary; its creator branch resolves a `userId`, but TranscriptionJob is
    // `createdBy`-scoped, so the creator check is enforced in the service.)
    return this.jobService.cancelJobForOwner(this.getUserId(), id);
  }

  @Post(':id/retry')
  @TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })
  @ApiOperation({
    summary: 'Retry a failed transcription job',
    description:
      'Re-publishes the job to the `stt_batch` worker queue and returns it at `QUEUED`. ' +
      'A retry is only possible while `retryCount < maxRetries`, and only for a job this caller created.',
  })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  @ApiResponse({ status: 400, description: 'The job has exhausted its retry budget; it is marked DEAD.' })
  @ApiResponse({ status: 404, description: 'Unknown job, or a job created by another user.' })
  @ApiResponse({
    status: 409,
    description:
      '`RETRY_ENVELOPE_MISSING` — the job carries no record of what was dispatched for it, which is the case for ' +
      'every job created before this capability shipped. Submit the audio again as a new job.',
  })
  @ApiResponse({ status: 503, description: "`RETRY_STORAGE_UNRESOLVED` — the job's tenant storage backend cannot be resolved right now." })
  async retry(@Param('id') id: string) {
    // EU-01 — creator-scoped (mirrors cancel); the assertion runs inside.
    //
    // TASK-992 FU-1 — this goes through the REALTIME service, not
    // `jobService.retryJobForOwner`, because that call only flips the row back
    // to QUEUED. The batch plane is driven entirely by the `stt_batch` Dramatiq
    // queue, so a row with no message behind it is never claimed: the caller
    // got a 200 and a job that sat at QUEUED forever, indistinguishable from a
    // backed-up queue. The realtime service owns message construction, so the
    // retry rebuilds the message in the one place that also builds the original.
    return this.realtimeService.retryAndDispatch(id, { ownerId: this.getUserId() });
  }

  @Get()
  @ApiOperation({ summary: 'List transcription jobs (paginated, caller-owned jobs)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(@Query('page') page: number = 1, @Query('limit') limit: number = 20) {
    // Owner-scoped: the caller's jobs only. The tenant-wide
    // listing lives on the admin surface (/admin/audio/transcription-jobs).
    return this.jobService.listForOwner(this.getUserId(), page, limit);
  }
}
