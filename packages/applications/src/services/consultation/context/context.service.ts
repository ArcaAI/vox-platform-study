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
import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, assertParentInScope } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IContextService } from './IContextService';
import { ContextDtoMapper } from './context.dto.mapper';
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
} from './dto';

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
  ) {
    super(eventEmitter, clsService, ResourceType.ContextItem);
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
      dnaWritingStyleId: request.dnaWritingStyleId,
      createdBy: userId ?? undefined,
    });

    const saved = await this.contextItemRepository.create(contextItem);

    // Create initial version (v1) for audit trail completeness.
    // Media types (AUDIO_RECORDING, ATTACHMENT) are excluded since they have no text content to version.
    if (!isMediaType) {
      const initialVersion = ContextItemVersionFactory.CreateInitialVersion(saved, userId ?? 'system');
      await this.contextItemVersionRepository.create(initialVersion);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      responsibleEntityId: userId ?? undefined,
      createdAt: saved.createdAt,
      data: { consultationId, type: request.type },
    });

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
    await this.contextItemVersionRepository.create(version);

    // Mark for Qdrant re-sync
    contextItem.markQdrantNeedsSync();

    contextItem.updatedBy = userId;

    const updated = await this.contextItemRepository.update(contextItemId, contextItem);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      responsibleEntityId: this.requestUserId ?? undefined,
      data: { ...contextItem.changes, versionCreated: newVersionNumber },
    });

    return ContextDtoMapper.toResponse(updated);
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
      data: { consultationId, type: 'AUDIO_RECORDING', mediaId: request.mediaId },
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

    const saved = await this.contextItemRepository.create(contextItem);

    // Create initial version (v1) for the AI-generated summary
    const initialVersion = ContextItemVersionFactory.CreateInitialVersion(saved, userId ?? 'system');
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
  async addAttachment(consultationId: string, content?: string): Promise<ContextItemResponse> {
    return this.addContext(consultationId, {
      type: ContextItemType.ATTACHMENT,
      source: ContextItemSource.USER,
      content,
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
   */
  private async resolveLinkedConsultationIds(consultationId: string): Promise<string[]> {
    const consultation = await this.consultationRepository.findById(consultationId);
    if (!consultation) return [];

    // Strategy 1: Chain-based (existing behaviour)
    const chain = await this.consultationRepository.findConsultationChain(consultationId);
    const chainIds = new Set(chain.map((c) => c.id));

    // Strategy 2: Date-based (new — same patient, same day, any department)
    const sameDayConsultations = await this.consultationRepository.findByPatientAndDate(
      consultation.tenantId,
      consultation.patientId,
      consultation.appointmentDate,
    );
    const sameDayIds = sameDayConsultations.map((c) => c.id);

    // Merge and deduplicate
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
