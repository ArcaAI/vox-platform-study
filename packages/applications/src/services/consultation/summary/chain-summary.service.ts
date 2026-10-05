import { BadRequestException, HttpException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AgentTask,
  AiActivityKind,
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
import { assembleTranscriptFragments, readSpeakerId } from './transcript-assembly.util';
import { buildLlmUsageBatches, buildTextActivityRun, parseTextUsageDetail, resolveDeployment, toLedgerProvider, type TextUsageDetail } from './text-usage';
import { IAiActivityRunService, IAiActivityRunServiceToken } from '../../ai-activity-run/IAiActivityRunService';
import { IUsageLedgerService } from '../../usageLedger/IUsageLedgerService';
import { IComputeDeviceResolver } from '../../usageLedger/compute-device.resolver';
import type { ComputeAugmentedBatch } from '../../usageLedger/compute-units';
import type { UsageEventBatchInput } from '../../usageLedger/dto';
import type { ComputeDevice } from '../../usageLedger/usage-attributes';
import { BaseService, assertParentInScope, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { clientClinicalContextReaderFor } from '../context/client-clinical-context';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { AgentResolverService } from '../../agent/agent-resolver.service';
import { AgentInvocationService, type AgentTextInvocationResult } from '../../agent/agent-invocation.service';
import { textPhaseSelectorTags } from '../../harness-policy/harness-policy.service';
import { buildPreSummaryVariables } from '../prompt/pre-summary-variables';
import { readSpokenLanguageMode } from '../consultation/summary-language';
import { INoteGenerationService, GenerationTrigger } from '../note-generation';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService, type VisitTypeDefinition } from '../visit-type/visit-type.service';
import { readRecordedVisitType } from '../consultation/open-markers';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { resolvePlatformOutputLanguage } from './platform-output-language';

/** The named-entity aggregate the chain carries, grouped by class. */
type AggregatedEntities = Record<string, Array<{ text: string; confidence?: number; sourceConsultationId: string }>>;

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
 * 4. Compose the chain as the invocation text, and the requesting consultation's clinical context
 *    as the agent's variables
 * 5. Invoke the tenant's published TEXT_GENERATION agent for the finalize phase (TASK-1006 — the
 *    agent plane; this path used to assemble its own prompt and call TEXT directly)
 * 6. Store result as ContextItem(RAW_SUMMARY) on the requesting consultation
 */
@Injectable()
export class ChainSummaryService extends BaseService {
  private readonly logger = new Logger(ChainSummaryService.name);

  constructor(
    private readonly contextItemRepository: ContextItemRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly summaryMetaRepository: SummaryMetaRepository,
    private readonly namedEntityRepository: NamedEntityRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-1006 — the agent plane. The tenant's assigned TEXT_GENERATION agent is resolved through
    // the ONE resolver every runtime call uses (assignment cascade, 404-over-403, hidden-agent
    // blindness), and run through the SAME invocation the business plane's `POST agents/:slug/
    // invocations` uses, so its instruction, parameters, credential fold and guardrail decision
    // apply here exactly as they do there.
    private readonly agentResolver: AgentResolverService,
    private readonly agentInvocation: AgentInvocationService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
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
    // the tenant's VISIT-TYPE catalogue — the `visit_type` variable the agent reads. Optional
    // + trailing so existing positional fixtures keep their arity; an unwired resolver serves the
    // two shipped visit types.
    @Optional() @Inject(VisitTypeService) private readonly visitTypes?: VisitTypeService,
    // TASK-959 §3.1 — which device a SELF-HOSTED engine ran on. Without it the appender
    // records NO compute row for a self-hosted call rather than guessing one, and this is the
    // most expensive generation the platform runs. Optional + trailing like the ledger above it.
    @Optional() @Inject(IComputeDeviceResolver) private readonly computeDevice?: IComputeDeviceResolver,
    // TASK-1001 (OD-12) — resolves `consultation.summary.outputLanguage`, the platform-default
    // language the chain summary is WRITTEN in (the agent's `language_name`). Optional + trailing;
    // unwired ⇒ the descriptor's code default (English).
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    // The per-activity run record of this generation, written in the usage transaction so the run
    // and the bill agree. Optional + trailing; unwired ⇒ the summary is metered without a run record.
    @Optional() @Inject(IAiActivityRunServiceToken) private readonly activityRuns?: IAiActivityRunService,
  ) {
    super(eventEmitter, clsService, ResourceType.ContextItem);
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
   * This is the synchronous endpoint — blocks until the agent returns.
   * For long consultation chains, prefer the async job endpoint.
   *
   * TASK-1006 — the generation runs on the AGENT PLANE: the tenant's published TEXT_GENERATION agent
   * for the finalize phase, invoked through {@link AgentInvocationService}. The agent owns the
   * instruction, model, parameters and guardrail decision, so the request's `template` and
   * `options` (prompt-template and model overrides of the retired direct-TEXT path) no longer
   * select anything; `dnaStyleId` is still recorded on the stored summary.
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
    let aggregatedEntities: AggregatedEntities | undefined;

    if (request.includeNER !== false) {
      aggregatedEntities = await this.gatherNamedEntities(allConsultationIds);
    }

    // Step 4–5: invoke the tenant's agent over the composed chain. The chain entity carries the
    // Department include the requesting row may not, so the department NAME is read off it.
    const anchor = linkedConsultations.find((c) => c.id === consultation.id) ?? consultation;
    const result = await this.invokeAgent(consultation, {
      text: this.composeChainText(sections, aggregatedEntities),
      variables: await this.noteContextVariables(consultation, anchor.Department?.name ?? null),
    });
    const usage = parseTextUsageDetail(result.usageDetail);
    const modelName = result.model ?? result.provider ?? undefined;
    const processingTimeMs = usage?.totalMs ?? undefined;
    const inputTokens = result.usage?.promptTokens ?? undefined;
    const outputTokens = result.usage?.completionTokens ?? undefined;

    // Step 6: Store as ContextItem(RAW_SUMMARY) on the requesting consultation
    const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, result.text, request.dnaStyleId, userId ?? 'system');

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
      aiModelId: modelName,
      processingTimeMs,
      inputTokens,
      outputTokens,
    });
    await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(summaryMeta, this.secretsService!));
    await this.persistSummaryMetaWithUsage(summaryMeta, usage, {
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
      processingTimeMs,
    });

    return {
      id: savedContext.id,
      consultationId: savedContext.consultationId,
      type: savedContext.type,
      content: savedContext.content ?? '',
      structuredData: { modelName, processingTimeMs, inputTokens, outputTokens },
      sourceConsultationIds: allConsultationIds,
      sectionCount: sections.length,
      namedEntities: aggregatedEntities,
      createdAt: savedContext.createdAt.toISOString(),
      updatedAt: savedContext.updatedAt.toISOString(),
    };
  }

  // =========================================================================
  // Internal methods, used by generateComprehensiveSummary above.
  //
  // Public (not private) for historical reasons: `ComprehensiveSummaryProcessor`
  // (the async BullMQ twin of this service) used to call them directly. That
  // processor was removed by TASK-1006 — the comprehensive summary now runs
  // synchronously on the agent plane, so this service is the only caller left.
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
        // Fall back to transcripts if no summary exists. Each TRANSCRIPT
        // ContextItem is one STT utterance (useArcaAudio.ts posts one per
        // finalized utterance) — pushing one section per item used to repeat
        // the "--- Section N ---" header (composeTextInput, below) once per
        // utterance and hand the model a wall of one-sentence "paragraphs".
        // Assemble adjacent utterances into real paragraphs first (TASK-998,
        // see transcript-assembly.util.ts) so a consultation with 200
        // utterances becomes a handful of sections instead of 200.
        const transcripts = await this.contextItemRepository.findTranscripts(consultation.id);
        const paragraphs = assembleTranscriptFragments(
          transcripts.map((t) => ({ content: t.content, createdAt: t.createdAt, speakerId: readSpeakerId(t) })),
        );
        for (const paragraph of paragraphs) {
          sections.push({
            consultationId: consultation.id,
            department: departmentName,
            doctor: doctorName,
            type: 'transcript',
            content: paragraph.content,
            createdAt: paragraph.createdAt?.toISOString(),
          });
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
        // The run record rides the same transaction as the usage it describes: both or neither.
        const run = usage
          ? buildTextActivityRun({
              usage,
              tenantId: attribution.tenantId,
              consultationId: attribution.consultationId,
              activityKind: AiActivityKind.NOTE_GENERATE,
              contextItemId: summaryMeta.contextItemId,
              outputVersionNumber: 1,
            })
          : null;
        if (run) await this.activityRuns?.record(run, tx);
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
   * The chain as ONE invocation `text`: a headed block per section, then the aggregated named
   * entities. This is the agent's user prompt; its instruction is the agent's own.
   */
  private composeChainText(sections: ChainSectionDto[], namedEntities: AggregatedEntities | undefined): string {
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

    let nerContext = '';
    if (namedEntities && Object.keys(namedEntities).length > 0) {
      const nerLines = Object.entries(namedEntities).map(([className, entities]) => {
        const uniqueTexts = [...new Set(entities.map((e) => e.text))];
        return `${className}: ${uniqueTexts.join(', ')}`;
      });
      nerContext = `\n\n--- Named Entities (auto-extracted) ---\n${nerLines.join('\n')}`;
    }

    return sectionTexts.join('\n\n') + nerContext;
  }

  /**
   * The requesting consultation's clinical context, as the agent's `variables`.
   *
   * The consultation-note vocabulary the seeded summarization agents bind (`current_department`,
   * `visit_type`, `safe_*`, `formatted_vitals`, `formatted_previous_visits`, …), valued exactly as
   * the durable lane's live handoff values them: through the shared `buildPreSummaryVariables`
   * builder (so an absent field inherits the same declared default), with the measured readings and
   * prior visits the client stated at `open`. `language` is the SOURCE language the microphone heard;
   * `language_name` is the note's OUTPUT language, the platform default (TASK-1001) — never the
   * declared code-switch.
   *
   * Supplied as plain strings, which override an agent's `{ path }` bindings of the same names: a
   * standalone invocation has no workflow trigger for those paths to resolve against.
   */
  private async noteContextVariables(consultation: ConsultationEntity, departmentName: string | null): Promise<Record<string, string>> {
    const client = await clientClinicalContextReaderFor(this.contextItemRepository, this.secretsService).read(consultation.id);
    const spokenLanguage = readSpokenLanguageMode(consultation);
    const outputLanguage = await resolvePlatformOutputLanguage(this.effectiveSettings, consultation.tenantId, this.logger);
    const shared = buildPreSummaryVariables({
      currentDepartment: departmentName,
      visitType: this.visitType(consultation).key,
      language: spokenLanguage,
      vitals: client.vitals,
      previousVisits: client.previousVisits,
    });
    return {
      ...shared,
      language_name: outputLanguage.name,
      language: (spokenLanguage ?? '').trim(),
      chief_complaint: '',
      formatted_vitals: client.vitals ?? shared.safe_vitals,
    };
  }

  /**
   * Resolve the tenant's TEXT_GENERATION agent for the finalize phase (department → tenant) and
   * invoke it, blocking.
   *
   * Every refusal the agent plane raises — no agent assigned (503), an unusable connection (409),
   * a missing prompt variable (400) — propagates as that plane states it. Only a failure with no
   * HTTP meaning of its own (the TEXT transport) is mapped, to the route's historical 400.
   */
  private async invokeAgent(
    consultation: ConsultationEntity,
    input: { text: string; variables: Record<string, string> },
  ): Promise<AgentTextInvocationResult> {
    const agent = await this.agentResolver.resolve({
      tenantId: consultation.tenantId,
      task: AgentTask.TEXT_GENERATION,
      departmentId: consultation.departmentId ?? null,
      selectorTags: textPhaseSelectorTags('finalize'),
    });
    try {
      return await this.agentInvocation.invokeText(agent, consultation.tenantId, input, 'blocking');
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error({
        message: 'Agent invocation failed for comprehensive summary',
        agentSlug: agent.slug,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new BadRequestException('Failed to generate comprehensive summary from AI service');
    }
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
