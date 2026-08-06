import { Inject, Injectable, Logger, NotFoundException, Optional, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ContextItemRepository,
  ConsultationRepository,
  CoreUnitOfWorkService,
  SummaryMetaRepository,
  NamedEntityRepository,
  ContextItemFactory,
  SummaryMetaFactory,
  ResourceType,
  SysEventType,
  ConsultationEntity,
} from '@arcaai/domains';
import { ComprehensiveSummaryRequest, ComprehensiveSummaryResponse, ChainSectionDto } from './dto';
import { buildSmrGeneratePayload, mapSmrGenerateResponse } from './smr-generate';
import { buildLlmUsageInput, parseSmrUsageDetail, type SmrUsageDetail } from './smr-usage';
import { IUsageLedgerService } from '../../usageLedger/IUsageLedgerService';
import { BaseService, assertParentInScope, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { HarnessPolicyService } from '../../harness-policy/harness-policy.service';
import { ConfigResolver } from '../../config-resolver';
import type { PromptResolutionTier } from '../prompt/prompt-resolution.service';

/**
 * ChainSummaryService — generates comprehensive cross-chain summaries.
 *
 * This service implements Step 13 of the consultation workflow: Doctor A
 * requests a final comprehensive summary that aggregates content from
 * all consultations in the chain (parent-child linked + same-day same-patient).
 *
 * Aggregation strategy:
 * 1. Resolve all linked consultation IDs (combined chain + date strategy)
 * 2. For each consultation, gather transcripts, summaries, case notes
 * 3. Optionally gather NER entities from all consultations
 * 4. Compose structured sections for the SMR service
 * 5. Call SMR for comprehensive summary generation
 * 6. Store result as ContextItem(RAW_SUMMARY) on the requesting consultation
 */
@Injectable()
export class ChainSummaryService extends BaseService {
  private readonly logger = new Logger(ChainSummaryService.name);
  private readonly smrServiceUrl: string;

  constructor(
    private readonly contextItemRepository: ContextItemRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly summaryMetaRepository: SummaryMetaRepository,
    private readonly namedEntityRepository: NamedEntityRepository,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly promptAssemblyService: PromptAssemblyService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Resolve the admin-managed SMR {provider, model} on every
    // SMR call (the gateway has no model default). Optional + trailing so
    // existing positional test fixtures keep compiling; production DI always
    // supplies it (ChainSummaryServiceModule).
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // Resolve the requesting doctor's preferred prompt template id
    // (UserProfile.preferredPromptTemplateId) so the sync chain-summary path
    // honors Tier-0 prompt selection. Optional + trailing so existing positional
    // test fixtures keep compiling; production DI supplies it (ChainSummaryServiceModule).
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // (TASK-615 WS-D) A chain summary spans several consultations and is one
    // of the most expensive generations the platform runs — leaving it
    // unmetered would understate cost exactly where it is highest. Optional +
    // trailing so existing positional test fixtures keep compiling.
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedger?: IUsageLedgerService,
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
   * Generate a comprehensive summary spanning all linked consultations.
   *
   * This is the synchronous endpoint — blocks until SMR returns.
   * For long consultation chains, prefer the async job endpoint.
   */
  async generateComprehensiveSummary(consultationId: string, request: ComprehensiveSummaryRequest): Promise<ComprehensiveSummaryResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // (audit C-1 / C-3 / C-4) — verify the requesting
    // Consultation belongs to the caller's tenant. `assertParentInScope`
    // throws `NotFoundException` for both missing and cross-tenant so
    // the response never leaks the existence of a foreign-tenant id.
    const consultation = await assertParentInScope(this.consultationRepository, consultationId, tenantId);

    // Resolve the requesting doctor's preferred prompt template id once,
    // keyed off the consultation the comprehensive artifact is written to, so it can
    // be threaded into promptAssemblyService.assemble (Tier-0 prompt selection).
    const preferredPromptTemplateId = this.configResolver
      ? await this.configResolver.resolvePreferredPromptTemplateId(consultation.doctorId ?? null)
      : undefined;

    // Step 1: Resolve all linked consultations (chain + same-day)
    const linkedConsultations = await this.resolveLinkedConsultations(consultation);
    if (linkedConsultations.length === 0) {
      throw new BadRequestException('No linked consultations found for comprehensive summary');
    }

    // `findConsultationChain` is NOT tenant-scoped at the
    // repo layer, so a historically poisoned `parentConsultationId`
    // pointer could pull a foreign-tenant consultation into the chain.
    // Refuse to aggregate any chain entry whose tenantId drifts from the
    // caller — same NotFound shape, no leak. (Same-day matches are
    // already tenant-filtered by `findByPatientAndDate` so they cannot
    // introduce drift on that branch, but the guard catches both.)
    this.assertChainInTenant(tenantId, linkedConsultations);

    const allConsultationIds = linkedConsultations.map((c) => c.id);

    this.logger.log({
      message: 'Generating comprehensive summary',
      consultationId,
      linkedConsultationCount: linkedConsultations.length,
      linkedIds: allConsultationIds,
    });

    // Step 2: Gather all content sections
    const sections = await this.gatherSections(linkedConsultations);

    if (sections.length === 0) {
      throw new BadRequestException('No content available across linked consultations for comprehensive summary');
    }

    // Step 3: Optionally gather NER entities
    let aggregatedEntities:
      | Record<
          string,
          Array<{
            text: string;
            confidence?: number;
            sourceConsultationId: string;
          }>
        >
      | undefined;

    if (request.includeNER !== false) {
      aggregatedEntities = await this.gatherNamedEntities(allConsultationIds);
    }

    // Step 4: Compose structured input and assemble final prompt for SMR
    const smrInput = await this.composeSmrInput(consultation, sections, aggregatedEntities, request, preferredPromptTemplateId);

    // Step 5: Call SMR service
    const smrResponse = await this.callSmrService(smrInput);

    // Step 6: Store as ContextItem(RAW_SUMMARY) on the requesting consultation
    const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, smrResponse.summary, request.dnaStyleId, userId ?? 'system');

    // Encrypt the generated summary text into `encryptedContent`
    // before persistence — the plaintext `content` column was dropped by the
    // PHI field-encryption migration, so an unencrypted create silently loses
    // the clinical text at rest (mirrors context.service.ts `encryptContent`).
    await this.encryptBestEffort('ContextItem content', () => this.contextItemRepository.encryptContentIntoEntity(contextItem, this.secretsService!));

    const savedContext = await this.contextItemRepository.create(contextItem);

    // Create summary metadata with source context tracking
    const summaryMeta = SummaryMetaFactory.CreateSummaryMeta({
      tenantId,
      contextItemId: savedContext.id,
      aiModelId: smrResponse.modelName ?? smrResponse.llmProvider,
      processingTimeMs: smrResponse.processingTimeMs,
      inputTokens: smrResponse.inputTokens,
      outputTokens: smrResponse.outputTokens,
    });
    await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(summaryMeta, this.secretsService!));
    await this.persistSummaryMetaWithUsage(summaryMeta, smrResponse.usage, {
      tenantId,
      consultationId,
      doctorId: consultation.doctorId,
      departmentId: consultation.departmentId,
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedContext.id,
      responsibleEntityId: userId ?? undefined,
      createdAt: savedContext.createdAt,
      data: {
        consultationId,
        type: 'comprehensive_summary',
        sourceConsultationIds: allConsultationIds,
        sectionCount: sections.length,
      },
    });

    this.logger.log({
      message: 'Comprehensive summary generated',
      consultationId,
      contextItemId: savedContext.id,
      sectionCount: sections.length,
      sourceConsultationCount: allConsultationIds.length,
      processingTimeMs: smrResponse.processingTimeMs,
    });

    return {
      id: savedContext.id,
      consultationId: savedContext.consultationId,
      type: savedContext.type,
      content: savedContext.content ?? '',
      structuredData: {
        modelName: smrResponse.modelName ?? smrResponse.llmProvider,
        processingTimeMs: smrResponse.processingTimeMs,
        inputTokens: smrResponse.inputTokens,
        outputTokens: smrResponse.outputTokens,
      },
      sourceConsultationIds: allConsultationIds,
      sectionCount: sections.length,
      namedEntities: aggregatedEntities,
      createdAt: savedContext.createdAt.toISOString(),
      updatedAt: savedContext.updatedAt.toISOString(),
    };
  }

  // =========================================================================
  // Internal methods — exposed for ComprehensiveSummaryProcessor (async path)
  // =========================================================================

  /**
   * Resolve all consultations linked to the given consultation.
   *
   * Combines chain-based (parentConsultationId) and date-based
   * (same tenantId, patientId, appointmentDate) strategies, matching
   * ContextService.resolveLinkedConsultationIds().
   */
  async resolveLinkedConsultations(consultation: ConsultationEntity): Promise<ConsultationEntity[]> {
    // Strategy 1: Chain-based
    const chain = await this.consultationRepository.findConsultationChain(consultation.id);
    const chainMap = new Map(chain.map((c) => [c.id, c]));

    // Strategy 2: Date-based
    const sameDayConsultations = await this.consultationRepository.findByPatientAndDate(
      consultation.tenantId,
      consultation.patientId,
      consultation.appointmentDate,
    );

    // Merge and deduplicate (chain entities take priority to preserve includes)
    for (const c of sameDayConsultations) {
      if (!chainMap.has(c.id)) {
        chainMap.set(c.id, c);
      }
    }

    return Array.from(chainMap.values());
  }

  /**
   * Gather content sections from all linked consultations.
   *
   * For each consultation, collects:
   * - Latest summary (RAW_SUMMARY or MODIFIED_SUMMARY) — if available
   * - Transcripts — if no summary exists
   * - Case notes
   * - Pre-summaries
   *
   * Summaries are preferred over raw transcripts because they're
   * more concise and fit better in the comprehensive summary input.
   */
  async gatherSections(consultations: ConsultationEntity[]): Promise<ChainSectionDto[]> {
    const sections: ChainSectionDto[] = [];

    for (const consultation of consultations) {
      const departmentName = consultation.Department?.name ?? consultation.departmentId ?? undefined;
      const doctorName = consultation.Doctor?.username ?? consultation.doctorId ?? undefined;

      // Get latest summary (preferred over raw transcripts)
      const summaries = await this.contextItemRepository.findSummaries(consultation.id);
      if (summaries.length > 0) {
        const latestSummary = summaries[summaries.length - 1];
        if (latestSummary.content?.trim()) {
          sections.push({
            consultationId: consultation.id,
            department: departmentName,
            doctor: doctorName,
            type: 'summary',
            content: latestSummary.content,
            createdAt: latestSummary.createdAt?.toISOString(),
          });
        }
      } else {
        // Fall back to transcripts if no summary exists
        const transcripts = await this.contextItemRepository.findTranscripts(consultation.id);
        for (const transcript of transcripts) {
          if (transcript.content?.trim()) {
            sections.push({
              consultationId: consultation.id,
              department: departmentName,
              doctor: doctorName,
              type: 'transcript',
              content: transcript.content,
              createdAt: transcript.createdAt?.toISOString(),
            });
          }
        }
      }

      // Case notes (always include — they provide historical context)
      const caseNotes = await this.contextItemRepository.findCaseNotes(consultation.id);
      for (const note of caseNotes) {
        if (note.content?.trim()) {
          sections.push({
            consultationId: consultation.id,
            department: departmentName,
            doctor: doctorName,
            type: 'case_note',
            content: note.content,
            createdAt: note.createdAt?.toISOString(),
          });
        }
      }

      // Pre-summaries (AI-generated case note summaries — provide condensed history)
      const preSummaries = await this.contextItemRepository.findPreSummaries(consultation.id);
      for (const preSummary of preSummaries) {
        if (preSummary.content?.trim()) {
          sections.push({
            consultationId: consultation.id,
            department: departmentName,
            doctor: doctorName,
            type: 'pre_summary',
            content: preSummary.content,
            createdAt: preSummary.createdAt?.toISOString(),
          });
        }
      }
    }

    return sections;
  }

  /**
   * Gather NER entities from all linked consultations, grouped by class.
   *
   * Iterates over all context items (summaries + transcripts) in each
   * consultation and aggregates their named entities.
   */
  async gatherNamedEntities(consultationIds: string[]): Promise<
    Record<
      string,
      Array<{
        text: string;
        confidence?: number;
        sourceConsultationId: string;
      }>
    >
  > {
    const entityMap: Record<
      string,
      Array<{
        text: string;
        confidence?: number;
        sourceConsultationId: string;
      }>
    > = {};

    for (const consultationId of consultationIds) {
      // Get all summaries and transcripts from this consultation
      const summaries = await this.contextItemRepository.findSummaries(consultationId);
      const transcripts = await this.contextItemRepository.findTranscripts(consultationId);
      const contextItems = [...summaries, ...transcripts];

      for (const item of contextItems) {
        const entities = await this.namedEntityRepository.findByContextItem(item.id);
        for (const entity of entities) {
          const className = entity.className ?? 'UNKNOWN';
          if (!entityMap[className]) {
            entityMap[className] = [];
          }

          // Deduplicate by text within the same class
          const alreadyExists = entityMap[className].some((e) => e.text === entity.text && e.sourceConsultationId === consultationId);
          if (!alreadyExists) {
            entityMap[className].push({
              text: entity.text ?? '',
              confidence: entity.confidence ?? undefined,
              sourceConsultationId: consultationId,
            });
          }
        }
      }
    }

    return entityMap;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * (audit C-1 / C-3 / C-4) — refuse to aggregate any chain
   * entry whose tenantId drifts from the caller. Throws `NotFoundException`
   * (no existence leak) on the first cross-tenant entry. Pre-D.2 data
   * could carry a poisoned `parentConsultationId` pointer into another
   * tenant; this guard short-circuits before SMR is called.
   */
  private assertChainInTenant(tenantId: string, consultations: ConsultationEntity[]): void {
    for (const c of consultations) {
      if (c.tenantId !== tenantId) {
        throw new NotFoundException('Resource not found');
      }
    }
  }

  /**
   * Persist the `SummaryMeta` and, in the SAME transaction, record the tokens
   * the chain generation consumed (TASK-615 WS-D).
   *
   * Mirrors `SummaryService.persistSummaryMetaWithUsage` exactly, including its
   * two degradations: unwired ledger ⇒ plain create, and a metering failure is
   * swallowed with the metadata re-persisted alone. The summary is already
   * delivered; a meter problem must never cost the clinician their note.
   */
  private async persistSummaryMetaWithUsage(
    summaryMeta: Parameters<SummaryMetaRepository['create']>[0],
    usage: SmrUsageDetail | null,
    attribution: { tenantId: string; consultationId: string; doctorId?: string | null; departmentId?: string | null },
  ): Promise<void> {
    const input = usage
      ? buildLlmUsageInput({
          usage,
          tenantId: attribution.tenantId,
          operation: 'generate',
          consultationId: attribution.consultationId,
          doctorId: attribution.doctorId,
          departmentId: attribution.departmentId,
        })
      : null;

    if (!this.usageLedger || !this.unitOfWork || !input) {
      await this.summaryMetaRepository.create(summaryMeta);
      return;
    }

    try {
      await this.unitOfWork.runInTransaction(async (tx) => {
        await this.summaryMetaRepository.create(summaryMeta, tx);
        await this.usageLedger!.recordUsage(input, tx);
      });
    } catch (error) {
      this.logger.warn({
        message: 'Usage metering failed for a comprehensive summary; persisting the summary metadata unmetered',
        consultationId: attribution.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.summaryMetaRepository.create(summaryMeta);
    }
  }

  /**
   * Compose structured input for the SMR service.
   *
   * The SMR service receives:
   * - sections: array of content blocks with metadata
   * - namedEntities: aggregated NER entities (optional)
   * - dnaStyleId/template: prompt configuration
   */
  private async composeSmrInput(
    consultation: ConsultationEntity,
    sections: ChainSectionDto[],
    namedEntities:
      | Record<
          string,
          Array<{
            text: string;
            confidence?: number;
            sourceConsultationId: string;
          }>
        >
      | undefined,
    request: ComprehensiveSummaryRequest,
    // Requesting doctor's preferred prompt template id (Tier-0).
    preferredPromptTemplateId: string | null | undefined,
  ): Promise<{
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
    context: Record<string, unknown>;
  }> {
    // Build a structured text from all sections
    const sectionTexts = sections.map((section, index) => {
      const header = [
        `--- Section ${index + 1} ---`,
        section.department ? `Department: ${section.department}` : null,
        section.doctor ? `Doctor: ${section.doctor}` : null,
        `Type: ${section.type}`,
        section.createdAt ? `Date: ${section.createdAt}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      return `${header}\n\n${section.content}`;
    });

    const fullText = sectionTexts.join('\n\n');

    // Build NER context if available
    let nerContext = '';
    if (namedEntities && Object.keys(namedEntities).length > 0) {
      const nerLines = Object.entries(namedEntities).map(([className, entities]) => {
        const uniqueTexts = [...new Set(entities.map((e) => e.text))];
        return `${className}: ${uniqueTexts.join(', ')}`;
      });
      nerContext = `\n\n--- Named Entities (auto-extracted) ---\n${nerLines.join('\n')}`;
    }

    const transcript = fullText + nerContext;
    const assembledPrompt = await this.promptAssemblyService.assemble({
      departmentId: consultation.departmentId ?? undefined,
      promptType: consultation.parentConsultationId ? 'revisit' : 'new-patient',
      transcript,
      conversationLanguage: this.resolveConversationLanguage(request.options),
      dnaStyleId: request.dnaStyleId,
      explicitTemplate: request.template ?? 'comprehensive',
      // Thread the requesting doctor's preferred prompt template id (Tier-0).
      preferredPromptTemplateId: preferredPromptTemplateId ?? undefined,
    });

    return {
      assembledPrompt,
      options: request.options,
      context: {
        dnaStyleId: request.dnaStyleId,
        template: request.template ?? 'comprehensive',
        includeNER: request.includeNER,
        summaryType: 'summary',
        promptResolvedFrom: assembledPrompt.resolvedFrom,
        promptHyperparameters: assembledPrompt.hyperparameters,
        isComprehensiveSummary: true,
        sectionCount: sections.length,
        sourceConsultationCount: new Set(sections.map((s) => s.consultationId)).size,
      },
    };
  }

  /**
   * Call the SMR service for comprehensive summary generation.
   */
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
    context: Record<string, unknown>;
  }): Promise<{
    summary: string;
    llmProvider?: string;
    modelName?: string;
    processingTimeMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    usage: SmrUsageDetail | null;
  }> {
    try {
      // Resolve the admin-managed {provider, model} (no in-gateway
      // default) as the base so a caller-supplied model still wins.
      let options = payload.options;
      if (this.harnessPolicyService) {
        const { provider, model } = await this.harnessPolicyService.resolveSmrSelection();
        options = { smrProvider: provider, smrModel: model, ...payload.options };
      }
      const smrPayload = buildSmrGeneratePayload(payload.assembledPrompt, options, payload.context);
      const smrServiceToken = (await this.secretsService?.getSecretOptional('SMR_SERVICE_TOKEN')) ?? '';
      const response = await this.httpService.axiosRef.post(`${this.smrServiceUrl}/api/v1/generate`, smrPayload, {
        timeout: 180000,
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': smrServiceToken,
        },
      });
      const data = response.data as { usage_detail?: unknown } | null;
      return { ...mapSmrGenerateResponse(response.data), usage: parseSmrUsageDetail(data?.usage_detail) };
    } catch (error) {
      this.logger.error({
        message: 'SMR service call failed for comprehensive summary',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new BadRequestException('Failed to generate comprehensive summary from AI service');
    }
  }

  private resolveConversationLanguage(options?: Record<string, unknown>): string {
    const candidate = options?.conversationLanguage ?? options?.language ?? options?.locale;

    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : 'en';
  }
}
