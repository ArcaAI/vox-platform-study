import { Inject, Injectable, Logger, Optional, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationRepository,
  ContextItemRepository,
  ContextItemFactory,
  ContextItemVersionRepository,
  ContextItemVersionFactory,
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
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IRedisCacheService } from '../../baseServices/redis';
import { HarnessAssuranceService } from './harness-assurance.service';
import { ConfigResolver } from '../../config-resolver';
import { PromptAssemblyService, type NerEntityForPrompt } from '../prompt/prompt-assembly.service';
import { IConsultationJobService } from '../jobs/consultation-job.service';
import { assertEqualTenants, createWorkerSession, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { HARNESS_DRAFT_PHASE } from './dto';
import type {
  HarnessAssembleRequest,
  HarnessAssembleResponse,
  HarnessDraftRequest,
  HarnessDraftResponse,
  HarnessEscalationRequest,
  HarnessEscalationResponse,
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

  // TASK-466 (C1-03) — Idempotency-Key dedup namespace + TTL for the WORM/draft
  // callbacks. The key value is the harness `{run_id}:{activity_id}` (globally
  // unique); the Redis key additionally namespaces by operation + tenantId.
  private readonly IDEMPOTENCY_KEY_PREFIX = 'idempotency:harness:';
  private readonly IDEMPOTENCY_TTL = 86400; // 24 hours

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
    // TASK-356 Phase 5 — optional so existing unit fixtures keep their constructor
    // arity; production DI supplies it via ConfigResolverModule. Threads the
    // doctor's preferred prompt id (UserProfile.preferredPromptTemplateId, read-only)
    // into assemble so the async/harness path honors Tier-0 like the sync/REST path.
    // TASK-356 Phase 6 (S3) — also resolves the effective DNA-style decision
    // (tenant AND doctor) so DNA style is applied on the harness generation path
    // only when the doctor is opted in under an enabling tenant.
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // TASK-356 Phase 6 (S4) — write the immutable AI-draft `v1` snapshot at the
    // harness generation boundary (`persistDraft`) for the DNA edit-capture
    // corpus. Optional + trailing so existing positional unit fixtures keep their
    // arity; production DI supplies it via CoreDatabaseModule. When unset the
    // snapshot is a no-op (best-effort), matching the pre-Phase-6 path.
    @Optional() @Inject(ContextItemVersionRepository) private readonly contextItemVersionRepository?: ContextItemVersionRepository,
    // TASK-369 Phase 3C — application-level field encryption for the clinical
    // models this callback half persists (NamedEntity spans, SummaryMeta
    // provenance JSONB, ContextItemVersion snapshots). Optional + trailing so
    // existing positional unit fixtures keep their arity; production DI supplies
    // it via CoreDatabaseModule. Absent ⇒ these PHI fields are left unpersisted
    // (Phase 6 dropped the plaintext columns); SECRETS_PROVIDER=vault is fail-closed.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // TASK-466 (C1-03) — Idempotency-Key dedup for the WORM/draft callbacks. The
    // durable harness workflow re-invokes these on each Temporal activity retry;
    // dedup keyed on the harness `Idempotency-Key` (`{run_id}:{activity_id}`) makes
    // the re-append a no-op that replays the prior response. Optional + trailing so
    // existing positional unit fixtures keep their arity; production DI supplies it
    // via RedisCacheModule. Absent (or a Redis hiccup) ⇒ best-effort fall-through to
    // normal processing (mirrors TASK-299 D-10).
    @Optional() @Inject(IRedisCacheService) private readonly redisCache?: IRedisCacheService,
  ) {
    const raw = String(this.configService?.get('HARNESS_WARM_START_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    this.warmStartEnabled = raw === 'true' || raw === '1';
  }

  /**
   * TASK-369 — encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   * The harness WORM audit payloads are built from the inbound DTO (not the
   * encrypted entity), so no ciphertext can leak into them — nothing to strip.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  /**
   * Persist NamedEntity rows (text/type/char-offsets from NLP) for a consultation.
   */
  async persistEntities(
    consultationId: string,
    dto: HarnessPersistEntitiesRequest,
    idempotencyKey?: string,
  ): Promise<HarnessPersistEntitiesResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    return this.withHarnessIdempotency('persistEntities', tenantId, idempotencyKey, () =>
      this.cls.run(async () => {
        this.cls.set('tenantId', tenantId);
        this.cls.set('user', createWorkerSession({ userId: dto.userId, tenantId, kind: 'harness-internal' }));

        // 404-over-403: assert consultation ownership before persisting WORM/PHI
        // NamedEntity rows (a cross-tenant id must not write audit rows) — mirrors
        // assemble/persistDraft/finalizeAssurance/recordEscalation.
        const consultation = await this.consultationRepository.findById(consultationId);
        assertEqualTenants(consultation, { tenantId });

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
          await this.encryptBestEffort('NamedEntity', () => this.namedEntityRepository.encryptFieldsIntoEntity(namedEntity, this.secretsService!));
          const saved = await this.namedEntityRepository.create(namedEntity);
          entityIds.push(saved?.id ?? namedEntity.id);
        }

        this.logger.log({ message: 'Harness entities persisted', consultationId, savedCount: entityIds.length });
        return { savedCount: entityIds.length, entityIds };
      }),
    );
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
        ...caseNotes.filter((n) => n.content?.trim()).map((n) => `[case note] ${n.content!.trim()}`),
        ...workNotes.filter((n) => n.content?.trim()).map((n) => `[work note] ${n.content!.trim()}`),
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
      const highlights = highlightEntities.filter((h) => h.exact?.trim()).map((h) => `[highlight] ${h.exact.trim()}`);

      // TASK-355 Phase C (R-6) — warm-start `generate` from the live SOAP
      // snapshot instead of cold-generating: inject the running SOAP note as
      // {pre_summary_text} so the model refines it. Cold path when absent.
      // Gated behind the kill-switch (default OFF): when disabled we skip the
      // snapshot lookup entirely so nothing is injected (exact pre-Phase-C path).
      const liveSnapshot = this.warmStartEnabled ? await this.loadLiveSoapSnapshot(consultationId) : null;

      // TASK-356 Phase 5 (§2.5) — thread the doctor's preferred prompt id (Tier-0)
      // through the async/harness path too. Read-only from UserProfile via the
      // ConfigResolver, keyed off the consultation's doctor. Best-effort: when the
      // resolver is unwired (unit fixtures) or there is no doctor, the id is omitted
      // and assembly falls back to the department/global tier exactly as before.
      const preferredPromptTemplateId = this.configResolver
        ? await this.configResolver.resolvePreferredPromptTemplateId(consultation?.doctorId ?? null)
        : undefined;

      // TASK-356 Phase 6 (S3) — gate the DNA style on the effective decision
      // (tenant AND doctor). Drops to `undefined` (no DNA prompt) when the doctor
      // has opted out or the tenant flag is off. No-op (passes the requested id
      // through) when ConfigResolver is unwired (legacy fixtures).
      const effectiveDnaStyleId = await this.resolveEffectiveDnaStyleId(tenantId, consultation?.departmentId, consultation?.doctorId, dto.dnaStyleId);

      const assembled = await this.promptAssemblyService.assemble({
        departmentId: consultation?.departmentId ?? undefined,
        promptType: consultation?.parentConsultationId ? 'revisit' : 'new-patient',
        transcript,
        conversationLanguage: dto.conversationLanguage?.trim() || 'en',
        dnaStyleId: effectiveDnaStyleId,
        explicitTemplate: dto.template,
        preferredPromptTemplateId,
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
  async persistDraft(consultationId: string, dto: HarnessDraftRequest, idempotencyKey?: string): Promise<HarnessDraftResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    return this.withHarnessIdempotency('persistDraft', tenantId, idempotencyKey, () =>
      this.cls.run(async () => {
        this.cls.set('tenantId', tenantId);
        this.cls.set('user', createWorkerSession({ userId: dto.userId, tenantId, kind: 'harness-internal' }));

        const userId = dto.userId ?? 'system';
        // Phase D delivery discriminator. Default (absent) == legacy single-shot.
        const isEarly = dto.phase === HARNESS_DRAFT_PHASE.EARLY;
        const consultation = await this.consultationRepository.findById(consultationId);
        assertEqualTenants(consultation, { tenantId });

        // 1. RAW_SUMMARY context item for the generated note.
        const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, dto.content, dto.dnaStyleId, userId);
        // TASK-356 Phase 6 (S4) — pin the AI draft to v1 so the `ai_draft_v1`
        // snapshot below IS version 1 and the doctor's first edit becomes v2.
        contextItem.currentVersionNumber = 1;
        const savedContext = await this.contextItemRepository.create(contextItem);
        const contextItemId = savedContext?.id ?? contextItem.id;

        // TASK-356 Phase 6 (S4) — capture the immutable AI-draft `v1` snapshot at
        // this (harness/optimistic) generation boundary too, so the DNA
        // edit-capture corpus is populated regardless of which path generated the
        // draft. Best-effort: a snapshot failure must never roll back the draft.
        await this.captureAiDraftSnapshot(savedContext ?? contextItem);

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
        await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(summaryMeta, this.secretsService!));
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
      }),
    );
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
    idempotencyKey?: string,
  ): Promise<HarnessFinalizeAssuranceResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    if (!dto.contextItemId) {
      throw new BadRequestException('contextItemId is required');
    }

    return this.withHarnessIdempotency('finalizeAssurance', tenantId, idempotencyKey, () =>
      this.cls.run(async () => {
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
        // TASK-369 Phase 3C — the EARLY persist wrote these JSONB blobs as NULL
        // (verdict withheld); this finalize is where citationsMap/guardrailDecisions
        // actually get their values, so re-encrypt here (after the backfill, before
        // the update) to keep the ciphertext columns in sync with the plaintext.
        await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(meta, this.secretsService!));
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
            message: 'Harness assurance returned an adverse verdict AFTER an early sign — POST_SIGN_FLAG recorded for amendment/follow-up',
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
      }),
    );
  }

  /**
   * Record the clinician GATE_DECISION as an append-only WORM audit event. The
   * harness calls this after apps/api has already written the SIGNED_NOTE + ATTEST
   * (the system-of-record); this closes the loop's audit trail with the gate
   * outcome. Re-establishes CLS from the body `tenantId` like the other handlers.
   */
  async recordGateDecision(consultationId: string, dto: HarnessGateDecisionRequest, idempotencyKey?: string): Promise<HarnessGateDecisionResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    return this.withHarnessIdempotency('recordGateDecision', tenantId, idempotencyKey, () =>
      this.cls.run(async () => {
        this.cls.set('tenantId', tenantId);
        this.cls.set('user', createWorkerSession({ userId: dto.userId, tenantId, kind: 'harness-internal' }));

        // 404-over-403: assert consultation ownership before appending the WORM row
        // (mirrors recordEscalation / persistDraft) — a cross-tenant id must not write.
        const consultation = await this.consultationRepository.findById(consultationId);
        assertEqualTenants(consultation, { tenantId });

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
      }),
    );
  }

  /**
   * TASK-466 (C1-05) — record a harness gate SLA-breach escalation as an
   * append-only WORM audit event. The durable workflow's `escalate_gate` activity
   * POSTs this when an un-signed gate passes its SLA; the `reason` encodes
   * terminal-ness (`gate_sla_abandoned` = the terminal escalation before the gate
   * abandons, C1-02) and maps to GATE_ABANDONED, else GATE_ESCALATED. Re-establishes
   * CLS from the body `tenantId` (like the other handlers) and enforces the
   * 404-over-403 tenancy posture: a cross-tenant consultation surfaces as
   * NotFoundException, never leaking that it exists under another tenant.
   */
  async recordEscalation(consultationId: string, dto: HarnessEscalationRequest, idempotencyKey?: string): Promise<HarnessEscalationResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    // TASK-466 (C1-03) — the harness ships an Idempotency-Key on this POST too, so
    // a re-delivered escalate_gate (worker restart / SLA-timeout racing a
    // slow-but-successful POST) must not double-append the hash-chained WORM row.
    return this.withHarnessIdempotency('recordEscalation', tenantId, idempotencyKey, () =>
      this.cls.run(async () => {
        this.cls.set('tenantId', tenantId);
        // No clinician — an SLA timeout is a workflow-initiated event; the worker
        // session falls back to the `system-harness-internal` sentinel.
        this.cls.set('user', createWorkerSession({ tenantId, kind: 'harness-internal' }));

        // 404-over-403: the escalation targets a specific consultation, so assert
        // ownership before recording (a cross-tenant id must not write a WORM row).
        const consultation = await this.consultationRepository.findById(consultationId);
        assertEqualTenants(consultation, { tenantId });

        const action = dto.reason === 'gate_sla_abandoned' ? HarnessAuditAction.GATE_ABANDONED : HarnessAuditAction.GATE_ESCALATED;

        await this.harnessAuditService.append({
          tenantId,
          consultationId,
          action,
          modelName: 'harness-gate',
          modelVersion: 'v1',
          // WORM payload carries the escalation provenance only (no PHI): the raw
          // reason string + the correlating harness job id.
          sensorScores: { reason: dto.reason, jobId: dto.jobId ?? null },
          citations: [],
          createdBy: null,
        });

        this.logger.log({ message: 'Harness gate escalation recorded', consultationId, reason: dto.reason, action });
        return { recorded: true };
      }),
    );
  }

  /**
   * TASK-466 (C1-03) — build the Redis dedup key for a WORM/draft callback. The
   * `idempotencyKey` value is the harness `{run_id}:{activity_id}` (already
   * globally unique); we additionally namespace by operation + tenantId so two
   * tenants can never collide and each callback dedups independently.
   */
  private buildIdempotencyKey(operation: string, tenantId: string, idempotencyKey: string): string {
    return `${this.IDEMPOTENCY_KEY_PREFIX}${operation}:${tenantId}:${idempotencyKey}`;
  }

  /**
   * TASK-466 (C1-03) — dedup a WORM/draft callback on the harness `Idempotency-Key`.
   * The durable workflow re-invokes these callbacks on each Temporal activity
   * retry; without dedup every retry re-appends the WORM/draft rows. This
   * caches-and-replays the prior RESPONSE BODY (not a bare seen-marker — e.g.
   * persistDraft's response carries the contextItemId) so a retried callback is
   * exactly one effect. The key is recorded AFTER a successful write; Temporal
   * activity retries are sequential, so a get-then-setex is adequate (no lock).
   * Best-effort: no key, no Redis, or a Redis throw ⇒ fall through to normal
   * processing (mirrors the consultation-job dedup, TASK-299 D-10).
   */
  private async withHarnessIdempotency<T>(
    operation: string,
    tenantId: string,
    idempotencyKey: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!idempotencyKey || !this.redisCache) {
      return work();
    }

    const redisKey = this.buildIdempotencyKey(operation, tenantId, idempotencyKey);

    // 1. Replay a prior response if this key has already been processed.
    try {
      const cached = await this.redisCache.get(redisKey);
      if (cached) {
        this.logger.log({ message: 'Harness callback idempotency hit — replaying prior response', operation, idempotencyKey });
        return JSON.parse(cached) as T;
      }
    } catch (error) {
      this.logger.warn({
        message: 'Harness callback idempotency lookup failed — processing normally',
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 2. Process (the durable write happens here, exactly once per key).
    const result = await work();

    // 3. Record the key AFTER the successful write so a retry replays this result.
    try {
      await this.redisCache.setex(redisKey, this.IDEMPOTENCY_TTL, JSON.stringify(result));
    } catch (error) {
      this.logger.warn({
        message: 'Harness callback idempotency record failed — a retry may double-write',
        operation,
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return result;
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
   * TASK-356 Phase 6 (S3) — resolve the DNA style id to actually apply at the
   * harness generation boundary: the requested id when DNA is EFFECTIVE (tenant
   * AND doctor), else `undefined`. No-op pass-through when ConfigResolver is
   * unwired or no id was requested. `resolveEffectiveDnaStyleEnabled` fails closed
   * internally, so a degraded config read drops DNA rather than applying it.
   */
  private async resolveEffectiveDnaStyleId(
    tenantId: string,
    departmentId: string | null | undefined,
    doctorId: string | null | undefined,
    dnaStyleId?: string,
  ): Promise<string | undefined> {
    if (!dnaStyleId || !this.configResolver) return dnaStyleId;
    const { effective } = await this.configResolver.resolveEffectiveDnaStyleEnabled({
      tenantId,
      departmentId: departmentId ?? null,
      doctorId: doctorId ?? null,
    });
    return effective ? dnaStyleId : undefined;
  }

  /**
   * TASK-356 Phase 6 (S4) — write the immutable AI-draft `v1` snapshot for the
   * DNA edit-capture corpus. Reuses `ContextItemVersion` with
   * `changeReason='ai_draft_v1'` / `changeSource='ai_model'` (no schema change),
   * mirroring the sync `SummaryService` path so both generation boundaries snapshot.
   * No-op when the version repository is unwired (legacy fixtures); best-effort
   * otherwise — a snapshot failure is logged and swallowed so it never rolls back
   * the committed draft.
   */
  private async captureAiDraftSnapshot(savedContext: ContextItemEntity): Promise<void> {
    if (!this.contextItemVersionRepository) return;
    try {
      const snapshot = ContextItemVersionFactory.CreateFromContextItem(savedContext, 1, 'ai_draft_v1', 'system', 'ai_model', 'AI draft v1 snapshot');
      await this.encryptBestEffort('ContextItemVersion', () =>
        this.contextItemVersionRepository!.encryptFieldsIntoEntity(snapshot, this.secretsService!),
      );
      await this.contextItemVersionRepository.create(snapshot);
    } catch (error) {
      this.logger.warn({
        message: 'AI-draft v1 snapshot capture failed (best-effort, draft not rolled back)',
        contextItemId: savedContext.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      typeof safety === 'string' ? safety : ((safety as Record<string, unknown>).decision ?? (safety as Record<string, unknown>).verdict);
    return String(verdict).toUpperCase() === 'FLAG';
  }
}
