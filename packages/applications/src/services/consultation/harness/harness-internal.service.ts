import { Inject, Injectable, Logger, Optional, BadRequestException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationRepository,
  ContextItemRepository,
  ContextItemFactory,
  NamedEntityRepository,
  NamedEntityFactory,
  SummaryMetaRepository,
  SummaryMetaFactory,
  PromptTemplateRepository,
  ConsultationStatus,
  HarnessAuditAction,
  HighlightRepository,
} from '@arcaai/domains';
import { HarnessAuditService } from '../../harness-audit';
import { PromptAssemblyService, type NerEntityForPrompt } from '../prompt/prompt-assembly.service';
import { IConsultationJobService } from '../jobs/consultation-job.service';
import { assertEqualTenants, createWorkerSession } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import type {
  HarnessAssembleRequest,
  HarnessAssembleResponse,
  HarnessDraftRequest,
  HarnessDraftResponse,
  HarnessGateDecisionRequest,
  HarnessGateDecisionResponse,
  HarnessPersistEntitiesRequest,
  HarnessPersistEntitiesResponse,
} from './dto';

/**
 * HarnessInternalService (TASK-330 Phase 1 — Lane G).
 *
 * The INBOUND apps/api half of the gate adapter. The durable harness workflow
 * (apps/harness) calls back into apps/api — which stays the sole DB writer and
 * system-of-record — through three operations. Each re-establishes CLS from the
 * request body `tenantId` (the harness runs outside the API edge ClsModule
 * middleware, exactly like the BullMQ workers), then delegates to the existing
 * PromptResolution/PromptAssembly/ContextItem/SummaryMeta/NamedEntity/Consultation/
 * HarnessAudit machinery — no new business logic, just orchestration.
 */
@Injectable()
export class HarnessInternalService {
  private readonly logger = new Logger(HarnessInternalService.name);

  constructor(
    private readonly contextItemRepository: ContextItemRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly namedEntityRepository: NamedEntityRepository,
    private readonly summaryMetaRepository: SummaryMetaRepository,
    private readonly promptAssemblyService: PromptAssemblyService,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly harnessAuditService: HarnessAuditService,
    private readonly cls: ClsService<IActiveUserContext>,
    // Optional so unit fixtures can omit it. Production DI supplies it via
    // ConsultationJobServiceModule; draft SSE progress is best-effort either way.
    @Optional() @Inject(IConsultationJobService) private readonly jobService?: IConsultationJobService,
    // TASK-344 Workstream B — optional so existing unit fixtures keep their
    // constructor arity; production DI supplies it via CoreDatabaseModule. The
    // manual-highlight SOAP feed is best-effort enrichment either way.
    @Optional() @Inject(HighlightRepository) private readonly highlightRepository?: HighlightRepository,
  ) {}

  /**
   * Persist NamedEntity rows (text/type/char-offsets from NLP) for a consultation.
   */
  async persistEntities(consultationId: string, dto: HarnessPersistEntitiesRequest): Promise<HarnessPersistEntitiesResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId: dto.userId, tenantId, kind: 'harness-internal' }));

      const entityIds: string[] = [];
      for (const entity of dto.entities ?? []) {
        const namedEntity = NamedEntityFactory.CreateNamedEntity({
          tenantId,
          contextItemId: dto.contextItemId,
          text: entity.text,
          className: entity.type,
          normalizedText: entity.normalizedText,
          startOffset: entity.startOffset,
          endOffset: entity.endOffset,
          confidence: entity.confidence,
          transcriptContextItemId: entity.transcriptContextItemId,
          transcriptStartOffset: entity.transcriptStartOffset,
          transcriptEndOffset: entity.transcriptEndOffset,
        });
        const saved = await this.namedEntityRepository.create(namedEntity);
        entityIds.push(saved?.id ?? namedEntity.id);
      }

      this.logger.log({ message: 'Harness entities persisted', consultationId, savedCount: entityIds.length });
      return { savedCount: entityIds.length, entityIds };
    });
  }

  /**
   * Resolve the prompt tier + assemble the SMR payload (incl. Lane E's NER
   * injection + SOAP responseFormat) — the single source of truth for prompt
   * assembly. nerEntities are loaded via NamedEntityRepository.findByConsultation.
   */
  async assemble(consultationId: string, dto: HarnessAssembleRequest): Promise<HarnessAssembleResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId: dto.userId, tenantId, kind: 'harness-internal' }));

      const consultation = await this.consultationRepository.findById(consultationId);
      assertEqualTenants(consultation, { tenantId });

      const transcripts = await this.contextItemRepository.findTranscripts(consultationId);
      const transcript = transcripts.map((t) => t.content).join('\n\n');

      const nerEntities = await this.loadNerEntities(consultationId);

      // TASK-342 GAP #2 — fold the doctor's case-notes / work-notes / attachments
      // into the authoritative-SOAP prompt. Read entities directly from the
      // repository (reads already filter resourceStatus = ENABLED, so soft-deleted
      // items drop out). Work notes are labeled `[work note]`; attachments use the
      // extracted text when present (GAP #5), else the stored filename label.
      const [caseNotes, workNotes, attachmentItems] = await Promise.all([
        this.contextItemRepository.findCaseNotes(consultationId),
        this.contextItemRepository.findWorknotes(consultationId),
        this.contextItemRepository.findAttachments(consultationId),
      ]);

      const clinicianNotes = [
        ...caseNotes
          .filter((n) => n.content?.trim())
          .map((n) => `[case note] ${n.content!.trim()}`),
        ...workNotes
          .filter((n) => n.content?.trim())
          .map((n) => `[work note] ${n.content!.trim()}`),
      ];
      const attachments = attachmentItems
        .map((a) => {
          // TASK-342 GAP #5 — prefer the extracted file text (txt / csv / md /
          // json, threaded onto `metaData.extractedText` at upload); fall back to
          // the stored "Lab/exam result: <name>" filename label when none exists.
          const meta = a.metaData as Record<string, unknown> | undefined;
          const extracted = typeof meta?.extractedText === 'string' ? meta.extractedText.trim() : '';
          return extracted || a.content?.trim() || '';
        })
        .filter((c): c is string => !!c);

      // TASK-344 Workstream B — thread the doctor's manual highlight spans into
      // the authoritative SOAP prompt, labeled `[highlight]` alongside the GAP #2
      // clinician notes. Best-effort: optional repo + soft-deleted rows already
      // excluded by the repository's resourceStatus filter. A SEPARATE aggregate
      // from NamedEntity, so manual marks never pollute the NER aggregation.
      const highlightEntities = this.highlightRepository ? await this.highlightRepository.findByConsultation(consultationId) : [];
      const highlights = highlightEntities
        .filter((h) => h.exact?.trim())
        .map((h) => `[highlight] ${h.exact.trim()}`);

      const assembled = await this.promptAssemblyService.assemble({
        departmentId: consultation?.departmentId ?? undefined,
        promptType: consultation?.parentConsultationId ? 'revisit' : 'new-patient',
        transcript,
        conversationLanguage: dto.conversationLanguage?.trim() || 'en',
        dnaStyleId: dto.dnaStyleId,
        explicitTemplate: dto.template,
        nerEntities,
        clinicianNotes,
        attachments,
        highlights,
      });

      const promptTemplateId = assembled.promptId ?? null;
      let promptVersion: string | null = null;
      if (promptTemplateId) {
        const template = await this.promptTemplateRepository.findById(promptTemplateId);
        promptVersion = template?.currentVersionNumber != null ? String(template.currentVersionNumber) : null;
      }

      return {
        userPrompt: assembled.userPrompt,
        systemPrompt: assembled.systemPrompt,
        hyperparameters: assembled.hyperparameters,
        responseFormat: assembled.responseFormat,
        promptTemplateId,
        promptVersion,
        resolvedFrom: assembled.resolvedFrom,
      };
    });
  }

  /**
   * Persist the generated draft: RAW_SUMMARY ContextItem + SummaryMeta (sensor
   * scores / citations / provenance) + status -> PENDING_REVIEW + SSE progress +
   * GENERATE & SENSOR_RUN WORM audit events.
   */
  async persistDraft(consultationId: string, dto: HarnessDraftRequest): Promise<HarnessDraftResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId: dto.userId, tenantId, kind: 'harness-internal' }));

      const userId = dto.userId ?? 'system';
      const consultation = await this.consultationRepository.findById(consultationId);
      assertEqualTenants(consultation, { tenantId });

      // 1. RAW_SUMMARY context item for the generated note.
      const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, dto.content, dto.dnaStyleId, userId);
      const savedContext = await this.contextItemRepository.create(contextItem);
      const contextItemId = savedContext?.id ?? contextItem.id;

      // 2. SummaryMeta — sensor score columns + full sensor detail + citation map.
      const summaryMeta = SummaryMetaFactory.CreateSummaryMeta({
        tenantId,
        contextItemId,
        modelName: dto.modelName ?? null,
        promptVersion: dto.promptVersion ?? null,
        entityFaithfulnessScore: dto.entityFaithfulnessScore ?? null,
        coverageScore: dto.coverageScore ?? null,
        ragTriadScore: dto.ragTriadScore ?? null,
        citationsMap: (dto.citationsMap ?? null) as never,
        guardrailDecisions: (dto.guardrailDecisions ?? null) as never,
        generatedAt: new Date(),
      });
      await this.summaryMetaRepository.create(summaryMeta);

      // 3. Lifecycle -> PENDING_REVIEW (clinician confirm-before-commit gate).
      if (consultation) {
        consultation.status = ConsultationStatus.PENDING_REVIEW;
        consultation.updatedBy = userId;
        await this.consultationRepository.update(consultation.id, consultation);
      }

      // 4. SSE progress (best-effort — a Redis hiccup must not lose the draft).
      if (dto.jobId) {
        try {
          await this.jobService?.notifyProgress(dto.jobId, 100, 'Draft ready for review');
        } catch (error) {
          this.logger.warn({
            message: 'Harness draft SSE progress notify failed (best-effort)',
            jobId: dto.jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // 5. WORM audit trail — GENERATE (provenance) + SENSOR_RUN (verdict, carrying
      // both sensorScores and guardrailDecisions) + REDUCED_ASSURANCE when the
      // inferential pass degraded (judge/safety backend unavailable).
      const sensorScoresAudit = {
        ...((dto.sensorScores ?? {}) as Record<string, unknown>),
        guardrailDecisions: dto.guardrailDecisions ?? null,
      };
      await this.harnessAuditService.append({
        tenantId,
        consultationId,
        action: HarnessAuditAction.GENERATE,
        modelName: dto.modelName ?? 'unknown',
        modelVersion: dto.modelVersion ?? 'unknown',
        promptTemplateId: dto.promptTemplateId ?? null,
        promptVersion: dto.promptVersion ?? null,
        sensorScores: {},
        citations: [],
        createdBy: userId,
      });
      await this.harnessAuditService.append({
        tenantId,
        consultationId,
        action: HarnessAuditAction.SENSOR_RUN,
        modelName: dto.modelName ?? 'unknown',
        modelVersion: dto.modelVersion ?? 'unknown',
        promptTemplateId: dto.promptTemplateId ?? null,
        promptVersion: dto.promptVersion ?? null,
        sensorScores: sensorScoresAudit as never,
        citations: (this.extractClaims(dto.citationsMap) ?? []) as never,
        gateDecision: dto.gateDecision ?? null,
        createdBy: userId,
      });
      if (dto.reducedAssurance) {
        await this.harnessAuditService.append({
          tenantId,
          consultationId,
          action: HarnessAuditAction.REDUCED_ASSURANCE,
          modelName: dto.modelName ?? 'unknown',
          modelVersion: dto.modelVersion ?? 'unknown',
          promptTemplateId: dto.promptTemplateId ?? null,
          promptVersion: dto.promptVersion ?? null,
          sensorScores: sensorScoresAudit as never,
          citations: [],
          gateDecision: dto.gateDecision ?? null,
          createdBy: userId,
        });
      }

      this.logger.log({ message: 'Harness draft persisted', consultationId, contextItemId, gateDecision: dto.gateDecision });
      return { contextItemId };
    });
  }

  /**
   * Record the clinician GATE_DECISION as an append-only WORM audit event. The
   * harness calls this after apps/api has already written the SIGNED_NOTE + ATTEST
   * (the system-of-record); this closes the loop's audit trail with the gate
   * outcome. Re-establishes CLS from the body `tenantId` like the other handlers.
   */
  async recordGateDecision(consultationId: string, dto: HarnessGateDecisionRequest): Promise<HarnessGateDecisionResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId: dto.userId, tenantId, kind: 'harness-internal' }));

      await this.harnessAuditService.append({
        tenantId,
        consultationId,
        action: HarnessAuditAction.GATE_DECISION,
        modelName: 'harness-gate',
        modelVersion: 'v1',
        sensorScores: {},
        citations: [],
        gateDecision: dto.gateDecision ?? null,
        contextItemVersionId: dto.contextItemVersionId ?? null,
        attestationHash: dto.attestationHash ?? null,
        clinicianId: dto.clinicianId ?? null,
        createdBy: dto.userId ?? dto.clinicianId ?? null,
      });

      this.logger.log({ message: 'Harness gate decision recorded', consultationId, decision: dto.decision, gateDecision: dto.gateDecision });
      return { recorded: true };
    });
  }

  /**
   * Flatten a consultation's NER entities for prompt injection. Transcript-span
   * offsets are preferred over the raw source offsets so the model can cite the
   * source location (mirrors SummaryProcessor.loadNerEntities).
   */
  private async loadNerEntities(consultationId: string): Promise<NerEntityForPrompt[]> {
    const entities = await this.namedEntityRepository.findByConsultation(consultationId);
    return entities.map((entity) => ({
      text: entity.text,
      type: entity.className,
      normalizedText: entity.normalizedText ?? undefined,
      umlsCui: entity.umlsCui ?? undefined,
      snomedCode: entity.snomedCode ?? undefined,
      rxnormCode: entity.rxnormCode ?? undefined,
      icdCode: entity.icdCode ?? undefined,
      loincCode: entity.loincCode ?? undefined,
      startOffset: entity.transcriptStartOffset ?? entity.startOffset ?? undefined,
      endOffset: entity.transcriptEndOffset ?? entity.endOffset ?? undefined,
    }));
  }

  private extractClaims(citationsMap?: Record<string, unknown> | null): unknown[] {
    const claims = citationsMap?.claims;
    return Array.isArray(claims) ? claims : [];
  }
}
