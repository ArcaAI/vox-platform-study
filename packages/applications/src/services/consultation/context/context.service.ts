import {
  AudioRecordingFactory,
  AudioRecordingRepository,
  ConsultationEntity,
  ConsultationRepository,
  ContextItemEntity,
  ContextItemFactory,
  ContextItemRepository,
  ContextItemSource,
  ContextItemType,
  ContextItemVersionFactory,
  ContextItemVersionRepository,
  NamedEntityFactory,
  NamedEntityRepository,
  ResourceType,
  SummaryMetaFactory,
  SummaryMetaRepository,
  SysEventType,
} from '@arcaai/domains';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, assertParentInScope, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IContextService } from './IContextService';
import { ContextDtoMapper } from './context.dto.mapper';
import { ConsultationPipelineEvent, ContextAddedPayload, ContextRemovedPayload } from '../events';
import {
  AddAudioRecordingRequest,
  AddContextRequest,
  AddNamedEntitiesRequest,
  AddRawSummaryRequest,
  AggregateNamedEntityItem,
  AggregateNerResponse,
  AggregateNerSource,
  AudioRecordingResponse,
  ContextFiltersDto,
  ContextItemResponse,
  ContextItemVersionResponse,
  NamedEntityResponse,
  PaginatedContextItemResponse,
  SummaryMetaResponse,
  UpdateContextRequest,
  VersionDiffResponse,
} from './dto';

/**
 * Context item types that trigger a `ConsultationPipelineEvent.ContextAdded`
 * fan-out for the live-documentation watcher (Clinical Workflow Playground WS2).
 * Human-authored notes / attachments only — transcripts and AI summaries are
 * excluded.
 */
const LIVE_CONTEXT_TYPES = new Set<ContextItemType>([ContextItemType.WORKNOTE, ContextItemType.CASE_NOTE, ContextItemType.ATTACHMENT]);

@Injectable()
export class ContextService extends BaseService implements IContextService {
  constructor(
    private readonly contextItemRepository: ContextItemRepository,
    private readonly contextItemVersionRepository: ContextItemVersionRepository,
    private readonly audioRecordingRepository: AudioRecordingRepository,
    private readonly summaryMetaRepository: SummaryMetaRepository,
    private readonly namedEntityRepository: NamedEntityRepository,
    private readonly consultationRepository: ConsultationRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-369 Phase 3B — Vault-Transit field encryption for `content`.
    // Optional + @Inject so legacy/direct-construction tests (which don't wire
    // the @Global SecretsService) still work, mirroring ApiKeyService /
    // StorageAccessKeyService. When absent, `content` is left unpersisted
    // (Phase 6 dropped the plaintext column).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.ContextItem);
  }

  private readonly logger = new Logger(ContextService.name);

  /**
   * TASK-369 — dual-write: encrypt the entity's plaintext `content` into
   * `encryptedContent` / `contentKeyVersion` (Vault Transit `hope-phi`) before
   * persistence, via the shared env-gated guard: a soft no-op in dev/test, but
   * fail-closed (throws) in staging/prod (SECRETS_PROVIDER=vault) so a populated
   * `content` is never persisted plaintext-only. Phase 6 has dropped the plaintext
   * column; reads decrypt the ciphertext only.
   */
  private async encryptContent(entity: ContextItemEntity): Promise<void> {
    await encryptPhiFields(
      this.secretsService,
      'ContextItem content',
      () => this.contextItemRepository.encryptContentIntoEntity(entity, this.secretsService!),
      this.logger,
    );
  }

  /**
   * TASK-369 — encrypt-on-write for the sibling clinical models persisted by
   * this service (ContextItemVersion snapshots, SummaryMeta provenance,
   * NamedEntity spans). Mirrors {@link encryptContent}: a soft no-op in dev/test,
   * fail-closed (throws) in staging/prod (SECRETS_PROVIDER=vault).
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  // ============================================
  // Context Item CRUD
  // ============================================

  /**
   * Add context item to consultation
   */
  async addContext(consultationId: string, request: AddContextRequest): Promise<ContextItemResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-305 D.3 (audit C-3) — verify the parent consultation lives in
    // the caller's tenant. `assertParentInScope` throws
    // `NotFoundException` for both missing-parent and cross-tenant cases
    // so the response never reveals the existence of a foreign-tenant
    // consultation.
    await assertParentInScope(this.consultationRepository, consultationId, tenantId);

    // Validate content for non-media types
    const isMediaType = request.type === ContextItemType.AUDIO_RECORDING || request.type === ContextItemType.ATTACHMENT;
    if (!isMediaType && !request.content) {
      throw new BadRequestException('Content is required for non-media types');
    }

    const contextItem = ContextItemFactory.CreateContextItem({
      tenantId,
      consultationId,
      type: request.type,
      source: request.source ?? ContextItemSource.USER,
      content: request.content,
      mediaId: request.mediaId,
      dnaWritingStyleId: request.dnaWritingStyleId,
      createdBy: userId ?? undefined,
    });

    // Clinical Workflow Playground (WS5) — persist optional free-form metadata
    // (e.g. `{ subType: 'LAB_RESULT' }` on ATTACHMENTs). Set before create so it
    // is included in the entity's toObject() payload.
    if (request.metadata) {
      contextItem.metaData = request.metadata;
    }

    // TASK-369 Phase 3B — encrypt `content` into the ciphertext columns before
    // the first persist (dual-write; plaintext column is retained for the soak).
    await this.encryptContent(contextItem);

    const saved = await this.contextItemRepository.create(contextItem);

    // Create initial version (v1) for audit trail completeness.
    // Media types (AUDIO_RECORDING, ATTACHMENT) are excluded since they have no text content to version.
    if (!isMediaType) {
      const initialVersion = ContextItemVersionFactory.CreateInitialVersion(saved, userId ?? 'system');
      await this.encryptBestEffort('ContextItemVersion', () =>
        this.contextItemVersionRepository.encryptFieldsIntoEntity(initialVersion, this.secretsService!),
      );
      await this.contextItemVersionRepository.create(initialVersion);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      responsibleEntityId: userId ?? undefined,
      createdAt: saved.createdAt,
      data: { consultationId, type: request.type },
    });

    // Clinical Workflow Playground (WS2) — fan a lightweight ContextAdded event
    // out to the LiveDocumentationService so notes / labs / files added
    // mid-visit are folded into the running live summary. Restricted to the
    // human-authored note/attachment types; TRANSCRIPT already drives the
    // harness pipeline via TranscriptionCreated and AI summaries are not live
    // inputs.
    if (LIVE_CONTEXT_TYPES.has(request.type)) {
      const subType = typeof request.metadata?.subType === 'string' ? (request.metadata.subType as string) : undefined;
      // TASK-342 GAP #5 — for uploaded lab/exam files the client extracts the
      // file's text (txt / csv / md / json) into `metadata.extractedText`; thread
      // the real contents into the live summary instead of the "Lab/exam result:
      // <name>" filename label. Falls back to `content` when nothing was extracted.
      const extractedText = typeof request.metadata?.extractedText === 'string' ? (request.metadata.extractedText as string) : undefined;
      const preview = extractedText ?? request.content;
      this.eventEmitter.emit(ConsultationPipelineEvent.ContextAdded, {
        consultationId,
        tenantId,
        userId: userId ?? undefined,
        timestamp: saved.createdAt.toISOString(),
        contextItemId: saved.id,
        contextType: request.type,
        subType,
        contentPreview: preview ? preview.slice(0, 2000) : undefined,
      } satisfies ContextAddedPayload);
    }

    return ContextDtoMapper.toResponse(saved);
  }

  /**
   * Update context item (with versioning).
   *
   * Uses "content-at-version" semantics: each ContextItemVersion record
   * stores the content AS IT IS at that version number. The version record
   * is created AFTER applying the update so it captures the new state.
   */
  async updateContext(contextItemId: string, request: UpdateContextRequest): Promise<ContextItemResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-305 D.3 (audit C-3) — verify the ContextItem being mutated
    // belongs to the caller's tenant before any version snapshot / update.
    const contextItem = await assertParentInScope(this.contextItemRepository, contextItemId, tenantId);

    const userId = this.requestUserId ?? 'system';

    // Apply changes to the entity first
    if (request.content !== undefined) {
      contextItem.content = request.content;
    }
    if (request.dnaWritingStyleId !== undefined) {
      contextItem.dnaWritingStyleId = request.dnaWritingStyleId;
    }

    // Use DB latest version to avoid stale in-memory version numbers.
    const latestVersionNumber = await this.contextItemVersionRepository.getLatestVersionNumber(contextItemId);
    const newVersionNumber = latestVersionNumber + 1;
    contextItem.currentVersionNumber = newVersionNumber;

    // Create version record with the NEW content (content-at-version semantics)
    const version = ContextItemVersionFactory.CreateUserEditVersion(
      contextItem,
      newVersionNumber,
      userId,
      request.changeSummary ?? 'Content updated',
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request.fieldChanges as any,
    );
    await this.encryptBestEffort('ContextItemVersion', () =>
      this.contextItemVersionRepository.encryptFieldsIntoEntity(version, this.secretsService!),
    );
    await this.contextItemVersionRepository.create(version);

    // Mark for Qdrant re-sync
    contextItem.markQdrantNeedsSync();

    contextItem.updatedBy = userId;

    // TASK-369 Phase 3B — re-encrypt only when `content` actually changed, so
    // metadata-only updates don't rewrite the ciphertext column needlessly.
    if (request.content !== undefined) {
      await this.encryptContent(contextItem);
    }

    const updated = await this.contextItemRepository.update(contextItemId, contextItem);

    // TASK-369 Phase 3B — never surface the ciphertext columns in the audit
    // payload (defense-in-depth; also avoids serialising a raw Buffer into the
    // SysEvent). The plaintext `content` change is unchanged from prior behavior.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { encryptedContent: _encryptedContent, contentKeyVersion: _contentKeyVersion, ...auditableChanges } =
      contextItem.changes as Record<string, unknown>;
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      responsibleEntityId: this.requestUserId ?? undefined,
      data: { ...auditableChanges, versionCreated: newVersionNumber },
    });

    return ContextDtoMapper.toResponse(updated);
  }

  /**
   * Soft-delete a context item (TASK-342 GAP #3).
   *
   * Removes a note / case-note / work-note / attachment via the base
   * `Repository.softDelete` (sets `resourceStatus = DELETED`). Every
   * `ContextItemRepository` read filters `resourceStatus: ENABLED`, so the
   * item drops out of `getContextItems` and the harness assemble automatically
   * — no hard delete. `assertParentInScope` enforces tenant ownership and
   * throws `NotFoundException` for both missing and cross-tenant items so the
   * response never reveals a foreign-tenant context item.
   */
  async deleteContext(contextItemId: string): Promise<void> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const contextItem = await assertParentInScope(this.contextItemRepository, contextItemId, tenantId);

    const userId = this.requestUserId ?? 'system';
    await this.contextItemRepository.softDelete(contextItemId, userId);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: contextItemId,
      responsibleEntityId: this.requestUserId ?? undefined,
      data: { consultationId: contextItem.consultationId, type: contextItem.type },
    });

    // TASK-342 GAP #3d — live drop-out. Mirror the `addContext` ContextAdded
    // fan-out: when a live-tracked note/lab/file (WORKNOTE / CASE_NOTE /
    // ATTACHMENT) is removed, signal the LiveDocumentationService so the matching
    // entry leaves the in-flight running summary on the next flush. Other types
    // (TRANSCRIPT, AI summaries) are never folded into the live notes, so they
    // are not announced — matching the add path.
    if (LIVE_CONTEXT_TYPES.has(contextItem.type)) {
      this.eventEmitter.emit(ConsultationPipelineEvent.ContextRemoved, {
        consultationId: contextItem.consultationId,
        tenantId,
        userId: this.requestUserId ?? undefined,
        timestamp: new Date().toISOString(),
        contextItemId,
      } satisfies ContextRemovedPayload);
    }
  }

  // ============================================
  // Audio Recording Methods
  // ============================================

  /**
   * Add audio recording to consultation
   */
  async addAudioRecording(consultationId: string, request: AddAudioRecordingRequest): Promise<ContextItemResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-305 D.3 (audit C-3) — verify the parent consultation lives in
    // the caller's tenant before any AudioRecording / container write.
    await assertParentInScope(this.consultationRepository, consultationId, tenantId);

    // Find or create audio recording container
    const audioContainer = await this.findOrCreateAudioContainer(consultationId, tenantId, userId);

    // Get next sequence number
    const sequenceNumber = await this.audioRecordingRepository.getNextSequenceNumber(audioContainer.id);

    // Create audio recording
    const audioRecording = AudioRecordingFactory.CreateWithMetadata(
      tenantId,
      audioContainer.id,
      request.mediaId,
      {
        rawMediaId: request.rawMediaId,
        processedMediaId: request.processedMediaId,
        duration: request.duration,
        format: request.format,
        sampleRate: request.sampleRate,
        channels: request.channels,
        bitrate: request.bitrate,
        language: request.language,
      },
      sequenceNumber,
      request.recordedAt,
    );

    const savedRecording = await this.audioRecordingRepository.create(audioRecording);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedRecording.id,
      responsibleEntityId: userId ?? undefined,
      createdAt: savedRecording.createdAt,
      data: {
        consultationId,
        type: 'AUDIO_RECORDING',
        mediaId: request.mediaId,
        rawMediaId: request.rawMediaId,
        processedMediaId: request.processedMediaId,
      },
    });

    // Return container with recordings
    const result = await this.contextItemRepository.findWithAudioRecordings(audioContainer.id);
    return ContextDtoMapper.toResponse(result!);
  }

  /**
   * Get audio recordings for consultation
   */
  async getAudioRecordings(consultationId: string): Promise<AudioRecordingResponse[]> {
    const containers = await this.contextItemRepository.findAudioRecordings(consultationId);
    const recordings: AudioRecordingResponse[] = [];

    for (const container of containers) {
      const containerRecordings = await this.audioRecordingRepository.findByContextItem(container.id);
      recordings.push(...containerRecordings.map(ContextDtoMapper.toAudioRecordingResponse));
    }

    return recordings;
  }

  // ============================================
  // Summary Methods
  // ============================================

  /**
   * Add raw AI-generated summary
   */
  async addRawSummary(consultationId: string, request: AddRawSummaryRequest): Promise<ContextItemResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-305 D.3 (audit C-3) — verify parent consultation lives in the
    // caller's tenant, then verify every ContextItem id captured in the
    // SummaryMeta context arrays. A poisoned `previousSummaryIds`
    // entry pointing into another tenant would otherwise be persisted
    // verbatim and later regurgitated as "context" by chain summarisers.
    await assertParentInScope(this.consultationRepository, consultationId, tenantId);
    await this.assertContextItemsInTenant(tenantId, request.caseNoteIds);
    await this.assertContextItemsInTenant(tenantId, request.preSummaryIds);
    await this.assertContextItemsInTenant(tenantId, request.previousSummaryIds);

    // Create summary context item
    const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, request.content, request.dnaWritingStyleId, userId ?? 'system');

    // TASK-369 Phase 3B — encrypt summary `content` before persist (dual-write).
    await this.encryptContent(contextItem);

    const saved = await this.contextItemRepository.create(contextItem);

    // Create initial version (v1) for the AI-generated summary
    const initialVersion = ContextItemVersionFactory.CreateInitialVersion(saved, userId ?? 'system');
    await this.encryptBestEffort('ContextItemVersion', () =>
      this.contextItemVersionRepository.encryptFieldsIntoEntity(initialVersion, this.secretsService!),
    );
    await this.contextItemVersionRepository.create(initialVersion);

    // Create summary metadata
    const summaryMeta = SummaryMetaFactory.CreateWithContext(
      tenantId,
      saved.id,
      request.aiModelId ?? '',
      request.aiModelVersion ?? '',
      {
        caseNoteIds: request.caseNoteIds,
        preSummaryIds: request.preSummaryIds,
        previousSummaryIds: request.previousSummaryIds,
      },
      request.processingTimeMs,
    );

    // Update with token info
    if (request.inputTokens !== undefined) {
      summaryMeta.inputTokens = request.inputTokens;
    }
    if (request.outputTokens !== undefined) {
      summaryMeta.outputTokens = request.outputTokens;
    }
    if (request.promptVersion) {
      summaryMeta.promptVersion = request.promptVersion;
    }
    if (request.cacheHit !== undefined) {
      summaryMeta.cacheHit = request.cacheHit;
    }
    if (request.qualityScore !== undefined) {
      summaryMeta.qualityScore = request.qualityScore;
    }

    await this.encryptBestEffort('SummaryMeta', () =>
      this.summaryMetaRepository.encryptFieldsIntoEntity(summaryMeta, this.secretsService!),
    );
    await this.summaryMetaRepository.create(summaryMeta);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      responsibleEntityId: userId ?? undefined,
      createdAt: saved.createdAt,
      data: { consultationId, type: ContextItemType.RAW_SUMMARY },
    });

    // Return with summary meta
    const result = await this.contextItemRepository.findWithSummaryMeta(saved.id);
    return ContextDtoMapper.toResponse(result!);
  }

  /**
   * Get summary metadata for a context item
   */
  async getSummaryMeta(contextItemId: string): Promise<SummaryMetaResponse | null> {
    const meta = await this.summaryMetaRepository.findByContextItem(contextItemId);
    return meta ? ContextDtoMapper.toSummaryMetaResponse(meta) : null;
  }

  // ============================================
  // Named Entity Methods
  // ============================================

  /**
   * Add named entities from NER
   */
  async addNamedEntities(contextItemId: string, request: AddNamedEntitiesRequest): Promise<NamedEntityResponse[]> {
    const tenantId = this.tenantId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-305 D.3 (audit C-3) — verify the parent ContextItem belongs to
    // the caller's tenant before any NER row is written. Without this
    // check a cross-tenant `contextItemId` would be stamped with the
    // CALLER's tenantId on the new NamedEntity rows, silently moving
    // PHI provenance across the tenancy boundary.
    await assertParentInScope(this.contextItemRepository, contextItemId, tenantId);

    const results: NamedEntityResponse[] = [];

    for (const entityItem of request.entities) {
      const namedEntity = NamedEntityFactory.CreateWithAiModel(
        tenantId,
        contextItemId,
        entityItem.text,
        entityItem.className,
        request.aiModelId ?? '',
        request.aiModelVersion ?? '',
        entityItem.confidence,
        request.processingTimeMs,
        entityItem.normalizedText,
        entityItem.startOffset,
        entityItem.endOffset,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        entityItem.metadata as any,
      );

      await this.encryptBestEffort('NamedEntity', () =>
        this.namedEntityRepository.encryptFieldsIntoEntity(namedEntity, this.secretsService!),
      );
      const saved = await this.namedEntityRepository.create(namedEntity);
      results.push(ContextDtoMapper.toNamedEntityResponse(saved));
    }

    if (results.length > 0) {
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: contextItemId,
        responsibleEntityId: this.requestUserId ?? undefined,
        data: {
          contextItemId,
          entityCount: results.length,
          type: 'NAMED_ENTITY',
        },
      });
    }

    return results;
  }

  /**
   * Get named entities for a context item
   */
  async getNamedEntities(contextItemId: string): Promise<NamedEntityResponse[]> {
    const entities = await this.namedEntityRepository.findByContextItem(contextItemId);
    return entities.map(ContextDtoMapper.toNamedEntityResponse);
  }

  /**
   * Get named entities by class
   */
  async getNamedEntitiesByClass(contextItemId: string, className: string): Promise<NamedEntityResponse[]> {
    const entities = await this.namedEntityRepository.findByClassName(contextItemId, className);
    return entities.map(ContextDtoMapper.toNamedEntityResponse);
  }

  /**
   * Get aggregate named entities across a consultation chain.
   *
   * ENH-1: Aggregate NER endpoint for the consultation workflow.
   * Step 12 requires Doctor A to see "main points and important
   * information detected using NER" across all consultations.
   *
   * When scope=chain, resolves all linked consultations (chain-based
   * + same-day same-patient) and aggregates NER entities from all
   * summaries and transcripts, grouped by entity class.
   *
   * When scope=single, only returns entities from the specified consultation.
   */
  async getAggregateNamedEntities(consultationId: string, scope: 'single' | 'chain'): Promise<AggregateNerResponse> {
    // TASK-306 W5.7.8 (306-F11) — for scope=single, verify the root
    // consultation lives in the caller's CLS tenant before doing any
    // work. The Prisma `tenantScope` extension already scopes the
    // downstream per-id reads to empty for a foreign-tenant root, so
    // PHI never leaks via `entities` / `sources`, but the
    // `ResourceViewed` broadcast at the end of this method would still
    // fire with the foreign `consultationId` in the payload — a minor
    // signal that distinguishes "valid same-tenant id with no data"
    // from "foreign-tenant id (extension-scoped to empty)".
    //
    // scope=chain is unaffected — `resolveLinkedConsultationIds` already
    // returns [] for foreign-tenant roots (W5.4 contract), and the
    // existing `consultationIds.length === 0` early-return below skips
    // the broadcast in that branch.
    //
    // The `this.tenantId` guard intentionally falls through when CLS is
    // missing: `getAggregateNamedEntities` has no top-level CLS-required
    // check today (unlike the W5.7.7-hoisted Consultation read paths),
    // and this fix is narrowly scoped to the broadcast-side-channel on
    // cross-tenant ids. Hardening the no-CLS posture for this method
    // (e.g. throwing instead of falling through) is deferred to a
    // separate ticket.
    if (scope === 'single' && this.tenantId) {
      const root = await this.consultationRepository.findById(consultationId);
      if (!root || root.tenantId !== this.tenantId) {
        return {
          consultationId,
          scope,
          entities: {},
          totalCount: 0,
          countByClass: {},
          sources: [],
        };
      }
    }

    // Resolve which consultations to include
    let consultationIds: string[];
    if (scope === 'chain') {
      consultationIds = await this.resolveLinkedConsultationIds(consultationId);
    } else {
      consultationIds = [consultationId];
    }

    if (consultationIds.length === 0) {
      return {
        consultationId,
        scope,
        entities: {},
        totalCount: 0,
        countByClass: {},
        sources: [],
      };
    }

    // Fetch consultations with Doctor/Department relations for source metadata
    const consultations = await this.fetchConsultationsWithRelations(consultationIds);
    const consultationMap = new Map(consultations.map((c) => [c.id, c]));

    // Aggregate entities from all summaries and transcripts
    const entityMap: Record<string, AggregateNamedEntityItem[]> = {};
    const sourceConsultationIds = new Set<string>();

    for (const cId of consultationIds) {
      const summaries = await this.contextItemRepository.findSummaries(cId);
      const transcripts = await this.contextItemRepository.findTranscripts(cId);
      const contextItems = [...summaries, ...transcripts];

      for (const item of contextItems) {
        const entities = await this.namedEntityRepository.findByContextItem(item.id);

        for (const entity of entities) {
          const className = entity.className ?? 'UNKNOWN';
          if (!entityMap[className]) {
            entityMap[className] = [];
          }

          // Deduplicate by (text, sourceConsultationId) within the same class
          const alreadyExists = entityMap[className].some((e) => e.text === entity.text && e.sourceConsultationId === cId);
          if (!alreadyExists) {
            entityMap[className].push({
              id: entity.id,
              text: entity.text ?? '',
              displayText: entity.displayText ?? entity.text ?? '',
              normalizedText: entity.normalizedText ?? undefined,
              confidence: entity.confidence ?? undefined,
              isHighConfidence: (entity.confidence ?? 0) >= 0.8,
              sourceConsultationId: cId,
              sourceContextItemId: item.id,
              sourceContextType: item.type ?? undefined,
              aiModelId: entity.aiModelId ?? undefined,
              createdAt: entity.createdAt.toISOString(),
            });
            sourceConsultationIds.add(cId);
          }
        }
      }
    }

    // Build count-by-class
    const countByClass: Record<string, number> = {};
    let totalCount = 0;
    for (const [className, items] of Object.entries(entityMap)) {
      countByClass[className] = items.length;
      totalCount += items.length;
    }

    // Build sources metadata
    const sources: AggregateNerSource[] = [...sourceConsultationIds].map((cId) => {
      const consultation = consultationMap.get(cId);
      return {
        consultationId: cId,
        department: consultation?.Department?.name ?? undefined,
        departmentId: consultation?.departmentId ?? undefined,
        doctor: this.formatDoctorName(consultation),
        doctorId: consultation?.doctorId ?? undefined,
      };
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        consultationId,
        scope,
        totalCount,
        sourceConsultationCount: sourceConsultationIds.size,
        classCount: Object.keys(entityMap).length,
      },
    });

    return {
      consultationId,
      scope,
      entities: entityMap,
      totalCount,
      countByClass,
      sources,
    };
  }

  // ============================================
  // Version History Methods
  // ============================================

  /**
   * Get version history for a context item
   */
  async getVersionHistory(contextItemId: string): Promise<ContextItemVersionResponse[]> {
    const versions = await this.contextItemVersionRepository.getVersionHistory(contextItemId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { contextItemId, versionCount: versions.length },
    });

    return versions.map(ContextDtoMapper.toVersionResponse);
  }

  /**
   * Get specific version of a context item
   */
  async getVersion(contextItemId: string, versionNumber: number): Promise<ContextItemVersionResponse | null> {
    const version = await this.contextItemVersionRepository.getVersion(contextItemId, versionNumber);
    return version ? ContextDtoMapper.toVersionResponse(version) : null;
  }

  /**
   * Diff two versions of a context item (summary). Returns both version
   * snapshots so the caller (UI `version-diff-panel`) can render the diff.
   *
   * TASK-329 (P6) — the parent context item is asserted to live in the
   * caller's tenant before any version content is returned; a missing or
   * cross-tenant item — or a missing version number — surfaces as NotFound.
   */
  async diffVersions(contextItemId: string, fromVersion: number, toVersion: number): Promise<VersionDiffResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    await assertParentInScope(this.contextItemRepository, contextItemId, tenantId);

    const [from, to] = await Promise.all([
      this.contextItemVersionRepository.getVersion(contextItemId, fromVersion),
      this.contextItemVersionRepository.getVersion(contextItemId, toVersion),
    ]);

    if (!from) {
      throw new NotFoundException(`Version ${fromVersion} not found for context item ${contextItemId}`);
    }
    if (!to) {
      throw new NotFoundException(`Version ${toVersion} not found for context item ${contextItemId}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: contextItemId,
      data: { contextItemId, fromVersion, toVersion },
    });

    return {
      contextItemId,
      from: ContextDtoMapper.toVersionResponse(from),
      to: ContextDtoMapper.toVersionResponse(to),
    };
  }

  // ============================================
  // Query Methods
  // ============================================

  /**
   * Get context items for consultation
   */
  async getContextItems(consultationId: string, filters?: ContextFiltersDto): Promise<ContextItemResponse[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await this.contextItemRepository.findByConsultation(consultationId, filters as any);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { consultationId, count: items.length },
    });

    return items.map(ContextDtoMapper.toResponse);
  }

  /**
   * Get context items for consultation with pagination.
   *
   * When page/limit are provided in filters, returns a paginated response
   * with total count. Fetches all matching items then slices in-memory;
   * for very large consultation contexts a repository-level skip/take
   * would be more efficient but the current data volumes don't warrant it.
   */
  async getContextItemsPaginated(consultationId: string, filters?: ContextFiltersDto): Promise<PaginatedContextItemResponse> {
    const allItems = await this.contextItemRepository.findByConsultation(
      consultationId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters ? ({ type: filters.type, source: filters.source } as any) : undefined,
    );

    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 50;
    const skip = (page - 1) * limit;
    const pageItems = allItems.slice(skip, skip + limit);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { consultationId, page, limit, count: allItems.length },
    });

    return {
      data: pageItems.map(ContextDtoMapper.toResponse),
      count: allItems.length,
      page,
      limit,
    };
  }

  /**
   * Get shared context from linked consultations.
   *
   * Combines two strategies:
   * 1. Chain-based: follows parentConsultationId links (existing behavior)
   * 2. Date-based: finds ALL consultations for the same (tenantId, patientId, appointmentDate)
   *
   * This ensures cross-department context sharing even when consultations
   * are not linked via parentConsultationId.
   */
  async getSharedContext(consultationId: string): Promise<ContextItemResponse[]> {
    const allIds = await this.resolveLinkedConsultationIds(consultationId);
    if (allIds.length === 0) return [];

    const items = await this.contextItemRepository.findSharedContext(allIds);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { consultationId, sharedFromCount: allIds.length, itemCount: items.length },
    });

    return items.map(ContextDtoMapper.toResponse);
  }

  /**
   * Get transcriptions for consultation (alias for getTranscripts)
   */
  async getTranscriptions(consultationId: string): Promise<ContextItemResponse[]> {
    const items = await this.contextItemRepository.findTranscripts(consultationId);
    return items.map(ContextDtoMapper.toResponse);
  }

  /**
   * Get transcripts for consultation
   */
  async getTranscripts(consultationId: string): Promise<ContextItemResponse[]> {
    return this.getTranscriptions(consultationId);
  }

  /**
   * Get case notes for consultation
   */
  async getCaseNotes(consultationId: string): Promise<ContextItemResponse[]> {
    const items = await this.contextItemRepository.findCaseNotes(consultationId);
    return items.map(ContextDtoMapper.toResponse);
  }

  /**
   * Get worknotes for consultation
   */
  async getWorknotes(consultationId: string): Promise<ContextItemResponse[]> {
    const items = await this.contextItemRepository.findWorknotes(consultationId);
    return items.map(ContextDtoMapper.toResponse);
  }

  /**
   * Get summaries for consultation
   */
  async getSummaries(consultationId: string): Promise<ContextItemResponse[]> {
    const items = await this.contextItemRepository.findSummaries(consultationId);
    return items.map(ContextDtoMapper.toResponse);
  }

  /**
   * Get context item with all relations
   */
  async getContextItemWithRelations(contextItemId: string): Promise<ContextItemResponse | null> {
    const item = await this.contextItemRepository.findWithAllRelations(contextItemId);
    return item ? ContextDtoMapper.toResponse(item) : null;
  }

  // ============================================
  // Convenience Methods
  // ============================================

  /**
   * Add transcript
   */
  async addTranscript(consultationId: string, content: string): Promise<ContextItemResponse> {
    return this.addContext(consultationId, {
      type: ContextItemType.TRANSCRIPT,
      source: ContextItemSource.TRANSCRIPTION,
      content,
    });
  }

  /**
   * Add transcription (alias for addTranscript for backward compatibility)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async addTranscription(consultationId: string, content: string, structuredData?: Record<string, unknown>): Promise<ContextItemResponse> {
    return this.addTranscript(consultationId, content);
  }

  /**
   * Add case note
   */
  async addCaseNote(consultationId: string, content: string): Promise<ContextItemResponse> {
    return this.addContext(consultationId, {
      type: ContextItemType.CASE_NOTE,
      source: ContextItemSource.USER,
      content,
    });
  }

  /**
   * Add worknote
   */
  async addWorknote(consultationId: string, content: string): Promise<ContextItemResponse> {
    return this.addContext(consultationId, {
      type: ContextItemType.WORKNOTE,
      source: ContextItemSource.USER,
      content,
    });
  }

  /**
   * Add pre-summary (AI-generated summary of case notes)
   * Pre-summaries provide comprehensive context for final summarization
   */
  async addPreSummary(consultationId: string, content: string, dnaWritingStyleId?: string): Promise<ContextItemResponse> {
    return this.addContext(consultationId, {
      type: ContextItemType.PRE_SUMMARY,
      source: ContextItemSource.AI,
      content,
      dnaWritingStyleId,
    });
  }

  /**
   * Add attachment to consultation
   */
  async addAttachment(consultationId: string, content?: string, mediaId?: string): Promise<ContextItemResponse> {
    return this.addContext(consultationId, {
      type: ContextItemType.ATTACHMENT,
      source: ContextItemSource.USER,
      content,
      mediaId,
    });
  }

  /**
   * Get attachments for consultation
   */
  async getAttachments(consultationId: string): Promise<ContextItemResponse[]> {
    const items = await this.contextItemRepository.findAttachments(consultationId);
    return items.map(ContextDtoMapper.toResponse);
  }

  /**
   * Get pre-summaries for consultation
   */
  async getPreSummaries(consultationId: string): Promise<ContextItemResponse[]> {
    const items = await this.contextItemRepository.findPreSummaries(consultationId);
    return items.map(ContextDtoMapper.toResponse);
  }

  /**
   * Get shared case notes from linked consultations.
   *
   * Uses the same combined chain + date strategy as getSharedContext()
   * to ensure cross-department case note sharing.
   */
  async getSharedCaseNotes(consultationId: string): Promise<ContextItemResponse[]> {
    const allIds = await this.resolveLinkedConsultationIds(consultationId);
    if (allIds.length === 0) return [];

    const items = await this.contextItemRepository.findCaseNotesFromChain(allIds);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { consultationId, sharedFromCount: allIds.length, itemCount: items.length },
    });

    return items.map(ContextDtoMapper.toResponse);
  }

  // ============================================
  // Private Helper Methods
  // ============================================

  /**
   * Resolve all consultation IDs linked to the given consultation.
   *
   * Combines two strategies and deduplicates:
   * 1. Chain-based — follows parentConsultationId links
   * 2. Date-based — all consultations for the same (tenantId, patientId, appointmentDate)
   *
   * TASK-306 P2.5 / AC-9 — Audit surface for array-input ContextItem reads.
   *
   * Three public methods consume the consultation-ID array returned by this
   * helper and pass it as `ids: string[]` to ContextItemRepository methods:
   *
   *   - `getSharedContext(consultationId)`        → findSharedContext(allIds)
   *   - `getSharedCaseNotes(consultationId)`      → findCaseNotesFromChain(allIds)
   *   - `getAggregateNamedEntities(consultationId, scope)`
   *       (scope=chain branch via consultationIds[]; scope=single uses [consultationId])
   *
   * The Prisma `tenantScope` extension scopes every repo call that flows
   * through `findMany`/`findFirst`/`findById`/etc., so single-id paths are
   * already covered. The defense-in-depth concern here is
   * `findConsultationChain`: if `parentConsultationId` was ever set
   * cross-tenant by a buggy write pre-TASK-305-W3.1 (or if the extension
   * is bypassed), the chain array could include foreign-tenant ids.
   * Filter the chain to the caller's CLS tenant BEFORE the downstream
   * repository calls. SUPER_ADMIN bypass is intentionally NOT applied
   * here — these methods compose tenant-scoped per-item data on a hot
   * PHI read path; any cross-tenant visibility for platform admins must
   * be exposed via an explicit method, not a side effect of this helper.
   */
  private async resolveLinkedConsultationIds(consultationId: string): Promise<string[]> {
    const consultation = await this.consultationRepository.findById(consultationId);
    if (!consultation) return [];

    // Defense-in-depth: caller's CLS tenant. Even though `findById`
    // above is tenant-scoped by the Prisma extension and returns null
    // on foreign-tenant, we still need to anchor the downstream filter
    // to a known-safe tenantId. Fail closed (return []) on missing CLS
    // or foreign-tenant root — both are hot read paths where throwing
    // would be over-eager.
    const callerTenantId = this.tenantId;
    if (!callerTenantId) return [];
    if (consultation.tenantId !== callerTenantId) return [];

    // Strategy 1: Chain-based — filtered to caller tenant to defend
    // against pre-W3.1 parentConsultationId poisoning / a defeated
    // extension that returns cross-tenant rows.
    const chain = await this.consultationRepository.findConsultationChain(consultationId);
    const chainIds = chain.filter((c) => c.tenantId === callerTenantId).map((c) => c.id);

    // Strategy 2: Date-based (same patient, same day, any department).
    // Pass `callerTenantId` (from CLS) rather than `consultation.tenantId`
    // so the contract is self-evident even if `consultation.tenantId`
    // is stale from a poisoned write. Filter the response defensively
    // for the same reason.
    const sameDayConsultations = await this.consultationRepository.findByPatientAndDate(
      callerTenantId,
      consultation.patientId,
      consultation.appointmentDate,
    );
    const sameDayIds = sameDayConsultations.filter((c) => c.tenantId === callerTenantId).map((c) => c.id);

    return [...new Set([...chainIds, ...sameDayIds])];
  }

  /**
   * Fetch multiple consultations with Doctor and Department relations.
   *
   * Used by getAggregateNamedEntities to populate source metadata.
   */
  private async fetchConsultationsWithRelations(ids: string[]): Promise<ConsultationEntity[]> {
    const results: ConsultationEntity[] = [];
    for (const id of ids) {
      const consultation = await this.consultationRepository.findWithRelations(id);
      if (consultation) {
        results.push(consultation);
      }
    }
    return results;
  }

  /**
   * Format doctor name from consultation entity's Doctor relation.
   *
   * Uses the same logic as TimelineService: prefer UserProfile
   * firstName/lastName, fall back to username.
   */
  private formatDoctorName(consultation?: ConsultationEntity | null): string | undefined {
    if (!consultation?.Doctor) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profile = (consultation.Doctor as any).UserProfile;
    if (profile?.firstName || profile?.lastName) {
      return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    }
    return consultation.Doctor.username ?? undefined;
  }

  /**
   * TASK-305 D.3 (audit C-3) — validate every ContextItem id in the given
   * list lives in `tenantId`. Used to scrub the metadata arrays on
   * `addRawSummary` (`caseNoteIds`, `preSummaryIds`, `previousSummaryIds`)
   * which would otherwise persist cross-tenant pointers into SummaryMeta.
   *
   * Skips when the list is empty / undefined. Uses a sequential `for...of`
   * so we fail fast on the first cross-tenant id without spawning
   * unnecessary parallel reads on the hot summary-create path.
   */
  private async assertContextItemsInTenant(tenantId: string, ids?: string[] | null): Promise<void> {
    if (!ids || ids.length === 0) return;
    for (const id of ids) {
      await assertParentInScope(this.contextItemRepository, id, tenantId);
    }
  }

  /**
   * Find or create audio recording container for a consultation
   */
  private async findOrCreateAudioContainer(consultationId: string, tenantId: string, userId?: string | null): Promise<ContextItemEntity> {
    const existing = await this.contextItemRepository.findAudioRecordings(consultationId);
    if (existing.length > 0) {
      return existing[0];
    }

    const container = ContextItemFactory.CreateAudioRecording(tenantId, consultationId, userId ?? 'system');

    return this.contextItemRepository.create(container);
  }
}
