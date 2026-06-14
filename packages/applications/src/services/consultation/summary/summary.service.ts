import { Inject, Injectable, Logger, Optional, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';
import {
  ContextItemRepository,
  ContextItemVersionRepository,
  ConsultationRepository,
  SummaryMetaRepository,
  NamedEntityRepository,
  UserProfileRepository,
  ContextItemFactory,
  ContextItemVersionFactory,
  SummaryMetaFactory,
  NamedEntityFactory,
  ResourceType,
  SysEventType,
  ConsultationStatus,
  HarnessAuditAction,
} from '@arcaai/domains';
import { HarnessAuditService } from '../../harness-audit';
import { ISummaryService } from './ISummaryService';
import { GenerateSummaryRequest, GeneratePreSummaryRequest, UpdateSummaryRequest, SummaryResponse, SummaryProvenanceResponse } from './dto';
import { SummaryDtoMapper } from './summary.dto.mapper';
import { buildSmrGeneratePayload, mapSmrGenerateResponse, type LegacySmrSummaryResponse } from './smr-v2-generate';
import { BaseService, assertParentInScope } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { HarnessGatewayService } from '../harness/harness-gateway.service';
import type { PromptResolutionTier } from '../prompt/prompt-resolution.service';

@Injectable()
export class SummaryService extends BaseService implements ISummaryService {
  private readonly logger = new Logger(SummaryService.name);
  private readonly smrServiceUrl: string;
  private readonly nlpServiceUrl: string;

  constructor(
    private readonly contextItemRepository: ContextItemRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly summaryMetaRepository: SummaryMetaRepository,
    private readonly namedEntityRepository: NamedEntityRepository,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly contextItemVersionRepository: ContextItemVersionRepository,
    private readonly promptAssemblyService: PromptAssemblyService,
    // Optional so existing test fixtures (and any future test that
    // constructs SummaryService directly) compile without supplying a
    // mock. When unset we behave exactly like the pre-migration code
    // when env var SMR_SERVICE_TOKEN was unset: no X-Service-Token header.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // TASK-329 P2 (Tier-0 prompt resolution): load the consulting doctor's
    // `UserProfile.preferredPromptTemplateId`. Optional + trailing so existing
    // positional test fixtures keep compiling; production DI (CoreDatabaseModule)
    // always supplies it.
    @Optional() @Inject(UserProfileRepository) private readonly userProfileRepository?: UserProfileRepository,
    // TASK-330 Phase 1 (attestation gate): append the ATTEST event to the Phase-0
    // WORM audit trail on approval. Optional + trailing so existing positional test
    // fixtures keep compiling; production DI (ConsultationServiceModule) always
    // supplies it, making the gate fail-closed (audit failure aborts the approval).
    @Optional() @Inject(HarnessAuditService) private readonly harnessAuditService?: HarnessAuditService,
    // TASK-330 Phase 1 (Lane G): forward the clinician sign-off to the durable
    // harness workflow (best-effort). Optional + trailing so existing positional
    // test fixtures keep compiling; production DI (SummaryServiceModule) supplies it.
    @Optional() @Inject(HarnessGatewayService) private readonly harnessGatewayService?: HarnessGatewayService,
  ) {
    super(eventEmitter, clsService, ResourceType.ContextItem);
    this.smrServiceUrl = this.configService.get<string>('SMR_URL') ?? 'http://localhost:8862';
    this.nlpServiceUrl = this.configService.get<string>('NLP_URL') ?? 'http://localhost:8864';
  }

  /**
   * Generate pre-summary from historical case notes
   */
  async generatePreSummary(consultationId: string, request: GeneratePreSummaryRequest): Promise<SummaryResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-305 D.4 (audit C-1 / C-3) — verify the parent Consultation
    // belongs to the caller's tenant before invoking the (expensive) SMR
    // call. `assertParentInScope` throws `NotFoundException` for both
    // missing-parent and cross-tenant cases so no existence leak.
    const consultation = await assertParentInScope(this.consultationRepository, consultationId, tenantId);

    // Get case notes for summarization
    let caseNotes = await this.contextItemRepository.findCaseNotes(consultationId);
    if (request.caseNoteIds?.length) {
      const requestedIds = new Set(request.caseNoteIds);
      caseNotes = caseNotes.filter((note) => requestedIds.has(note.id));
    }
    const content = caseNotes.map((c) => c.content).join('\n\n');

    if (!content.trim()) {
      throw new BadRequestException('No case notes found for pre-summary generation');
    }

    const assembledPrompt = await this.promptAssemblyService.assemble({
      departmentId: consultation.departmentId ?? undefined,
      promptType: 'pre-summary',
      transcript: content,
      conversationLanguage: this.resolveConversationLanguage(request.options),
      dnaStyleId: request.dnaStyleId,
      preferredPromptTemplateId: await this.resolvePreferredPromptTemplateId(consultation.doctorId),
    });

    // Call SMR service
    const smrResponse = await this.callSmrService({
      assembledPrompt,
      options: request.options,
      context: {
        dnaStyleId: request.dnaStyleId,
        summaryType: 'pre-summary',
        promptResolvedFrom: assembledPrompt.resolvedFrom,
        promptHyperparameters: assembledPrompt.hyperparameters,
      },
    });

    // Create pre-summary context item
    const contextItem = ContextItemFactory.CreatePreSummary(tenantId, consultationId, smrResponse.summary, request.dnaStyleId, userId ?? 'system');

    const savedContext = await this.contextItemRepository.create(contextItem);

    // Create summary metadata record
    const summaryMeta = SummaryMetaFactory.CreateSummaryMeta({
      tenantId,
      contextItemId: savedContext.id,
      aiModelId: smrResponse.modelName ?? smrResponse.llmProvider,
      processingTimeMs: smrResponse.processingTimeMs,
      inputTokens: smrResponse.inputTokens,
      outputTokens: smrResponse.outputTokens,
      cacheHit: smrResponse.cacheHit,
      qualityScore: smrResponse.qualityScore,
      promptResolvedFrom: assembledPrompt.resolvedFrom,
      resolvedPromptId: assembledPrompt.promptId,
    });
    await this.summaryMetaRepository.create(summaryMeta);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedContext.id,
      responsibleEntityId: userId ?? undefined,
      createdAt: savedContext.createdAt,
      data: { consultationId, type: 'pre_summary' },
    });

    return SummaryDtoMapper.toResponse(savedContext);
  }

  /**
   * Generate final consultation summary
   */
  async generateSummary(consultationId: string, request: GenerateSummaryRequest): Promise<SummaryResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-305 D.4 (audit C-1 / C-3) — verify the parent Consultation
    // belongs to the caller's tenant, then validate every explicit
    // `contextItemIds` reference. Without the per-id check a cross-tenant
    // id would be silently filtered into the SMR transcript and
    // exfiltrated through the generated summary content.
    const consultation = await assertParentInScope(this.consultationRepository, consultationId, tenantId);
    await this.assertContextItemsInTenant(tenantId, request.contextItemIds);

    // Get transcriptions if not provided
    let content = request.transcription;
    if (!content && request.contextItemIds?.length) {
      const requestedIds = new Set(request.contextItemIds);
      const contextItems = await Promise.all(request.contextItemIds.map((id) => this.contextItemRepository.findById(id)));
      content = contextItems
        .filter((item): item is NonNullable<typeof item> => !!item)
        .filter((item) => requestedIds.has(item.id))
        .map((item) => item.content)
        .join('\n\n');
    }
    if (!content) {
      const transcripts = await this.contextItemRepository.findTranscripts(consultationId);
      content = transcripts.map((c) => c.content).join('\n\n');
    }

    if (!content?.trim()) {
      throw new BadRequestException('No content available for summary generation');
    }

    const latestPreSummary = await this.contextItemRepository.findLatestPreSummary(consultationId);
    const assembledPrompt = await this.promptAssemblyService.assemble({
      departmentId: consultation.departmentId ?? undefined,
      promptType: consultation.parentConsultationId ? 'revisit' : 'new-patient',
      transcript: content,
      conversationLanguage: this.resolveConversationLanguage(request.options),
      dnaStyleId: request.dnaStyleId,
      preSummaryText: latestPreSummary?.content ?? undefined,
      explicitTemplate: request.template,
      preferredPromptTemplateId: await this.resolvePreferredPromptTemplateId(consultation.doctorId),
    });

    // Call SMR service
    const smrResponse = await this.callSmrService({
      assembledPrompt,
      options: request.options,
      context: {
        dnaStyleId: request.dnaStyleId,
        template: request.template,
        includeNER: request.includeNER,
        summaryType: 'summary',
        promptResolvedFrom: assembledPrompt.resolvedFrom,
        promptHyperparameters: assembledPrompt.hyperparameters,
      },
    });

    // Create summary context item
    const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, smrResponse.summary, request.dnaStyleId, userId ?? 'system');

    const savedContext = await this.contextItemRepository.create(contextItem);

    // Create summary metadata record
    const summaryMeta = SummaryMetaFactory.CreateSummaryMeta({
      tenantId,
      contextItemId: savedContext.id,
      aiModelId: smrResponse.modelName ?? smrResponse.llmProvider,
      processingTimeMs: smrResponse.processingTimeMs,
      inputTokens: smrResponse.inputTokens,
      outputTokens: smrResponse.outputTokens,
      cacheHit: smrResponse.cacheHit,
      qualityScore: smrResponse.qualityScore,
      promptResolvedFrom: assembledPrompt.resolvedFrom,
      resolvedPromptId: assembledPrompt.promptId,
    });
    await this.summaryMetaRepository.create(summaryMeta);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedContext.id,
      responsibleEntityId: userId ?? undefined,
      createdAt: savedContext.createdAt,
      data: { consultationId, type: 'summary' },
    });

    return SummaryDtoMapper.toResponse(savedContext);
  }

  /**
   * Update existing summary content
   */
  async updateSummary(contextItemId: string, request: UpdateSummaryRequest): Promise<SummaryResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-305 D.4 (audit C-3) — assert the target summary lives in
    // the caller's tenant before reading approvals / writing a new
    // version. Missing or cross-tenant both surface as NotFound.
    const contextItem = await assertParentInScope(this.contextItemRepository, contextItemId, tenantId);

    const approvals = await this.contextItemVersionRepository.getVersionsByChangeReason(contextItemId, 'approved');
    if (approvals.length > 0) {
      throw new BadRequestException('Summary is approved and locked');
    }

    if (!contextItem.isSummary) {
      throw new BadRequestException(`Context item ${contextItemId} is not a summary`);
    }

    const previousData = contextItem.toObject();

    const versionNumber = ((contextItem.currentVersionNumber as number) ?? 0) + 1;
    const version = ContextItemVersionFactory.CreateFromContextItem(
      contextItem,
      versionNumber,
      request.changeReason ?? 'Manual edit',
      this.requestUserId ?? 'system',
      request.changeSource ?? 'doctor_edit',
      request.changeSummary,
    );
    const savedVersion = await this.contextItemVersionRepository.create(version);

    contextItem.currentVersionNumber = versionNumber;

    if (request.content !== undefined) {
      contextItem.content = request.content;
    }

    if (this.requestUserId) {
      contextItem.updatedBy = this.requestUserId;
    }

    const updated = await this.contextItemRepository.update(contextItemId, contextItem);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: contextItem.changes,
      previousData: previousData as object,
    });

    // TASK-355 Phase D (Slice 5c) — if this edit lands while the draft is still
    // under optimistic assurance (DRAFT_PENDING_SENSORS), forward it to the
    // harness so the running workflow re-binds + re-runs assurance on the edited
    // version (Q3) and permanently disables silent regen-if-untouched (Q1).
    // Best-effort: the MODIFIED_SUMMARY version write above is the source of
    // truth — a signal failure must never roll back the (committed) edit. Edits
    // in any other consultation status have no assurance window, so they no-op.
    try {
      const consultation = await this.consultationRepository.findById(contextItem.consultationId);
      if (consultation?.status === ConsultationStatus.DRAFT_PENDING_SENSORS) {
        await this.harnessGatewayService?.signalEdit(contextItem.consultationId, {
          content: contextItem.content ?? '',
          contextItemVersionId: savedVersion?.id ?? version.id,
          editedBy: this.requestUserId ?? undefined,
        });
      }
    } catch (error) {
      this.logger.warn({
        message: 'Harness edit signal failed (best-effort, edit not rolled back)',
        consultationId: contextItem.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return SummaryDtoMapper.toResponse(updated);
  }

  /**
   * Approve and lock a summary (TASK-330 Phase 1 — attestation gate /
   * confirm-before-commit). This is the single, non-bypassable signing path:
   *
   *   1. Writes a SIGNED_NOTE `ContextItemVersion` stamped with the clinician
   *      attestation fields (attestedBy / attestedAt / attestationHash). The
   *      version keeps `changeReason='approved'` so the existing idempotency
   *      check still recognises a signed note.
   *   2. Appends an `ATTEST` event to the Phase-0 WORM audit trail
   *      (`HarnessAuditService`) — fail-closed: if the audit append throws, the
   *      whole approval is rejected and the consultation is NOT signed.
   *   3. Flips `Consultation.status` → `SIGNED`.
   *
   * TASK-355 Phase D — RELAXED sign-off governance (clinician autonomy + full
   * audit, doc 08 §7.1):
   *   Q2a — signing BEFORE assurance lands is allowed with no acknowledgement;
   *         a `SIGNED_BEFORE_ASSURANCE` WORM annotation is appended so the
   *         late-verdict path (`finalizeAssurance` Q2b) can correlate.
   *   Q4  — a COMPLETED safety FLAG hard-blocks UNLESS the clinician supplies an
   *         explicit one-click `overrideSafetyFlag`, recorded (no free-text) as a
   *         `SAFETY_OVERRIDE` WORM event. A REGEN/groundedness flag stays signable.
   */
  async approveSummary(
    contextItemId: string,
    options?: { overrideSafetyFlag?: boolean },
  ): Promise<{ contextItemId: string; approvalStatus: string; approvedBy: string; approvedAt: string }> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-305 D.4 (audit C-3) — assert the target summary belongs to
    // the caller's tenant before any approval / lock state mutates.
    const contextItem = await assertParentInScope(this.contextItemRepository, contextItemId, tenantId);

    if (!contextItem.isFinalSummary) {
      throw new BadRequestException(`Context item ${contextItemId} is not a final summary`);
    }

    const existingApprovals = await this.contextItemVersionRepository.getVersionsByChangeReason(contextItemId, 'approved');
    if (existingApprovals.length > 0) {
      const first = existingApprovals[0];
      return {
        contextItemId,
        approvalStatus: 'APPROVED',
        approvedBy: first.changedBy ?? 'unknown',
        approvedAt: first.createdAt.toISOString(),
      };
    }

    // TASK-355 Phase D — RELAXED sign-off assurance guard (defense-in-depth; the
    // UI mirrors this, but the API is the non-bypassable enforcement point). The
    // draft's SummaryMeta carries the two-phase assurance state:
    //   Q2a — signing while assurance is still running (`assuranceCompletedAt`
    //         NULL, i.e. an optimistically-delivered DRAFT_PENDING_SENSORS draft)
    //         is ALLOWED with no acknowledgement; we annotate the WORM trail with
    //         SIGNED_BEFORE_ASSURANCE so the late-verdict path can correlate.
    //   Q4  — a COMPLETED safety FLAG hard-blocks UNLESS the clinician supplies an
    //         explicit one-click override, recorded as a SAFETY_OVERRIDE WORM
    //         event. A REGEN/groundedness flag stays signable — those are review
    //         prompts, not safety stops.
    // Legacy single-shot drafts stamp `assuranceCompletedAt` at persist, and
    // non-harness/manual summaries have no SummaryMeta at all — both have neither
    // flag set, so they sign through unchanged with no extra annotations.
    const draftMeta = await this.summaryMetaRepository.findByContextItem(contextItemId);
    const signedBeforeAssurance = !!draftMeta && !draftMeta.assuranceCompletedAt;
    const overridingSafetyFlag = !!draftMeta && SummaryService.hasSafetyFlag(draftMeta);
    if (overridingSafetyFlag && !options?.overrideSafetyFlag) {
      throw new ConflictException(
        'This draft was flagged by the safety sensor and cannot be signed. Escalate for clinical review, or sign with an explicit safety override.',
      );
    }

    const approvedBy = this.requestUserId;
    if (!approvedBy) {
      throw new BadRequestException('User ID is required');
    }

    const versionNumber = ((contextItem.currentVersionNumber as number) ?? 0) + 1;
    const attestedAt = new Date();
    const attestationHash = this.computeAttestationHash({
      contextItemId,
      versionNumber,
      content: contextItem.content ?? '',
      attestedBy: approvedBy,
      attestedAt,
    });

    // 1. Persist the attested SIGNED_NOTE version.
    const version = ContextItemVersionFactory.CreateSignedNoteVersion({
      tenantId,
      contextItemId,
      versionNumber,
      content: contextItem.content ?? undefined,
      attestedBy: approvedBy,
      attestationHash,
      attestedAt,
      changeSummary: 'Approved and locked',
    });
    const savedVersion = await this.contextItemVersionRepository.create(version);
    const versionId = savedVersion?.id ?? version.id;

    // 2a. Q4 — record the clinician's explicit safety-flag override FIRST, and
    //     fail-closed: if this WORM write fails the sign-off aborts before the
    //     consultation is flipped (a safety override is never silently dropped).
    if (overridingSafetyFlag && options?.overrideSafetyFlag) {
      await this.harnessAuditService?.append({
        tenantId,
        consultationId: contextItem.consultationId,
        contextItemVersionId: versionId,
        action: HarnessAuditAction.SAFETY_OVERRIDE,
        modelName: 'clinician-override',
        modelVersion: 'v1',
        sensorScores: {},
        citations: [],
        clinicianId: approvedBy,
        attestationHash,
        createdBy: approvedBy,
      });
    }

    // 2. Append the ATTEST event to the WORM audit trail. Fail-closed: any error
    //    propagates and aborts the approval BEFORE the consultation is signed.
    await this.harnessAuditService?.append({
      tenantId,
      consultationId: contextItem.consultationId,
      contextItemVersionId: versionId,
      action: HarnessAuditAction.ATTEST,
      modelName: 'clinician-attestation',
      modelVersion: 'v1',
      sensorScores: {},
      citations: [],
      clinicianId: approvedBy,
      attestationHash,
      createdBy: approvedBy,
    });

    // 2b. Q2a — annotate that this sign preceded assurance completion so the
    //     late-verdict path (finalizeAssurance Q2b) can correlate and surface an
    //     amendment alert. Fail-closed, consistent with ATTEST.
    if (signedBeforeAssurance) {
      await this.harnessAuditService?.append({
        tenantId,
        consultationId: contextItem.consultationId,
        contextItemVersionId: versionId,
        action: HarnessAuditAction.SIGNED_BEFORE_ASSURANCE,
        modelName: 'clinician-attestation',
        modelVersion: 'v1',
        sensorScores: {},
        citations: [],
        clinicianId: approvedBy,
        attestationHash,
        createdBy: approvedBy,
      });
    }

    // 3. Flip the consultation lifecycle → SIGNED.
    const consultation = await this.consultationRepository.findById(contextItem.consultationId);
    if (consultation) {
      consultation.status = ConsultationStatus.SIGNED;
      consultation.updatedBy = approvedBy;
      await this.consultationRepository.update(consultation.id, consultation);
    }

    contextItem.currentVersionNumber = versionNumber;
    contextItem.updatedBy = approvedBy;
    await this.contextItemRepository.update(contextItemId, contextItem);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: contextItemId,
      responsibleEntityId: approvedBy,
      data: { approvalStatus: 'APPROVED', consultationStatus: ConsultationStatus.SIGNED, attested: true },
    });

    // 4. TASK-330 Phase 1 (Lane G) — best-effort: forward the sign-off to the
    //    harness so it can resolve the workflow's approval wait-condition. The
    //    WORM ATTEST write above is the system-of-record; a signal failure here
    //    MUST NOT block or roll back the (already-committed) sign-off.
    try {
      await this.harnessGatewayService?.signalApproval(contextItem.consultationId, {
        tenantId,
        contextItemVersionId: versionId,
        attestationHash,
        clinicianId: approvedBy,
      });
    } catch (error) {
      this.logger.warn({
        message: 'Harness approval signal failed (best-effort, sign-off not rolled back)',
        consultationId: contextItem.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      contextItemId,
      approvalStatus: 'APPROVED',
      approvedBy,
      approvedAt: version.createdAt.toISOString(),
    };
  }

  /**
   * TASK-330 Phase 1 — deterministic SHA-256 attestation hash binding the
   * clinician + timestamp to the exact signed content/version. Stored on the
   * SIGNED_NOTE version and echoed into the ATTEST audit event so tampering
   * with the note after signing is detectable.
   */
  private computeAttestationHash(input: {
    contextItemId: string;
    versionNumber: number;
    content: string;
    attestedBy: string;
    attestedAt: Date;
  }): string {
    return createHash('sha256')
      .update(`${input.contextItemId}:${input.versionNumber}:${input.attestedBy}:${input.attestedAt.toISOString()}:${input.content}`)
      .digest('hex');
  }

  /**
   * TASK-355 Phase D — sign-off safety stop (I4). Reads the inferential safety
   * verdict off the draft's `SummaryMeta.guardrailDecisions` and returns true iff
   * the SAFETY dimension is a FLAG. Tolerant of the two shapes the harness emits:
   * `{ safety: 'FLAG' }` and `{ safety: { decision|verdict: 'FLAG' } }`. ONLY the
   * safety dimension hard-blocks — groundedness / RAG / REGEN verdicts remain
   * signable (they are review prompts, not safety stops).
   */
  private static hasSafetyFlag(meta: { guardrailDecisions?: unknown }): boolean {
    const decisions = meta.guardrailDecisions as Record<string, unknown> | null | undefined;
    if (!decisions || typeof decisions !== 'object') return false;
    const safety = (decisions as Record<string, unknown>).safety ?? (decisions as Record<string, unknown>).SAFETY;
    if (safety == null) return false;
    const verdict =
      typeof safety === 'string'
        ? safety
        : ((safety as Record<string, unknown>).decision ?? (safety as Record<string, unknown>).verdict);
    return String(verdict).toUpperCase() === 'FLAG';
  }

  /**
   * Get latest summary for consultation (raw or modified)
   */
  async getLatestSummary(consultationId: string): Promise<SummaryResponse | null> {
    // Try to get latest modified summary first, then raw summary
    let summary = await this.contextItemRepository.findLatestModifiedSummary(consultationId);
    if (!summary) {
      summary = await this.contextItemRepository.findLatestRawSummary(consultationId);
    }
    if (!summary) return null;
    return SummaryDtoMapper.toResponse(summary);
  }

  /**
   * Get latest pre-summary for consultation
   */
  async getLatestPreSummary(consultationId: string): Promise<SummaryResponse | null> {
    const preSummary = await this.contextItemRepository.findLatestPreSummary(consultationId);
    if (!preSummary) return null;
    return SummaryDtoMapper.toResponse(preSummary);
  }

  /**
   * Get all summaries for consultation
   */
  async getSummaries(consultationId: string): Promise<SummaryResponse[]> {
    const summaries = await this.contextItemRepository.findSummaries(consultationId);
    return summaries.map(SummaryDtoMapper.toResponse);
  }

  /**
   * TASK-330 follow-up — read-only harness provenance for a generated summary.
   * Returns the `SummaryMeta` citationsMap + sensor scores + modelName that the
   * harness wrote. Tenant isolation is enforced by the repository's tenant-scoped
   * client (the controller has already verified read access to the consultation).
   */
  async getSummaryProvenance(contextItemId: string): Promise<SummaryProvenanceResponse> {
    const meta = await this.summaryMetaRepository.findByContextItem(contextItemId);
    if (!meta) {
      throw new NotFoundException(`No provenance found for summary ${contextItemId}`);
    }
    return SummaryDtoMapper.toProvenanceResponse(meta);
  }

  /**
   * Extract medical entities from context and store as NamedEntity records.
   * This is the synchronous path — entities are persisted before returning.
   * For async processing, use the job queue endpoints.
   */
  async extractEntities(contextItemId: string): Promise<void> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-305 D.4 (audit C-3) — assert the target context item belongs
    // to the caller's tenant before invoking the NLP service or
    // persisting NamedEntity rows. A cross-tenant id would otherwise
    // produce NER rows stamped with the CALLER's tenantId.
    const contextItem = await assertParentInScope(this.contextItemRepository, contextItemId, tenantId);

    if (!contextItem.content?.trim()) {
      throw new BadRequestException('Context item has no content for entity extraction');
    }

    const nerResponse = await this.callNlpService(contextItem.content);
    const entities = nerResponse.entities ?? [];

    let savedCount = 0;

    for (const entity of entities) {
      try {
        const namedEntity = NamedEntityFactory.CreateNamedEntity({
          tenantId,
          contextItemId,
          text: (entity.value as string) ?? (entity.text as string),
          className: (entity.type as string) ?? (entity.className as string),
          confidence: entity.confidence as number | undefined,
          startOffset: (entity.start as number) ?? (entity.startOffset as number),
          endOffset: (entity.end as number) ?? (entity.endOffset as number),
        });

        await this.namedEntityRepository.create(namedEntity);
        savedCount++;
      } catch (error) {
        this.logger.warn({
          message: 'Failed to persist named entity',
          contextItemId,
          entity,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log({
      message: 'Sync NER extraction completed',
      contextItemId,
      extractedCount: entities.length,
      savedCount,
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: contextItem.id,
      data: {
        entitiesExtracted: true,
        entityCount: entities.length,
        savedCount,
      },
    });
  }

  /**
   * TASK-305 D.4 (audit C-3) — validate every ContextItem id in the given
   * list belongs to `tenantId`. Used to scrub `generateSummary`'s
   * `contextItemIds` array so a cross-tenant id cannot be silently filtered
   * into the SMR transcript.
   *
   * Sequential `for...of` fails fast on the first cross-tenant id without
   * spawning unnecessary parallel reads on the hot summary-generate path.
   */
  private async assertContextItemsInTenant(tenantId: string, ids?: string[] | null): Promise<void> {
    if (!ids || ids.length === 0) return;
    for (const id of ids) {
      await assertParentInScope(this.contextItemRepository, id, tenantId);
    }
  }

  private async callSmrService(payload: {
    assembledPrompt: {
      userPrompt: string;
      systemPrompt: string;
      hyperparameters: Record<string, number>;
      responseFormat: {
        type: string;
        json_schema: Record<string, unknown>;
        strict: boolean;
      } | null;
      resolvedFrom: PromptResolutionTier;
    };
    options?: Record<string, unknown>;
    context?: Record<string, unknown>;
  }): Promise<LegacySmrSummaryResponse> {
    try {
      const smrPayload = buildSmrGeneratePayload(payload.assembledPrompt, payload.options, payload.context);
      const smrServiceToken = (await this.secretsService?.getSecretOptional('SMR_SERVICE_TOKEN')) ?? '';
      const response = await this.httpService.axiosRef.post(`${this.smrServiceUrl}/api/v1/generate`, smrPayload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': smrServiceToken,
        },
      });
      return mapSmrGenerateResponse(response.data);
    } catch (error) {
      throw new BadRequestException(`Failed to call SMR service: ${error}`);
    }
  }

  private resolveConversationLanguage(options?: Record<string, unknown>): string {
    const candidate = options?.conversationLanguage ?? options?.language ?? options?.locale;

    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : 'en';
  }

  /**
   * TASK-329 P2 (Tier-0): resolve the consulting doctor's preferred prompt template id
   * from their UserProfile. Returns null when the repo isn't wired (legacy fixtures),
   * the doctor has no profile, or the lookup fails — letting prompt resolution fall
   * through to the department/default tiers.
   */
  private async resolvePreferredPromptTemplateId(doctorId?: string | null): Promise<string | null> {
    if (!doctorId || !this.userProfileRepository) return null;

    try {
      const profiles = await this.userProfileRepository.findAll({ where: { userId: doctorId } });
      return profiles[0]?.preferredPromptTemplateId ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve preferred prompt template — falling back to department/default',
        doctorId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async callNlpService(text: string): Promise<{
    entities: Record<string, unknown>[];
  }> {
    try {
      const response = await this.httpService.axiosRef.post(`${this.nlpServiceUrl}/api/v1/classify/tokens`, { text });
      return response.data;
    } catch (error) {
      throw new BadRequestException(`Failed to call NLP service: ${error}`);
    }
  }
}
