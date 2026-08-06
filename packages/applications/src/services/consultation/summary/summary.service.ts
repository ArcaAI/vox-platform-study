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
  CoreUnitOfWorkService,
  SummaryMetaRepository,
  NamedEntityRepository,
  UserProfileRepository,
  ContextItemFactory,
  ContextItemVersionFactory,
  ContextItemEntity,
  SummaryMetaFactory,
  NamedEntityFactory,
  ResourceType,
  SysEventType,
  ConsultationStatus,
  HarnessAuditAction,
  JsonValue,
  AgentSessionKind,
  AgentStepStatus,
  AgentStepType,
  TranscriptSegmentRepository,
  generateId,
} from '@arcaai/domains';
import { IAgentTrajectoryService } from '../../agent-trajectory/IAgentTrajectoryService';
import type { CreateAgentTrajectoryStepInput } from '../../agent-trajectory/dto';
import { HarnessAuditService } from '../../harness-audit';
import { ConfigResolver } from '../../config-resolver';
import { diffContent } from './content-diff.util';
import { ISummaryService } from './ISummaryService';
import {
  GenerateSummaryRequest,
  GeneratePreSummaryRequest,
  UpdateSummaryRequest,
  SummaryResponse,
  SummaryProvenanceResponse,
  CitedSegmentResponse,
} from './dto';
import { SummaryDtoMapper } from './summary.dto.mapper';
import { buildSmrGeneratePayload, mapSmrGenerateResponse, type LegacySmrSummaryResponse } from './smr-generate';
import { buildGuardrailUsageInput, buildLlmUsageInput, parseSmrUsageDetail, type SmrUsageDetail } from './smr-usage';
import { IUsageLedgerService } from '../../usageLedger/IUsageLedgerService';
import type { UsageOperation } from '../../usageLedger/vocabulary';
import { BaseService, assertParentInScope, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { HarnessGatewayService } from '../harness/harness-gateway.service';
import { HarnessPolicyService } from '../../harness-policy/harness-policy.service';
import type { PromptResolutionTier } from '../prompt/prompt-resolution.service';
import { namedEntityPropsFromNlp, type NlpNamedEntity } from '../shared/namedEntityFromNlp';
import { resolveNerModelInjection } from '../shared/resolveNerModelSelection';
import { buildNerUsageEvent } from '../shared/nerUsageEvent';
import { collectCitedSegmentIds } from '../lib/transcript-segments';
import { generateJsonWithRepair, looksLikeJsonObject, parsesAsJsonObject, type JsonRepairCall } from '../shared/bounded-json-repair';
import { IAiTaskDefaultService } from '../../ai-task-default/IAiTaskDefaultService';

/**
 * the AD-1 GenerationStats headline fields the summary
 * paths persist onto `SummaryMeta`. A narrow view of the SMR `/generate`
 * `stats` block: only the three headline fields are read here (predicted/total
 * token counts are derivable from the existing `inputTokens`/`outputTokens`).
 * All optional — never fabricated; a field the engine omitted stays null.
 */
interface SmrGenerationStats {
  stop_reason?: string | null;
  ttft_ms?: number | null;
  tokens_per_second?: number | null;
}

/**
 * One SMR `/generate` call inside the bounded auto-repair loop.
 * Carries the mapped response alongside the raw `text` the repair helper parses,
 * so the caller can attribute cost across the (at most two) calls.
 */
interface SmrRepairCall extends JsonRepairCall {
  mapped: LegacySmrSummaryResponse;
  stats: SmrGenerationStats | null;
  /** SMR's billing passthrough for this call — one per attempt, all metered. */
  usage: SmrUsageDetail | null;
  /** The guardrail call this generation triggered, forwarded by SMR. */
  guardrailUsage: SmrUsageDetail | null;
}

/** Everything an emission needs that is NOT already on the usage block. */
interface SummaryUsageAttribution {
  tenantId: string;
  consultationId: string;
  doctorId?: string | null;
  departmentId?: string | null;
}

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
    // (Tier-0 prompt resolution): load the consulting doctor's
    // `UserProfile.preferredPromptTemplateId`. Optional + trailing so existing
    // positional test fixtures keep compiling; production DI (CoreDatabaseModule)
    // always supplies it.
    @Optional() @Inject(UserProfileRepository) private readonly userProfileRepository?: UserProfileRepository,
    // (attestation gate): append the ATTEST event to the Phase-0
    // WORM audit trail on approval. Optional + trailing so existing positional test
    // fixtures keep compiling; production DI (ConsultationServiceModule) always
    // supplies it, making the gate fail-closed (audit failure aborts the approval).
    @Optional() @Inject(HarnessAuditService) private readonly harnessAuditService?: HarnessAuditService,
    // (Lane G): forward the clinician sign-off to the durable
    // harness workflow (best-effort). Optional + trailing so existing positional
    // test fixtures keep compiling; production DI (SummaryServiceModule) supplies it.
    @Optional() @Inject(HarnessGatewayService) private readonly harnessGatewayService?: HarnessGatewayService,
    // Resolve the admin-managed SMR {provider, model} on every
    // SMR call (the gateway has no model default). Optional + trailing so
    // existing positional test fixtures keep compiling; production DI
    // (SummaryServiceModule) always supplies it, keeping the path fail-closed.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // Resolve the effective DNA-style decision
    // (tenant AND doctor) so DNA style is applied at generation only when the
    // doctor is opted in under an enabling tenant. Optional + trailing so
    // existing positional test fixtures keep compiling; production DI
    // (SummaryServiceModule) always supplies it. When unset, DNA gating is a
    // no-op and behaviour is byte-identical to the pre-Phase-6 path.
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // Optional (append-only DI); enforces the plan
    // `monthlySummaries` meter on generation (kill-switch-gated, → 429 over cap).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // §2C — one LLM_CALL trajectory step per generate/pre-summary.
    // Optional + trailing so existing positional test fixtures compile;
    // production DI (SummaryServiceModule) supplies it. Fire-and-forget: a
    // trajectory failure never rolls back the (delivered) summary.
    @Optional() @Inject(IAgentTrajectoryService) private readonly trajectoryService?: IAgentTrajectoryService,
    // Resolves the effective `nlp.ner` AiTaskDefault model for injection into
    // the synchronous extractEntities NLP call (TASK-552 Lane A). Optional +
    // trailing so existing positional test fixtures keep compiling; absent ⇒
    // posts without `model_name`, i.e. today's behavior (fail-open).
    @Optional() @Inject(IAiTaskDefaultService) private readonly aiTaskDefaultService?: IAiTaskDefaultService,
    // Resolves the cited-segment evidence rows for getSummaryProvenance
    // (TASK-552 Lane C). Optional + trailing so existing positional test
    // fixtures keep compiling; absent ⇒ citedSegments: [] (best-effort).
    @Optional() @Inject(TranscriptSegmentRepository) private readonly transcriptSegmentRepository?: TranscriptSegmentRepository,
    // Shared by two lanes: WS-D (generatePreSummary/generateSummary) records
    // the LLM + guardrail token rows a generation produced; WS-E
    // (extractEntities) records the ner.extract usage row the synchronous
    // NER path produced. Optional + trailing so existing positional test
    // fixtures keep compiling; absent ⇒ the corresponding path is simply
    // not metered (never fails — metering is additive, not a precondition).
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedger?: IUsageLedgerService,
    // (TASK-615 WS-D) Lets the SummaryMeta write and the usage emission share
    // one transaction, so neither can survive without the other.
    // This is the DOMAINS `CoreUnitOfWorkService` (provided + exported by
    // `CoreDatabaseModule`, so `@Optional()` actually resolves it), NOT the
    // identically-named, unwired class under `services/baseServices` — which
    // resolved to `undefined` and silently disabled this metering entirely.
    // The token stays EXPLICIT (rather than relying on `emitDecoratorMetadata`,
    // as `SttInternalService` does) so the DI guard test can assert it.
    @Optional() @Inject(CoreUnitOfWorkService) private readonly unitOfWork?: CoreUnitOfWorkService,
  ) {
    super(eventEmitter, clsService, ResourceType.ContextItem);
    this.smrServiceUrl = this.configService.get<string>('SMR_URL') ?? 'http://localhost:8862';
    this.nlpServiceUrl = this.configService.get<string>('NLP_URL') ?? 'http://localhost:8864';
  }

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
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

    // A generated summary consumes a monthly meter unit.
    // Kill-switch-gated (Q9); → 429 once the tenant is over the monthly cap.
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlySummaries');

    // (audit C-1 / C-3) — verify the parent Consultation
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

    // Encrypt the generated pre-summary text into
    // `encryptedContent` before persistence — the plaintext `content` column was
    // dropped by the PHI field-encryption migration, so an unencrypted create
    // silently loses the clinical text at rest (mirrors context.service.ts
    // `encryptContent`).
    await this.encryptBestEffort('ContextItem content', () => this.contextItemRepository.encryptContentIntoEntity(contextItem, this.secretsService!));

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
    // persist the AD-1 GenerationStats headline fields when
    // SMR returned them. Set via the entity setters (change-tracked, same path
    // as `contextItem.currentVersionNumber = 1` above); the factory does not yet
    // expose these props. Null/absent stats (legacy idempotency-cache hit) leaves
    // the columns null — never fabricated.
    if (smrResponse.stats) {
      summaryMeta.stopReason = smrResponse.stats.stop_reason ?? null;
      summaryMeta.ttftMs = smrResponse.stats.ttft_ms ?? null;
      summaryMeta.tokensPerSecond = smrResponse.stats.tokens_per_second ?? null;
    }
    await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(summaryMeta, this.secretsService!));
    await this.persistSummaryMetaWithUsage(summaryMeta, smrResponse, 'presummarize', {
      tenantId,
      consultationId,
      doctorId: consultation.doctorId,
      departmentId: consultation.departmentId,
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedContext.id,
      responsibleEntityId: userId ?? undefined,
      createdAt: savedContext.createdAt,
      data: { consultationId, type: 'pre_summary' },
    });

    // §2C — one SUMMARY_JOB LLM_CALL step for this generation (non-fatal).
    await this.recordSummaryTrajectory({
      tenantId,
      consultationId,
      summaryId: savedContext.id,
      name: 'pre-summary',
      stats: smrResponse.stats,
      durationMs: smrResponse.processingTimeMs,
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

    // A generated summary consumes a monthly meter unit.
    // Kill-switch-gated (Q9); → 429 once the tenant is over the monthly cap.
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlySummaries');

    // (audit C-1 / C-3) — verify the parent Consultation
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
    // Gate the DNA style on the effective decision
    // (tenant AND doctor). Drops to `undefined` (no DNA prompt) when the doctor
    // has opted out or the tenant flag is off. No-op (passes the requested id
    // through) when ConfigResolver is not wired into this instance.
    const effectiveDnaStyleId = await this.resolveEffectiveDnaStyleId(tenantId, consultation.departmentId, consultation.doctorId, request.dnaStyleId);
    const assembledPrompt = await this.promptAssemblyService.assemble({
      departmentId: consultation.departmentId ?? undefined,
      promptType: consultation.parentConsultationId ? 'revisit' : 'new-patient',
      transcript: content,
      conversationLanguage: this.resolveConversationLanguage(request.options),
      dnaStyleId: effectiveDnaStyleId,
      preSummaryText: latestPreSummary?.content ?? undefined,
      explicitTemplate: request.template,
      preferredPromptTemplateId: await this.resolvePreferredPromptTemplateId(consultation.doctorId),
    });

    // Call SMR service
    const smrResponse = await this.callSmrService({
      assembledPrompt,
      options: request.options,
      context: {
        dnaStyleId: effectiveDnaStyleId,
        template: request.template,
        includeNER: request.includeNER,
        summaryType: 'summary',
        promptResolvedFrom: assembledPrompt.resolvedFrom,
        promptHyperparameters: assembledPrompt.hyperparameters,
      },
    });

    // Create summary context item
    const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, smrResponse.summary, effectiveDnaStyleId, userId ?? 'system');
    // Pin the AI draft to v1 so the immutable
    // `ai_draft_v1` snapshot below IS version 1 and the doctor's first edit
    // becomes v2 (no `@@unique([contextItemId, versionNumber])` collision).
    contextItem.currentVersionNumber = 1;

    // Encrypt the generated summary text into `encryptedContent`
    // before persistence — the plaintext `content` column was dropped by the
    // PHI field-encryption migration, so an unencrypted create silently loses
    // the clinical text at rest (mirrors context.service.ts `encryptContent`).
    await this.encryptBestEffort('ContextItem content', () => this.contextItemRepository.encryptContentIntoEntity(contextItem, this.secretsService!));

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
    // persist the AD-1 GenerationStats headline fields when
    // SMR returned them. Set via the entity setters (change-tracked, same path
    // as `contextItem.currentVersionNumber = 1` above); the factory does not yet
    // expose these props. Null/absent stats (legacy idempotency-cache hit) leaves
    // the columns null — never fabricated.
    if (smrResponse.stats) {
      summaryMeta.stopReason = smrResponse.stats.stop_reason ?? null;
      summaryMeta.ttftMs = smrResponse.stats.ttft_ms ?? null;
      summaryMeta.tokensPerSecond = smrResponse.stats.tokens_per_second ?? null;
    }
    await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(summaryMeta, this.secretsService!));
    await this.persistSummaryMetaWithUsage(summaryMeta, smrResponse, 'generate', {
      tenantId,
      consultationId,
      doctorId: consultation.doctorId,
      departmentId: consultation.departmentId,
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedContext.id,
      responsibleEntityId: userId ?? undefined,
      createdAt: savedContext.createdAt,
      data: { consultationId, type: 'summary' },
    });

    // Capture the immutable AI-draft `v1` snapshot for
    // the DNA edit-capture corpus (draft↔approved learning). Runs
    // AFTER the draft + meta are committed and is best-effort: a snapshot
    // failure must never roll back the (delivered) draft.
    await this.captureAiDraftSnapshot(savedContext);

    // §2C — one SUMMARY_JOB LLM_CALL step for this generation (non-fatal).
    await this.recordSummaryTrajectory({
      tenantId,
      consultationId,
      summaryId: savedContext.id,
      name: 'generate',
      stats: smrResponse.stats,
      durationMs: smrResponse.processingTimeMs,
    });

    return SummaryDtoMapper.toResponse(savedContext);
  }

  /**
   * Persist a `SummaryMeta` and, in the SAME transaction, record the tokens the
   * generation consumed (TASK-615 WS-D).
   *
   * The transaction is the point. A `SummaryMeta` that rolls back must not
   * leave a billed event behind, and one that commits must not lose its usage
   * to a crash a millisecond later — passing `tx` guards both directions at
   * once, which is why the contract prefers it over a follow-up write.
   *
   * TWO deliberate degradations:
   *   - No ledger / no unit-of-work wired (legacy positional test fixtures) ⇒
   *     plain create, unmetered. Metering is additive; it must not become a
   *     precondition for saving a clinical note.
   *   - A metering failure is swallowed. The model already ran and the clinician
   *     is waiting for the draft: "not metered" is recoverable from the provider's
   *     own usage API, a 500 on a delivered summary is not.
   */
  private async persistSummaryMetaWithUsage(
    summaryMeta: Parameters<SummaryMetaRepository['create']>[0],
    smrResponse: { usage: SmrUsageDetail | null; guardrailUsage: SmrUsageDetail | null },
    operation: UsageOperation,
    attribution: SummaryUsageAttribution,
  ): Promise<void> {
    const llmInput = smrResponse.usage
      ? buildLlmUsageInput({
          usage: smrResponse.usage,
          tenantId: attribution.tenantId,
          operation,
          consultationId: attribution.consultationId,
          doctorId: attribution.doctorId,
          departmentId: attribution.departmentId,
        })
      : null;
    const guardrailInput = smrResponse.guardrailUsage
      ? buildGuardrailUsageInput({
          usage: smrResponse.guardrailUsage,
          tenantId: attribution.tenantId,
          consultationId: attribution.consultationId,
          doctorId: attribution.doctorId,
          departmentId: attribution.departmentId,
          fallbackRequestId: smrResponse.usage?.taskId ?? null,
        })
      : null;

    const inputs = [llmInput, guardrailInput].filter((input): input is NonNullable<typeof input> => input !== null);

    if (!this.usageLedger || !this.unitOfWork || inputs.length === 0) {
      await this.summaryMetaRepository.create(summaryMeta);
      return;
    }

    try {
      await this.unitOfWork.runInTransaction(async (tx) => {
        await this.summaryMetaRepository.create(summaryMeta, tx);
        for (const input of inputs) {
          await this.usageLedger!.recordUsage(input, tx);
        }
      });
    } catch (error) {
      this.logger.warn({
        message: 'Usage metering failed for a generated summary; persisting the summary metadata unmetered',
        consultationId: attribution.consultationId,
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
      // The transaction rolled back, so the SummaryMeta was never written.
      // Re-create it on its own — losing the metadata over a metering problem
      // would be strictly worse than losing the meter.
      await this.summaryMetaRepository.create(summaryMeta);
    }
  }

  /**
   * §2C — emit ONE LLM_CALL trajectory step for a summary generation.
   * sessionKind=SUMMARY_JOB, sessionId=the generated summary's contextItem id
   * (stable job id), runId="" (non-Temporal sentinel), seq=0 (one step per job).
   * Fire-and-forget: any failure is swallowed + logged so telemetry never rolls
   * back the delivered summary. No-op when the emitter is not wired.
   */
  private async recordSummaryTrajectory(params: {
    tenantId: string;
    consultationId: string;
    summaryId: string;
    name: 'generate' | 'pre-summary';
    stats: SmrGenerationStats | null;
    durationMs?: number | null;
  }): Promise<void> {
    if (!this.trajectoryService) return;
    try {
      const now = Date.now();
      const durationMs = params.durationMs ?? undefined;
      const step: CreateAgentTrajectoryStepInput = {
        tenantId: params.tenantId,
        consultationId: params.consultationId,
        sessionKind: AgentSessionKind.SUMMARY_JOB,
        sessionId: params.summaryId,
        runId: '',
        seq: 0,
        stepType: AgentStepType.LLM_CALL,
        name: params.name,
        status: AgentStepStatus.OK,
        startedAt: new Date(durationMs ? now - durationMs : now),
        endedAt: new Date(now),
        durationMs,
        stats: (params.stats ?? undefined) as CreateAgentTrajectoryStepInput['stats'],
      };
      await this.trajectoryService.recordSteps([step]);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to record summary trajectory (non-fatal)',
        consultationId: params.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update existing summary content
   */
  async updateSummary(contextItemId: string, request: UpdateSummaryRequest): Promise<SummaryResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // (audit C-3) — assert the target summary lives in
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

    // Stamp the edit delta (previous draft → this edit)
    // onto the existing version columns for the DNA edit-capture corpus.
    // `CreateFromContextItem` snapshots the PREVIOUS content
    // (request.content is applied below), so diff(previous, new). A metadata-only
    // edit (no `content`) leaves both columns null. This runs BEFORE the
    // `signalEdit` hook below — order preserved.
    const editDelta = request.content !== undefined ? diffContent(contextItem.content, request.content) : { contentDiff: null, fieldChanges: null };
    version.contentDiff = editDelta.contentDiff;
    version.fieldChanges = editDelta.fieldChanges as unknown as JsonValue | null;

    await this.encryptBestEffort('ContextItemVersion', () =>
      this.contextItemVersionRepository.encryptFieldsIntoEntity(version, this.secretsService!),
    );
    const savedVersion = await this.contextItemVersionRepository.create(version);

    contextItem.currentVersionNumber = versionNumber;

    if (request.content !== undefined) {
      contextItem.content = request.content;
    }

    if (this.requestUserId) {
      contextItem.updatedBy = this.requestUserId;
    }

    // Encrypt the edited content into `encryptedContent` before
    // persistence — the plaintext `content` column was dropped by the PHI
    // field-encryption migration, and a bare property assignment (above) is
    // invisible to the change-tracked persistence mapper (no such column), so
    // skipping this call silently drops the clinician's edit at rest (mirrors
    // context.service.ts `encryptContent`).
    await this.encryptBestEffort('ContextItem content', () => this.contextItemRepository.encryptContentIntoEntity(contextItem, this.secretsService!));

    const updated = await this.contextItemRepository.update(contextItemId, contextItem);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: contextItem.changes,
      previousData: previousData as object,
    });

    // If this edit lands while the draft is still
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
   * Approve and lock a summary (attestation gate /
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
   * RELAXED sign-off governance (clinician autonomy + full
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

    // (audit C-3) — assert the target summary belongs to
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

    // RELAXED sign-off assurance guard (defense-in-depth; the
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

    // Stamp the cumulative AI-draft → approved delta on
    // the signed note so the final divergence is captured even when the doctor
    // signs without an intermediate edit. Baseline = the immutable
    // `ai_draft_v1` snapshot; skipped for legacy drafts that predate the
    // snapshot mechanism (no v1 snapshot) so their signed note keeps the null
    // delta columns. This is append-only and never blocks the sign-off below.
    const draftBaseline = await this.resolveAiDraftBaseline(contextItemId);
    if (draftBaseline !== null) {
      const signDelta = diffContent(draftBaseline, contextItem.content);
      version.contentDiff = signDelta.contentDiff;
      version.fieldChanges = signDelta.fieldChanges as unknown as JsonValue | null;
    }

    await this.encryptBestEffort('ContextItemVersion', () =>
      this.contextItemVersionRepository.encryptFieldsIntoEntity(version, this.secretsService!),
    );
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

    // Defense-in-depth: re-encrypt `content` into
    // `encryptedContent` on this final update too — this lane doesn't itself
    // reassign `content`, but keeping every ContextItem persist on this write
    // path running the same cipher call closes off the whole class of "some
    // future edit here forgets to encrypt" regressions (mirrors the other
    // ContextItem write lanes in this service).
    await this.encryptBestEffort('ContextItem content', () => this.contextItemRepository.encryptContentIntoEntity(contextItem, this.secretsService!));

    await this.contextItemRepository.update(contextItemId, contextItem);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: contextItemId,
      responsibleEntityId: approvedBy,
      data: { approvalStatus: 'APPROVED', consultationStatus: ConsultationStatus.SIGNED, attested: true },
    });

    // 4. Best-effort: forward the sign-off to the
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
   * Deterministic SHA-256 attestation hash binding the
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
   * Sign-off safety stop (I4). Reads the inferential safety
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
      typeof safety === 'string' ? safety : ((safety as Record<string, unknown>).decision ?? (safety as Record<string, unknown>).verdict);
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
   * Read-only harness provenance for a generated summary.
   * Returns the `SummaryMeta` citationsMap + sensor scores + modelName that the
   * harness wrote, plus the cited transcript segments (TASK-552 Lane C) so a
   * console evidence panel can render/scroll to the source without a second
   * controller. Tenant isolation is enforced by the repository's tenant-scoped
   * client (the controller has already verified read access to the consultation).
   */
  async getSummaryProvenance(contextItemId: string): Promise<SummaryProvenanceResponse> {
    const meta = await this.summaryMetaRepository.findByContextItem(contextItemId);
    if (!meta) {
      throw new NotFoundException(`No provenance found for summary ${contextItemId}`);
    }
    const citedSegments = await this.resolveCitedSegments(contextItemId, meta.citationsMap as Record<string, unknown> | null | undefined);
    return SummaryDtoMapper.toProvenanceResponse(meta, citedSegments);
  }

  /**
   * TASK-552 Lane C — resolve the transcript segments cited as evidence for a
   * summary's citationsMap, so the console evidence panel can render (speaker,
   * t0–t1) and slice a snippet without a second controller. Best-effort +
   * non-destructive, mirroring `enrichCitationsWithSegments`
   * (harness-internal.service.ts): degrades to `[]` — never throws, never
   * blocks the provenance read — when nothing was cited, the repository isn't
   * wired, the summary's own ContextItem can't be loaded, or the consultation
   * has no SINGLE resolvable transcript (offsets are per-transcript, so an
   * unambiguous transcript is required to resolve segment ids by id lookup).
   */
  private async resolveCitedSegments(
    summaryContextItemId: string,
    citationsMap: Record<string, unknown> | null | undefined,
  ): Promise<CitedSegmentResponse[]> {
    const citedIds = collectCitedSegmentIds(citationsMap);
    if (citedIds.length === 0 || !this.transcriptSegmentRepository) return [];
    try {
      const summaryContextItem = await this.contextItemRepository.findById(summaryContextItemId);
      if (!summaryContextItem) return [];
      const transcripts = await this.contextItemRepository.findTranscripts(summaryContextItem.consultationId);
      if (transcripts.length !== 1) return [];
      const segments = await this.transcriptSegmentRepository.findByContextItem(summaryContextItem.tenantId, transcripts[0].id);
      const citedSet = new Set(citedIds);
      return segments
        .filter((segment) => citedSet.has(segment.id))
        .map((segment) => ({
          id: segment.id,
          idx: segment.idx,
          t0Ms: segment.t0Ms ?? null,
          t1Ms: segment.t1Ms ?? null,
          speaker: segment.speaker ?? null,
          charStart: segment.charStart ?? null,
          charEnd: segment.charEnd ?? null,
        }));
    } catch (error) {
      this.logger.warn({
        message: 'citedSegments resolution skipped (best-effort)',
        contextItemId: summaryContextItemId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
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

    // (audit C-3) — assert the target context item belongs
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
        const namedEntity = NamedEntityFactory.CreateNamedEntity(namedEntityPropsFromNlp(entity as NlpNamedEntity, { tenantId, contextItemId }));

        await this.encryptBestEffort('NamedEntity', () => this.namedEntityRepository.encryptFieldsIntoEntity(namedEntity, this.secretsService!));
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

    // TASK-615 WS-E (revised): per-invocation ner.extract usage row — keyed
    // on a freshly generated requestId for THIS synchronous call (this path
    // has no natural durable job id the way NerProcessor does), never on
    // consultationId (attribution only — shares buildNerUsageEvent with the
    // async NerProcessor path so the shape can't drift). No business
    // transaction to join — entity persistence above isn't wrapped in one —
    // so recordUsage runs without `tx`. Never let a metering failure fail
    // the request; it's a side effect of work already done.
    if (this.usageLedger) {
      try {
        await this.usageLedger.recordUsage(
          buildNerUsageEvent({
            tenantId,
            requestId: generateId(),
            consultationId: contextItem.consultationId,
            charCount: [...contextItem.content].length,
            model: nerResponse.modelUsed,
          }),
        );
      } catch (error) {
        this.logger.warn({
          message: 'NER usage emission failed',
          contextItemId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

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
   * (audit C-3) — validate every ContextItem id in the given
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
  }): Promise<LegacySmrSummaryResponse & { stats: SmrGenerationStats | null; usage: SmrUsageDetail | null; guardrailUsage: SmrUsageDetail | null }> {
    try {
      // SMR is a stateless gateway with no model default; resolve
      // the tenant's effective {provider, model} and merge it in as the base so a
      // caller-supplied model still wins (resolved values fill only when omitted).
      let options = payload.options;
      if (this.harnessPolicyService) {
        const { provider, model } = await this.harnessPolicyService.resolveSmrSelection();
        options = { smrProvider: provider, smrModel: model, ...payload.options };
      }
      const smrPayload = buildSmrGeneratePayload(payload.assembledPrompt, options, payload.context);
      const smrServiceToken = (await this.secretsService?.getSecretOptional('SMR_SERVICE_TOKEN')) ?? '';

      // The finalize path now carries the SAME bounded corrective
      // retry as the live-doc flush. Before this, a structured request
      // that came back as malformed JSON was persisted VERBATIM as the clinical note
      // — on the HIGHER-stakes path, since this output is what the clinician signs.
      // The corrective instruction is APPENDED so the prefix-cache-stable lead-in
      // stays byte-identical between the original and the repair call.
      const basePrompt = smrPayload.prompt;
      const structuredRequested = smrPayload.response_format !== undefined;

      const outcome = await generateJsonWithRepair<string, SmrRepairCall>({
        generate: async (corrective) => {
          const response = await this.httpService.axiosRef.post(
            `${this.smrServiceUrl}/api/v1/generate`,
            { ...smrPayload, prompt: corrective ? `${basePrompt}${corrective}` : basePrompt },
            {
              headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': smrServiceToken,
              },
            },
          );
          const mapped = mapSmrGenerateResponse(response.data);
          const data = response.data as { usage_detail?: unknown; guardrail_usage?: unknown } | null;
          return {
            text: mapped.summary,
            mapped,
            stats: SummaryService.parseGenerationStats(response.data),
            usage: parseSmrUsageDetail(data?.usage_detail),
            guardrailUsage: parseSmrUsageDetail(data?.guardrail_usage),
          };
        },
        // The summary is opaque JSON we persist verbatim, so the strict parse only
        // decides WHETHER the structured contract was honoured — the text passes
        // through unchanged. Storage semantics stay byte-identical to the
        // pre-repair behaviour in every case except the malformed-JSON one.
        parseStrict: (text) => (parsesAsJsonObject(text) ? text : null),
        parseTolerant: (text) => text,
        // Retry only a genuine malformed-JSON attempt: structured output was
        // requested AND the text opens a JSON object. Prose (no leading `{`) is
        // the contract on an unstructured request — retrying could never help.
        shouldRepair: (first) => structuredRequested && looksLikeJsonObject(first.text),
      });

      const finalCall = outcome.calls[outcome.calls.length - 1];
      if (outcome.repaired) {
        this.logger.warn({
          message: 'SMR finalize response failed the structured-output contract; one corrective retry applied',
          repairSucceeded: parsesAsJsonObject(outcome.value),
        });
      }
      // Cost fields are additive across the (at most two) calls — the repair really
      // did spend those tokens/that time. Everything else describes the call whose
      // text became the stored note.
      const sumAcrossCalls = (pick: (call: SmrRepairCall) => number | undefined): number | undefined => {
        const values = outcome.calls.map(pick).filter((v): v is number => typeof v === 'number');
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) : undefined;
      };
      return {
        ...finalCall.mapped,
        summary: outcome.value,
        inputTokens: sumAcrossCalls((c) => c.mapped.inputTokens),
        outputTokens: sumAcrossCalls((c) => c.mapped.outputTokens),
        processingTimeMs: sumAcrossCalls((c) => c.mapped.processingTimeMs),
        stats: finalCall.stats,
        // The usage blocks describe the call whose text became the stored note.
        // A repair attempt is a SEPARATE SMR request with its own task id, so it
        // bills as its own ledger event rather than being folded in here — the
        // per-unit sums above would silently merge two idempotency identities.
        usage: finalCall.usage,
        guardrailUsage: finalCall.guardrailUsage,
      };
    } catch (error) {
      throw new BadRequestException(`Failed to call SMR service: ${error}`);
    }
  }

  /**
   * read the AD-1 GenerationStats headline fields off the
   * SMR `/generate` response. Returns `null` when the `stats` block is absent
   * (legacy response) or null (idempotency-cache hit) so the caller persists
   * nothing extra. Null-safe per field — never throws over missing/odd stats.
   */
  private static parseGenerationStats(data: unknown): SmrGenerationStats | null {
    const raw = (data as { stats?: unknown } | null | undefined)?.stats;
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const stats = raw as Record<string, unknown>;
    return {
      stop_reason: typeof stats.stop_reason === 'string' ? stats.stop_reason : null,
      ttft_ms: typeof stats.ttft_ms === 'number' && Number.isFinite(stats.ttft_ms) ? stats.ttft_ms : null,
      tokens_per_second: typeof stats.tokens_per_second === 'number' && Number.isFinite(stats.tokens_per_second) ? stats.tokens_per_second : null,
    };
  }

  private resolveConversationLanguage(options?: Record<string, unknown>): string {
    const candidate = options?.conversationLanguage ?? options?.language ?? options?.locale;

    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : 'en';
  }

  /**
   * (Tier-0): resolve the consulting doctor's preferred prompt template id
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

  /**
   * Resolve the DNA style id to actually apply at
   * generation: the requested id when DNA is EFFECTIVE (tenant AND doctor), else
   * `undefined` (no DNA prompt). When ConfigResolver is not wired (legacy
   * fixtures) or no id was requested this is a pass-through no-op, so behaviour
   * is byte-identical to the pre-Phase-6 path. `resolveEffectiveDnaStyleEnabled`
   * fails closed internally, so a degraded config read drops DNA rather than
   * applying it.
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
   * Write the immutable AI-draft `v1` snapshot for the
   * DNA edit-capture corpus. Reuses `ContextItemVersion` with
   * `changeReason='ai_draft_v1'` / `changeSource='ai_model'` (no schema change).
   * Best-effort: a snapshot failure is logged and swallowed so it never rolls
   * back the already-committed draft (mirrors the Slice-5c `signalEdit`
   * discipline). Idempotency is guarded by `@@unique([contextItemId, versionNumber])`.
   */
  private async captureAiDraftSnapshot(savedContext: ContextItemEntity): Promise<void> {
    try {
      const snapshot = ContextItemVersionFactory.CreateFromContextItem(savedContext, 1, 'ai_draft_v1', 'system', 'ai_model', 'AI draft v1 snapshot');
      await this.encryptBestEffort('ContextItemVersion', () =>
        this.contextItemVersionRepository.encryptFieldsIntoEntity(snapshot, this.secretsService!),
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
   * Read the AI-draft `v1` snapshot content as the
   * baseline for the draft→approved delta on sign. Returns null (skip delta)
   * when no snapshot exists (legacy pre-Phase-6 drafts) or on a lookup failure,
   * so signing is never blocked by edit-capture.
   */
  private async resolveAiDraftBaseline(contextItemId: string): Promise<string | null> {
    try {
      const drafts = await this.contextItemVersionRepository.getVersionsByChangeReason(contextItemId, 'ai_draft_v1');
      return drafts[0]?.content ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'AI-draft baseline lookup failed (best-effort, sign-off not blocked)',
        contextItemId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async callNlpService(text: string): Promise<{
    entities: Record<string, unknown>[];
    /**
     * The resolved `model_name` actually sent to NLP, or `null` when
     * resolution fail-opened (NLP's own env default applied, which this
     * caller has no visibility into — TASK-615 WS-E never guesses it).
     */
    modelUsed: string | null;
  }> {
    try {
      // TASK-552 Lane A: inject the effective `nlp.ner` AiTaskDefault model
      // (mirrors AiInferenceController's playground mapping) so a global
      // admin's re-point governs this synchronous clinical NER path too, not
      // just the playground. Fail-open: {} on any resolution hiccup.
      const modelSelection = await resolveNerModelInjection(this.aiTaskDefaultService, this.clsService, this.logger);
      const response = await this.httpService.axiosRef.post(`${this.nlpServiceUrl}/api/v1/classify/tokens`, { text, ...modelSelection });
      return { ...response.data, modelUsed: modelSelection.model_name ?? null };
    } catch (error) {
      throw new BadRequestException(`Failed to call NLP service: ${error}`);
    }
  }
}
