import {
  ConsultationAttachmentPurpose,
  ConsultationAttachmentRepository,
  ConsultationAttachmentStatus,
  ConsultationEntity,
  ConsultationFeedbackEntity,
  ConsultationFeedbackFactory,
  ConsultationFeedbackRepository,
  ConsultationRepository,
  ContextItemRepository,
  CoreUnitOfWorkService,
  FeedbackCursor,
  FeedbackRating,
  FeedbackTargetKind,
  NamedEntityRepository,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional, PayloadTooLargeException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, assertParentInScope, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { GateEditMiningJob, IGateEditMiningQueue } from '../../gate-edit-mining/IGateEditMiningQueue';
import {
  FEEDBACK_REASON_CODES_DEFAULT,
  FEEDBACK_REASON_CODES_KEY,
} from '../../settings-registry/descriptors/consultation-attachments-feedback.descriptors';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { IContextService } from '../context/IContextService';
import { JobIdempotencyService } from '../jobs/job-idempotency.service';
import { ClinicalCaller, IConsultationLifecycleGate, IConsultationLifecycleGateToken } from '../lifecycle/IConsultationLifecycleService';
import { CreateFeedbackRequest, FeedbackPageResponse, FeedbackReasonCodesResponse, FeedbackResponse } from './dto';
import { FeedbackProvenanceResolver, provenanceColumns } from './feedback-provenance';
import {
  FEEDBACK_ERROR_CODES,
  FeedbackPolicyError,
  FeedbackReason,
  FeedbackShapeLimits,
  FeedbackTargetKindValue,
  FeedbackTargetRef,
  assertFeedbackShape,
  targetKey,
  validateReasonList,
} from './feedback-policy';
import { FeedbackListFilters, FeedbackMiningSignal, IConsultationFeedbackService } from './IConsultationFeedbackService';

const COMMENT_MAX_CHARS_KEY = 'consultation.feedback.commentMaxChars';
const MAX_MEDIA_KEY = 'consultation.feedback.maxMediaPerFeedback';
const COMMENT_MAX_CHARS_FALLBACK = 4000;
const MAX_MEDIA_FALLBACK = 3;

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

const RATING_TO_DB: Readonly<Record<string, FeedbackRating>> = { up: FeedbackRating.UP, down: FeedbackRating.DOWN, cleared: FeedbackRating.CLEARED };
const RATING_FROM_DB: Readonly<Record<FeedbackRating, 'up' | 'down' | 'cleared'>> = {
  [FeedbackRating.UP]: 'up',
  [FeedbackRating.DOWN]: 'down',
  [FeedbackRating.CLEARED]: 'cleared',
};

/** Who the row is attributed to: a human acts as themself; a machine acts as the consultation's doctor. */
interface FeedbackActor {
  userId: string;
  credentialClass: 'jwt' | 'api-key' | 'service-account';
  principalId: string | null;
}

interface ResolvedTarget {
  ref: FeedbackTargetRef & { versionNumber: number };
  encounterSeq: number | null;
  entityLabel: string | null;
}

@Injectable()
export class ConsultationFeedbackService extends BaseService implements IConsultationFeedbackService {
  private readonly logger = new Logger(ConsultationFeedbackService.name);

  constructor(
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly feedbackRepository: ConsultationFeedbackRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly namedEntityRepository: NamedEntityRepository,
    private readonly attachmentRepository: ConsultationAttachmentRepository,
    private readonly unitOfWork: CoreUnitOfWorkService,
    @Inject(IConsultationLifecycleGateToken) private readonly lifecycleGate: IConsultationLifecycleGate,
    @Inject(IContextService) private readonly contextService: IContextService,
    private readonly provenance: FeedbackProvenanceResolver,
    private readonly settings: TenantSettingsService,
    private readonly idempotency: JobIdempotencyService,
    // Unwired ⇒ feedback is not mined; it never blocks the clinician's write.
    @Optional() @Inject(IGateEditMiningQueue) private readonly miningQueue?: { enqueue(job: GateEditMiningJob): Promise<void> },
    // Unwired ⇒ the shared PHI guard decides (soft in dev, fail-closed under Vault).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.ConsultationFeedback);
  }

  // ============================================================
  // Create
  // ============================================================

  async create(
    consultationId: string,
    body: CreateFeedbackRequest,
    idempotencyKey: string | undefined,
    caller: ClinicalCaller,
  ): Promise<FeedbackResponse> {
    const tenantId = this.requireTenant();
    const consultation = await assertParentInScope<ConsultationEntity>(this.consultationRepository as never, consultationId, tenantId);

    const comment = body.comment?.trim() ? body.comment.trim() : null;
    this.assertShape(body, comment, tenantId);
    const actor = this.resolveActor(caller, consultation);

    let created: { entity: ConsultationFeedbackEntity; comment: string | null } | undefined;
    const { value: feedbackId } = await this.idempotency.run<string>(
      { operation: `consultation-feedback:${consultationId}`, tenantId, principalId: actor.principalId ?? actor.userId, key: idempotencyKey },
      {
        target: body.target ?? null,
        rating: body.rating ?? null,
        reasonCodes: body.reasonCodes ?? [],
        comment,
        attachmentIds: body.attachmentIds ?? [],
        correction: body.correction ?? null,
        client: body.client ?? null,
      },
      async () => {
        const stored = idempotencyKey ? await this.findByIdempotencyKey(consultationId, idempotencyKey, actor.userId) : null;
        if (stored) return stored.id;
        created = { entity: await this.persist(tenantId, consultation, body, comment, idempotencyKey, actor), comment };
        return created.entity.id;
      },
    );

    if (created) return this.toResponse(created.entity, created.comment);
    const row = await this.feedbackRepository.findById(feedbackId);
    return this.toResponse(row, await this.decryptComment(row));
  }

  private async persist(
    tenantId: string,
    consultation: ConsultationEntity,
    body: CreateFeedbackRequest,
    comment: string | null,
    idempotencyKey: string | undefined,
    actor: FeedbackActor,
  ): Promise<ConsultationFeedbackEntity> {
    const consultationId = consultation.id;
    const target = body.target ? await this.resolveTarget(consultationId, tenantId, body.target) : null;
    const mediaIds = await this.resolveFeedbackMedia(consultationId, tenantId, body.attachmentIds ?? []);
    if (body.correction) await this.lifecycleGate.assertContentWritable(consultationId);

    const snapshot = target
      ? await this.provenance.resolve({ tenantId, consultationId, contextItemId: target.ref.contextItemId, versionNumber: target.ref.versionNumber })
      : null;
    const rating = body.rating ? RATING_TO_DB[body.rating] : null;

    const entity = ConsultationFeedbackFactory.CreateConsultationFeedback({
      tenantId,
      consultationId,
      encounterSeq: target?.encounterSeq ?? consultation.currentEncounterSeq ?? null,
      actorUserId: actor.userId,
      actorCredentialClass: actor.credentialClass,
      actorPrincipalId: actor.principalId,
      clientApp: body.client?.app ?? null,
      clientSurface: body.client?.surface ?? null,
      targetKind: target ? (target.ref.kind as FeedbackTargetKind) : null,
      targetContextItemId: target?.ref.contextItemId ?? null,
      targetVersionNumber: target?.ref.versionNumber ?? null,
      targetSectionKey: target?.ref.sectionKey ?? null,
      targetDocumentKey: target?.ref.documentKey ?? null,
      targetEntityRef: target?.ref.entityRef ?? null,
      entityLabel: target?.entityLabel ?? null,
      targetKey: target ? targetKey(target.ref) : null,
      rating,
      reasonCodes: body.reasonCodes ?? [],
      comment,
      mediaIds,
      provenance: snapshot ? (snapshot as never) : null,
      ...provenanceColumns(snapshot),
      idempotencyKey: idempotencyKey ?? null,
      createdBy: actor.userId,
    });

    if (comment) {
      await encryptPhiFields(
        this.secretsService,
        'ConsultationFeedback',
        () => this.feedbackRepository.encryptFieldsIntoEntity(entity, this.secretsService!),
        this.logger,
      );
    }

    const { saved } = await this.unitOfWork.runInTransaction(async (tx) => {
      if (body.correction && target) {
        const { versionNumber } = await this.contextService.appendVersion({
          contextItemId: target.ref.contextItemId,
          content: body.correction.content,
          expectedVersion: body.correction.expectedVersion,
          changeSource: 'feedback',
          changeReason: 'feedback',
          changedBy: actor.userId,
          metaData: { feedbackId: entity.id },
        });
        entity.correctionContextItemId = target.ref.contextItemId;
        entity.correctionVersionNumber = versionNumber;
      }
      return this.feedbackRepository.appendWithSupersede(entity, tx);
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: {
        consultationId,
        targetKind: saved.targetKind ?? null,
        rating: saved.rating ?? null,
        reasonCount: saved.reasonCodes?.length ?? 0,
        hasComment: comment !== null,
        hasCorrection: saved.correctionVersionNumber != null,
        mediaCount: mediaIds.length,
        supersedesId: saved.supersedesId ?? null,
      },
    });
    await this.touch(consultationId);
    if (rating === FeedbackRating.DOWN || body.correction) {
      await this.enqueueMining({
        tenantId,
        consultationId,
        contextItemId: target?.ref.contextItemId ?? null,
        doctorId: consultation.doctorId,
        gateDecision: 'feedback',
        signedAt: null,
        source: 'feedback',
        feedbackId: saved.id,
      });
    }
    return saved;
  }

  // ============================================================
  // Reads
  // ============================================================

  async list(consultationId: string, filters: FeedbackListFilters): Promise<FeedbackPageResponse> {
    const tenantId = this.requireTenant();
    await assertParentInScope(this.consultationRepository as never, consultationId, tenantId);
    return this.page(consultationId, {
      limit: filters.limit,
      cursor: filters.cursor,
      targetKind: filters.targetKind,
      contextItemId: filters.contextItemId,
      includeHistory: filters.includeHistory ?? false,
    });
  }

  async listForActivity(consultationId: string, page: { cursor?: string; limit?: number }): Promise<FeedbackPageResponse> {
    const tenantId = this.requireTenant();
    await assertParentInScope(this.consultationRepository as never, consultationId, tenantId);
    return this.page(consultationId, { limit: page.limit, cursor: page.cursor, includeHistory: true });
  }

  async reasonCodes(tenantId?: string): Promise<FeedbackReasonCodesResponse> {
    const { reasons, source } = this.effectiveReasons(tenantId ?? this.tenantId ?? null);
    return {
      items: reasons.map((r) => ({ code: r.code, label: r.label, ...(r.appliesTo ? { appliesTo: [...r.appliesTo] } : {}) })),
      source,
    };
  }

  private async page(
    consultationId: string,
    options: { limit?: number; cursor?: string; targetKind?: FeedbackTargetKindValue; contextItemId?: string; includeHistory: boolean },
  ): Promise<FeedbackPageResponse> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT);
    const { items, next } = await this.feedbackRepository.listCursor(consultationId, {
      limit,
      targetKind: options.targetKind as FeedbackTargetKind | undefined,
      contextItemId: options.contextItemId,
      includeHistory: options.includeHistory,
      after: options.cursor ? decodeCursor(options.cursor) : undefined,
    });
    const rows: FeedbackResponse[] = [];
    for (const row of items) rows.push(this.toResponse(row, await this.decryptComment(row)));
    return { items: rows, nextCursor: next ? encodeCursor(next) : null };
  }

  // ============================================================
  // Validation
  // ============================================================

  private assertShape(body: CreateFeedbackRequest, comment: string | null, tenantId: string): void {
    const limits: FeedbackShapeLimits = {
      reasons: this.effectiveReasons(tenantId).reasons,
      commentMaxChars: this.numberSetting(COMMENT_MAX_CHARS_KEY, tenantId, COMMENT_MAX_CHARS_FALLBACK),
      maxMedia: this.numberSetting(MAX_MEDIA_KEY, tenantId, MAX_MEDIA_FALLBACK),
    };
    try {
      assertFeedbackShape(
        {
          target: body.target ?? null,
          rating: body.rating ?? null,
          reasonCodes: body.reasonCodes,
          comment,
          attachmentIds: body.attachmentIds,
          correction: body.correction,
        },
        limits,
      );
    } catch (error) {
      if (!(error instanceof FeedbackPolicyError)) throw error;
      const payload = { code: error.code, message: error.message, ...error.details };
      throw error.httpStatus === 413 ? new PayloadTooLargeException(payload) : new BadRequestException(payload);
    }
    if (body.target?.kind === 'ENTITY' && !body.target.entityRef) {
      throw new BadRequestException({ code: FEEDBACK_ERROR_CODES.TARGET_REQUIRED, message: 'An ENTITY target needs an entityRef.' });
    }
  }

  /** The item belongs to this consultation, the version exists (pinned to the current one when omitted), the entity belongs to the item. */
  private async resolveTarget(
    consultationId: string,
    tenantId: string,
    target: NonNullable<CreateFeedbackRequest['target']>,
  ): Promise<ResolvedTarget> {
    const item = await this.contextItemRepository.findByIdOrNull(target.contextItemId);
    if (!item || item.tenantId !== tenantId || item.consultationId !== consultationId) throw targetNotFound();
    const versionNumber = target.versionNumber ?? item.currentVersionNumber;
    if (versionNumber > item.currentVersionNumber) throw targetNotFound();

    let entityLabel: string | null = null;
    if (target.entityRef) {
      const named = await this.namedEntityRepository.findByIdOrNull(target.entityRef);
      if (!named || named.tenantId !== tenantId || named.contextItemId !== item.id) throw targetNotFound();
      entityLabel = named.className ?? null;
    }

    return {
      ref: {
        kind: target.kind,
        contextItemId: item.id,
        versionNumber,
        sectionKey: target.sectionKey ?? null,
        documentKey: target.documentKey ?? null,
        entityRef: target.entityRef ?? null,
      },
      encounterSeq: item.encounterSeq ?? null,
      entityLabel,
    };
  }

  /** Each id must be a READY `purpose=feedback` attachment of this consultation; answers its Media ids. */
  private async resolveFeedbackMedia(consultationId: string, tenantId: string, attachmentIds: readonly string[]): Promise<string[]> {
    const mediaIds: string[] = [];
    for (const attachmentId of attachmentIds) {
      const attachment = await this.attachmentRepository.findByIdOrNull(attachmentId);
      const usable =
        attachment &&
        attachment.tenantId === tenantId &&
        attachment.consultationId === consultationId &&
        attachment.purpose === ConsultationAttachmentPurpose.FEEDBACK &&
        attachment.status === ConsultationAttachmentStatus.READY &&
        attachment.mediaId;
      if (!usable) {
        throw new BadRequestException({
          code: FEEDBACK_ERROR_CODES.ATTACHMENT_INVALID,
          message: 'Every attachment must be a READY feedback attachment of this consultation.',
          attachmentId,
        });
      }
      mediaIds.push(attachment.mediaId as string);
    }
    return mediaIds;
  }

  private resolveActor(caller: ClinicalCaller, consultation: ConsultationEntity): FeedbackActor {
    if (caller.isMachine) {
      return {
        userId: consultation.doctorId,
        credentialClass: caller.serviceAccountId ? 'service-account' : 'api-key',
        principalId: caller.serviceAccountId ?? caller.apiKeyId ?? null,
      };
    }
    const userId = caller.userId ?? this.requestUserId;
    if (!userId) throw new BadRequestException('A user is required to record feedback.');
    return { userId, credentialClass: 'jwt', principalId: null };
  }

  // ============================================================
  // Settings
  // ============================================================

  private effectiveReasons(tenantId: string | null): { reasons: FeedbackReason[]; source: 'tenant' | 'system' } {
    try {
      const resolved = this.settings.resolve<unknown>(FEEDBACK_REASON_CODES_KEY, tenantId);
      if (validateReasonList(resolved.value) === undefined) {
        return { reasons: resolved.value as FeedbackReason[], source: resolved.source === 'tenant' ? 'tenant' : 'system' };
      }
      this.logger.warn({ message: 'feedback.reason_codes_invalid', source: resolved.source });
    } catch (error) {
      this.logger.warn({ message: 'feedback.reason_codes_unresolved', error: errorText(error) });
    }
    return { reasons: FEEDBACK_REASON_CODES_DEFAULT.map((r) => ({ code: r.code, label: r.label })), source: 'system' };
  }

  private numberSetting(key: string, tenantId: string, fallback: number): number {
    try {
      const value = this.settings.resolve<unknown>(key, tenantId).value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch (error) {
      this.logger.warn({ message: 'feedback.setting_unresolved', key, error: errorText(error) });
    }
    return fallback;
  }

  // ============================================================
  // Helpers
  // ============================================================

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    return tenantId;
  }

  private async findByIdempotencyKey(
    consultationId: string,
    idempotencyKey: string,
    actorUserId: string,
  ): Promise<ConsultationFeedbackEntity | null> {
    const rows = await this.feedbackRepository.findAll({ where: { consultationId, idempotencyKey, actorUserId }, limit: 1 } as never);
    return rows[0] ?? null;
  }

  private async decryptComment(row: ConsultationFeedbackEntity): Promise<string | null> {
    if (!row.encryptedComment || !this.secretsService) return null;
    return this.feedbackRepository.decryptFieldsFromEntity(row, this.secretsService);
  }

  private async touch(consultationId: string): Promise<void> {
    try {
      await this.lifecycleGate.touchActivity(consultationId);
    } catch (error) {
      // swallow-ok: the activity clock is advisory; the feedback is already committed.
      this.logger.warn({ message: 'feedback.touch_activity_failed', consultationId, error: errorText(error) });
    }
  }

  private async enqueueMining(job: GateEditMiningJob & FeedbackMiningSignal): Promise<void> {
    if (!this.miningQueue) return;
    try {
      await this.miningQueue.enqueue(job);
    } catch (error) {
      // swallow-ok: mining is a learning signal, never a reason to fail the clinician's write.
      this.logger.warn({ message: 'feedback.mining_enqueue_failed', consultationId: job.consultationId, error: errorText(error) });
    }
  }

  private toResponse(row: ConsultationFeedbackEntity, comment: string | null): FeedbackResponse {
    const hasProvenance = row.provAgentSlug || row.provModelName || row.provPromptVersion || row.provWorkflowRunId || row.provActivityRunId;
    return {
      id: row.id,
      consultationId: row.consultationId,
      target:
        row.targetKind && row.targetContextItemId
          ? {
              kind: row.targetKind as FeedbackTargetKindValue,
              contextItemId: row.targetContextItemId,
              versionNumber: row.targetVersionNumber ?? null,
              sectionKey: row.targetSectionKey ?? null,
              documentKey: row.targetDocumentKey ?? null,
              entityRef: row.targetEntityRef ?? null,
            }
          : null,
      rating: row.rating ? RATING_FROM_DB[row.rating] : null,
      reasonCodes: [...(row.reasonCodes ?? [])],
      comment,
      attachmentIds: [...(row.mediaIds ?? [])],
      correction:
        row.correctionContextItemId && row.correctionVersionNumber != null
          ? { contextItemId: row.correctionContextItemId, versionNumber: row.correctionVersionNumber }
          : null,
      isLatest: row.isLatest ?? true,
      ...(row.supersedesId ? { supersedes: row.supersedesId } : {}),
      provenance: hasProvenance
        ? {
            agentSlug: row.provAgentSlug ?? null,
            agentVersion: row.provAgentVersion ?? null,
            modelName: row.provModelName ?? null,
            promptVersion: row.provPromptVersion ?? null,
            workflowRunId: row.provWorkflowRunId ?? null,
            activityRunId: row.provActivityRunId ?? null,
          }
        : null,
      actor: { userId: row.actorUserId, credentialClass: row.actorCredentialClass },
      client: { app: row.clientApp ?? null, surface: row.clientSurface ?? null },
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    };
  }
}

function targetNotFound(): NotFoundException {
  return new NotFoundException({ code: 'FEEDBACK_TARGET_NOT_FOUND', message: 'The feedback target was not found in this consultation.' });
}

function encodeCursor(cursor: FeedbackCursor): string {
  return Buffer.from(JSON.stringify({ k: cursor.createdAt.toISOString(), id: cursor.id })).toString('base64url');
}

function decodeCursor(raw: string): FeedbackCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { k?: unknown; id?: unknown };
    const createdAt = typeof parsed.k === 'string' ? new Date(parsed.k) : null;
    if (createdAt && !Number.isNaN(createdAt.getTime()) && typeof parsed.id === 'string' && parsed.id.length > 0) {
      return { createdAt, id: parsed.id };
    }
  } catch {
    // swallow-ok: an undecodable cursor is answered by the 400 below.
  }
  throw new BadRequestException({ code: 'FEEDBACK_CURSOR_INVALID', message: 'The cursor is not valid.' });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
