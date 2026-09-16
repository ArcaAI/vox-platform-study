import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AiDeploymentKind,
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
import { buildTextGeneratePayload, mapTextGenerateResponse } from './text-generate';
import { buildLlmUsageBatches, parseTextUsageDetail, resolveDeployment, toLedgerProvider, type TextUsageDetail } from './text-usage';
import { IUsageLedgerService } from '../../usageLedger/IUsageLedgerService';
import { IComputeDeviceResolver } from '../../usageLedger/compute-device.resolver';
import type { ComputeAugmentedBatch } from '../../usageLedger/compute-units';
import type { UsageEventBatchInput } from '../../usageLedger/dto';
import type { ComputeDevice } from '../../usageLedger/usage-attributes';
import { BaseService, TENANTLESS, assertParentInScope, encryptPhiFields, internalServiceHeaders, resolveInternalAccessToken } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { clientClinicalContextReaderFor } from '../context/client-clinical-context';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { HarnessPolicyService } from '../../harness-policy/harness-policy.service';
import { TextRequestEnrichmentService } from '../../text-request/text-request-enrichment.service';
import { ConfigResolver } from '../../config-resolver';
import type { PromptResolutionTier } from '../prompt/prompt-resolution.service';
import { INoteGenerationService, GenerationTrigger } from '../note-generation';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService, type VisitTypeDefinition } from '../visit-type/visit-type.service';
import { readRecordedVisitType } from '../consultation/open-markers';

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
 * 4. Compose structured sections for the TEXT service
 * 5. Call TEXT for comprehensive summary generation
 * 6. Store result as ContextItem(RAW_SUMMARY) on the requesting consultation
 */
@Injectable()
export class ChainSummaryService extends BaseService {
  private readonly logger = new Logger(ChainSummaryService.name);
  private readonly textServiceUrl: string;

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
    // Resolve the admin-managed TEXT {provider, model} on every
    // TEXT call (the gateway has no model default). Optional + trailing so
    // existing positional test fixtures keep compiling; production DI always
    // supplies it (ChainSummaryServiceModule).
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // Resolve the requesting doctor's preferred prompt template id
    // (UserProfile.preferredPromptTemplateId) so the sync chain-summary path
    // honors Tier-0 prompt selection. Optional + trailing so existing positional
    // test fixtures keep compiling; production DI supplies it (ChainSummaryServiceModule).
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // A chain summary spans several consultations and is one
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
    // comprehensive-summary has no harness equivalent today;
    // this call exists purely to make the generator decision happen through
    // the single seam and get the decision logged. Optional + trailing so
    // existing positional fixtures keep compiling.
    @Optional() @Inject(INoteGenerationService) private readonly noteGenerationService?: INoteGenerationService,
    // the SHARED TEXT enrichment path. Since lane B
    // (`70eec34d5`) removed TEXT's per-provider env plane, a `/api/v1/generate`
    // body with no `provider_overrides` entry fails closed with 503
    // PROVIDER_CREDENTIALS_MISSING. Optional + trailing so existing positional
    // fixtures keep their arity.
    @Optional() @Inject(TextRequestEnrichmentService) private readonly textRequestEnrichment?: TextRequestEnrichmentService,
    // the tenant's VISIT-TYPE catalogue, which replaces the
    // `parentConsultationId ? 'revisit': 'new-patient'` literal below. Optional
    // + trailing so existing positional fixtures keep their arity; an unwired
    // resolver serves the two shipped visit types, whose keys and follow-up rule
    // are byte-identical to the ternary it replaces.
    @Optional() @Inject(VisitTypeService) private readonly visitTypes?: VisitTypeService,
    // TASK-959 §3.1 — which device a SELF-HOSTED engine ran on. Without it the appender
    // records NO compute row for a self-hosted call rather than guessing one, and this is the
    // most expensive generation the platform runs. Optional + trailing like the ledger above it.
    @Optional() @Inject(IComputeDeviceResolver) private readonly computeDevice?: IComputeDeviceResolver,
  ) {
    super(eventEmitter, clsService, ResourceType.ContextItem);
    this.textServiceUrl = this.configService.get<string>('TEXT_URL') ?? 'http://localhost:8862';
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
   * This is the synchronous endpoint — blocks until TEXT returns.
   * For long consultation chains, prefer the async job endpoint.
   */
  async generateComprehensiveSummary(consultationId: string, request: ComprehensiveSummaryRequest): Promise<ComprehensiveSummaryResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // no harness equivalent for comprehensive-summary; logs the
    // decision through the single seam without affecting generation below.
    if (this.noteGenerationService) {
      try {
        const decision = await this.noteGenerationService.generate(GenerationTrigger.COMPREHENSIVE_SUMMARY, { consultationId, tenantId, userId });
        this.logger.log({ message: 'NoteGenerationService decision', trigger: GenerationTrigger.COMPREHENSIVE_SUMMARY, consultationId, decision });
      } catch (error) {
        this.logger.warn({
          message: 'NoteGenerationService seam call failed (best-effort, non-blocking)',
          consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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

    // Step 4: Compose structured input and assemble final prompt for TEXT
    const textInput = await this.composeTextInput(consultation, sections, aggregatedEntities, request, preferredPromptTemplateId);

    // Step 5: Call TEXT service
    const textResponse = await this.callTextService(textInput);

    // Step 6: Store as ContextItem(RAW_SUMMARY) on the requesting consultation
    const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, textResponse.summary, request.dnaStyleId, userId ?? 'system');

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
      aiModelId: textResponse.modelName ?? textResponse.llmProvider,
      processingTimeMs: textResponse.processingTimeMs,
      inputTokens: textResponse.inputTokens,
      outputTokens: textResponse.outputTokens,
    });
    await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(summaryMeta, this.secretsService!));
    await this.persistSummaryMetaWithUsage(summaryMeta, textResponse.usage, {
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
      processingTimeMs: textResponse.processingTimeMs,
    });

    return {
      id: savedContext.id,
      consultationId: savedContext.consultationId,
      type: savedContext.type,
      content: savedContext.content ?? '',
      structuredData: {
        modelName: textResponse.modelName ?? textResponse.llmProvider,
        processingTimeMs: textResponse.processingTimeMs,
        inputTokens: textResponse.inputTokens,
        outputTokens: textResponse.outputTokens,
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
   * tenant; this guard short-circuits before TEXT is called.
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
   * the chain generation consumed.
   *
   * Mirrors `SummaryService.persistSummaryMetaWithUsage` exactly, including its
   * two degradations: unwired ledger ⇒ plain create, and a metering failure is
   * swallowed with the metadata re-persisted alone. The summary is already
   * delivered; a meter problem must never cost the clinician their note.
   */
  private async persistSummaryMetaWithUsage(
    summaryMeta: Parameters<SummaryMetaRepository['create']>[0],
    usage: TextUsageDetail | null,
    attribution: { tenantId: string; consultationId: string; doctorId?: string | null; departmentId?: string | null },
  ): Promise<void> {
    // TASK-959 — the `*Batches` sibling, not `buildLlmUsageInput`: the BUILDER appends the
    // compute and byte rows, and only this form hands back the platform CPU leg of a BYOK call.
    const inputs = usageBatches(
      usage
        ? buildLlmUsageBatches({
            usage,
            tenantId: attribution.tenantId,
            operation: 'generate',
            consultationId: attribution.consultationId,
            doctorId: attribution.doctorId,
            departmentId: attribution.departmentId,
            device: await this.llmDevice(attribution.tenantId, usage),
          })
        : null,
    );

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
        message: 'Usage metering failed for a comprehensive summary; persisting the summary metadata unmetered',
        consultationId: attribution.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.summaryMetaRepository.create(summaryMeta);
    }
  }

  /**
   * Which device this generation's seconds were spent on — `null` when this service has no
   * business naming one (TASK-959 §3.1).
   *
   * A CLOUD or BYOK call is not the vendor's hardware: those seconds are the platform's own CPU
   * spent CALLING the vendor, which the appender meters as `cpu` whatever is passed. The
   * provider is read off TEXT's OWN usage block — the engine that actually served — never the
   * one this service asked for, so a fallback is never priced against a server it never touched.
   *
   * Never raises: an unresolvable device costs a compute row, and losing the whole batch —
   * tokens included — to protect a device label is the expensive direction to be wrong in.
   */
  private async llmDevice(tenantId: string, usage: TextUsageDetail): Promise<ComputeDevice | null> {
    const provider = toLedgerProvider(usage.textProvider);
    if (resolveDeployment(provider, usage.byok) !== AiDeploymentKind.SELF_HOSTED) return null;
    try {
      return (await this.computeDevice?.resolve(tenantId, provider)) ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Compute device unresolved; metering this chain summary without a compute row',
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Compose structured input for the TEXT service.
   *
   * The TEXT service receives:
   * - sections: array of content blocks with metadata
   * - namedEntities: aggregated NER entities (optional)
   * - dnaStyleId/template: prompt configuration
   */
  private async composeTextInput(
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
    // The measured readings and prior-visit history the client stated at `open` on the
    // consultation this chain is anchored to. Absent for a consultation that stated neither.
    const client = await clientClinicalContextReaderFor(this.contextItemRepository, this.secretsService).read(consultation.id);
    const assembledPrompt = await this.promptAssemblyService.assemble({
      departmentId: consultation.departmentId ?? undefined,
      vitals: client.vitals,
      previousVisits: client.previousVisits,
      // Tenant-configured visit type ; `parentConsultationId`
      // remains the follow-up signal, the vocabulary is no longer a literal.
      promptType: this.visitType(consultation).key,
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
   * Call the TEXT service for comprehensive summary generation.
   */
  private async callTextService(payload: {
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
    usage: TextUsageDetail | null;
  }> {
    // The tenant id is resolved EXPLICITLY (B-04), OUTSIDE the try/catch
    // below — never a bare no-arg call trusting `resolveTextSelection`'s own
    // CLS fallback, so a worker path with unpopulated CLS fails loudly with
    // a clear message instead of either silently serving the SYSTEM default
    // model or having that failure masked by the generic TEXT-call catch.
    if (this.harnessPolicyService && !this.tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    try {
      // Resolve the admin-managed {provider, model} (no in-gateway
      // default) as the base so a caller-supplied model still wins.
      let options = payload.options;
      // TASK-891 — the resolved selection's `generation` block, carried alongside
      // {provider, model} so its reasoning posture can reach `applyTextRuntimeProfile` below.
      let generation: Record<string, unknown> | undefined;
      if (this.harnessPolicyService) {
        const selection = await this.harnessPolicyService.resolveTextSelection(this.tenantId!, 'finalize');
        options = { textProvider: selection.provider, textModel: selection.model, ...payload.options };
        generation = selection.generation;
      }
      const textPayload = buildTextGeneratePayload(payload.assembledPrompt, options, payload.context);
      // inject the tenant's resolved provider credential through the
      // ONE shared implementation (tenant → SYSTEM cascade, `funding` label
      // carried so metering is derived from the supplying row rather than
      // stamped here). Without it TEXT fails closed with 503
      // PROVIDER_CREDENTIALS_MISSING — lane B removed its env plane.
      // layer the platform admin's runtime profile (hyperparameters + engine
      // extras such as `reasoning_effort`) BEFORE the credential fold, exactly as the
      // TEXT proxy does. Caller-set fields win; a resolver error injects nothing.
      // TASK-891 — `generation` carries the resolved agent's reasoning posture (OD-4) onto the
      // `extra` ride-along; an agent with no opinion injects nothing.
      await this.textRequestEnrichment?.applyTextRuntimeProfile(textPayload as { provider?: string; model?: string }, generation);
      await this.textRequestEnrichment?.applyTenantProviderOverrides(textPayload as { provider?: string });
      // D-D: the ONE shared `INTERNAL_ACCESS_TOKEN` (the per-service `TEXT_SERVICE_TOKEN`
      // fallback was retired with its descriptor, TASK-888). `X-Tenant-Id` is MANDATORY — the tenant
      // was null-checked at the top of this method and then DROPPED, so Text
      // resolved the platform-default provider instead of this tenant's BYOK
      // credential and derived `funding`/`cost_basis` ran against the
      // wrong tier. `this.tenantId` is non-null here whenever the policy service
      // is wired; the declared marker covers the no-policy-service fixture path so
      // the header is never simply absent.
      const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
      const response = await this.httpService.axiosRef.post(`${this.textServiceUrl}/api/v1/generate`, textPayload, {
        timeout: 180000,
        headers: internalServiceHeaders({
          serviceToken,
          tenantId: this.tenantId,
          tenantlessReason: TENANTLESS.PLATFORM_OPERATOR,
        }),
      });
      const data = response.data as { usage_detail?: unknown } | null;
      return { ...mapTextGenerateResponse(response.data), usage: parseTextUsageDetail(data?.usage_detail) };
    } catch (error) {
      this.logger.error({
        message: 'TEXT service call failed for comprehensive summary',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new BadRequestException('Failed to generate comprehensive summary from AI service');
    }
  }

  private resolveConversationLanguage(options?: Record<string, unknown>): string {
    const candidate = options?.conversationLanguage ?? options?.language ?? options?.locale;

    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : 'en';
  }

  /**
   * The consultation's visit type — one of the platform's two, through the one
   * vocabulary every caller shares rather than a literal repeated at each call site.
   *
   * TASK-951 §D-3 — the value the CALLER stated at open (`metadata.visitType`) ranks above the
   * consultation's own follow-up signal (`parentConsultationId`), which is what
   * `selectVisitType` has always done with a recorded value; until this ticket nothing on this
   * path ever supplied one. A consultation with no stated visit type derives exactly as before.
   */
  private visitType(consultation: { tenantId?: string | null; parentConsultationId?: string | null; metadata?: unknown }): VisitTypeDefinition {
    return (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).forConsultation(consultation.tenantId ?? null, {
      recorded: readRecordedVisitType(consultation.metadata),
      isFollowUp: Boolean(consultation.parentConsultationId),
    });
  }
}

/**
 * Both halves of an augmented pair (TASK-959 §6.3) — the tokens, and the platform CPU leg a
 * BYOK call splits onto its own `INTERNAL` batch because `costBasis` lives on `common`. A
 * non-BYOK pair flattens to the one batch it always was.
 */
function usageBatches(pair: ComputeAugmentedBatch | null): UsageEventBatchInput[] {
  if (!pair) return [];
  return pair.platformBatch ? [pair.batch, pair.platformBatch] : [pair.batch];
}
