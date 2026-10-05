import { DNA_MEMORY_CAPTURE_EVENT, type DnaMemoryCaptureRequest } from '../../dna-writing-style/dna-memory.events';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BusinessException } from '@arcaai/exceptions';
import { HttpService } from '@nestjs/axios';
import type { AxiosError } from 'axios';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';
import {
  AiDeploymentKind,
  ContextItemRepository,
  ContextItemVersionRepository,
  ConsultationRepository,
  CorePrisma,
  DnaWritingStyleReportRepository,
  CoreUnitOfWorkService,
  SummaryMetaRepository,
  NamedEntityRepository,
  UserProfileRepository,
  ContextItemFactory,
  ContextItemVersionFactory,
  SummaryMetaFactory,
  NamedEntityFactory,
  ResourceType,
  SysEventType,
  ConsultationEntity,
  ConsultationProcessing,
  AiActivityKind,
  HarnessAuditAction,
  JsonValue,
  AgentSessionKind,
  AgentStepStatus,
  AgentStepType,
  TranscriptSegmentRepository,
  AiModelRepository,
  UserDepartmentRepository,
  UserRepository,
  UserRoleAssignmentRepository,
  WorkflowDefinitionRepository,
  DocumentSectionRepository,
  generateId,
} from '@arcaai/domains';
import { IAgentTrajectoryService } from '../../agent-trajectory/IAgentTrajectoryService';
import type { CreateAgentTrajectoryStepInput } from '../../agent-trajectory/dto';
import { HarnessAuditService } from '../../harness-audit';
import { ConfigResolver } from '../../config-resolver';
import { diffContent } from './content-diff.util';
import { assertAttributedClinicianInTenant, resolveAttributedClinician, tenantRoleReaderFor, type ClinicalCaller } from './clinician-attribution';
import { type OutputLanguage } from '../consultation/summary-language';
// TASK-1001 (owner decision 2026-09-23) — the platform-default language the note is WRITTEN in.
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { resolvePlatformOutputLanguage } from './platform-output-language';
import { finalNoteSections, sectionKeysByTitle, splitHeadedNote } from './final-note-sections';
import { ISummaryService } from './ISummaryService';
import { GeneratePreSummaryRequest, UpdateSummaryRequest, SummaryResponse, SummaryProvenanceResponse, CitedSegmentResponse } from './dto';
import { SummaryDtoMapper } from './summary.dto.mapper';
import { buildTextGeneratePayload, mapTextGenerateResponse, withoutCallerModelSelection, type LegacyTextSummaryResponse } from './text-generate';
import {
  buildGuardrailUsageBatches,
  buildLlmUsageBatches,
  parseTextUsageDetail,
  resolveDeployment,
  toLedgerProvider,
  buildTextActivityRun,
  type TextUsageDetail,
} from './text-usage';
import { IAiActivityRunService, IAiActivityRunServiceToken } from '../../ai-activity-run/IAiActivityRunService';
import { IUsageLedgerService } from '../../usageLedger/IUsageLedgerService';
import { IComputeDeviceResolver } from '../../usageLedger/compute-device.resolver';
import type { ComputeAugmentedBatch } from '../../usageLedger/compute-units';
import type { UsageEventBatchInput } from '../../usageLedger/dto';
import { withUsageAttributes } from '../../usageLedger/usage-attributes';
import type { ComputeDevice, UsageAttributes } from '../../usageLedger/usage-attributes';
import type { UsageOperation } from '../../usageLedger/vocabulary';
import { BaseService, TENANTLESS, assertParentInScope, encryptPhiFields, internalServiceHeaders, resolveInternalAccessToken } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { clientCaseNoteRenderings, clientClinicalContextReaderFor, type ClientClinicalContext } from '../context/client-clinical-context';
import { resolveSameDayPrequel, resolveSameDayPrequelTimeZone } from '../harness/same-day-prequel';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { IBillingService } from '../../billing/IBillingService';
import { HarnessGatewayService } from '../harness/harness-gateway.service';
import { HarnessPolicyService } from '../../harness-policy/harness-policy.service';
import { TextRequestEnrichmentService } from '../../text-request/text-request-enrichment.service';
import type { PromptResolutionTier } from '../prompt/prompt-resolution.service';
import { namedEntityPropsFromNlp, type NlpNamedEntity } from '../shared/namedEntityFromNlp';
import { resolveNerModelInjection } from '../shared/resolveNerModelSelection';
import { buildNerUsageEvent, nerDevice, nerInferenceMs } from '../shared/nerUsageEvent';
import { stampContentCounters } from '../shared/contentCounters';
import { collectCitedSegmentIds } from '../lib/transcript-segments';
import { generateJsonWithRepair, looksLikeJsonObject, parsesAsJsonObject, type JsonRepairCall } from '../shared/bounded-json-repair';
import { IAiRoutingPolicyService } from '../../ai-routing-policy/IAiRoutingPolicyService';
import { IWorkflowExposureService } from '../../workflow-exposure/IWorkflowExposureService';
import { readGoverningEngineMarker, tenantWorkflowGoverns } from '../governing-engine';
import { INoteGenerationService, GenerationTrigger } from '../note-generation';
import { IPhiRedactor } from '../../gate-edit-mining/IPhiRedactor';
import { IGateEditMiningQueue } from '../../gate-edit-mining/IGateEditMiningQueue';
import {
  IDocumentTemplateService,
  type IDocumentTemplateService as IDocumentTemplateServicePort,
} from '../../document-template/IDocumentTemplateService';
import type { CompiledDocumentTemplate } from '../../document-template/document-template-compiler';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService, type VisitTypeDefinition } from '../visit-type/visit-type.service';
import { readRecordedVisitType } from '../consultation/open-markers';
import {
  IConsultationLifecycleGate,
  IConsultationLifecycleGateToken,
  IConsultationLifecycleService,
  IConsultationLifecycleServiceToken,
  type ClinicalCaller as LifecycleCaller,
} from '../lifecycle/IConsultationLifecycleService';
import { LifecycleConflictCode } from '../lifecycle/lifecycle-errors';
import type { PreparedNoteSignature, PreparedSessionSignature, SessionSignerCaller } from '../lifecycle/session-note-signer';

/** The attribution-form caller, as the lifecycle command service takes it. */
function toLifecycleCaller(caller: ClinicalCaller | undefined): LifecycleCaller {
  if (!caller) return { isMachine: false };
  if (caller.credentialClass === 'service-account') return { serviceAccountId: caller.principalId, isMachine: true };
  if (caller.credentialClass === 'api-key') return { apiKeyId: caller.principalId, userId: caller.boundUserId ?? undefined, isMachine: true };
  return { userId: caller.principalId, isMachine: false };
}

/**
 * the AD-1 GenerationStats headline fields the summary
 * paths persist onto `SummaryMeta`. A narrow view of the TEXT `/generate`
 * `stats` block: only the three headline fields are read here (predicted/total
 * token counts are derivable from the existing `inputTokens`/`outputTokens`).
 * All optional — never fabricated; a field the engine omitted stays null.
 */
interface TextGenerationStats {
  stop_reason?: string | null;
  ttft_ms?: number | null;
  tokens_per_second?: number | null;
}

/**
 * One TEXT `/generate` call inside the bounded auto-repair loop.
 * Carries the mapped response alongside the raw `text` the repair helper parses,
 * so the caller can attribute cost across the (at most two) calls.
 */
interface TextRepairCall extends JsonRepairCall {
  mapped: LegacyTextSummaryResponse;
  stats: TextGenerationStats | null;
  /** TEXT's billing passthrough for this call — one per attempt, all metered. */
  usage: TextUsageDetail | null;
  /** The guardrail call this generation triggered, forwarded by TEXT. */
  guardrailUsage: TextUsageDetail | null;
}

/**
 * TASK-972 Lane 3 — the `core` vocabulary's durable human wait. A VOCABULARY key, not
 * configuration: it names an entry of `WORKFLOW_NODE_REGISTRY`, the same way
 * `config-resolver.service.ts` names `agent.dna_style` and `core.agent`. A `core.action`
 * delegating to a review is deliberately not matched — the action catalogue carries no review
 * capability, so there is nothing to delegate to.
 */
const HUMAN_REVIEW_NODE_TYPE = 'core.humanReview';

/** Everything an emission needs that is NOT already on the usage block. */
interface SummaryUsageAttribution {
  tenantId: string;
  consultationId: string;
  doctorId?: string | null;
  departmentId?: string | null;
}

/** Request shape for `SummaryService#callTextService` / `#executeTextGenerate` (B-03 / B-04). */
interface TextCallPayload {
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
  /**
   * TASK-876 — the consultation's department, so the assigned-agent cascade can start at the
   * DEPARTMENT tier (`department → tenant → SYSTEM`) instead of always at the tenant's. The
   * call site has the consultation row in hand; `null` when it has no department.
   */
  departmentId?: string | null;
  /** The consultation this call generates for — its known PHI rides the egress enrichment as `known_phi`. */
  consultationId?: string | null;
}

type TextCallResult = LegacyTextSummaryResponse & {
  stats: TextGenerationStats | null;
  usage: TextUsageDetail | null;
  guardrailUsage: TextUsageDetail | null;
};

@Injectable()
export class SummaryService extends BaseService implements ISummaryService {
  private readonly logger = new Logger(SummaryService.name);
  private readonly textServiceUrl: string;
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
    // when the internal token was unset: no X-Service-Token header.
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
    // Resolve the admin-managed TEXT {provider, model} on every
    // TEXT call (the gateway has no model default). Optional + trailing so
    // existing positional test fixtures keep compiling; production DI
    // (SummaryServiceModule) always supplies it, keeping the path fail-closed.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // UNREAD since TASK-1006. It resolved the effective DNA-style decision (tenant AND doctor)
    // for the synchronous `generateSummary`, which was removed; the slot stays so the positional
    // `new SummaryService(...)` fixtures keep their arity.
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // Optional (append-only DI); enforces the plan
    // `monthlySummaries` meter on generation (kill-switch-gated, → 429 over cap).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // One LLM_CALL trajectory step per generate/pre-summary.
    // Optional + trailing so existing positional test fixtures compile;
    // production DI (SummaryServiceModule) supplies it. Fire-and-forget: a
    // trajectory failure never rolls back the (delivered) summary.
    @Optional() @Inject(IAgentTrajectoryService) private readonly trajectoryService?: IAgentTrajectoryService,
    // Resolves the SYSTEM `nlp.ner` routing election for injection into the
    // synchronous extractEntities NLP call (`resolveNerModelInjection`).
    // Optional + trailing so existing positional test fixtures keep compiling;
    // absent ⇒ the NER hop is refused with a 503 naming the key (fail-closed).
    @Optional() @Inject(IAiRoutingPolicyService) private readonly routingPolicies?: IAiRoutingPolicyService,
    // Resolves the cited-segment evidence rows for getSummaryProvenance
    // Optional + trailing so existing positional test
    // fixtures keep compiling; absent ⇒ citedSegments: [] (best-effort).
    @Optional() @Inject(TranscriptSegmentRepository) private readonly transcriptSegmentRepository?: TranscriptSegmentRepository,
    // Shared by two lanes: WS-D (generatePreSummary) records
    // the LLM + guardrail token rows a generation produced; WS-E
    // (extractEntities) records the ner.extract usage row the synchronous
    // NER path produced. Optional + trailing so existing positional test
    // fixtures keep compiling; absent ⇒ the corresponding path is simply
    // not metered (never fails — metering is additive, not a precondition).
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedger?: IUsageLedgerService,
    // Lets the SummaryMeta write and the usage emission share
    // one transaction, so neither can survive without the other.
    // This is the DOMAINS `CoreUnitOfWorkService` (provided + exported by
    // `CoreDatabaseModule`, so `@Optional()` actually resolves it), NOT the
    // identically-named, unwired class under `services/baseServices` — which
    // resolved to `undefined` and silently disabled this metering entirely.
    // The token stays EXPLICIT (rather than relying on `emitDecoratorMetadata`,
    // as `SttInternalService` does) so the DI guard test can assert it.
    @Optional() @Inject(CoreUnitOfWorkService) private readonly unitOfWork?: CoreUnitOfWorkService,
    // Optional + trailing: enforces the tenant's OPTIONAL monthly
    // spend limit before an LLM generation incurs more paid overage (→ 402).
    // Absent (or no limit set) ⇒ no-op, so metering/quotas are unaffected.
    @Optional() @Inject(IBillingService) private readonly billing?: IBillingService,
    // UNREAD. It served the retired per-agent FINALIZE LLM override (`llmOverrides.finalize`);
    // the slot stays so the positional `new SummaryService(...)` fixtures keep their arity.
    @Optional() @Inject(AiModelRepository) private readonly aiModelRepository?: AiModelRepository,
    // seam. `generatePreSummary` calls `noteGenerationService.generate`
    // (PRE_SUMMARY has no harness equivalent — always a side-effect-free
    // 'legacy' decision, logged for observability).
    // Optional + trailing so existing positional fixtures keep compiling.
    @Optional() @Inject(INoteGenerationService) private readonly noteGenerationService?: INoteGenerationService,
    // hop 1 — PHI redaction before the synchronous NER call.
    //
    // DELIBERATELY NOT `@Optional()` (owner directive D-A, 2026-08-17: no
    // production data yet, so ship day-1-complete rather than
    // degrade-gracefully). Nest therefore REQUIRES this provider: a deployment
    // whose module graph forgot `PhiRedactionServiceModule` fails loudly at
    // boot instead of silently posting raw PHI to `apps/nlp`. The TypeScript
    // `?` marker is retained ONLY so the pre-existing positional
    // `new SummaryService(...)` fixtures (12 unit specs plus one apps/api
    // integration spec) keep compiling — it is NOT a licence to run without a
    // redactor: `extractEntities` throws when it is absent (see below), so
    // there is no code path on which unredacted content reaches NLP.
    //
    // This closes the hole re-opened: hop 1 was originally wired into
    // `jobs/processors/ner.processor.ts`, which deleted, leaving this
    // synchronous path posting `contextItem.content` raw.
    @Inject(IPhiRedactor) private readonly phiRedactor?: IPhiRedactor,
    // the gate-edit learning loop's enqueue seam.
    //
    // `@Optional()` and TRAILING, deliberately, for the reason the port itself
    // documents: this is the clinician SIGN-OFF path. A deployment with no
    // miner wired must simply not mine — it must never fail, delay, or roll
    // back a signature. Absent ⇒ byte-identical behaviour to before this
    // ticket. Trailing also keeps every existing positional
    // `new SummaryService(...)` fixture compiling untouched.
    @Optional() @Inject(IGateEditMiningQueue) private readonly gateEditMiningQueue?: IGateEditMiningQueue,
    // the SHARED TEXT enrichment path. Since lane B
    // (`70eec34d5`) removed TEXT's per-provider env plane, a `/api/v1/generate`
    // body with no `provider_overrides` entry fails closed with 503
    // PROVIDER_CREDENTIALS_MISSING. Optional + trailing so existing positional
    // fixtures keep their arity.
    @Optional() @Inject(TextRequestEnrichmentService) private readonly textRequestEnrichment?: TextRequestEnrichmentService,
    // carry-over A — the section vocabulary for the edit-capture
    // diff. `content-diff.util.ts` no longer owns a hardcoded four-key SOAP
    // tuple, so the tenant's PINNED document shape has to arrive from
    // somewhere; this is that seam. Optional + trailing so the 17 existing
    // positional `new SummaryService(...)` fixtures keep their arity, and
    // because a diff is enrichment, never a precondition: absent ⇒ the util's
    // documented whole-document fallback, which is exactly today's behaviour
    // for an unparseable note.
    @Optional() @Inject(IDocumentTemplateService) private readonly documentTemplateService?: IDocumentTemplateServicePort,
    // the tenant's VISIT-TYPE catalogue, which replaces the
    // `parentConsultationId ? 'revisit': 'new-patient'` literal below. Optional
    // + trailing so existing positional fixtures keep their arity; an unwired
    // resolver serves the two shipped visit types, whose keys and follow-up rule
    // are byte-identical to the ternary it replaces.
    @Optional() @Inject(VisitTypeService) private readonly visitTypes?: VisitTypeService,
    // UNREAD since TASK-1006. It auto-resolved the clinician's own writing-style report
    // (TASK-932 D-10) for the synchronous `generateSummary`, which was removed; the slot stays so
    // the positional `new SummaryService(...)` fixtures keep their arity.
    @Optional() @Inject(DnaWritingStyleReportRepository) private readonly dnaReportRepository?: DnaWritingStyleReportRepository,
    // TASK-959 §3.1 — which device a SELF-HOSTED engine ran on, the one thing `apps/text`
    // cannot report about itself (it is stateless per call and no request or model row carries
    // a device). Without it the appender records NO compute row for a self-hosted call rather
    // than guessing one, so every platform-served summary was billed for its tokens alone.
    // `@Optional()` and TRAILING like the ledger beside it: absent ⇒ no compute row, never a
    // failed generation.
    @Optional() @Inject(IComputeDeviceResolver) private readonly computeDevice?: IComputeDeviceResolver,
    // ── TASK-972 Lane 1: machine sign-off attribution ────────────────────────────────────────
    //
    // The three repositories the named-clinician rule needs, optional + TRAILING like every
    // dependency above them (the positional `new SummaryService(...)` fixtures keep their arity).
    // Production DI supplies all three through `CoreDatabaseModule`, which this module already
    // imports.
    //
    // `userRoleAssignmentRepository` answers the TENANT-SCOPED admin-role question ("may this
    // caller act for somebody else?"); the other two complete `assertUserBelongsToTenant`, whose
    // absence is a 404 rather than a pass — a composition that cannot prove membership must not
    // attribute a clinical attestation on an unverified id. Only the NAMED path reaches them, so
    // every caller acting as itself is unaffected.
    @Optional() @Inject(UserRoleAssignmentRepository) private readonly userRoleAssignmentRepository?: UserRoleAssignmentRepository,
    @Optional() @Inject(UserDepartmentRepository) private readonly userDepartmentRepository?: UserDepartmentRepository,
    @Optional() @Inject(UserRepository) private readonly userRepository?: UserRepository,
    // ── TASK-972 Lane 3: route the sign-off to the GOVERNING run ────────────────────────────
    //
    // `signalApproval` targets `harness-doc-<consultationId>` (Substrate A). A consultation
    // governed by a tenant workflow runs on Substrate B, where that execution does not exist, so
    // the sign-off reached nothing and the run stayed parked on its review gate (TASK-933 H3-6).
    // These two resolve the run's review node(s) and release them through the EXISTING decide
    // path. Both optional + trailing, and the whole release is best-effort: a gate that cannot be
    // released must never fail a signature.
    @Optional() @Inject(IWorkflowExposureService) private readonly workflowExposure?: IWorkflowExposureService,
    @Optional() @Inject(WorkflowDefinitionRepository) private readonly workflowDefinitionRepository?: WorkflowDefinitionRepository,
    // TASK-1001 (owner decision 2026-09-23) — resolves `consultation.summary.outputLanguage`, the
    // platform-default language a note is WRITTEN in. Optional + trailing like every dependency
    // above it, so the positional `new SummaryService(...)` fixtures keep their arity; unwired ⇒
    // the descriptor's own code default (English), never the consultation's declared language.
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    // TASK-1001 (wave 2, final note) — the consultation's document sections, read ONLY for their
    // `sectionKey`/`title` pairs, so the final note's `duplicate` flags name a section by the key
    // `documents/sections` and the live flags already use. Optional + trailing like every
    // dependency above it; unwired ⇒ keys derived from the note's own headings.
    @Optional() @Inject(DocumentSectionRepository) private readonly documentSectionRepository?: DocumentSectionRepository,
    // Run records for the generations this service performs, written in the usage transaction.
    @Optional() @Inject(IAiActivityRunServiceToken) private readonly activityRuns?: IAiActivityRunService,
    // The consultation-level content lock for summary edits. Optional + trailing; see `updateSummary`.
    @Optional() @Inject(IConsultationLifecycleGateToken) private readonly lifecycleGate?: Pick<IConsultationLifecycleGate, 'assertContentWritable'>,
    // Resolves the lifecycle command service lazily for the per-summary approve: the lifecycle
    // module imports this one (for the signing core), so this one cannot import it back.
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    super(eventEmitter, clsService, ResourceType.ContextItem);
    this.textServiceUrl = this.configService.get<string>('TEXT_URL') ?? 'http://localhost:8862';
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
   * route a trigger with NO harness equivalent through the seam
   * purely to make the generator decision happen in one place and get the
   * decision logged. Safe to call unconditionally: `generate()` never has a
   * side effect for a trigger outside `HARNESS_SUPPORTED_TRIGGERS`, and this
   * is best-effort — a seam failure never blocks generation.
   */
  private async logGenerationDecision(trigger: GenerationTrigger, consultationId: string, tenantId: string, userId?: string): Promise<void> {
    if (!this.noteGenerationService) return;
    try {
      const decision = await this.noteGenerationService.generate(trigger, { consultationId, tenantId, userId });
      this.logger.log({ message: 'NoteGenerationService decision', trigger, consultationId, decision });
    } catch (error) {
      this.logger.warn({
        message: 'NoteGenerationService seam call failed (best-effort, non-blocking)',
        trigger,
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * What the CLIENT stated at `open` — measured vitals and a prior-visit history — rendered for
   * a prompt.
   *
   * One reader per generation, so the memo it carries is scoped to that operation rather than
   * accumulating consultations on this boot-time singleton. Never throws: the reader degrades an
   * unreadable or undecryptable row to "the client sent nothing", which is exactly the state
   * every consultation opened before the context schema existed is in.
   */
  private readClientClinicalContext(consultationId: string): Promise<ClientClinicalContext> {
    return clientClinicalContextReaderFor(this.contextItemRepository, this.secretsService).read(consultationId);
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

    // no harness equivalent for pre-summary; logs the decision
    // through the single seam without affecting generation below.
    await this.logGenerationDecision(GenerationTrigger.PRE_SUMMARY, consultationId, tenantId, userId ?? undefined);

    // A generated summary consumes a monthly meter unit.
    // Kill-switch-gated (Q9); → 429 once the tenant is over the monthly cap.
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlySummaries');

    // LLM-token allowance pre-flight, BEFORE the (expensive)
    // TEXT call. Post-hoc debit model (D6): a request's own token count is
    // unknowable until TEXT responds, so this compares month-to-date rollups
    // against the allowance rather than predicting this call's usage — same
    // no-increment call shape as `monthlySummaries` above. A no-op (never
    // reads the ledger) while the kill-switch is off or the allowance is
    // null (unlimited — the seeded default for every plan today).
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlyLlmTokens');

    // Optional spend-limit gate → 402 when the tenant set a
    // monthly cap and its overage spend has reached it. No-op (no draft
    // computed) when unset — the seeded default for every tenant.
    await this.billing?.assertSpendLimit(tenantId);

    // (audit C-1 / C-3) — verify the parent Consultation
    // belongs to the caller's tenant before invoking the (expensive) TEXT
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

    // The client's own context. Read AFTER the "is there anything to summarise" guard, which is
    // still asked of the case-note records as they stand: a consultation whose only notes came
    // from the client is a consultation with notes, and it must not start refusing simply because
    // the same text also reaches the prompt as prior-visit context below.
    const client = await this.readClientClinicalContext(consultationId);
    // TASK-1020 — the client's lab results and the same-day prequel (the patient's EARLIER visits
    // today): at a same-day return this briefing is exactly where the morning's note and the labs
    // taken in between belong. Both never throw; both are spread only when present.
    const [testResults, sameDayPrequel] = await Promise.all([
      clientClinicalContextReaderFor(this.contextItemRepository, this.secretsService).readTestResults(consultationId),
      resolveSameDayPrequel(
        { consultationRepository: this.consultationRepository, contextItemRepository: this.contextItemRepository },
        consultation,
        {
          timeZone: await resolveSameDayPrequelTimeZone(this.effectiveSettings, tenantId),
        },
      ),
    ]);

    // A note the client sent under `previous_case_notes` is persisted TWICE at open — once as the
    // structured kind, once as a `CASE_NOTE` row per entry — and `client.previousVisits` already
    // carries it, dated and ordered. Feeding the case-note copies in as well would put the same
    // history in front of the model under two different headings.
    const duplicated = client.previousVisits ? clientCaseNoteRenderings(client.raw.previousVisits) : null;
    const promptCaseNotes = caseNotes.map((note) => (note.content ?? '').trim()).filter((text) => text.length > 0 && !duplicated?.has(text));

    const assembledPrompt = await this.promptAssemblyService.assemble({
      departmentId: consultation.departmentId ?? undefined,
      // The pre-summary chain has no department axis: without the tenant a
      // consultation with NO department skips the tenant tier and lands on the
      // SYSTEM default (or a 503).
      tenantId,
      promptType: 'pre-summary',
      // The department-free fork. The v1-parity body (the resolver's `'v1'` default) existed for
      // the v1-compat surface, which is gone (TASK-1004).
      preSummaryVariant: 'dept-free',
      // v1 `{visit_type}`. `parentConsultationId` is the consultation's own follow-up
      // signal; the LABEL comes from the platform's visit types, not from a literal that
      // disagreed with the one the summary path used for the same concept.
      visitType: this.visitType(consultation).label,
      // EMPTY, and that is the honest value: this chain has no recording. The case-note records
      // used to be passed here, so the model was told that text from PREVIOUS encounters was the
      // transcript of this one. They now travel as `caseNotes`, under their own section.
      transcript: '',
      caseNotes: promptCaseNotes,
      vitals: client.vitals,
      previousVisits: client.previousVisits,
      ...(testResults ? { testResults } : {}),
      ...(sameDayPrequel.hasSameDayPrequel ? { sameDayPrequelSummary: sameDayPrequel.summary } : {}),
      conversationLanguage: (await this.resolveNoteOutputLanguage(tenantId)).tag,
      dnaStyleId: request.dnaStyleId,
      preferredPromptTemplateId: await this.resolvePreferredPromptTemplateId(consultation.doctorId),
    });

    // Call TEXT service
    const textResponse = await this.callTextService({
      assembledPrompt,
      options: request.options,
      departmentId: consultation.departmentId,
      consultationId: consultation.id,
      context: {
        dnaStyleId: request.dnaStyleId,
        summaryType: 'pre-summary',
        promptResolvedFrom: assembledPrompt.resolvedFrom,
        promptHyperparameters: assembledPrompt.hyperparameters,
      },
    });

    // Create pre-summary context item
    const contextItem = ContextItemFactory.CreatePreSummary(tenantId, consultationId, textResponse.summary, request.dnaStyleId, userId ?? 'system');
    // TASK-999 (D-3(a)) — measured from the plaintext, before the encrypt below is the last
    // moment anything can. The factory's positional form carries no counters, so they are
    // stamped on the entity.
    stampContentCounters(contextItem, textResponse.summary);

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
      aiModelId: textResponse.modelName ?? textResponse.llmProvider,
      processingTimeMs: textResponse.processingTimeMs,
      inputTokens: textResponse.inputTokens,
      outputTokens: textResponse.outputTokens,
      cacheHit: textResponse.cacheHit,
      qualityScore: textResponse.qualityScore,
      promptResolvedFrom: assembledPrompt.resolvedFrom,
      resolvedPromptId: assembledPrompt.promptId,
    });
    // persist the AD-1 GenerationStats headline fields when
    // TEXT returned them. Set via the entity setters (change-tracked, same path
    // as `contextItem.currentVersionNumber = 1` above); the factory does not yet
    // expose these props. Null/absent stats (legacy idempotency-cache hit) leaves
    // the columns null — never fabricated.
    if (textResponse.stats) {
      summaryMeta.stopReason = textResponse.stats.stop_reason ?? null;
      summaryMeta.ttftMs = textResponse.stats.ttft_ms ?? null;
      summaryMeta.tokensPerSecond = textResponse.stats.tokens_per_second ?? null;
    }
    await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(summaryMeta, this.secretsService!));
    await this.persistSummaryMetaWithUsage(summaryMeta, textResponse, 'presummarize', {
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

    // One SUMMARY_JOB LLM_CALL step for this generation (non-fatal).
    await this.recordSummaryTrajectory({
      tenantId,
      consultationId,
      summaryId: savedContext.id,
      name: 'pre-summary',
      stats: textResponse.stats,
      durationMs: textResponse.processingTimeMs,
    });

    return SummaryDtoMapper.toResponse(savedContext);
  }

  /**
   * Persist a `SummaryMeta` and, in the SAME transaction, record the tokens the
   * generation consumed.
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
    textResponse: { usage: TextUsageDetail | null; guardrailUsage: TextUsageDetail | null },
    operation: UsageOperation,
    attribution: SummaryUsageAttribution,
  ): Promise<void> {
    // TASK-890 (OD-E) — WHICH activity produced these rows. Every generation
    // this service performs is a clinical consultation; the dimension is what
    // lets a tenant's spend be split from a prompt bench's or a workflow's.
    //
    // And HOW it was screened: every call is (the opt-outs and the platform kill switch are
    // retired), so a call that went through the egress enrichment is `screened`. With no
    // enrichment wired the row is stamped with NOTHING, never a guess.
    const guardrail = this.textRequestEnrichment ? ('screened' as const) : undefined;
    // TASK-959 — the `*Batches` siblings, not the single-batch forms: the BUILDER appends the
    // compute and byte rows, and only these hand back the platform CPU leg of a BYOK call. The
    // `device` they need is resolved HERE because the builders are pure modules and the cascade
    // is asynchronous.
    const llmPair = textResponse.usage
      ? buildLlmUsageBatches({
          usage: textResponse.usage,
          tenantId: attribution.tenantId,
          operation,
          consultationId: attribution.consultationId,
          doctorId: attribution.doctorId,
          departmentId: attribution.departmentId,
          device: await this.llmDevice(attribution.tenantId, textResponse.usage),
        })
      : null;
    const guardrailPair = textResponse.guardrailUsage
      ? buildGuardrailUsageBatches({
          usage: textResponse.guardrailUsage,
          tenantId: attribution.tenantId,
          consultationId: attribution.consultationId,
          doctorId: attribution.doctorId,
          departmentId: attribution.departmentId,
          fallbackRequestId: textResponse.usage?.taskId ?? null,
          // The guard call is its OWN provider call: a tenant may screen on one engine and
          // generate on another, so its device is resolved from ITS provider.
          device: await this.llmDevice(attribution.tenantId, textResponse.guardrailUsage),
        })
      : null;

    const inputs = [
      ...stampedBatches(llmPair, { trigger: 'CONSULTATION', ...(guardrail ? { guardrail } : {}) }),
      ...stampedBatches(guardrailPair, { trigger: 'CONSULTATION' }),
    ];

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
        const run = textResponse.usage
          ? buildTextActivityRun({
              usage: textResponse.usage,
              tenantId: attribution.tenantId,
              consultationId: attribution.consultationId,
              activityKind: operation === 'presummarize' ? AiActivityKind.PRE_SUMMARY : AiActivityKind.NOTE_GENERATE,
              contextItemId: summaryMeta.contextItemId,
              outputVersionNumber: 1,
            })
          : null;
        if (run) await this.activityRuns?.record(run, tx);
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
   * Emit ONE LLM_CALL trajectory step for a summary generation.
   * sessionKind=SUMMARY_JOB, sessionId=the generated summary's contextItem id
   * (stable job id), runId="" (non-Temporal sentinel), seq=0 (one step per job).
   * Fire-and-forget: any failure is swallowed + logged so telemetry never rolls
   * back the delivered summary. No-op when the emitter is not wired.
   */
  private async recordSummaryTrajectory(params: {
    tenantId: string;
    consultationId: string;
    summaryId: string;
    name: 'pre-summary';
    stats: TextGenerationStats | null;
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
   * The tenant's PINNED document shape, for keying the edit-capture
   * `fieldChanges` map ( carry-over A). Null when no catalog is wired
   * or resolution fails.
   *
   * `resolveForGeneration` is itself fail-open (it falls back to the compiled
   * PLATFORM shape rather than throwing for an unconfigured tenant), so the
   * catch here only covers an unreachable catalog. Either way the answer is
   * null and `diffContent` records a whole-document delta: a clinician's edit
   * or signature must never fail because a template could not be read.
   */
  private async resolveDiffTemplate(tenantId: string): Promise<CompiledDocumentTemplate | null> {
    if (!this.documentTemplateService) return null;
    try {
      const resolved = await this.documentTemplateService.resolveForGeneration(tenantId);
      return resolved?.compiled ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve document template for edit-capture diff (non-fatal; whole-document delta used)',
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Update existing summary content
   */
  async updateSummary(contextItemId: string, request: UpdateSummaryRequest, options?: { caller?: ClinicalCaller }): Promise<SummaryResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // (audit C-3) — assert the target summary lives in
    // the caller's tenant before reading approvals / writing a new
    // version. Missing or cross-tenant both surface as NotFound.
    const contextItem = await assertParentInScope(this.contextItemRepository, contextItemId, tenantId);

    // The content lock is the CONSULTATION's: approved / approved-and-closed ⇒ 409
    // `CONSULTATION_APPROVED`, closed incomplete ⇒ 409 `CONSULTATION_CLOSED`. A reopened
    // consultation is writable again even though its note carries an earlier signature. Without
    // the gate wired, a signed note stays locked (the same 409).
    if (this.lifecycleGate) {
      await this.lifecycleGate.assertContentWritable(contextItem.consultationId);
    } else {
      const approvals = await this.contextItemVersionRepository.getVersionsByChangeReason(contextItemId, 'approved');
      if (approvals.length > 0) {
        throw new ConflictException({ code: LifecycleConflictCode.CONSULTATION_APPROVED, message: 'Summary is approved and locked' });
      }
    }

    if (!contextItem.isSummary) {
      throw new BadRequestException(`Context item ${contextItemId} is not a summary`);
    }

    // TASK-972 Lane 1 — WHOSE edit this is. Resolved AFTER the tenant assertion above so an
    // unknown or foreign summary is still a 404 first: existence, then the rule.
    const { clinicianId: editedBy } = await this.resolveActingClinician(tenantId, request.clinicianUserId, options?.caller);

    const previousData = contextItem.toObject();

    const versionNumber = ((contextItem.currentVersionNumber as number) ?? 0) + 1;
    const version = ContextItemVersionFactory.CreateFromContextItem(
      contextItem,
      versionNumber,
      request.changeReason ?? 'Manual edit',
      editedBy,
      request.changeSource ?? 'doctor_edit',
      request.changeSummary,
    );

    // Stamp the edit delta (previous draft → this edit)
    // onto the existing version columns for the DNA edit-capture corpus.
    // `CreateFromContextItem` snapshots the PREVIOUS content
    // (request.content is applied below), so diff(previous, new). A metadata-only
    // edit (no `content`) leaves both columns null. This runs BEFORE the
    // `signalEdit` hook below — order preserved.
    const editDelta =
      request.content !== undefined
        ? diffContent(contextItem.content, request.content, await this.resolveDiffTemplate(tenantId))
        : { contentDiff: null, fieldChanges: null };
    version.contentDiff = editDelta.contentDiff;
    version.fieldChanges = editDelta.fieldChanges as unknown as JsonValue | null;

    await this.encryptBestEffort('ContextItemVersion', () =>
      this.contextItemVersionRepository.encryptFieldsIntoEntity(version, this.secretsService!),
    );
    contextItem.currentVersionNumber = versionNumber;

    if (request.content !== undefined) {
      contextItem.content = request.content;
    }

    contextItem.updatedBy = editedBy;

    // Encrypt the edited content into `encryptedContent` before
    // persistence — the plaintext `content` column was dropped by the PHI
    // field-encryption migration, and a bare property assignment (above) is
    // invisible to the change-tracked persistence mapper (no such column), so
    // skipping this call silently drops the clinician's edit at rest (mirrors
    // context.service.ts `encryptContent`).
    await this.encryptBestEffort('ContextItem content', () => this.contextItemRepository.encryptContentIntoEntity(contextItem, this.secretsService!));

    // Compare-And-Set against `_version` — the CAS predicate is
    // the `@RequiresIfMatch()`-gated `expectedVersion` folded onto the DTO by
    // the controller. Drift throws `OptimisticConcurrencyException` -> 412.
    //
    // The version row and the CAS MUST share one transaction. The insert
    // consumes `(contextItemId, versionNumber)`, which is UNIQUE, while the CAS
    // is what decides whether this edit is allowed at all. Inserting first and
    // OUTSIDE a transaction left an orphan version row behind every rejected
    // (412) write, and because a rejected write never advances
    // `currentVersionNumber`, the next legitimate edit recomputed the SAME
    // `versionNumber` and died on
    // `ContextItemVersion_contextItemId_versionNumber_key` (P2002 -> 409):
    // one stale `If-Match` permanently wedged the summary.
    const writeVersionAndCas = async (tx?: CorePrisma.TransactionClient) => {
      const saved = await this.contextItemVersionRepository.create(version, tx);
      const row = await this.contextItemRepository.updateWithVersion(contextItemId, contextItem, request.expectedVersion, tx);
      return { saved, row };
    };
    // Without the unit of work (direct-construction fixtures) both writes still
    // run, just unguarded — identical to the behaviour before this fix.
    const { saved: savedVersion, row: updated } = this.unitOfWork
      ? await this.unitOfWork.runInTransaction((tx: CorePrisma.TransactionClient) => writeVersionAndCas(tx))
      : await writeVersionAndCas();

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: contextItem.changes,
      previousData: previousData as object,
    });

    // TASK-1034 — capture the clinician's edited note as DNA writing-style memory (EDIT).
    // After the commit, through an async event, so it can never fail or delay the edit.
    if (request.content !== undefined) {
      this.requestDnaMemoryCapture({ tenantId, consultationId: contextItem.consultationId, contextItemId, source: 'EDIT' });
    }

    // If this edit lands while the draft is still
    // under optimistic assurance (processing SUMMARIZING), forward it to the
    // harness so the running workflow re-binds + re-runs assurance on the edited
    // version (Q3) and permanently disables silent regen-if-untouched (Q1).
    // Best-effort: the MODIFIED_SUMMARY version write above is the source of
    // truth — a signal failure must never roll back the (committed) edit. Edits
    // in any other processing state have no assurance window, so they no-op.
    try {
      const consultation = await this.consultationRepository.findById(contextItem.consultationId);
      if (consultation?.processing === ConsultationProcessing.SUMMARIZING) {
        await this.harnessGatewayService?.signalEdit(contextItem.consultationId, {
          content: contextItem.content ?? '',
          contextItemVersionId: savedVersion?.id ?? version.id,
          editedBy,
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
   * Approve and lock a summary — the per-summary route, kept one release for older clients.
   *
   * Approval is a property of the whole consultation now: this delegates to the session approve
   * (`IConsultationLifecycleService.approve` with `legacyContextItemId`), which signs this note
   * through {@link prepareSessionSignature}, snapshots every item, locks the record and writes the
   * WORM trail. The caller's If-Match stays the NOTE's version. Idempotent: an approved (or
   * approved-and-closed) consultation answers the existing signature.
   */
  async approveSummary(
    contextItemId: string,
    options?: { overrideSafetyFlag?: boolean; expectedVersion?: number; clinicianUserId?: string; caller?: ClinicalCaller },
  ): Promise<{ contextItemId: string; approvalStatus: string; approvedBy: string; approvedAt: string }> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // (audit C-3) — assert the target summary belongs to the caller's tenant before anything else.
    const contextItem = await assertParentInScope(this.contextItemRepository, contextItemId, tenantId);
    if (!contextItem.isFinalSummary) {
      throw new BadRequestException(`Context item ${contextItemId} is not a final summary`);
    }

    const lifecycle = this.lifecycleService();
    if (!lifecycle) {
      throw new ServiceUnavailableException('Consultation approval is unavailable: the lifecycle service is not wired.');
    }
    await lifecycle.approve(contextItem.consultationId, {
      expectedVersion: options?.expectedVersion as number,
      clinicianUserId: options?.clinicianUserId,
      overrideSafetyFlag: options?.overrideSafetyFlag,
      caller: toLifecycleCaller(options?.caller),
      legacyContextItemId: contextItemId,
    });

    const [signed] = await this.contextItemVersionRepository.getVersionsByChangeReason(contextItemId, 'approved');
    return {
      contextItemId,
      approvalStatus: 'APPROVED',
      approvedBy: signed?.changedBy ?? 'unknown',
      approvedAt: (signed?.createdAt ?? new Date()).toISOString(),
    };
  }

  /**
   * The note-signing core of the session approve (`SessionNoteSigner`). Resolves WHO attests and
   * readies the consultation's final note — `legacyContextItemId`, else the latest final summary —
   * as an attested SIGNED_NOTE version. Writes NOTHING: the approval service persists the version,
   * the note's compare-and-set and the WORM rows in one transaction.
   *
   * RELAXED sign-off governance (clinician autonomy + full audit, doc 08):
   *   Q2a — signing BEFORE assurance lands is allowed; `signedBeforeAssurance` tells the caller
   *         to annotate SIGNED_BEFORE_ASSURANCE so the late-verdict path can correlate.
   *   Q4 — a COMPLETED safety FLAG hard-blocks (409) UNLESS `overrideSafetyFlag`, which the
   *         caller records as SAFETY_OVERRIDE. A REGEN/groundedness flag stays signable.
   *
   * A note whose CURRENT version is already a signature (an approve → reopen → approve with no
   * edit in between) is not signed again: `version` is null and the existing signature is reused.
   */
  async prepareSessionSignature(input: {
    tenantId: string;
    consultationId: string;
    legacyContextItemId?: string;
    clinicianUserId?: string;
    caller?: SessionSignerCaller;
    overrideSafetyFlag?: boolean;
  }): Promise<PreparedSessionSignature> {
    const { tenantId } = input;

    let contextItem = input.legacyContextItemId
      ? await assertParentInScope(this.contextItemRepository, input.legacyContextItemId, tenantId)
      : ((await this.contextItemRepository.findLatestModifiedSummary(input.consultationId)) ??
        (await this.contextItemRepository.findLatestRawSummary(input.consultationId)));
    if (contextItem && (!contextItem.isFinalSummary || contextItem.consultationId !== input.consultationId)) {
      throw new BadRequestException(`Context item ${contextItem.id} is not a final summary of this consultation`);
    }

    // TASK-972 Lane 1 — WHO attested (the resolved CLINICIAN), and WHICH credential submitted it.
    const { clinicianId: approvedBy, caller: actor } = await this.resolveActingClinician(tenantId, input.clinicianUserId, input.caller);

    if (!contextItem) {
      return { approvedBy, actor, note: null };
    }

    const currentVersionNumber = (contextItem.currentVersionNumber as number) ?? 0;
    const existing = (await this.contextItemVersionRepository.getVersionsByChangeReason(contextItem.id, 'approved')).find(
      (version) => version.versionNumber === currentVersionNumber,
    );
    if (existing) {
      return {
        approvedBy,
        actor,
        note: {
          contextItem,
          version: null,
          versionId: existing.id,
          versionNumber: currentVersionNumber,
          attestationHash: existing.attestationHash ?? '',
          attestedAt: existing.attestedAt ?? existing.createdAt,
          signedBeforeAssurance: false,
          safetyOverride: false,
        },
      };
    }

    // The draft's SummaryMeta carries the two-phase assurance state. Legacy single-shot drafts
    // stamp `assuranceCompletedAt` at persist and manual summaries have no SummaryMeta at all —
    // neither flag is set for them, so they sign through with no annotations.
    const draftMeta = await this.summaryMetaRepository.findByContextItem(contextItem.id);
    const signedBeforeAssurance = !!draftMeta && !draftMeta.assuranceCompletedAt;
    const safetyFlagged = !!draftMeta && SummaryService.hasSafetyFlag(draftMeta);
    if (safetyFlagged && !input.overrideSafetyFlag) {
      throw new ConflictException(
        'This draft was flagged by the safety sensor and cannot be signed. Escalate for clinical review, or sign with an explicit safety override.',
      );
    }

    const versionNumber = currentVersionNumber + 1;
    const attestedAt = new Date();
    const attestationHash = this.computeAttestationHash({
      contextItemId: contextItem.id,
      versionNumber,
      content: contextItem.content ?? '',
      attestedBy: approvedBy,
      attestedAt,
    });
    const version = ContextItemVersionFactory.CreateSignedNoteVersion({
      tenantId,
      contextItemId: contextItem.id,
      versionNumber,
      content: contextItem.content ?? undefined,
      attestedBy: approvedBy,
      attestationHash,
      attestedAt,
      changeSummary: 'Approved and locked',
    });

    // The cumulative AI-draft → approved delta, so the final divergence is captured even when the
    // doctor signs without an intermediate edit. Skipped for drafts that predate the immutable
    // `ai_draft_v1` snapshot (their signed note keeps null delta columns).
    const draftBaseline = await this.resolveAiDraftBaseline(contextItem.id);
    if (draftBaseline !== null) {
      const signDelta = diffContent(draftBaseline, contextItem.content, await this.resolveDiffTemplate(tenantId));
      version.contentDiff = signDelta.contentDiff;
      version.fieldChanges = signDelta.fieldChanges as unknown as JsonValue | null;
    }
    await this.encryptBestEffort('ContextItemVersion', () =>
      this.contextItemVersionRepository.encryptFieldsIntoEntity(version, this.secretsService!),
    );

    contextItem.currentVersionNumber = versionNumber;
    contextItem.updatedBy = approvedBy;
    // Keep every ContextItem persist on this path running the same cipher call.
    const note = contextItem;
    await this.encryptBestEffort('ContextItem content', () => this.contextItemRepository.encryptContentIntoEntity(note, this.secretsService!));
    contextItem = note;

    return {
      approvedBy,
      actor,
      note: {
        contextItem,
        version,
        versionId: version.id,
        versionNumber,
        attestationHash,
        attestedAt,
        signedBeforeAssurance,
        safetyOverride: safetyFlagged,
      },
    };
  }

  /**
   * The post-commit half of the signing core (`SessionNoteSigner`). Every step is best-effort and
   * runs only after the approval committed — none can fail, delay or roll back a signature.
   */
  async afterSessionSigned(input: {
    tenantId: string;
    consultation: ConsultationEntity;
    note: PreparedNoteSignature | null;
    approvedBy: string;
    actor: SessionSignerCaller;
  }): Promise<void> {
    const { tenantId, consultation, note, approvedBy, actor } = input;

    if (note) {
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: note.contextItem.id,
        responsibleEntityId: approvedBy,
        data: {
          approvalStatus: 'APPROVED',
          consultationStatus: consultation.status,
          attested: true,
          // TASK-972 Lane 1 — the credential, named beside the clinician.
          actorPrincipalId: actor.principalId,
          actorCredentialClass: actor.credentialClass,
        },
      });
    }

    // Forward the sign-off to the harness so it can resolve the workflow's approval wait. Only for
    // a default-engine consultation (TASK-1022): a consultation governed by a tenant workflow never
    // starts `harness-doc-<consultationId>`; its review is released below instead.
    if (note && !tenantWorkflowGoverns(consultation.metadata)) {
      try {
        await this.harnessGatewayService?.signalApproval(consultation.id, {
          tenantId,
          contextItemVersionId: note.versionId,
          attestationHash: note.attestationHash,
          clinicianId: approvedBy,
        });
      } catch (error) {
        this.logger.warn({
          message: 'Harness approval signal failed (best-effort, sign-off not rolled back)',
          consultationId: consultation.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // TASK-972 Lane 3 (TASK-933 H3-6) — release the GOVERNING run's review. Never throws.
    await this.releaseGoverningWorkflowReview(tenantId, consultation);

    if (!note || !note.version) return;

    // The gate-edit learning loop — the only live writer of `GateEditExemplar`. `enqueue` only
    // adds a job; the comparison, redaction and persistence happen in the worker.
    try {
      await this.gateEditMiningQueue?.enqueue({
        tenantId,
        consultationId: consultation.id,
        contextItemId: note.contextItem.id,
        // WHOSE writing this is: the consultation's own doctor, not the signer.
        doctorId: consultation.doctorId ?? null,
        // A clinician sign-off; 'SIGNED' is a CLEAN_DECISIONS token in `edit-burden.ts`.
        gateDecision: 'SIGNED',
        signedAt: note.attestedAt.toISOString(),
      });
    } catch (error) {
      this.logger.warn({
        message: 'Gate-edit mining enqueue failed (best-effort, sign-off not rolled back)',
        consultationId: consultation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // TASK-1034 — capture the signed note as DNA writing-style memory (SIGNOFF).
    this.requestDnaMemoryCapture({ tenantId, consultationId: consultation.id, contextItemId: note.contextItem.id, source: 'SIGNOFF' });
  }

  /** The lifecycle command service, resolved lazily: the lifecycle module imports this one. */
  private lifecycleService(): IConsultationLifecycleService | null {
    if (!this.moduleRef) return null;
    try {
      return this.moduleRef.get<IConsultationLifecycleService>(IConsultationLifecycleServiceToken, { strict: false });
    } catch {
      return null;
    }
  }

  /** TASK-1034 — fire-and-forget DNA memory capture; a throwing emitter is logged, never raised. */
  private requestDnaMemoryCapture(request: DnaMemoryCaptureRequest): void {
    try {
      this.eventEmitter.emit(DNA_MEMORY_CAPTURE_EVENT, request);
    } catch (error) {
      this.logger.warn({
        message: 'DNA memory capture request failed (best-effort, clinical action unaffected)',
        consultationId: request.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * TASK-972 Lane 3 (TASK-933 defect H3-6) — release the review gate of the run that is actually
   * GOVERNING this consultation.
   *
   * ## The defect
   *
   * `signalApproval` posts to `/internal/workflows/{consultationId}/signal/approve`, which the
   * harness documents as forwarding to that consultation's `harness-doc-<consultationId>`
   * workflow — Substrate A. A consultation governed by a tenant-authored graph runs under the
   * `WorkflowInterpreter` (Substrate B), where that execution does not exist: the POST fails, the
   * failure is swallowed because the signal is best-effort by design, and the run sits on its
   * review gate indefinitely. That is the mode behind the one genuinely stranded session measured
   * on the dev cluster (§2b).
   *
   * ## Why the decide path, and not a new signal
   *
   * `WorkflowExposureService.decideReview` already exists, already addresses the review CHILD by
   * `(runId, nodeId)`, and already re-proves that the run belongs to this tenant and to this
   * slug. That last part is not incidental: `Consultation.metadata` is client-writable, so the
   * pointer this method reads is FORGEABLE — routing through `decideReview` means a forged
   * `workflowRunId` meets the same 404-over-403 ownership check any other caller would, instead
   * of being signalled by the platform's own credentials. No new harness endpoint and no change
   * to `review_workflow.py`, so there is no replay exposure either.
   *
   * ## Why every failure here is NORMAL
   *
   * Under OD-2 the external consumer keeps its blind auto-approve, so by the time a clinician
   * signs, the gate has usually been released already. *Pointer absent* (Substrate A governs),
   * *gate already closed* and *run already completed* are therefore expected outcomes, not
   * errors — each is logged and the sign-off continues. The WORM `ATTEST` row is the clinical
   * system-of-record; a graph gate that cannot be released must never fail a signature, exactly
   * as `signalApproval` before it must not.
   *
   * The reviewer recorded on the decision is whatever CLS holds, because `ReviewDecisionRequest`
   * deliberately refuses a `reviewerId` from its caller (a decision is an attribution). For a
   * machine sign-off that is nobody — which is correct: the clinician's attestation lives on the
   * WORM row, and this is the graph resuming, not a second clinical act.
   */
  private async releaseGoverningWorkflowReview(tenantId: string, consultation: { metadata?: unknown } | null): Promise<void> {
    const marker = readGoverningEngineMarker(consultation?.metadata);
    if (!marker) return;
    if (!this.workflowExposure || !this.workflowDefinitionRepository || !marker.workflowDefinitionSlug) {
      this.logger.log({
        message: 'Governing-run review not released — no exposure/definition resolver wired, or the marker names no definition',
        runId: marker.workflowRunId,
      });
      return;
    }

    let nodeIds: string[];
    try {
      const definition = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, marker.workflowDefinitionSlug);
      const graph = definition?.graph as unknown as { nodes?: Array<{ id?: string; type?: string }> } | null | undefined;
      nodeIds = (graph?.nodes ?? []).filter((node) => node?.type === HUMAN_REVIEW_NODE_TYPE && node.id).map((node) => node.id as string);
    } catch (error) {
      this.logger.warn({
        message: 'Governing-run review not released — the governing definition could not be read (sign-off not rolled back)',
        runId: marker.workflowRunId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (nodeIds.length === 0) return;

    for (const nodeId of nodeIds) {
      try {
        const result = await this.workflowExposure.decideReview(marker.workflowDefinitionSlug, marker.workflowRunId, nodeId, {
          decision: 'approved',
        });
        this.logger.log({
          message: 'Governing-run review released on sign-off',
          runId: marker.workflowRunId,
          nodeId,
          signaled: result?.signaled === true,
        });
      } catch (error) {
        // Already closed, already completed, not exposed, or unreachable — all NORMAL here.
        this.logger.log({
          message: 'Governing-run review not released (gate already closed, run finished, or unreachable) — the sign-off stands',
          runId: marker.workflowRunId,
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * TASK-972 Lane 1 — the clinician a write is attributed to, and the credential that submitted it.
   *
   * Three steps, in this order and for this reason:
   *
   *  1. classify the CREDENTIAL. A controller that has one passes it (the API-key class is the
   *     only one CLS cannot answer for, because there is no `apiKey` CLS key). Absent, it is
   *     derived: a service account has its own CLS principal, anything else is a human JWT — so
   *     every pre-existing in-process and fixture call site keeps its behaviour byte-identically.
   *  2. apply the RULE (`resolveAttributedClinician`) — a 400 naming what is wrong, never a 403:
   *     the request is refused on WHO it names, and there is no row to protect.
   *  3. assert MEMBERSHIP for a named third party — a 404, the house cross-tenant posture, and
   *     doubly right here because a clinical note is PHI. Skipped when the resolved clinician IS
   *     the caller, who proved membership by authenticating.
   */
  private async resolveActingClinician(
    tenantId: string,
    named: string | undefined,
    caller: ClinicalCaller | undefined,
  ): Promise<{ clinicianId: string; caller: ClinicalCaller }> {
    const serviceAccount = this.requestServiceAccount;
    const effectiveCaller: ClinicalCaller =
      caller ??
      (serviceAccount
        ? { credentialClass: 'service-account', principalId: serviceAccount.id }
        : { credentialClass: 'jwt', principalId: this.requestUserId ?? '' });

    const clinicianId = await resolveAttributedClinician({
      named,
      caller: effectiveCaller,
      tenantId,
      requestUser: this.requestUser,
      readTenantRoles: tenantRoleReaderFor(this.userRoleAssignmentRepository),
    });

    if (clinicianId !== this.requestUserId) {
      await assertAttributedClinicianInTenant(
        {
          userRoleAssignmentRepository: this.userRoleAssignmentRepository,
          userDepartmentRepository: this.userDepartmentRepository,
          userRepository: this.userRepository,
        },
        clinicianId,
        tenantId,
      );
    }

    return { clinicianId, caller: effectiveCaller };
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
   *
   * TASK-1001 (wave 2, final note) — plus `sections`: the note split at its headings, each carrying
   * the cross-section `duplicate` flags computed over this FINAL text (`final-note-sections.ts`).
   * This is the note a client shows once the consultation is finalised; the live flags describe the
   * text as it was being written and do not survive the finalizer's rewrite. `content` is returned
   * exactly as persisted — the sections only LOCATE text in it.
   */
  async getLatestSummary(consultationId: string): Promise<SummaryResponse | null> {
    // Try to get latest modified summary first, then raw summary
    let summary = await this.contextItemRepository.findLatestModifiedSummary(consultationId);
    if (!summary) {
      summary = await this.contextItemRepository.findLatestRawSummary(consultationId);
    }
    if (!summary) return null;
    const response = SummaryDtoMapper.toResponse(summary);

    // Fewer than two headed sections has nothing to compare across — and no reason to read rows.
    if (splitHeadedNote(response.content).length < 2) return response;
    const sections = finalNoteSections(response.content, await this.documentSectionKeysByTitle(consultationId));
    return sections ? { ...response, sections } : response;
  }

  /**
   * TASK-1001 (wave 2, final note) — the consultation's own section keys, by title, so a final
   * `duplicate` flag names a section by the key `GET consultations/:id/documents/sections` reports.
   *
   * Enrichment, never a precondition: no repository, no tenant, or a failed read answers an empty
   * map and the note's headings derive the keys. Reads keys and titles only — no content, so
   * nothing is decrypted.
   */
  private async documentSectionKeysByTitle(consultationId: string): Promise<Map<string, string>> {
    const tenantId = this.tenantId;
    if (!this.documentSectionRepository || !tenantId) return new Map();
    try {
      return sectionKeysByTitle(await this.documentSectionRepository.findByConsultation(tenantId, consultationId));
    } catch (error) {
      this.logger.warn({
        message: 'Document sections could not be read for the final note`s section keys — deriving them from its headings',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }
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
   * harness wrote, plus the cited transcript segments so a
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
   * Resolve the transcript segments cited as evidence for a
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

    // hop 1 — pseudonymize BEFORE the text leaves this process.
    // `pseudonymize` (not `full`): NER exists to extract the clinical entities,
    // and GLiNER's PII taxonomy never covers medication/condition spans, so
    // they survive verbatim while identifiers become stable `[PERSON_1]`-style
    // tokens (see `IPhiRedactor`'s mode doc).
    //
    // Fail-closed on BOTH failure shapes, with no silent fallback to raw text:
    //  - redactor unwired → throw here (the dependency is non-`@Optional()`,
    //                        so in production this is unreachable — it is the
    //                        belt to the DI braces, not the primary guard);
    //  - redactor throws → propagate, aborting before `callNlpService`.
    if (!this.phiRedactor) {
      throw new BusinessException('PHI redactor is not available; refusing to send unredacted content to the NLP service');
    }
    const redactedContent = await this.phiRedactor.redact(contextItem.content, 'pseudonymize');

    // TASK-890 (§3.13) — the NLP text-unit allowance. `ner.extract` rows were
    // RECORDED and never GATED: the allowance existed and nothing consulted
    // it. Post-hoc debit (D6), the same call shape the summary path uses —
    // kill-switch-gated inside, → 429 once over. Placed after redaction and
    // before the call, so a refused tenant's content never leaves the process.
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlyNlpTextUnits');

    // TASK-999 (D-2(c)) — time the hop. `apps/nlp` reports its own `inference_ms` and that is
    // preferred; this wall clock is the fallback, so a duration reaches the `ner.extract` ledger
    // row even against an NLP build that reports none. Measured around the CALL only — the
    // redaction and the persistence loop below are this service's own time, not NER's.
    const nlpStartedAt = Date.now();
    const nerResponse = await this.callNlpService(redactedContent);
    const nlpWallClockMs = Date.now() - nlpStartedAt;
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

    // Per-invocation ner.extract usage row — keyed
    // on a freshly generated requestId for THIS synchronous call (this path
    // has no natural durable job id the way an async BullMQ job would),
    // never on consultationId (attribution only — shares `buildNerUsageEvent`
    // with what was, before deleted it, the legacy async NER
    // generator's own usage event, so the shape couldn't drift; that shared
    // helper now has only this one caller). No business
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
            // TASK-999 (D-2(c)) — the per-call DURATION, recorded ONCE, here.
            //
            // It becomes a single CPU_SECOND/GPU_SECOND row on this `ner.extract` event
            // (`appendComputeAndByteUnits`), which is the ledger's existing timing mechanism —
            // not a second duration column. `NamedEntity.processingTimeMs` stays for
            // back-compat and is no longer the duration source: it is stamped identically on
            // every entity of one call, so summing it multiplies one duration by the entity
            // count. This path never set it at all, which is why the clinical NER hop had no
            // summable duration anywhere.
            inferenceMs: nerInferenceMs(nerResponse.inference_ms),
            totalMs: nlpWallClockMs,
            device: nerDevice(nerResponse.device),
            // TASK-957 F-8 — this hop is reached from exactly one place: a
            // consultation's context item. The agent NER route and the
            // playground bench declare their own.
            trigger: 'CONSULTATION',
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
   * The single TEXT call path for this service's generation (`generatePreSummary`), on the
   * tenant's `finalize` text selection (B-03 / B-04). Resolves the tenant's effective
   * {provider, model} EXPLICITLY (never relies on `resolveTextSelection()`'s own CLS fallback — a
   * worker path with unpopulated CLS must fail loudly, not silently serve the SYSTEM default),
   * then runs the request with the bounded corrective-JSON retry. On a provider-side failure,
   * retries EXACTLY ONCE against the tenant's configured `text.finalize.fallback` selection; an
   * unconfigured/no-op fallback propagates the ORIGINAL error.
   */
  private async callTextService(payload: TextCallPayload): Promise<TextCallResult> {
    let tenantId: string | undefined;
    if (this.harnessPolicyService) {
      tenantId = this.tenantId ?? undefined;
      if (!tenantId) {
        throw new BadRequestException('Tenant ID is required');
      }
    }

    // The caller's `options` ride along but NEVER select the engine (TASK-1012 item 11):
    // model-selecting keys are dropped before the resolved pair is merged in.
    const callerOptions = withoutCallerModelSelection(payload.options);
    let options = callerOptions;
    // TASK-891 — the resolved selection's `generation` block, carried alongside
    // {provider, model} so its reasoning posture can reach `applyTextRuntimeProfile` below.
    let generation: Record<string, unknown> | undefined;
    let deploymentKind: string | undefined;
    if (this.harnessPolicyService && tenantId) {
      // The assigned `TEXT_GENERATION` agent; the A4 fallback retry below stays
      // TENANT-configured.
      const selection = await this.harnessPolicyService.resolveTextSelection(tenantId, 'finalize', payload.departmentId ?? null);
      options = { ...callerOptions, textProvider: selection.provider, textModel: selection.model };
      generation = selection.generation;
      deploymentKind = selection.deploymentKind;
    }

    try {
      return await this.executeTextGenerate(payload, options, generation, deploymentKind);
    } catch (primaryError) {
      if (tenantId && this.harnessPolicyService && this.isTextFallbackEligible(primaryError)) {
        const fallback = await this.harnessPolicyService.resolveTextFallbackSelection(tenantId, 'finalize', payload.departmentId ?? null);
        const primaryProvider = (options as Record<string, unknown> | undefined)?.textProvider;
        if (fallback && fallback.provider !== primaryProvider) {
          const fallbackOptions = { ...options, textProvider: fallback.provider, textModel: fallback.model };
          try {
            // TASK-891 — the FALLBACK selection's own `generation`, not the primary's: a
            // different agent may serve, and it carries its own reasoning posture.
            const result = await this.executeTextGenerate(payload, fallbackOptions, fallback.generation, fallback.deploymentKind);
            this.logger.warn({
              message: 'Primary TEXT finalize call failed; served via tenant-configured fallback',
              fallbackProvider: fallback.provider,
            });
            return result;
          } catch (fallbackError) {
            // Surface the ORIGINAL primary error below — the primary failure is
            // the one the caller's request actually hit.
            this.logger.warn({
              message: 'Tenant-configured TEXT fallback also failed for finalize',
              fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            });
          }
        }
      }
      // this used to be
      // `BadRequestException(\`Failed to call TEXT service: ${primaryError}\`)`,
      // which answered 400 for an ABSENT dependency and handed the caller
      // `connect ECONNREFUSED 127.0.0.1:8862`. Rethrow the CAUSE instead: the
      // gateway boundary (`apps/api/src/filters/downstream-error.ts`, applied by
      // `ExceptionInterceptor`) classifies it — transport ⇒ 503, upstream 5xx ⇒
      // 502, upstream 4xx propagated — and is the only thing that builds the
      // client-facing body. This service must not, and cannot: it is one layer
      // below the HTTP contract and its other callers are queue processors.
      this.logger.error({
        message: 'TEXT finalize call failed; rethrowing the cause for the gateway boundary to classify',
        causeMessage: primaryError instanceof Error ? primaryError.message : String(primaryError),
      });
      throw primaryError;
    }
  }

  /**
   * Fallback is eligible for provider-side failures: an upstream RESPONSE
   * error (TEXT answered with an error — the LLM/provider failed) OR a
   * parse/mapping failure (unparseable content, thrown by
   * `generateJsonWithRepair`/`mapTextGenerateResponse`). NOT eligible when TEXT
   * itself was unreachable (a connect-phase transport error with no
   * response) — retrying a different provider through the same unreachable
   * gateway cannot help.
   */
  private isTextFallbackEligible(err: unknown): boolean {
    const axiosError = err as AxiosError;
    if (axiosError?.response !== undefined) return true; // TEXT responded with an error
    if (typeof axiosError?.code === 'string') return false; // connect-phase / unreachable TEXT
    return true; // parse/mapping failure
  }

  /**
   * One TEXT generate attempt (with the bounded corrective-JSON retry).
   * Raw errors propagate uncaught so `callTextService` can decide fallback
   * eligibility from the original shape before wrapping into
   * `BadRequestException`.
   */
  private async executeTextGenerate(
    payload: TextCallPayload,
    options: Record<string, unknown> | undefined,
    // TASK-891 — the RESOLVED selection's `parameters.generation`, when this attempt was made
    // on behalf of one (primary or fallback). Its `reasoning` block becomes the `extra`
    // ride-along below. Absent on the no-policy-service path, where there is no resolved agent
    // to have an opinion.
    generation?: Record<string, unknown>,
    // `AiModel.deploymentKind` of the row serving this attempt, for the egress `provider_locality`.
    deploymentKind?: string,
  ): Promise<TextCallResult> {
    const textPayload = buildTextGeneratePayload(payload.assembledPrompt, options, payload.context);
    // (OD-9 exemption: credential injection ONLY) — this path reached
    // TEXT with no `provider_overrides` entry at all, so every generation 503'd
    // with PROVIDER_CREDENTIALS_MISSING once lane B (`70eec34d5`)
    // removed TEXT's per-provider env plane. Injected through the ONE shared
    // implementation so the tenant → SYSTEM cascade and the `funding` label
    // that derives metering both apply. Awaited BEFORE the repair loop below so
    // the original and the corrective retry post byte-identical credentials.
    // layer the platform admin's runtime profile (hyperparameters + engine
    // extras such as `reasoning_effort`) BEFORE the credential fold, exactly as the
    // TEXT proxy does. Caller-set fields win; a resolver error injects nothing.
    // TASK-891 — `generation` carries the resolved agent's reasoning posture (OD-4) onto the
    // `extra` ride-along; an agent with no opinion injects nothing.
    await this.textRequestEnrichment?.applyTextRuntimeProfile(textPayload as { provider?: string; model?: string }, generation);
    await this.textRequestEnrichment?.applyTenantProviderOverrides(textPayload as { provider?: string }, {
      deploymentKind: deploymentKind ?? null,
      consultationId: payload.consultationId ?? null,
      phase: 'finalize',
    });
    // D-D: the ONE shared `INTERNAL_ACCESS_TOKEN` (the per-service `TEXT_SERVICE_TOKEN`
    // fallback was retired with its descriptor, TASK-888). `X-Tenant-Id` is MANDATORY on this hop — this
    // path reached Text with no tenant at all, so the tenant's BYOK provider/credential
    // was never resolved and the derived `funding`/`cost_basis` was attributed to
    // the platform tier instead. Both headers are built once, here, by the shared
    // contract rather than a hand-rolled literal.
    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
    const textHeaders = internalServiceHeaders({
      serviceToken,
      tenantId: this.tenantId,
      tenantlessReason: TENANTLESS.PLATFORM_OPERATOR,
    });

    // The SAME bounded corrective retry as the live-doc flush: without it, a
    // structured request that came back as malformed JSON was persisted VERBATIM
    // as the note. The corrective instruction is APPENDED so the prefix-cache-stable lead-in
    // stays byte-identical between the original and the repair call.
    const basePrompt = textPayload.prompt;
    const structuredRequested = textPayload.response_format !== undefined;

    const outcome = await generateJsonWithRepair<string, TextRepairCall>({
      generate: async (retry) => {
        const response = await this.httpService.axiosRef.post(
          `${this.textServiceUrl}/api/v1/generate`,
          {
            ...textPayload,
            prompt: retry ? `${basePrompt}${retry.corrective}` : basePrompt,
            // TASK-1000 — the retry generates under the RAISED budget when one was resolved.
            // Re-asking at the budget that just ran out reproduces the truncation exactly.
            ...(retry?.maxTokens !== undefined ? { max_tokens: retry.maxTokens } : {}),
          },
          { headers: textHeaders },
        );
        const mapped = mapTextGenerateResponse(response.data);
        const data = response.data as { usage_detail?: unknown; guardrail_usage?: unknown } | null;
        return {
          text: mapped.summary,
          mapped,
          stats: SummaryService.parseGenerationStats(response.data),
          usage: parseTextUsageDetail(data?.usage_detail),
          guardrailUsage: parseTextUsageDetail(data?.guardrail_usage),
        };
      },
      // The summary is opaque JSON we persist verbatim, so the strict parse only
      // decides WHETHER the structured contract was honoured — the text passes
      // through unchanged. Storage semantics stay byte-identical to the
      // pre-repair behaviour in every case except the malformed-JSON one.
      parseStrict: (text) => (parsesAsJsonObject(text) ? text : null),
      parseTolerant: (call) => call.text,
      // Retry only a genuine malformed-JSON attempt: structured output was
      // requested AND the text opens a JSON object. Prose (no leading `{`) is
      // the contract on an unstructured request — retrying could never help.
      shouldRepair: (first) => structuredRequested && looksLikeJsonObject(first.text),
      // TASK-1000 OD-8 — this path has the SAME truncation exposure as the live flush and a
      // worse consequence: `parseTolerant` returns the text verbatim, so a cut-off generation was
      // persisted as the whole note rather than being confined to one section. Raising here routes it into this method's existing failure handling instead.
      // `stopReason` was already recorded onto `SummaryMeta` — it is now also acted on.
      // Scoped to a STRUCTURED request for the reason the live flush documents: a truncated
      // prose note is readable text a clinician can finish, while a truncated JSON document is a
      // fragment that would be persisted as the note's entire body.
      isTruncated: (call) => structuredRequested && call.stats?.stop_reason === 'length',
      // Double whatever budget this payload carries; `undefined` when it carries none, which
      // leaves the text service's own default in place exactly as before.
      repairMaxTokens: typeof textPayload.max_tokens === 'number' && textPayload.max_tokens > 0 ? textPayload.max_tokens * 2 : undefined,
    });

    const finalCall = outcome.calls[outcome.calls.length - 1];
    if (outcome.repaired) {
      this.logger.warn({
        message: 'TEXT finalize response failed the structured-output contract; one corrective retry applied',
        repairSucceeded: parsesAsJsonObject(outcome.value),
      });
    }
    // Cost fields are additive across the (at most two) calls — the repair really
    // did spend those tokens/that time. Everything else describes the call whose
    // text became the stored note.
    const sumAcrossCalls = (pick: (call: TextRepairCall) => number | undefined): number | undefined => {
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
      // A repair attempt is a SEPARATE TEXT request with its own task id, so it
      // bills as its own ledger event rather than being folded in here — the
      // per-unit sums above would silently merge two idempotency identities.
      usage: finalCall.usage,
      guardrailUsage: finalCall.guardrailUsage,
    };
  }

  /**
   * read the AD-1 GenerationStats headline fields off the
   * TEXT `/generate` response. Returns `null` when the `stats` block is absent
   * (legacy response) or null (idempotency-cache hit) so the caller persists
   * nothing extra. Null-safe per field — never throws over missing/odd stats.
   */
  private static parseGenerationStats(data: unknown): TextGenerationStats | null {
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

  /**
   * TASK-1001 (owner decision 2026-09-23) — the language the note is WRITTEN in, as the tag this
   * surface feeds `PromptAssemblyService` under its historical name, `conversationLanguage`.
   *
   * That name is misleading and the misreading was the defect. What the value actually DOES is
   * decide the OUTPUT: it renders as `{{conversation_language}}` into bodies that say "write the
   * content in the conversation language", and through `buildPreSummaryVariables` it becomes the
   * pre-summary's `{{language_name}}` ("Write ALL bullet content in …"). So it was fed the
   * consultation's declared SOURCE language — and a consultation ALaaS opens as `ml-en`
   * (Malayalam-led code-switch) was told to write its note in the conversation language.
   *
   * Owner decision: *"The summarization (both pre-summary and summary) is still in English, by
   * admin configuration OR by default."* On this surface the tenant's configuration cannot be
   * SELECTED — `PromptAssemblyService` resolves the agent's primary template, not its fragment list,
   * so an output-language policy fragment never reaches this prompt — which leaves the platform
   * default, `consultation.summary.outputLanguage` (English unless a platform admin changes it).
   *
   * Two sources are therefore deliberately NOT consulted any more:
   *  - the consultation's declared language (`readSummaryLanguage`) — it describes what is SPOKEN;
   *  - per-request `options.conversationLanguage` / `options.language` / `options.locale` — a
   *    caller's per-call language is neither admin configuration nor the default, and a client that
   *    forwards its STT locale there would reproduce the same code-switched note.
   *
   * Never throws: a settings-backend failure is logged and the note is written in the code default
   * rather than failing a clinician's summary.
   *
   * Returns the tag (what assembly binds) with its name. The one read shared with the
   * chain-summary and queue paths: `resolvePlatformOutputLanguage`.
   */
  private resolveNoteOutputLanguage(tenantId: string): Promise<OutputLanguage> {
    return resolvePlatformOutputLanguage(this.effectiveSettings, tenantId, this.logger);
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
     * The resolved `model_name` actually sent to NLP. Always a real model id:
     * resolution is fail-CLOSED, so an unresolved `nlp.ner` throws before the
     * post rather than leaving this unknown.
     */
    modelUsed: string;
    /**
     * TASK-999 (D-2(c)) — the two metering fields `apps/nlp` reports about ITSELF, already
     * present on the wire and already spread into this return value; they were simply not
     * DECLARED, so no caller could reach them. Typed `unknown` deliberately: the body is an
     * unvalidated axios payload, and `nerInferenceMs`/`nerDevice` are the shape checks.
     */
    inference_ms?: unknown;
    device?: unknown;
  }> {
    try {
      // Inject the SYSTEM `nlp.ner` routing election's model
      // (mirrors AiInferenceController's playground mapping) so a global
      // admin's re-point governs this synchronous clinical NER path too, not
      // just the playground. Fail-CLOSED: an unresolved key throws a 503 naming
      // `nlp.ner` here, rather than posting without `model_name` and taking the
      // same 503 back from NLP one hop later, attributed to the wrong thing.
      const modelSelection = await resolveNerModelInjection(this.routingPolicies, this.clsService, this.logger);
      // /738: this call sent NO headers object at all — neither the
      // service token (so it only ever worked against an NLP with the empty-token
      // dev bypass) nor the tenant. NLP delegates tenant-scoped classification on
      // to Text, so an absent tenant propagates two hops before resolving the
      // platform default, silently.
      const serviceToken = await resolveInternalAccessToken(this.secretsService, 'NLP_SERVICE_TOKEN');
      const response = await this.httpService.axiosRef.post(
        `${this.nlpServiceUrl}/api/v1/classify/tokens`,
        { text, ...modelSelection },
        {
          headers: internalServiceHeaders({
            serviceToken,
            tenantId: this.tenantId,
            tenantlessReason: TENANTLESS.PLATFORM_OPERATOR,
          }),
        },
      );
      return { ...response.data, modelUsed: modelSelection.model_name };
    } catch (error) {
      // see `callTextWithTenantFallback`: rethrow the cause, let the
      // gateway boundary classify and build the body. Composing a message here
      // is what leaked the NLP host:port as a 400.
      this.logger.error({
        message: 'NLP token-classification call failed; rethrowing the cause for the gateway boundary to classify',
        causeMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Which device an LLM call's seconds were spent on — `null` when this service has no business
   * naming one (TASK-959 §3.1).
   *
   * A CLOUD or BYOK call is NOT the vendor's hardware: those seconds are the platform's own CPU
   * spent CALLING the vendor, which the appender meters as `cpu` whatever is passed, so nothing
   * is resolved for them and the cascade is not read at all. Only a self-hosted server has a
   * device worth looking up.
   *
   * The provider is read off TEXT's OWN usage block — the engine that actually served — never
   * the one this service asked for: a call that fell back to another engine would otherwise be
   * priced against the device of a server it never touched.
   *
   * `null` also when the resolver is unwired (a positional fixture) or raises despite its
   * contract not to: no compute row, never a guessed one, and never a lost usage batch. The
   * summary is already generated and the clinician is waiting for it.
   */
  private async llmDevice(tenantId: string, usage: TextUsageDetail): Promise<ComputeDevice | null> {
    const provider = toLedgerProvider(usage.textProvider);
    if (resolveDeployment(provider, usage.byok) !== AiDeploymentKind.SELF_HOSTED) return null;
    try {
      return (await this.computeDevice?.resolve(tenantId, provider)) ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Compute device unresolved; metering this generation without a compute row',
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
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
 * Both halves of an augmented pair, each carrying the same stamped dimensions (TASK-959 §6.3).
 *
 * The platform CPU leg of a BYOK call is the same product activity, screened the same way, as
 * the tokens beside it — "why did this cost happen" has one answer per request, not one per cost
 * basis. A pair with no platform leg (every non-BYOK call) flattens to the one batch it always
 * was.
 */
function stampedBatches(pair: ComputeAugmentedBatch | null, attributes: UsageAttributes): UsageEventBatchInput[] {
  if (!pair) return [];
  const halves = pair.platformBatch ? [pair.batch, pair.platformBatch] : [pair.batch];
  return halves.map((batch) => withUsageAttributes(batch, attributes) ?? batch);
}
