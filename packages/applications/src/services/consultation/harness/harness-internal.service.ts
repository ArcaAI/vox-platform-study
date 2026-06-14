import { Inject, Injectable, Logger, Optional, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  ContextItemEntity,
} from '@arcaai/domains';
import { HarnessAuditService } from '../../harness-audit';
import { HarnessAssuranceService } from './harness-assurance.service';
import { PromptAssemblyService, type NerEntityForPrompt } from '../prompt/prompt-assembly.service';
import { IConsultationJobService } from '../jobs/consultation-job.service';
import { assertEqualTenants, createWorkerSession } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { HARNESS_DRAFT_PHASE } from './dto';
import type {
  HarnessAssembleRequest,
  HarnessAssembleResponse,
  HarnessDraftRequest,
  HarnessDraftResponse,
  HarnessFinalizeAssuranceRequest,
  HarnessFinalizeAssuranceResponse,
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

  // TASK-355 Phase C (R-6) — warm-start kill-switch (HARNESS_WARM_START_ENABLED,
  // default OFF). When OFF the harness injects no prior draft and records no
  // preSummaryIds provenance (exact pre-Phase-C behavior); enable for the doc-07
  // §3 cold-vs-warm A/B. Cached at construction, matching live-documentation/ocr.
  private readonly warmStartEnabled: boolean;

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
    // TASK-355 Phase C (R-6) — optional so existing unit fixtures keep their
    // constructor arity; production DI supplies it via ConfigModule (added to
    // HarnessInternalServiceModule). Absent ⇒ flag OFF, matching the prod default.
    @Optional() private readonly configService?: ConfigService,
    // TASK-355 Phase D Slice 5d — optional so existing unit fixtures keep their
    // constructor arity; production DI supplies it via HarnessAssuranceServiceModule.
    // finalizeAssurance publishes the terminal `assurance_complete` here to close
    // the live SSE feed (best-effort — a Redis hiccup must not break finalize).
    @Optional() private readonly assuranceService?: HarnessAssuranceService,
  ) {
    const raw = String(this.configService?.get('HARNESS_WARM_START_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    this.warmStartEnabled = raw === 'true' || raw === '1';
  }

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

      // TASK-355 Phase C (R-6) — warm-start `generate` from the live SOAP
      // snapshot instead of cold-generating: inject the running SOAP note as
      // {pre_summary_text} so the model refines it. Cold path when absent.
      // Gated behind the kill-switch (default OFF): when disabled we skip the
      // snapshot lookup entirely so nothing is injected (exact pre-Phase-C path).
      const liveSnapshot = this.warmStartEnabled ? await this.loadLiveSoapSnapshot(consultationId) : null;

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
        preSummaryText: liveSnapshot?.content ?? undefined,
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
   * Persist the generated draft: RAW_SUMMARY ContextItem + SummaryMeta + status
   * + SSE progress + WORM audit.
   *
   * TASK-355 Phase D — two-phase (optimistic) delivery, gated by `dto.phase`:
   *   - EARLY (`DRAFT_PENDING_SENSORS`): persist the readable draft BEFORE the
   *     inferential assurance pass finishes. SummaryMeta carries the
   *     computational scores only; the inferential scores, gate verdict, and
   *     `assuranceCompletedAt` are withheld (NULL) and status becomes
   *     `DRAFT_PENDING_SENSORS`. Only the GENERATE audit is written — no
   *     SENSOR_RUN, because no verdict exists yet (WORM truthfulness).
   *     `finalizeAssurance()` completes the meta + flips to PENDING_REVIEW.
   *   - FINALIZE / absent (legacy single-shot): assurance is already complete, so
   *     the meta is fully scored, `assuranceCompletedAt` is stamped (the sign-off
   *     guard treats legacy drafts as assured), status flips straight to
   *     PENDING_REVIEW, and GENERATE + SENSOR_RUN (+ REDUCED_ASSURANCE) are written.
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
      // Phase D delivery discriminator. Default (absent) == legacy single-shot.
      const isEarly = dto.phase === HARNESS_DRAFT_PHASE.EARLY;
      const consultation = await this.consultationRepository.findById(consultationId);
      assertEqualTenants(consultation, { tenantId });

      // 1. RAW_SUMMARY context item for the generated note.
      const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, dto.content, dto.dnaStyleId, userId);
      const savedContext = await this.contextItemRepository.create(contextItem);
      const contextItemId = savedContext?.id ?? contextItem.id;

      // 2. SummaryMeta — sensor score columns + full sensor detail + citation map.
      // TASK-355 Phase C (R-6) — record warm-start provenance. The consumed
      // snapshot id can't be threaded assemble->generate->persist_draft (no
      // Temporal workflow change), so re-resolve the same frozen LIVE_SOAP_SNAPSHOT
      // row via the shared helper (deterministic post-stop) and write its id.
      // Gated behind the kill-switch (default OFF): when disabled we skip the
      // lookup and record empty provenance (exact pre-Phase-C behavior).
      const liveSnapshot = this.warmStartEnabled ? await this.loadLiveSoapSnapshot(consultationId) : null;
      // EARLY: withhold the inferential scores + verdict + assurance marker (they
      // don't exist yet — finalizeAssurance backfills them). LEGACY: full meta +
      // `assuranceCompletedAt` stamped now so the sign-off guard treats the
      // single-shot draft as already assured.
      const summaryMeta = SummaryMetaFactory.CreateSummaryMeta({
        tenantId,
        contextItemId,
        modelName: dto.modelName ?? null,
        promptVersion: dto.promptVersion ?? null,
        entityFaithfulnessScore: dto.entityFaithfulnessScore ?? null,
        coverageScore: dto.coverageScore ?? null,
        ragTriadScore: isEarly ? null : (dto.ragTriadScore ?? null),
        citationsMap: (isEarly ? null : (dto.citationsMap ?? null)) as never,
        guardrailDecisions: (isEarly ? null : (dto.guardrailDecisions ?? null)) as never,
        gateDecision: isEarly ? null : (dto.gateDecision ?? null),
        assuranceCompletedAt: isEarly ? null : new Date(),
        preSummaryIds: liveSnapshot ? [liveSnapshot.id] : [],
        generatedAt: new Date(),
      });
      await this.summaryMetaRepository.create(summaryMeta);

      // 3. Lifecycle. EARLY -> DRAFT_PENDING_SENSORS (readable, assurance pending,
      // NOT signable). LEGACY -> PENDING_REVIEW (clinician confirm-before-commit).
      if (consultation) {
        consultation.status = isEarly ? ConsultationStatus.DRAFT_PENDING_SENSORS : ConsultationStatus.PENDING_REVIEW;
        consultation.updatedBy = userId;
        await this.consultationRepository.update(consultation.id, consultation);
      }

      // 4. SSE progress (best-effort — a Redis hiccup must not lose the draft).
      if (dto.jobId) {
        try {
          await this.jobService?.notifyProgress(
            dto.jobId,
            isEarly ? 90 : 100,
            isEarly ? 'Draft ready — verifying safety' : 'Draft ready for review',
          );
        } catch (error) {
          this.logger.warn({
            message: 'Harness draft SSE progress notify failed (best-effort)',
            jobId: dto.jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // 5. WORM audit trail. GENERATE (provenance) is written in BOTH phases.
      // SENSOR_RUN (the verdict, carrying sensorScores + guardrailDecisions) and
      // REDUCED_ASSURANCE are written only when a verdict EXISTS — the legacy
      // single-shot path here, or `finalizeAssurance()` in Phase D. Early delivery
      // emits NO SENSOR_RUN (WORM truthfulness: a gate decision is recorded only
      // once it has been computed).
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
      if (!isEarly) {
        const sensorScoresAudit = {
          ...((dto.sensorScores ?? {}) as Record<string, unknown>),
          guardrailDecisions: dto.guardrailDecisions ?? null,
        };
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
      }

      this.logger.log({
        message: isEarly ? 'Harness early draft persisted (assurance pending)' : 'Harness draft persisted',
        consultationId,
        contextItemId,
        gateDecision: isEarly ? null : (dto.gateDecision ?? null),
      });
      return { contextItemId };
    });
  }

  /**
   * TASK-355 Phase D — second phase of optimistic delivery. The inferential
   * assurance pass has finished, so backfill the early-persisted SummaryMeta with
   * the inferential scores + gate verdict, stamp `assuranceCompletedAt`, flip the
   * consultation `DRAFT_PENDING_SENSORS → PENDING_REVIEW`, and record the
   * SENSOR_RUN (+ REDUCED_ASSURANCE) WORM audit — the verdict that early
   * `persistDraft()` deliberately withheld. Fail-closed: a missing early-persisted
   * SummaryMeta is a contract violation (no draft to finalize) and aborts.
   *
   * Idempotent on the lifecycle flip (only DRAFT_PENDING_SENSORS advances), so a
   * Temporal activity retry re-stamps the same verdict without regressing state.
   */
  async finalizeAssurance(
    consultationId: string,
    dto: HarnessFinalizeAssuranceRequest,
  ): Promise<HarnessFinalizeAssuranceResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    if (!dto.contextItemId) {
      throw new BadRequestException('contextItemId is required');
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId: dto.userId, tenantId, kind: 'harness-internal' }));

      const userId = dto.userId ?? 'system';
      const consultation = await this.consultationRepository.findById(consultationId);
      assertEqualTenants(consultation, { tenantId });

      // TASK-355 Phase D (Q2b) — did the clinician early-sign (Q2a) before this
      // verdict landed? If so the note is already immutable and STANDS; a late
      // adverse verdict is recorded as POST_SIGN_FLAG (below), never regressing it.
      const alreadySigned = consultation?.status === ConsultationStatus.SIGNED;

      // 1. Backfill the early-persisted SummaryMeta with the inferential verdict.
      // Fail-closed: no meta ⇒ no early draft to finalize (contract violation).
      const meta = await this.summaryMetaRepository.findByContextItem(dto.contextItemId);
      if (!meta) {
        throw new BadRequestException(
          `No draft SummaryMeta for contextItem ${dto.contextItemId} — finalizeAssurance requires a prior early persist`,
        );
      }
      meta.ragTriadScore = dto.ragTriadScore ?? null;
      meta.citationsMap = (dto.citationsMap ?? null) as never;
      meta.guardrailDecisions = (dto.guardrailDecisions ?? null) as never;
      meta.gateDecision = dto.gateDecision ?? null;
      meta.assuranceCompletedAt = new Date();
      await this.summaryMetaRepository.update(meta.id, meta);

      // 2. Lifecycle DRAFT_PENDING_SENSORS -> PENDING_REVIEW (idempotent — a retry
      // after the flip is a no-op, never regressing a signed/closed consultation).
      if (consultation && consultation.status === ConsultationStatus.DRAFT_PENDING_SENSORS) {
        consultation.status = ConsultationStatus.PENDING_REVIEW;
        consultation.updatedBy = userId;
        await this.consultationRepository.update(consultation.id, consultation);
      }

      // 3. SSE progress (best-effort — a Redis hiccup must not lose the verdict).
      if (dto.jobId) {
        try {
          await this.jobService?.notifyProgress(dto.jobId, 100, 'Assurance complete');
        } catch (error) {
          this.logger.warn({
            message: 'Harness finalizeAssurance SSE progress notify failed (best-effort)',
            jobId: dto.jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // 4. WORM — SENSOR_RUN (the deferred verdict) + REDUCED_ASSURANCE.
      const sensorScoresAudit = {
        ...((dto.sensorScores ?? {}) as Record<string, unknown>),
        guardrailDecisions: dto.guardrailDecisions ?? null,
      };
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

      // 4b. TASK-355 Phase D (Q2b) — a late ADVERSE verdict (FLAG/REGEN) for a
      // note the clinician already early-signed. The signed note is immutable and
      // STANDS — never regressed (step 2's flip is skipped for SIGNED) — but we
      // append a POST_SIGN_FLAG WORM annotation so the amendment/follow-up path
      // (and the assurance SSE terminal event, Slice 5d) can surface an alert.
      const lateAdverseVerdict = dto.gateDecision === 'FLAG' || dto.gateDecision === 'REGEN';
      if (alreadySigned && lateAdverseVerdict) {
        await this.harnessAuditService.append({
          tenantId,
          consultationId,
          action: HarnessAuditAction.POST_SIGN_FLAG,
          modelName: dto.modelName ?? 'unknown',
          modelVersion: dto.modelVersion ?? 'unknown',
          promptTemplateId: dto.promptTemplateId ?? null,
          promptVersion: dto.promptVersion ?? null,
          sensorScores: sensorScoresAudit as never,
          citations: (this.extractClaims(dto.citationsMap) ?? []) as never,
          gateDecision: dto.gateDecision ?? null,
          createdBy: userId,
        });
        this.logger.warn({
          message:
            'Harness assurance returned an adverse verdict AFTER an early sign — POST_SIGN_FLAG recorded for amendment/follow-up',
          consultationId,
          contextItemId: dto.contextItemId,
          gateDecision: dto.gateDecision ?? null,
        });
      }

      // 5. TASK-355 Phase D Slice 5d — close the live assurance SSE feed with the
      // terminal `assurance_complete` (aggregate verdict + safetyFlag + postSignAlert)
      // so the browser can stop the spinner, enable sign-off, or raise the Q2b
      // amendment alert. Best-effort: the service swallows Redis errors, but guard
      // anyway so an unexpected throw can never undo the durable finalize above.
      try {
        await this.assuranceService?.publishComplete(consultationId, {
          tenantId,
          jobId: dto.jobId,
          gateDecision: dto.gateDecision ?? null,
          safetyFlag: HarnessInternalService.hasSafetyFlag(dto.guardrailDecisions),
          reducedAssurance: !!dto.reducedAssurance,
          postSignAlert: alreadySigned && lateAdverseVerdict,
        });
      } catch (error) {
        this.logger.warn({
          message: 'Harness finalizeAssurance terminal SSE publish failed (best-effort)',
          consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      this.logger.log({
        message: 'Harness assurance finalized',
        consultationId,
        contextItemId: dto.contextItemId,
        gateDecision: dto.gateDecision ?? null,
      });
      return { recorded: true, contextItemId: dto.contextItemId };
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
   * TASK-355 Phase C (R-6) — the latest live SOAP snapshot for warm-start.
   * The live session upserts ONE PRE_SUMMARY row tagged metaData.subType =
   * 'LIVE_SOAP_SNAPSHOT'. Distinct from legacy case-notes pre-summaries, so we
   * filter on subType (findLatestPreSummary is NOT subType-aware). Returns the
   * newest matching row (defensive sort: findPreSummaries is createdAt ASC).
   * Shared by assemble() (injects the text) and persistDraft() (records the id)
   * so both always agree on which row was consumed.
   */
  private async loadLiveSoapSnapshot(consultationId: string): Promise<ContextItemEntity | null> {
    const preSummaries = await this.contextItemRepository.findPreSummaries(consultationId);
    const snapshots = preSummaries.filter((p) => (p.metaData as Record<string, unknown> | undefined)?.subType === 'LIVE_SOAP_SNAPSHOT');
    if (snapshots.length === 0) return null;
    return snapshots.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
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

  /**
   * TASK-355 Phase D Slice 5d — true iff the inferential SAFETY dimension is a
   * FLAG, derived from the harness `guardrailDecisions`. Tolerant of the two
   * shapes the harness emits (`{ safety: 'FLAG' }` and
   * `{ safety: { decision|verdict: 'FLAG' } }`), mirroring
   * `SummaryService.hasSafetyFlag` so the SSE terminal event and the sign-off
   * guard agree on what counts as a safety stop.
   */
  private static hasSafetyFlag(guardrailDecisions?: Record<string, unknown> | null): boolean {
    if (!guardrailDecisions || typeof guardrailDecisions !== 'object') return false;
    const safety = guardrailDecisions.safety ?? guardrailDecisions.SAFETY;
    if (safety == null) return false;
    const verdict =
      typeof safety === 'string'
        ? safety
        : ((safety as Record<string, unknown>).decision ?? (safety as Record<string, unknown>).verdict);
    return String(verdict).toUpperCase() === 'FLAG';
  }
}
