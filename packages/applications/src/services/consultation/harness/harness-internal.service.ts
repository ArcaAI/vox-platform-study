import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationRepository,
  DnaWritingStyleReportRepository,
  ConsultationEntity,
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
  ConsultationProcessing,
  HarnessAuditAction,
  HighlightRepository,
  ContextItemEntity,
  NamedEntityEntity,
  ContextItemType,
  TranscriptSegmentRepository,
  McpServerRepository,
  AiModelRepository,
  type AiModelEntity,
  SYSTEM_TENANT_ID,
  ResourceStatusType,
  NotificationType,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { attachSegmentEvidence, extractAndStripSegmentCitationMarkers, type SegmentOffsetRef } from '../lib/transcript-segments';
import { HarnessAuditService } from '../../harness-audit';
// Imported from the leaf modules rather than the package barrel: the barrel
// re-exports `ai-provider-connection.service.module`, and pulling a NestJS
// module in from a service file is how an import cycle starts.
import { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import { PROVIDER_SERVICES, isCloudByoProvider, type ProviderService } from '../../ai-provider-connection/constants';
import { derivedLocalPath } from '../../ai-model/constants';
import { IAiRoutingPolicyService } from '../../ai-routing-policy/IAiRoutingPolicyService';
import type { AiTaskKey } from '../../ai-routing-policy/constants';
import { NLP_NER_TASK_KEY, readClinicalTaxonomy, resolveSystemTaskModel } from '../shared/resolveNerModelSelection';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { validateRedactionRuleSet } from '../../dna-writing-style/redaction-rules';
import { renderDnaRedactionRulesText } from '../../dna-writing-style/redaction-rules-text';
import { IRedisCacheService } from '../../baseServices/redis';
import { HarnessAssuranceService } from './harness-assurance.service';
import { HarnessProgressService } from './harness-progress.service';
import { ConfigResolver } from '../../config-resolver';
import { HarnessPolicyService } from '../../harness-policy/harness-policy.service';
import { selectAuthoritativeNoteText } from './prior-visit-summary';
import { resolveSameDayPrequel, resolveSameDayPrequelTimeZone } from './same-day-prequel';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { PromptAssemblyService, type AssembledPrompt, type NerEntityForPrompt, type PromptAssemblyParams } from '../prompt/prompt-assembly.service';
import {
  CLIENT_INVESTIGATIONS_KIND_KEY,
  CLIENT_VITALS_KIND_KEY,
  clientCaseNoteRenderings,
  clientClinicalContextReaderFor,
} from '../context/client-clinical-context';
import {
  NoteCompositionRequestError,
  NoteInputComposerService,
  NoteInputExceedsContextError,
  NoteModelUnavailableError,
  NoteTemplateUnresolvedError,
  type NoteComposeRequest,
  type NoteSnapshotText,
  type NoteSourceSnapshot,
} from '../note-composition/note-input-composer.service';
import { NoteTokenizerUnavailableError } from '../note-composition/text-token-count.client';
import {
  NOTE_INPUT_EXCEEDS_CONTEXT,
  coverageResultV1Schema,
  type CoverageResultV1,
  type NotePlanEnvelope,
  type NotePlanMode,
  type NotePlanV1,
} from '../note-composition/note-plan.types';
import { formatSessionAgentPromptVersion, readLiveAgentLineage } from '../prompt/live-agent-lineage';
import { IConsultationJobService } from '../jobs/consultation-job.service';
import type { JobStatusType, SummaryJobResult } from '../jobs/dto';
import { IUsageLedgerService } from '../../usageLedger';
import { INotificationService } from '../../notification';
import type { CreateNotificationRequest } from '../../notification/dto';
import { assertEqualTenants, BaseService, createWorkerSession, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { HARNESS_DRAFT_PHASE, HARNESS_PROGRESS_FAILED_STAGE, HARNESS_PROGRESS_TERMINAL_STAGE } from './dto';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService } from '../visit-type/visit-type.service';
import { readRecordedVisitType } from '../consultation/open-markers';
import { readGoverningEngineMarker, withGoverningEngineMarker } from '../governing-engine';
import type {
  HarnessAssembleRequest,
  HarnessAssembleResponse,
  HarnessDraftRequest,
  HarnessDraftResponse,
  HarnessEscalationRequest,
  HarnessEscalationResponse,
  HarnessFinalizeAssuranceRequest,
  HarnessFinalizeAssuranceResponse,
  HarnessEntitiesResponse,
  HarnessProviderCredentialResponse,
  HarnessGateDecisionRequest,
  HarnessGateDecisionResponse,
  HarnessPersistEntitiesRequest,
  HarnessPersistEntitiesResponse,
  HarnessProgressAck,
  HarnessProgressRequest,
  HarnessResolvedModelResponse,
  HarnessSegmentCitationRef,
  HarnessNotePlanSummary,
} from './dto';
import { HARNESS_DRAFT_SUBTYPE } from './harness-draft.constants';
import { IConsultationLifecycleGate, IConsultationLifecycleGateToken } from '../lifecycle/IConsultationLifecycleService';

/**
 * The routing task keys a harness worker may resolve a model for over
 * `GET internal/harness/models/resolve?taskKey=`. Every entry is platform-only
 * (SYSTEM election, `resolveSystemTaskModel`), so no tenant row is consulted.
 */
export const HARNESS_RESOLVABLE_TASK_KEYS: readonly AiTaskKey[] = [NLP_NER_TASK_KEY];

/** A catalogue row in the wire shape the harness worker consumes. */
function toResolvedModelResponse(row: AiModelEntity): HarnessResolvedModelResponse {
  const metaData =
    row.metaData && typeof row.metaData === 'object' && !Array.isArray(row.metaData) ? (row.metaData as Record<string, unknown>) : null;
  const taxonomy = metaData?.labelTaxonomy;
  const labelTaxonomy = taxonomy && typeof taxonomy === 'object' && !Array.isArray(taxonomy) ? (taxonomy as Record<string, unknown>) : undefined;
  const clinicalTaxonomy = readClinicalTaxonomy(metaData);

  return {
    slug: row.slug,
    taskType: String(row.taskType),
    tenantId: row.tenantId,
    sourceUri: row.sourceUri,
    sourceRevision: row.sourceRevision ?? null,
    localPath: derivedLocalPath(row),
    wireModelId: row.wireModelId ?? null,
    servedBy: String(row.servedBy),
    provider: row.provider ?? null,
    format: String(row.format),
    computeType: row.computeType ?? null,
    ...(labelTaxonomy ? { labelTaxonomy } : {}),
    ...(clinicalTaxonomy ? { clinicalTaxonomy } : {}),
  };
}

/** TASK-946 OD-4 — what the gateway's run-completion watcher reports about a terminal run. */
export interface FailGovernedRunInput {
  tenantId: string;
  runId: string;
  /** Only the two outcomes that leave the consultation with nothing to sign. */
  status: 'FAILED' | 'TIMED_OUT';
  /** The interpreter's own terminal reason. PHI-free; `null` when the envelope carried none. */
  reason?: string | null;
  /** When the run ended, from the terminal envelope. Defaults to now. */
  at?: Date;
}

/**
 * The consultation's status AFTER the call — `transitioned: false` means it was left alone.
 * `processing` is present when the call set the processing axis (FAILED).
 */
export interface FailGovernedRunResult {
  transitioned: boolean;
  status: ConsultationStatus;
  processing?: ConsultationProcessing;
}

/** What the gateway's run-completion watcher reports about a run that ended WITHOUT failing. */
export interface RecordGovernedRunCompletedInput {
  tenantId: string;
  runId: string;
  /** True when the run finished with at least one degraded or skipped-for-cause node. */
  degraded: boolean;
  /** When the run ended, from the terminal envelope. Defaults to now. */
  at?: Date;
}

/**
 * The consultation states in which a governed run is still the thing writing the document, so
 * its outcome is worth recording and announcing.
 *
 * `STOPPED` is handled separately and more strongly (it marks processing FAILED); the three here
 * record and announce without touching either axis, because the clinician is still working and
 * the default loop can still produce a note. `APPROVED` and either `CLOSED_*` have already moved
 * past this run, and re-stamping them would rewrite history.
 */
const GOVERNED_RUN_OBSERVABLE_STATUSES: readonly ConsultationStatus[] = [
  ConsultationStatus.OPEN,
  ConsultationStatus.RECORDING,
  ConsultationStatus.PAUSED,
];

/**
 * The processing values the harness callbacks may replace on a STOPPED consultation. The other
 * two belong to other writers — `FINALIZING_TRANSCRIPT` to the stop flow, `PROCESSING_ATTACHMENT`
 * to the attachment pipeline (ref-counted) — and replacing them would let a clinician approve a
 * note while its inputs are still landing.
 */
const HARNESS_WRITABLE_PROCESSING: ReadonlySet<ConsultationProcessing> = new Set([
  ConsultationProcessing.IDLE,
  ConsultationProcessing.SUMMARIZING,
  ConsultationProcessing.AWAITING_REVIEW,
  ConsultationProcessing.FAILED,
]);

/** The reason a harness-doc run that ended `failed` (the note was never persisted) leaves on processing. */
const NOTE_GENERATION_FAILED = 'NOTE_GENERATION_FAILED';

/**
 * The SummaryMeta coverage columns of a delivery: the status and gap count stay plain (queryable,
 * PHI-free), the whole report rides the transient `coverageReport`, which the repository encrypts
 * into `encryptedCoverageReport`. All null for a note that did not come from a plan.
 */
function noteCoverageColumns(coverage: CoverageResultV1 | null): {
  coverageStatus: string | null;
  coverageGapCount: number | null;
  coverageReport: CoverageResultV1 | null;
} {
  if (!coverage) return { coverageStatus: null, coverageGapCount: null, coverageReport: null };
  return { coverageStatus: coverage.status, coverageGapCount: coverage.gaps.length, coverageReport: coverage };
}

/** The consultation states in which the note is signed and therefore immutable. */
const APPROVED_STATUSES: ReadonlySet<ConsultationStatus> = new Set([ConsultationStatus.APPROVED, ConsultationStatus.CLOSED_COMPLETE]);

/** The live-summary channel every realtime consultation frame shares. */
const LIVE_SUMMARY_CHANNEL_PREFIX = 'consultation:live-summary:';

/**
 * HarnessInternalService.
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
export class HarnessInternalService extends BaseService {
  private readonly logger = new Logger(HarnessInternalService.name);

  // Warm-start switch: `HarnessPolicy.warmStartEnabled`, resolved per call (see
  // `resolveWarmStartEnabled`). TASK-882 removed the `HARNESS_WARM_START_ENABLED` env fallback —
  // the column is the one source and a null column is the code default (OFF).

  // Idempotency-Key dedup namespace + TTL for the WORM/draft
  // callbacks. The key value is the harness `{run_id}:{activity_id}` (globally
  // unique); the Redis key additionally namespaces by operation + tenantId.
  private readonly IDEMPOTENCY_KEY_PREFIX = 'idempotency:harness:';
  private readonly IDEMPOTENCY_TTL = 86400; // 24 hours

  // `metaData.subType` marker stamped on the RAW_SUMMARY ContextItem
  // that `persistDraft` creates, so a LATER persist can recognise the harness's
  // OWN prior draft and update it instead of adding a second note.
  //
  // The marker is what makes the adoption safe. Other production paths create
  // RAW_SUMMARY rows for the same consultation — `ChainSummaryService.generateComprehensiveSummary`,
  // `ContextService.addRawSummary` and the comprehensive-summary BullMQ processor —
  // none of which coordinate with the harness.
  // Adopting the newest RAW_SUMMARY unconditionally would let a harness draft
  // OVERWRITE a note this workflow never authored, which is strictly worse than a
  // duplicate. Unmarked rows are therefore never touched: the lookup fails safe to
  // create. (Same `metaData.subType` convention as `LIVE_SOAP_SNAPSHOT`.)
  private readonly HARNESS_DRAFT_SUBTYPE = HARNESS_DRAFT_SUBTYPE;

  // The same ownership idea, for `persistEntities`. `NamedEntity`
  // has no `metaData` column to mark: its `metadata` is Vault-Transit ciphertext
  // (`encryptedMetadata`; the plaintext column was DROPPED) and encryption is a
  // soft no-op outside `SECRETS_PROVIDER=vault`, so it is neither queryable nor
  // reliably present. `aiModelId` is the plaintext, nullable "which recognizer
  // produced this span" column, and it is the honest home for this: these rows
  // ARE the harness NER pass's output.
  //
  // Other production paths create NamedEntity rows — `ContextService`,
  // `SummaryService`, and `ChainSummaryService`'s NER writes (the legacy
  // BullMQ NER generator's own writes were removed with it) — all
  // through `namedEntityPropsFromNlp`, which sets NO `aiModelId`. They routinely
  // cover the SAME transcript ContextItem and the same spans, so scoping by
  // `contextItemId` alone would let this path rewrite rows it never authored.
  // Filtering on this marker means unmarked rows (including harness rows written
  // before this change) are never read, never updated and never removed — the
  // lookup fails safe to CREATE, exactly as `HARNESS_DRAFT_SUBTYPE` does.
  private readonly HARNESS_NER_MODEL_ID = 'HARNESS_NER';

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
    // Optional so existing unit fixtures keep their
    // constructor arity; production DI supplies it via CoreDatabaseModule. The
    // manual-highlight SOAP feed is best-effort enrichment either way.
    @Optional() @Inject(HighlightRepository) private readonly highlightRepository?: HighlightRepository,
    // Optional so existing unit fixtures keep their
    // constructor arity; production DI supplies it via HarnessAssuranceServiceModule.
    // finalizeAssurance publishes the terminal `assurance_complete` here to close
    // the live SSE feed (best-effort — a Redis hiccup must not break finalize).
    @Optional() private readonly assuranceService?: HarnessAssuranceService,
    // Optional so existing unit fixtures keep their constructor
    // arity; production DI supplies it via ConfigResolverModule. Threads the
    // doctor's preferred prompt id (UserProfile.preferredPromptTemplateId, read-only)
    // into assemble so the async/harness path honors Tier-0 like the sync/REST path.
    // Also resolves the effective DNA-style decision
    // (tenant AND doctor) so DNA style is applied on the harness generation path
    // only when the doctor is opted in under an enabling tenant.
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // Write the immutable AI-draft `v1` snapshot at the
    // harness generation boundary (`persistDraft`) for the DNA edit-capture
    // corpus. Optional + trailing so existing positional unit fixtures keep their
    // arity; production DI supplies it via CoreDatabaseModule. When unset the
    // snapshot is a no-op (best-effort), matching the legacy path.
    @Optional() @Inject(ContextItemVersionRepository) private readonly contextItemVersionRepository?: ContextItemVersionRepository,
    // Application-level field encryption for the clinical
    // models this callback half persists (NamedEntity spans, SummaryMeta
    // provenance JSONB, ContextItemVersion snapshots). Optional + trailing so
    // existing positional unit fixtures keep their arity; production DI supplies
    // it via CoreDatabaseModule. Absent ⇒ these PHI fields are left unpersisted
    // (there are no plaintext columns); SECRETS_PROVIDER=vault is fail-closed.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Idempotency-Key dedup for the WORM/draft callbacks. The
    // durable harness workflow re-invokes these on each Temporal activity retry;
    // dedup keyed on the harness `Idempotency-Key` (`{run_id}:{activity_id}`) makes
    // the re-append a no-op that replays the prior response. Optional + trailing so
    // existing positional unit fixtures keep their arity; production DI supplies it
    // via RedisCacheModule. Absent (or a Redis hiccup) ⇒ best-effort fall-through to
    // normal processing (mirrors the consultation-job dedup).
    @Optional() @Inject(IRedisCacheService) private readonly redisCache?: IRedisCacheService,
    // optional + trailing (arity-preserving) segment reader. When
    // wired, the persisted transcript segments enrich `SummaryMeta.citationsMap`
    // with sentence-level segment provenance (each evidence span gets the
    // `segmentId` whose char span contains its transcript offset). Best-effort:
    // absent repo, no segments, or >1 transcript ⇒ citationsMap is left as-is.
    @Optional()
    @Inject(TranscriptSegmentRepository)
    private readonly transcriptSegmentRepository?: TranscriptSegmentRepository,
    // Effective-policy source for `warmStartEnabled`. Optional +
    // trailing so existing positional unit fixtures keep their arity; production DI
    // supplies it. Absent ⇒ the env fallback governs (the legacy behaviour).
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // The MCP registry, used ONLY as the authRef allowlist for
    // `resolveMcpToken`. Optional + trailing; absent ⇒ no token resolves (the
    // fail-closed default: nothing is callable).
    @Optional() @Inject(McpServerRepository) private readonly mcpServerRepository?: McpServerRepository,
    // Injected but DELIBERATELY NEVER CALLED.
    // `persistDraft`'s `HarnessDraftRequest` carries no token fields, and
    // harness-originated LLM calls are already metered PER-STEP by the
    // agent-trajectory path (WS-F: `harness:step:<sessionId>:<runId>:<seq>`
    // idempotency keys) — the harness calls TEXT via its own `TextClient`
    // directly, never through this gateway's TEXT proxy, so the
    // `llm:<requestId>` and `harness:step:<...>` id-spaces are disjoint by
    // construction. Adding emission here would double-bill the same
    // generation under a second, unrelated key. Wired only so
    // `harness-internal.service.test.ts`'s double-bill-guard test can assert
    // `recordUsage` is never called — see that test for the regression net.
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedgerService?: IUsageLedgerService,
    // clinician notification on the terminal gate-SLA abandonment. Optional +
    // trailing so existing positional unit fixtures keep their arity; production
    // DI supplies it via NotificationServiceModule. Best-effort: a
    // notification-send failure must NEVER roll back the escalation or its WORM
    // append — the record is the WORM row, the notification is the courtesy.
    @Optional() @Inject(INotificationService) private readonly notificationService?: INotificationService,
    // lane B — THE BYO provider plane, used ONLY by
    // `resolveProviderCredential`. Optional + trailing so existing positional
    // unit fixtures keep their arity; absent ⇒ every resolve is `unavailable`,
    // which is the FAIL-CLOSED direction (never `absent`, which would let a
    // consumer proceed unauthenticated because the gateway was misconfigured).
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnectionService?: IProviderConnectionService,
    // the VISIT-TYPE vocabulary, which replaces the
    // `parentConsultationId ? 'revisit': 'new-patient'` literal below. Optional
    // + trailing so existing positional fixtures keep their arity; an unwired
    // resolver serves the same two visit types.
    @Optional() @Inject(VisitTypeService) private readonly visitTypes?: VisitTypeService,
    // F11 — the model CATALOGUE, used ONLY by `resolveRegistryModel`. Optional +
    // trailing so existing positional unit fixtures keep their arity; absent ⇒
    // every resolve is a 404, which is the FAIL-CLOSED direction (model
    // SELECTION never substitutes a value for one it could not resolve).
    @Optional() @Inject(AiModelRepository) private readonly aiModelRepository?: AiModelRepository,
    // The consultation-addressed harness-progress feed, used by `persistDraft` ONLY
    // when the draft carries no summary `jobId` — see step 4 there. Optional + trailing so
    // existing positional unit fixtures keep their arity; production DI supplies it via
    // HarnessProgressServiceModule. Absent ⇒ no push, which is the pre-existing behaviour
    // (the console's bounded post-stop poll still finds the note).
    @Optional() @Inject(HarnessProgressService) private readonly progressService?: HarnessProgressService,
    // TASK-946 OD-4 — `failGovernedRun` is the first operation on this surface that changes a
    // consultation's lifecycle on behalf of NO caller (a background watcher, not a Temporal
    // activity carrying a jobId), so it must fan out as a `Consultation` sys-event like every
    // other lifecycle writer. Optional + trailing so every existing positional unit fixture
    // keeps its arity; absent ⇒ the transition still persists and only the broadcast is skipped.
    @Optional() @Inject(EventEmitter2) eventEmitter?: EventEmitter2,
    // The routing plane, used ONLY by `resolveTaskModel`. Optional + trailing so every
    // positional fixture keeps its arity; absent => every task-key resolve is a 503
    // (selection fails closed).
    @Optional() @Inject(IAiRoutingPolicyService) private readonly routingPolicies?: IAiRoutingPolicyService,
    // TASK-1020 — the tenant's `consultation.appointmentDay.timeZone`, which the same-day prequel
    // states its times in. Optional + trailing so every positional fixture keeps its arity; absent
    // ⇒ the times read in UTC, exactly as before.
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    // TASK-1034 R3 — the doctor's DNA report, read for its redaction RULES so the gateway lane can
    // render them as instructions. Optional + trailing so every positional fixture keeps its arity;
    // absent ⇒ no rules text (the deterministic post-generation pass is unaffected).
    @Optional() @Inject(DnaWritingStyleReportRepository) private readonly dnaReportRepository?: DnaWritingStyleReportRepository,
    // The consultation lifecycle gate: the harness callbacks move the PROCESSING axis through it
    // (never `status`, never `_version`). Optional + trailing so every positional fixture keeps its
    // arity; absent ⇒ the note still persists and only the processing signal is skipped.
    @Optional() @Inject(IConsultationLifecycleGateToken) private readonly lifecycleGate?: IConsultationLifecycleGate,
    // The note input composer: plans what the summarizer sees across every encounter, within the
    // model's window, and caches the plan for the harness. Optional + trailing so every positional
    // fixture keeps its arity; absent ⇒ no plan, and assembly sends the per-section prompt.
    @Optional() @Inject(NoteInputComposerService) private readonly noteComposer?: NoteInputComposerService,
  ) {
    super(eventEmitter as EventEmitter2, cls, ResourceType.Consultation);
  }

  /**
   * F11 — resolve ONE registry model by slug for the harness worker,
   * tenant BYO → SYSTEM catalogue.
   *
   * WHY THIS EXISTS. The durable `core.classify` node has called
   * `GET /internal/harness/models/resolve` since TASK-864 and the route was
   * never built: `apps/api/route-manifest.json` carried
   * `/internal/agents/resolve` and `/internal/harness/prompt-templates/:id/
   * resolved` and nothing else, so every classify node degraded on a 404 at
   * model resolution. The same boundary rule as `resolveMcpToken` /
   * `resolveProviderCredential` applies: `apps/harness` holds no DB handle, so
   * the catalogue row a node REFERENCES by slug is resolved here and injected.
   *
   * The cascade is the platform's standard one and is NOT reimplemented
   * loosely: the tenant's OWN row wins on presence, SYSTEM answers only on
   * ABSENCE — identical to `AgentResolverService.modelBySlug`. A slug that
   * exists only under some OTHER tenant resolves nothing and answers 404,
   * exactly like an unknown slug (404-over-403); the two reads are pinned to
   * `[caller, SYSTEM]` by construction, so no third tenant is reachable.
   *
   * `taskType` is an OPTIONAL filter, not a requirement. `core.classify`'s own
   * schema accepts a TEXT_CLASSIFICATION **or** TOKEN_CLASSIFICATION slug, and
   * the two classification-capable rows the platform seeds
   * (`gliner2-guardrails-pii-multi`, `medical-ner`) are both
   * TOKEN_CLASSIFICATION — so a hard task pin here would 404 the very models
   * the node is authored against. The row's own `taskType` rides on the
   * response instead, and a caller that DOES require a task gets a 404 on a
   * mismatch rather than a row it cannot use.
   *
   * Fails CLOSED throughout: an unresolvable slug, a task mismatch and an
   * unwired catalogue are all a 404. Nothing is ever substituted for a
   * selection that did not resolve.
   */
  async resolveRegistryModel(slug: string, tenantId: string, taskType?: string): Promise<HarnessResolvedModelResponse> {
    if (!slug || !slug.trim()) {
      throw new BadRequestException('slug is required');
    }
    // No tenant-less form, deliberately — the same reasoning as
    // `resolveProviderCredential`: a tenant-less resolve could only mean "read
    // SYSTEM unconditionally", which is the widen-without-absence bug the
    // two-tier rule exists to prevent.
    if (!tenantId || !tenantId.trim()) {
      throw new BadRequestException('tenantId is required');
    }
    if (!this.aiModelRepository) {
      this.logger.warn(`Harness model resolve requested but the model catalogue is unwired (${slug})`);
      throw new NotFoundException(`Model '${slug}' could not be resolved.`);
    }

    const repository = this.aiModelRepository;
    // A service-token request carries NO tenant on the CLS store, and `AiModel`
    // is tenant-scoped: the scope extension refuses a read without one, and its
    // shared-read widening admits exactly `[caller, SYSTEM]`. Re-establish the
    // tenant from the query first, as `getEffectivePolicy` /
    // `resolveProviderCredential` already do (the S-3 recurrence class).
    const row = await this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      const own = tenantId === SYSTEM_TENANT_ID ? null : await repository.findBySlug(tenantId, slug).catch(() => null);
      if (own) return own;
      return repository.findBySlug(SYSTEM_TENANT_ID, slug).catch(() => null);
    });

    if (!row) {
      throw new NotFoundException(`Model '${slug}' is not visible to this tenant.`);
    }
    const rowTask = String(row.taskType);
    if (taskType && rowTask !== taskType) {
      throw new NotFoundException(`Model '${slug}' is ${rowTask}, not ${taskType}.`);
    }

    return toResolvedModelResponse(row);
  }

  /**
   * Resolve the model a platform-only routing task key elects, for a harness
   * worker activity that runs a fixed task rather than a node naming a slug —
   * today the document workflow's clinical NER (`nlp.ner`).
   *
   * The SAME read the gateway's own clinical NER callers use
   * (`resolveSystemTaskModel`): SYSTEM election only, fail-closed. Only keys in
   * {@link HARNESS_RESOLVABLE_TASK_KEYS} are served; anything else is a 400.
   * `tenantId` is still REQUIRED, like every internal harness call, so the
   * request stays attributable even though the read itself is SYSTEM-only.
   *
   * @throws BadRequestException for a missing tenant or a key outside the allow-list.
   * @throws ServiceUnavailableException naming the key when no ENABLED model is elected.
   */
  async resolveTaskModel(taskKey: string, tenantId: string): Promise<HarnessResolvedModelResponse> {
    if (!tenantId || !tenantId.trim()) {
      throw new BadRequestException('tenantId is required');
    }
    if (!(HARNESS_RESOLVABLE_TASK_KEYS as readonly string[]).includes(taskKey)) {
      throw new BadRequestException(`taskKey '${taskKey}' cannot be resolved by the harness worker.`);
    }
    const model = await resolveSystemTaskModel(this.routingPolicies, this.cls, this.logger, taskKey);
    return toResolvedModelResponse(model);
  }

  /**
   * Resolve an MCP server's credential from its `authRef`.
   *
   * The harness deliberately gets NO Vault client — secret material stays on the
   * side of the boundary that already holds it. The worker calls
   * `GET /internal/harness/mcp-token?authRef=…` (X-Service-Token guarded) inside
   * the activity that performs the MCP call, uses the token, and discards it. It
   * is never persisted in workflow state, activity inputs, or heartbeats:
   * Temporal history is durable, so a token in an input is a token on disk.
   *
   * `authRef` is an ALLOWLIST lookup against registered, ENABLED `McpServer` rows
   * — never an arbitrary secret-path read. Without that check, anything holding
   * the service token could read any path the gateway's secrets backend can see.
   *
   * Returns null (never throws, never logs the value) for: an empty ref, an
   * unregistered or disabled ref, an unwired registry/secrets backend, or a
   * backend failure. Null means "no token" — the server must then be public /
   * in-boundary, which is the intended behaviour rather than a silent leak.
   */
  async resolveMcpToken(authRef: string): Promise<string | null> {
    if (!authRef || !authRef.trim()) return null;
    if (!this.mcpServerRepository || !this.secretsService) {
      this.logger.warn('MCP token resolution requested but the registry or secrets backend is unwired');
      return null;
    }

    try {
      const servers = await this.mcpServerRepository.findAll({ where: { tenantId: SYSTEM_TENANT_ID } } as never);
      const registered = (servers ?? []).some((s) => s.enabled && s.authRef === authRef);
      if (!registered) {
        // Log the REF (a path, not a secret) — this is a security-relevant denial.
        this.logger.warn(`MCP token denied: authRef is not a registered enabled McpServer (${authRef})`);
        return null;
      }
      return await this.secretsService.getSecret(authRef);
    } catch (error) {
      // Deliberately does NOT interpolate the error body: a secrets-backend error
      // can echo the requested path and, on some providers, response fragments.
      this.logger.error(`MCP token resolution failed for a registered authRef (${authRef})`);
      void error;
      return null;
    }
  }

  /**
   * lane B — resolve ONE `AiProviderConnection` credential for the
   * harness worker, tenant → SYSTEM.
   *
   * WHY THIS EXISTS AT ALL. `apps/harness` reaches neither of the two shipped
   * BYO delivery paths. It holds no DB handle, so `resolveConnection` is
   * unreachable from the worker process; and its judge/retriever run inside a
   * Temporal ACTIVITY, so there is no inbound gateway request to fold a
   * `provider_overrides` envelope into the way `apps/text` receives one. The
   * remaining option is the one this file ALREADY implements for exactly this
   * situation — `resolveMcpToken` — so this is that precedent generalised, not
   * a new channel: the worker asks INSIDE the activity, uses the value, and
   * discards it. Temporal history is durable, so a credential on an activity
   * input is a credential on disk; nothing here ever reaches one.
   *
   * The cascade is NOT reimplemented. `resolveTenantCloudOverrides` is the one
   * place in the codebase that decides tenant-vs-SYSTEM precedence, the veto set
   * and the platform-default entitlement, and it is what derives `funding` from
   * the row rather than letting a call site stamp it. This method only PROJECTS
   * its result onto the four-outcome wire contract the worker needs.
   *
   * The `absent` / `unavailable` split is the load-bearing part. `absent` means
   * "no tier has an opinion", which for a self-hosted in-boundary endpoint
   * (a local OpenAI-compatible judge server, an unauthenticated dev Qdrant) is
   * the CORRECT resolved state and lets the worker call it unauthenticated.
   * `unavailable` means the gateway could not answer, and the worker must fail
   * closed. Collapsing the two would turn a Vault outage into a silent
   * downgrade from authenticated to unauthenticated.
   *
   * Never returns key material through an error, a log line or `reason`.
   */
  async resolveProviderCredential(service: string, provider: string, tenantId: string): Promise<HarnessProviderCredentialResponse> {
    if (!PROVIDER_SERVICES.includes(service as ProviderService)) {
      throw new BadRequestException(`Unknown provider service '${service}'. Expected one of: ${PROVIDER_SERVICES.join(', ')}.`);
    }
    if (!provider || !provider.trim()) {
      throw new BadRequestException('provider is required');
    }
    // No tenant-less form, deliberately. A credential resolve without a tenant
    // could only mean "read SYSTEM directly", which is the unconditional-widen
    // bug rule 09 names; tenant-less harness work must not reach this route.
    if (!tenantId || !tenantId.trim()) {
      throw new BadRequestException('tenantId is required');
    }
    if (!this.providerConnectionService) {
      this.logger.warn(`Harness credential resolve requested but the provider-connection plane is unwired (${service}/${provider})`);
      return { outcome: 'unavailable', reason: 'provider-connection plane unavailable' };
    }

    const typedService = service as ProviderService;
    let resolved: Awaited<ReturnType<IProviderConnectionService['resolveTenantCloudOverrides']>>;
    try {
      // a service-token request carries NO tenant on the CLS store,
      // and the cascade reads tenant-scoped `AiProviderConnection` rows, which
      // the tenant-scope extension refuses without one. Re-establish the tenant
      // from the query, exactly as `assemble` / `getEffectivePolicy` do; without
      // it every resolve faulted into `unavailable` and the harness failed closed
      // on rows that exist (the gateway's own text proxy, inside an HTTP tenant
      // context, resolved the same rows).
      resolved = await this.cls.run(async () => {
        this.cls.set('tenantId', tenantId);
        this.cls.set('user', createWorkerSession({ tenantId, kind: 'harness-internal' }));
        return this.providerConnectionService!.resolveTenantCloudOverrides(typedService, tenantId);
      });
    } catch (error) {
      // Deliberately does NOT interpolate the error body — same rule as
      // `resolveMcpToken` and `toOverrideEntry`: a Vault-Transit error string
      // can echo the payload it choked on.
      this.logger.error(`Harness credential resolve failed for ${service}/${provider} (tenant ${tenantId})`);
      void error;
      return { outcome: 'unavailable', reason: 'credential resolution failed' };
    }

    const entry = resolved.overrides[provider];
    if (entry) {
      // TASK-952 D-1b — split the wire entry into "the row's own column-backed
      // fields" and "everything else", exactly as `resolveCredential` does on the
      // sibling contract. This route used to allow-list `model` and drop the rest,
      // which is why `vector:qdrant`'s `collection` prefix was stored and then
      // discarded one hop before the only thing that reads it. Destructuring the
      // reserved keys out is the belt-and-braces half of the rule
      // `provider-extras.ts` already enforces on write: `extras` can never carry
      // the credential, the endpoint, or the derived `funding` label.
      const {
        api_key: _apiKey,
        funding: _funding,
        base_url: _baseUrl,
        region: _region,
        api_version: _apiVersion,
        deployment_name: _deploymentName,
        ...extras
      } = entry;
      return {
        outcome: 'resolved',
        apiKey: entry.api_key,
        funding: entry.funding,
        ...(entry.base_url ? { baseUrl: entry.base_url } : {}),
        ...(entry.region ? { region: entry.region } : {}),
        ...(entry.api_version ? { apiVersion: entry.api_version } : {}),
        ...(entry.deployment_name ? { deploymentName: entry.deployment_name } : {}),
        // `model` stays DECLARED beside `extras` (it is also in the block): the
        // harness has read it by name since before this ticket, and a consumer on
        // an older build must keep seeing it exactly where it was.
        ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
        ...(Object.keys(extras).length > 0 ? { extras } : {}),
      };
    }

    const outcome = resolved.platformDefault;
    // TASK-952 D-1c — both branches below answer `denied`, and a consumer with a
    // fallback provider must treat them DIFFERENTLY, so each now carries a
    // machine-readable `denial` beside the prose `reason`. Nothing should ever
    // have to parse the sentence to decide whether it may widen.
    if (outcome?.vetoed.includes(provider)) {
      return {
        outcome: 'denied',
        denial: 'tenant-veto',
        reason: `tenant veto: '${provider}' is disabled for service '${service}'`,
      };
    }
    // The entitlement gate governs platform SPEND on a VENDOR account, so it
    // only denies a CLOUD provider. A SYSTEM row for a self-host engine is
    // platform INFRASTRUCTURE and stays reachable — the same `isCloudByoProvider`
    // split the cascade itself applies, read here rather than re-derived.
    //
    // It is therefore NOT a statement about the capability, only about this
    // vendor pair: a caller that has a `PLATFORM_SELF_HOST_PROVIDERS` row to fall
    // back on (the harness's `embeddings:tei-embed`) may use it. A tenant VETO
    // above is the opposite and must never be widened past.
    if (outcome?.entitlementSuppressed && isCloudByoProvider(typedService, provider)) {
      return {
        outcome: 'denied',
        denial: 'platform-entitlement',
        reason: 'the platform-default credential entitlement is not granted for this tenant',
      };
    }

    return { outcome: 'absent' };
  }

  /**
   * Effective warm-start decision for `tenantId` — the `HarnessPolicy.warmStartEnabled` column,
   * resolved on every call so a super admin's console flip takes effect with no redeploy. A null
   * column is the code default (OFF); so is an unwired policy service or a policy-backend
   * failure — this sits on the harness generation path and must not throw on a governance
   * lookup, and since TASK-882 there is no env value to fall back to.
   */
  private async resolveWarmStartEnabled(tenantId: string): Promise<boolean> {
    if (!this.harnessPolicyService) return false;
    try {
      const effective = await this.harnessPolicyService.getEffectivePolicy(tenantId);
      return effective.warmStartEnabled ?? false;
    } catch (error) {
      this.logger.warn({
        message: 'Harness policy lookup failed while resolving warmStartEnabled — warm start stays OFF for this run',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Effective re-visit carry-forward decision (F-18) — TASK-882: the assigned consultation
   * graph's `carryForward` binding (prompt-composition node or `core.agent.overrides`), read
   * through `ConfigResolver`, which fails SAFE toward OFF in every degraded case. That direction
   * is deliberate and is the opposite of `resolveWarmStartEnabled`'s: warm-start degrades toward
   * its configured value because losing it only costs quality, whereas carrying a PRIOR VISIT's
   * content into a new note on the back of a failed governance read is a clinical-safety
   * regression. An unwired resolver (positional fixtures) is OFF too.
   */
  private async resolveRevisitCarryForwardEnabled(tenantId: string, consultation: ConsultationEntity | null | undefined): Promise<boolean> {
    if (!this.configResolver) return false;
    return this.configResolver.resolveRevisitCarryForwardEnabled({
      tenantId,
      departmentId: consultation?.departmentId ?? null,
      doctorId: consultation?.doctorId ?? null,
    });
  }

  /**
   * The prior visit's most authoritative note, or `null`.
   *
   * Authority order is `SIGNED_NOTE` → `MODIFIED_SUMMARY` → `RAW_SUMMARY`: a note
   * the clinician actually signed outranks one they merely edited, which outranks
   * a raw model draft. Only the FIRST tier that yields anything is used — mixing
   * tiers would carry a superseded draft alongside the signed note. Within a tier
   * the newest row wins (`findByType` sorts ascending, so reduce rather than
   * index).
   *
   * Three outcomes that are deliberately NOT the same:
   *  * Parent ABSENT (deleted, or filtered out by the soft-delete extension) ⇒
   *    `null`. A tenant deleting last month's consultation must not break this
   *    month's note generation; there is simply nothing to carry.
   *  * Parent EXISTS but belongs to another tenant ⇒ THROWS 404 (never 403).
   *    That is a boundary violation, not a degraded read, and swallowing it would
   *    hide the one case that actually matters.
   *  * Anything else (store hiccup) ⇒ `null`. Carry-forward is an enhancement; it
   *    must never fail a clinician's note generation.
   *
   * Content arrives already decrypted (repository decrypt-on-read) and is carried
   * whole — the note composer's budget decides what fits, never a character cut.
   */
  private async loadPriorVisitSummary(parentConsultationId: string, tenantId: string): Promise<string | null> {
    // Outside the try: a cross-tenant parent must surface as 404, not be swallowed.
    const parent = await this.consultationRepository.findById(parentConsultationId).catch(() => null);
    if (!parent) {
      this.logger.debug({
        message: 'Re-visit parent consultation is absent or removed — nothing to carry forward',
        consultationId: parentConsultationId,
      });
      return null;
    }
    assertEqualTenants(parent, { tenantId });

    try {
      // TASK-1020 — the selection is shared with the same-day prequel, so the two never disagree
      // about which of a visit's notes is "the" note.
      const note = await selectAuthoritativeNoteText(this.contextItemRepository, parentConsultationId);
      return note ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Prior-visit summary lookup failed — the re-visit prompt proceeds without carry-forward',
        consultationId: parentConsultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   * The harness WORM audit payloads are built from the inbound DTO (not the
   * encrypted entity), so no ciphertext can leak into them — nothing to strip.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  /**
   * Assert the consultation is still live (`resourceStatus === ENABLED`) before
   * a harness write-back path persists against it. `findById` + `assertEqualTenants`
   * only guard tenant ownership — a soft-deleted/disabled consultation still
   * passes both, so an in-flight durable workflow could otherwise keep writing
   * drafts/entities/audit rows to a note the tenant has already removed.
   * 404-over-403 posture preserved: a non-ENABLED consultation is indistinguishable
   * from a missing one to the caller.
   */
  private assertConsultationWritable(consultation: Pick<ConsultationEntity, 'resourceStatus'> | null | undefined): void {
    if (!consultation || consultation.resourceStatus !== ResourceStatusType.ENABLED) {
      throw new NotFoundException('Resource not found');
    }
  }

  /**
   * Move a STOPPED consultation's PROCESSING axis on behalf of a harness callback, best-effort.
   *
   * The harness callbacks never write `status`: the lifecycle commands own it. They report what
   * the document pipeline is doing — a draft awaiting assurance, a finished note, a gate that wants
   * a clinician — through the lifecycle gate, which bumps no `_version`. Only a STOPPED
   * consultation has a pipeline to report on, and only the values in `HARNESS_WRITABLE_PROCESSING`
   * are replaced (see there). A gate failure is logged and swallowed: the note this surface just
   * persisted is the record, and a Temporal retry over a lost processing signal would only
   * re-deliver the same note.
   *
   * @returns `true` when the processing value was written.
   */
  private async setHarnessProcessing(
    consultation: ConsultationEntity,
    next: ConsultationProcessing,
    origin: string,
    reason?: string,
  ): Promise<boolean> {
    if (!this.lifecycleGate) return false;
    if (consultation.status !== ConsultationStatus.STOPPED || !HARNESS_WRITABLE_PROCESSING.has(consultation.processing)) {
      this.logger.log({
        message: 'Harness callback left the consultation processing unchanged — it is not a stopped consultation the harness may report on',
        consultationId: consultation.id,
        origin,
        currentStatus: consultation.status,
        currentProcessing: consultation.processing,
        requestedProcessing: next,
      });
      return false;
    }
    try {
      if (reason === undefined) {
        await this.lifecycleGate.setProcessing(consultation.id, next);
      } else {
        await this.lifecycleGate.setProcessing(consultation.id, next, reason);
      }
      return true;
    } catch (error) {
      this.logger.warn({
        message: 'Consultation processing update failed (best-effort — the harness write itself stands)',
        consultationId: consultation.id,
        origin,
        requestedProcessing: next,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * The coverage a draft delivery carries, or `null`. A report that does not match
   * `hope.note_coverage.v1` is logged (shape only — the gap details are clinical) and dropped:
   * a contract slip in the coverage must never cost the clinician the note it describes.
   */
  private readDraftCoverage(consultationId: string, raw: Record<string, unknown> | undefined): CoverageResultV1 | null {
    if (raw === undefined || raw === null) return null;
    const parsed = coverageResultV1Schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    this.logger.warn({
      message: 'Draft coverage did not match hope.note_coverage.v1 — the note is persisted without coverage',
      consultationId,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).slice(0, 10),
    });
    return null;
  }

  /**
   * TASK-1014 — the harness progress callback. The live feed is `HarnessProgressService`'s
   * (unchanged); this adds the ONE thing it cannot do: when the doc workflow reports its
   * `failed` terminal stage with the summary job's id, the ConsultationJob becomes FAILED, so
   * `GET consultations/jobs/:jobId` stops reading RUNNING for a run that is over.
   *
   * The interpreter's progress carries the harness RUN's id, not a ConsultationJob's — no job
   * record exists for it, and `notifyFailed` writes nothing for an id it cannot find.
   */
  async reportProgress(consultationId: string, dto: HarnessProgressRequest): Promise<HarnessProgressAck> {
    const ack = (await this.progressService?.reportProgress(consultationId, dto)) ?? { ok: false };
    if (dto.stage === HARNESS_PROGRESS_FAILED_STAGE && dto.jobId) {
      await this.failHarnessJob(dto.jobId, dto.label ?? 'Documentation generation failed');
    }
    if (dto.stage === HARNESS_PROGRESS_FAILED_STAGE) {
      await this.failUnwrittenNote(consultationId, dto.tenantId);
    }
    return ack;
  }

  /**
   * A `HarnessDocWorkflow` that ended `failed` (its note-plan executor or generation raised, so
   * `persistDraft` never ran) moves a STOPPED consultation with no written note to processing
   * FAILED — the same rule `failGovernedRun` applies to a governed run. A consultation whose note
   * is already written, or that has moved on, is left alone. Best-effort: the progress feed this
   * rides must never fail.
   */
  private async failUnwrittenNote(consultationId: string, tenantId: string | undefined): Promise<void> {
    if (!tenantId || !this.lifecycleGate) return;
    try {
      await this.cls.run({ ifNested: 'inherit' }, async () => {
        this.cls.set('tenantId', tenantId);
        const consultation = await this.consultationRepository.findById(consultationId);
        if (!consultation || consultation.tenantId !== tenantId || consultation.status !== ConsultationStatus.STOPPED) return;
        if (await this.hasWrittenHarnessNote(consultation)) return;
        // Already failed by name (e.g. the note plan did not fit): keep that reason, as `failGovernedRun` does.
        if (consultation.processing === ConsultationProcessing.FAILED && consultation.processingReason) return;
        await this.setHarnessProcessing(consultation, ConsultationProcessing.FAILED, 'reportProgress (failed)', NOTE_GENERATION_FAILED);
      });
    } catch (error) {
      this.logger.warn({
        message: 'Harness failure could not be reflected on the consultation processing (best-effort)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private static readonly TERMINAL_JOB_STATUSES: readonly JobStatusType[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

  /** True when the job has already settled — every harness callback after that is a duplicate or late. */
  private async isHarnessJobSettled(jobId: string): Promise<boolean> {
    const current = await this.jobService?.getJobStatus(jobId);
    return !!current && HarnessInternalService.TERMINAL_JOB_STATUSES.includes(current.status);
  }

  /**
   * Push a harness summary job forward, and complete it when `terminal` is given.
   *
   * Idempotent against duplicate harness callbacks (a second `HarnessDocWorkflow` execution, a
   * re-delivered activity, a late EARLY draft): once the job is COMPLETED / FAILED / CANCELLED
   * nothing here writes to it again, so it is completed at most once and never regressed to
   * RUNNING. The result mirrors the BullMQ path's `SummaryJobResult`, with `content` read back
   * from the persisted row — what the clinician will see, including an adoption the draft path
   * skipped.
   *
   * Best-effort, like every push on this surface: a Redis hiccup must never undo a persisted note.
   */
  private async advanceHarnessJob(
    jobId: string,
    progress: number,
    currentStep: string,
    terminal: { contextItemId: string; modelName?: string } | null,
  ): Promise<void> {
    try {
      if (await this.isHarnessJobSettled(jobId)) {
        this.logger.debug({ message: 'Harness job already settled — duplicate callback ignored', jobId });
        return;
      }
      await this.jobService?.notifyProgress(jobId, progress, currentStep);
      if (terminal) {
        await this.jobService?.notifyComplete(jobId, await this.buildSummaryJobResult(terminal.contextItemId, terminal.modelName));
      }
    } catch (error) {
      this.logger.warn({
        message: 'Harness job status update failed (best-effort)',
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async buildSummaryJobResult(contextItemId: string, modelName?: string): Promise<SummaryJobResult> {
    const row = await this.contextItemRepository.findById(contextItemId);
    return {
      contextItemId,
      content: row?.content ?? '',
      ...(modelName ? { summaryMeta: { aiModelId: modelName } } : {}),
    };
  }

  /** The FAILED twin of `advanceHarnessJob` — same settled-guard, same best-effort posture. */
  private async failHarnessJob(jobId: string, error: string): Promise<void> {
    try {
      if (await this.isHarnessJobSettled(jobId)) return;
      await this.jobService?.notifyFailed(jobId, error);
    } catch (err) {
      this.logger.warn({
        message: 'Harness job FAILED transition failed (best-effort)',
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * TASK-946 OD-4 — the outcome for a governed consultation whose interpreter run ended FAILED or
   * TIMED_OUT.
   *
   * WHY THIS EXISTS. Measured 2026-09-10: a degraded `n_finalize` opened a `ReviewGate` on an
   * empty payload, the gate timed out an hour later, `n_output` failed its schema, and the
   * workflow closed FAILED. Nothing on the gateway acted on that, and the caller saw nothing but
   * harness-progress heartbeats in the meantime.
   *
   * A STOPPED consultation whose note was never written is marked processing `FAILED` with the
   * run's reason. The consultation is NOT closed: the clinician can still record again, or close
   * it, and the auto-close sweep owns the idle case. A STOPPED consultation that already holds the
   * harness note (processing `IDLE` with the harness draft, or `AWAITING_REVIEW`) is left alone —
   * marking it failed because a later node of the same run failed would misdescribe a written
   * note. `APPROVED` and either `CLOSED_*` have moved past this run. A retry after the write finds
   * `FAILED` and writes it again, which is idempotent (the watcher carries no Idempotency-Key: it
   * is not a Temporal activity).
   *
   * 404-over-403 throughout: an unknown, cross-tenant or soft-deleted consultation id is
   * indistinguishable to the caller, exactly as on every other operation of this surface.
   */
  async failGovernedRun(consultationId: string, input: FailGovernedRunInput): Promise<FailGovernedRunResult> {
    const tenantId = input.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      // No clinician — a failed run is a workflow-initiated event, so the worker session's
      // `system-harness-internal` sentinel is the actor (mirrors `recordEscalation`).
      this.cls.set('user', createWorkerSession({ tenantId, kind: 'harness-internal' }));

      const consultation = await this.consultationRepository.findById(consultationId);
      assertEqualTenants(consultation, { tenantId });
      this.assertConsultationWritable(consultation);
      // `assertConsultationWritable` already threw on null; the guard is for the type narrowing.
      if (!consultation) {
        throw new NotFoundException('Resource not found');
      }

      // TASK-1022 — a resumed recording SUPERSEDES the governing run. A late failure from the
      // superseded run must not mark, or stamp an outcome on, the run that replaced it.
      const governingRunId = readGoverningEngineMarker(consultation.metadata)?.workflowRunId;
      if (governingRunId && governingRunId !== input.runId) {
        this.logger.log({
          message: 'Superseded governing run ended — ignored, a newer run governs this consultation',
          consultationId,
          runId: input.runId,
          runStatus: input.status,
          governingRunId,
        });
        return { transitioned: false, status: consultation.status };
      }

      if (consultation.status !== ConsultationStatus.STOPPED) {
        // The run failed while the clinician is still working - the common case for a TRIGGER
        // failure, which happens seconds after `open`. There is nothing to mark (the default
        // loop can still document this consultation and the clinician can still record), but the
        // outcome must stop being invisible: it goes on the marker every read surface derives
        // `governingRun` from, on the sys-event bus, and on the live feed the client is already
        // holding open. Neither axis is touched - a failed governing run is not a failed
        // consultation.
        if (GOVERNED_RUN_OBSERVABLE_STATUSES.includes(consultation.status)) {
          await this.recordGovernedRunFailure(consultation, input);
          return { transitioned: false, status: consultation.status };
        }

        this.logger.log({
          message: 'Governed run ended without a clinical result, but the consultation has already moved past STOPPED — left unchanged',
          consultationId,
          runId: input.runId,
          runStatus: input.status,
          currentStatus: consultation.status,
        });
        return { transitioned: false, status: consultation.status };
      }

      if (await this.hasWrittenHarnessNote(consultation)) {
        this.logger.log({
          message: 'Governed run ended without a clinical result after the note was written — processing left unchanged',
          consultationId,
          runId: input.runId,
          runStatus: input.status,
          currentProcessing: consultation.processing,
        });
        return { transitioned: false, status: consultation.status };
      }

      // TASK-1045 — a consultation the note path already FAILED by name (`NOTE_INPUT_EXCEEDS_CONTEXT`
      // at the handoff) keeps that reason: the run's own reason is downstream of it and less specific.
      const keptReason = consultation.processing === ConsultationProcessing.FAILED ? consultation.processingReason || null : null;
      const reason = keptReason ?? input.reason ?? null;
      // The interpreter's own reason (PHI-free) when it gave one, otherwise the named outcome.
      const processingReason = (reason ?? `GOVERNED_RUN_${input.status}`).slice(0, 256);
      if (!this.lifecycleGate || !HARNESS_WRITABLE_PROCESSING.has(consultation.processing)) {
        this.logger.log({
          message: 'Governed run ended without a clinical result — processing not marked (no lifecycle gate, or another writer owns it)',
          consultationId,
          runId: input.runId,
          runStatus: input.status,
          currentProcessing: consultation.processing,
        });
        return { transitioned: false, status: consultation.status };
      }
      // Not best-effort: this IS the operation's one durable write, so a failure surfaces to the
      // watcher rather than reading as success.
      await this.lifecycleGate.setProcessing(consultation.id, ConsultationProcessing.FAILED, processingReason);

      if (this.eventEmitter) {
        this.broadcastSysEvent(SysEventType.ResourceUpdated, {
          resourceId: consultationId,
          data: {
            action: 'failGovernedRun',
            status: consultation.status,
            processing: ConsultationProcessing.FAILED,
            runId: input.runId,
            runStatus: input.status,
            reason,
          },
        });
      }

      // Best-effort, like every other push on this surface: the caller has been watching a
      // heartbeat feed for an hour, so telling it the run failed matters — but a Redis hiccup
      // must never roll back the already-persisted outcome.
      try {
        await this.progressService?.reportProgress(consultationId, {
          tenantId,
          stage: HARNESS_PROGRESS_FAILED_STAGE,
          label: (reason ?? (input.status === 'TIMED_OUT' ? 'Documentation workflow timed out' : 'Documentation workflow failed')).slice(0, 256),
        });
      } catch (error) {
        this.logger.warn({
          message: 'Harness progress FAILED publish failed (best-effort — the consultation is already marked FAILED)',
          consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      this.logger.warn({
        message: 'Governed consultation marked processing FAILED — its workflow run ended without a clinical result',
        consultationId,
        runId: input.runId,
        runStatus: input.status,
        reason,
      });

      return { transitioned: true, status: consultation.status, processing: ConsultationProcessing.FAILED };
    });
  }

  /**
   * Does this STOPPED consultation already hold the harness note? `AWAITING_REVIEW` always does
   * (only a written note waits for review); `IDLE` does when the harness's own draft exists — a
   * stopped consultation with no draft is still waiting for one.
   */
  private async hasWrittenHarnessNote(consultation: ConsultationEntity): Promise<boolean> {
    if (consultation.processing === ConsultationProcessing.AWAITING_REVIEW) return true;
    if (consultation.processing !== ConsultationProcessing.IDLE) return false;
    return (await this.findOwnHarnessDraft(consultation.id)) !== null;
  }

  /**
   * Record and ANNOUNCE a governed run's failure on a consultation that is still in progress.
   *
   * Three writes, in the order that makes each safe if the next one fails:
   *
   *   1. the MARKER — the system of record. `governingRun` on every consultation read, and on
   *      `GET consultations/:id/workflow`, is derived from it, so this is what makes the failure
   *      durable and visible to a client that reconnects an hour later;
   *   2. the sys-event — audit and webhooks, through the existing fan-out;
   *   3. ONE SSE frame on the live-summary channel — for the client holding the stream open right
   *      now, which would otherwise see only silence.
   *
   * Steps 2 and 3 are best-effort in exactly the sense the rest of this surface is: a Redis
   * hiccup must never roll back the already-persisted outcome.
   *
   * A consultation carrying no governing marker writes nothing at all — there is no run to
   * describe, and inventing a marker here would make an ungoverned consultation look governed to
   * the substrate gate.
   */
  private async recordGovernedRunFailure(consultation: ConsultationEntity, input: FailGovernedRunInput): Promise<void> {
    const marker = readGoverningEngineMarker(consultation.metadata);
    if (!marker) return;

    const reason = input.reason ?? null;
    const expectedVersion = consultation.version;

    consultation.metadata = withGoverningEngineMarker(consultation.metadata, {
      ...marker,
      runStatus: 'FAILED',
      ...(reason ? { terminalReason: reason } : {}),
      endedAt: (input.at ?? new Date()).toISOString(),
    }) as ConsultationEntity['metadata'];

    await this.consultationRepository.updateWithVersion(consultation.id, consultation, expectedVersion);

    if (this.eventEmitter) {
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: consultation.id,
        data: { action: 'failGovernedRun', status: consultation.status, runId: input.runId, runStatus: input.status, reason },
      });
    }

    await this.publishWorkflowFailed(consultation.id, marker.workflowRunId, marker.workflowDefinitionSlug, reason);

    this.logger.warn({
      message: 'Governing workflow run failed while the consultation is still in progress — recorded on the row, the consultation continues',
      consultationId: consultation.id,
      runId: input.runId,
      runStatus: input.status,
      currentStatus: consultation.status,
      reason,
    });
  }

  /** The one `workflow.failed` frame, on the channel the live-summary lane already multiplexes. */
  private async publishWorkflowFailed(
    consultationId: string,
    workflowRunId: string,
    workflowDefinitionSlug: string,
    reason: string | null,
  ): Promise<void> {
    if (!this.redisCache) return;
    try {
      await this.redisCache.publish(
        `${LIVE_SUMMARY_CHANNEL_PREFIX}${consultationId}`,
        // Discriminated by the `event` field IN the JSON, like every other frame on this channel
        // — a consumer reads one shape and switches on `event`.
        JSON.stringify({ event: 'workflow.failed', consultationId, workflowRunId, workflowDefinitionSlug, reason }),
      );
    } catch (error) {
      this.logger.warn({
        message: 'workflow.failed SSE publish failed (best-effort — the outcome is already on the consultation row)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stamp a governed run's SUCCESSFUL terminal outcome on the marker.
   *
   * The sibling of `failGovernedRun`, and it lives here for the same reason: `apps/api`'s
   * completion watcher must not reach into `Consultation.metadata` itself. The marker's shape is
   * this package's business, and a second writer of it would eventually disagree with
   * `governingRunOf` about what a field means.
   *
   * Never throws and never changes `status`: success on the governing run is already expressed by
   * `persistDraft` / `finalizeAssurance` moving the consultation, and the run row has already
   * been recorded by the time this is called. This adds the ONE fact those paths do not carry —
   * that the run reached COMPLETED, and whether any node degraded.
   *
   * The `runId` guard is what makes it safe against a late watcher: a consultation re-opened onto
   * a NEW governing run must not have its live marker overwritten by the terminal status of the
   * previous one.
   */
  async recordGovernedRunCompleted(consultationId: string, input: RecordGovernedRunCompletedInput): Promise<void> {
    try {
      await this.cls.run(async () => {
        this.cls.set('tenantId', input.tenantId);
        this.cls.set('user', createWorkerSession({ tenantId: input.tenantId, kind: 'harness-internal' }));

        const consultation = await this.consultationRepository.findById(consultationId);
        if (!consultation || consultation.tenantId !== input.tenantId) return;

        const marker = readGoverningEngineMarker(consultation.metadata);
        if (!marker || marker.workflowRunId !== input.runId) return;

        const expectedVersion = consultation.version;
        consultation.metadata = withGoverningEngineMarker(consultation.metadata, {
          ...marker,
          runStatus: 'COMPLETED',
          ...(input.degraded ? { degraded: true } : {}),
          endedAt: (input.at ?? new Date()).toISOString(),
        }) as ConsultationEntity['metadata'];

        await this.consultationRepository.updateWithVersion(consultationId, consultation, expectedVersion);
      });
    } catch (error) {
      // Best-effort by contract: the WorkflowRun row already carries the terminal status, so a
      // failure here costs the consultation surface one field, never the run's own record.
      this.logger.warn({
        message: 'Governed run completed but its outcome could not be stamped on the consultation — the run row still carries it',
        consultationId,
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
        this.assertConsultationWritable(consultation);

        // Build every entity first, then encrypt each one, THEN issue a
        // single batched `createMany` (F-14) instead of one INSERT + one
        // per-row Transit-encryption call interleaved per entity. Ids are
        // pre-generated UUIDv7s from the factory, so `createMany` (which never
        // returns rows) loses nothing callers here need.
        const namedEntities = (dto.entities ?? []).map((entity) =>
          NamedEntityFactory.CreateNamedEntity({
            tenantId,
            contextItemId: dto.contextItemId,
            // Ownership marker — see HARNESS_NER_MODEL_ID. Stamped on create so
            // a LATER execution can recognise this path's own rows.
            aiModelId: this.HARNESS_NER_MODEL_ID,
            text: entity.text,
            className: entity.type,
            normalizedText: entity.normalizedText,
            startOffset: entity.startOffset,
            endOffset: entity.endOffset,
            confidence: entity.confidence,
            // persist the assertion polarity the harness NER carries.
            assertion: entity.assertion,
            // Persist the ontology codes the harness NER carries.
            umlsCui: entity.umlsCui,
            snomedCode: entity.snomedCode,
            rxnormCode: entity.rxnormCode,
            icdCode: entity.icdCode,
            loincCode: entity.loincCode,
            transcriptContextItemId: entity.transcriptContextItemId,
            transcriptStartOffset: entity.transcriptStartOffset,
            transcriptEndOffset: entity.transcriptEndOffset,
          }),
        );

        // Adopt this path's OWN prior rows instead of inserting a
        // second set. A second workflow EXECUTION is routine (see
        // HARNESS_NER_MODEL_ID and the ticket), and its Idempotency-Key differs,
        // so the replay cache cannot be the guarantee — the invariant is here.
        //
        // Rows are paired by POSITION: the repository returns them ordered by
        // `startOffset`, and the incoming list arrives in NLP order (also start
        // offset ascending), so pair i is the same span of the transcript. Each
        // adopted row is REWRITTEN in place with the freshly extracted values —
        // a genuine re-extraction over changed input therefore replaces the
        // entity set rather than being silently ignored — and only the surplus
        // is created.
        //
        // NamedEntity is in MODELS_WITHOUT_SOFT_DELETE (no `resourceStatus`
        // column), so `softDelete()` throws for it and hard deletes are not on
        // the table for PHI. Nothing here removes a row: when a re-extraction
        // yields FEWER entities than the previous one, the trailing rows this
        // path owns are left in place.
        const owned = await this.findOwnHarnessEntities(dto.contextItemId);
        const adopted = Math.min(owned.length, namedEntities.length);

        for (let index = 0; index < adopted; index++) {
          const row = owned[index];
          this.rewriteHarnessEntity(row, namedEntities[index]);
          await this.encryptBestEffort('NamedEntity', () => this.namedEntityRepository.encryptFieldsIntoEntity(row, this.secretsService!));
          await this.namedEntityRepository.update(row.id, row);
        }

        const created = namedEntities.slice(adopted);
        for (const namedEntity of created) {
          await this.encryptBestEffort('NamedEntity', () => this.namedEntityRepository.encryptFieldsIntoEntity(namedEntity, this.secretsService!));
        }
        if (created.length > 0) {
          await this.namedEntityRepository.createMany(created);
        }

        const entityIds = [...owned.slice(0, adopted).map((row) => row.id), ...created.map((e) => e.id)];

        this.logger.log({ message: 'Harness entities persisted', consultationId, savedCount: entityIds.length, adopted, created: created.length });
        return { savedCount: entityIds.length, entityIds };
      }),
    );
  }

  /**
   * Read a consultation's persisted NamedEntity rows so the durable
   * loop can reuse them as NER priors (the read counterpart of persistEntities). Reuses
   * the same transcript-offset-preferring projection as the prompt injection
   * (loadNerEntities), carrying the ontology codes through; the harness gates
   * reuse on those codes, so this is inert until they are populated. Read-only — no WORM
   * audit, no sys-event.
   */
  async getEntities(consultationId: string, tenantId: string): Promise<HarnessEntitiesResponse> {
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ tenantId, kind: 'harness-internal' }));

      // 404-over-403: assert consultation ownership before reading its NER rows (a
      // cross-tenant id must not leak the priors) — mirrors persistEntities/assemble.
      const consultation = await this.consultationRepository.findById(consultationId);
      assertEqualTenants(consultation, { tenantId });

      const entities = await this.loadNerEntities(consultationId);
      return {
        entities: entities.map((entity) => ({
          text: entity.text,
          type: entity.type,
          normalizedText: entity.normalizedText ?? undefined,
          startOffset: entity.startOffset ?? undefined,
          endOffset: entity.endOffset ?? undefined,
          umlsCui: entity.umlsCui ?? undefined,
          snomedCode: entity.snomedCode ?? undefined,
          rxnormCode: entity.rxnormCode ?? undefined,
          icdCode: entity.icdCode ?? undefined,
          loincCode: entity.loincCode ?? undefined,
        })),
      };
    });
  }

  /**
   * Resolve the prompt tier + assemble the TEXT payload — the single source of truth for prompt
   * assembly.
   *
   * With the note composer wired, the user message IS a composed note plan: every encounter, the
   * results and uploads, the earlier note — budgeted against the model's declared window, never
   * cut. The plan is cached for the harness (`notePlanRef`); a request naming `notePlanId` reuses
   * that plan's blocks rather than composing another. A plan that cannot fit is refused
   * (`NOTE_INPUT_EXCEEDS_CONTEXT`, 422, non-retryable) and the consultation's processing fails.
   */
  async assemble(consultationId: string, dto: HarnessAssembleRequest): Promise<HarnessAssembleResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId: dto.userId, tenantId, kind: 'harness-internal' }));

      const built = await this.buildAssembleParams(consultationId, tenantId, dto);
      const mode: NotePlanMode = dto.mode ?? 'final';
      let envelope: NotePlanEnvelope | null = null;
      if (this.noteComposer) {
        envelope = dto.notePlanId ? await this.noteComposer.loadEnvelope(tenantId, consultationId, dto.notePlanId) : null;
        // Harness-originated: never wait for a fact ledger inside the caller's request timeout.
        envelope ??= await this.composeEnvelope(consultationId, tenantId, built, dto, {
          mode,
          cache: true,
          waitForLedgers: false,
          planId: dto.notePlanId,
        });
      }
      const assembled = await this.promptAssemblyService.assemble(envelope ? withNoteInputs(built.params, envelope.plan) : built.params);

      const promptTemplateId = assembled.promptId ?? null;
      // Provenance must name the version whose content the LLM actually saw
      // (agent pin / approvedVersionNumber snapshot), not the mutable row's
      // currentVersionNumber; fall back to the row only for legacy templates
      // that have no version rows.
      let promptVersion: string | null = assembled.resolvedVersionNumber != null ? String(assembled.resolvedVersionNumber) : null;
      if (promptVersion === null && promptTemplateId) {
        const template = await this.promptTemplateRepository.findById(promptTemplateId);
        promptVersion = template?.currentVersionNumber != null ? String(template.currentVersionNumber) : null;
      }

      // PHI-safe segment refs for harness finalize StrictCitations.
      // Same single-transcript gate as citationsMap enrichment; empty when
      // ambiguous / absent so the prompt stays byte-identical to before.
      const segmentCitations = await this.loadSegmentCitations(tenantId, built.transcripts);

      return {
        userPrompt: assembled.userPrompt,
        // The plan's own system message, so the single-prompt path and the plan path agree.
        systemPrompt: envelope?.plan.system ?? assembled.systemPrompt,
        hyperparameters: assembled.hyperparameters,
        responseFormat: assembled.responseFormat,
        promptTemplateId,
        promptVersion,
        resolvedFrom: assembled.resolvedFrom,
        segmentCitations,
        notePlanRef: envelope ? { consultationId, mode: envelope.plan.mode, planId: envelope.plan.planId } : null,
      };
    });
  }

  /**
   * Compose (and cache) the note plan for a harness run that is about to START — the call a run
   * starter makes before it hands the harness `note_plan_ref`. Unlike `assemble` this may wait,
   * bounded by `consultation.note.ledger.waitSeconds`, for the encounters' fact ledgers to catch up
   * (an encounter whose ledger is still missing stays verbatim and its coverage is unchecked).
   *
   * @throws UnprocessableEntityException `NOTE_INPUT_EXCEEDS_CONTEXT` (non-retryable; processing → failed).
   * @throws ConflictException when a section regenerate targets an approved note or there is no note.
   */
  async composeNotePlan(consultationId: string, dto: HarnessAssembleRequest): Promise<HarnessNotePlanSummary> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    if (!this.noteComposer) {
      throw new ServiceUnavailableException({ code: 'NOTE_COMPOSER_UNAVAILABLE', message: 'The note composer is not wired.' });
    }
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set('tenantId', tenantId);
      const built = await this.buildAssembleParams(consultationId, tenantId, dto);
      const { plan } = await this.composeEnvelope(consultationId, tenantId, built, dto, {
        mode: dto.mode ?? 'final',
        cache: true,
        waitForLedgers: true,
      });
      return {
        notePlanRef: { consultationId, mode: plan.mode, planId: plan.planId },
        strategy: plan.budget.strategy,
        callCount: plan.calls.length,
        promptTokens: Math.max(...plan.calls.map((call) => call.promptTokens)),
      };
    });
  }

  /**
   * The plan the harness executes, for `GET internal/consultations/:id/note-plans/:planId`:
   * `{ plan, preservedSections }`. A cache miss is recomposed under the SAME plan id from the
   * recipe recorded with it (its mode, sections and model) and cached again; the harness never
   * composes. A plan id of another consultation or tenant is a 404.
   */
  async getNotePlan(consultationId: string, planId: string, tenantId: string): Promise<NotePlanEnvelope> {
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    if (!this.noteComposer) {
      throw new NotFoundException('Resource not found');
    }
    const composer = this.noteComposer;
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ tenantId, kind: 'harness-internal' }));
      const consultation = await this.consultationRepository.findById(consultationId);
      assertEqualTenants(consultation, { tenantId });

      const cached = await composer.loadEnvelope(tenantId, consultationId, planId);
      if (cached) return cached;

      const recipe = await composer.loadRecipe(planId);
      if (recipe && (recipe.consultationId !== consultationId || recipe.tenantId !== tenantId)) {
        throw new NotFoundException('Resource not found');
      }
      const dto: HarnessAssembleRequest = {
        tenantId,
        mode: recipe?.mode ?? 'final',
        ...(recipe?.sectionKeys.length ? { sectionKeys: recipe.sectionKeys } : {}),
        ...(recipe?.model ? { model: recipe.model } : {}),
      };
      const built = await this.buildAssembleParams(consultationId, tenantId, dto);
      const envelope = await this.composeEnvelope(consultationId, tenantId, built, dto, {
        mode: dto.mode ?? 'final',
        cache: true,
        waitForLedgers: false,
        planId,
      });
      this.logger.warn({
        message: 'Note plan was not cached — recomposed for the harness under the same plan id',
        consultationId,
        planId,
        recipeFound: recipe !== null,
        strategy: envelope.plan.budget.strategy,
      });
      return envelope;
    });
  }

  /**
   * Compose through the note composer, with the system message assembled beside the plan's blocks,
   * mapping the composer's named refusals to the gateway's.
   */
  private async composeEnvelope(
    consultationId: string,
    tenantId: string,
    built: Awaited<ReturnType<HarnessInternalService['buildAssembleParams']>>,
    dto: HarnessAssembleRequest,
    options: { mode: NotePlanMode; cache: boolean; waitForLedgers: boolean; planId?: string },
  ): Promise<NotePlanEnvelope> {
    const composer = this.noteComposer!;
    if (options.mode === 'section_regen') {
      // An approved note is locked: a section regenerate is refused before anything is composed.
      await this.lifecycleGate?.assertContentWritable(consultationId);
    }
    const request: NoteComposeRequest = {
      tenantId,
      consultationId,
      mode: options.mode,
      sectionKeys: dto.sectionKeys,
      model: dto.model ?? null,
      extras: built.noteExtras,
      system: async (blocks) => (await this.promptAssemblyService.assemble(withNoteInputs(built.params, { blocks }))).systemPrompt,
      cache: options.cache,
      waitForLedgers: options.waitForLedgers,
      ...(options.planId ? { planId: options.planId } : {}),
    };
    try {
      return await composer.compose(request);
    } catch (error) {
      if (error instanceof NoteInputExceedsContextError) {
        if (built.consultation) {
          await this.setHarnessProcessing(built.consultation, ConsultationProcessing.FAILED, 'note-plan', NOTE_INPUT_EXCEEDS_CONTEXT);
        }
        throw new UnprocessableEntityException({
          code: NOTE_INPUT_EXCEEDS_CONTEXT,
          message: error.message,
          contextWindow: error.contextWindow,
          requiredTokens: error.requiredTokens,
          retryable: false,
        });
      }
      if (
        error instanceof NoteModelUnavailableError ||
        error instanceof NoteTemplateUnresolvedError ||
        error instanceof NoteTokenizerUnavailableError
      ) {
        throw new ServiceUnavailableException({ code: error.code, message: error.message });
      }
      if (error instanceof NoteCompositionRequestError) {
        if (error.code === 'NOTE_SECTION_REGEN_NO_DRAFT') throw new ConflictException({ code: error.code, message: error.message });
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  /**
   * The Prompt Inspector's view of a consultation's assembly: the SAME inputs `assemble` gathers,
   * shaped for the inspector's `phase`, with an optional instruction override (its `agentSlug`),
   * and returned with the composition the harness response does not carry.
   *
   *   - `finalize` — exactly what `assemble` sends: the composed note plan's blocks (composed for
   *     the preview only — nothing is cached and no fact ledger is waited for);
   *   - `pre-summary` — the pre-summary chain's shape: the department-free body, NO transcript
   *     (that chain has no recording) and the case notes under their own section;
   *   - `live` — the governed live prompt over the transcript so far. An approximation of a live
   *     turn: the per-turn delta, frame and turn contract exist only inside a running session.
   */
  async previewAssembly(
    consultationId: string,
    dto: HarnessAssembleRequest,
    options: { phase: 'live' | 'pre-summary' | 'finalize'; instructionOverride?: PromptAssemblyParams['instructionOverride'] },
  ): Promise<AssembledPrompt> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set('tenantId', tenantId);
      const built = await this.buildAssembleParams(consultationId, tenantId, dto);
      const { params, caseNoteTexts } = built;
      const override = options.instructionOverride ? { instructionOverride: options.instructionOverride } : {};
      if (options.phase === 'finalize' && this.noteComposer) {
        const { plan } = await this.composeEnvelope(consultationId, tenantId, { ...built, params: { ...params, ...override } }, dto, {
          mode: dto.mode ?? 'final',
          cache: false,
          waitForLedgers: false,
        });
        return this.promptAssemblyService.assemble({ ...withNoteInputs(params, plan), ...override });
      }
      const shaped: PromptAssemblyParams =
        options.phase === 'pre-summary'
          ? {
              ...params,
              promptType: 'pre-summary',
              preSummaryVariant: 'dept-free',
              transcript: '',
              caseNotes: caseNoteTexts,
              clinicianNotes: [],
              pinnedAgentId: undefined,
            }
          : options.phase === 'live'
            ? { ...params, promptType: 'live' }
            : params;
      return this.promptAssemblyService.assemble({ ...shaped, ...override });
    });
  }

  /**
   * Gather every input the consultation's prompt is assembled from — the ONE gathering both
   * `assemble` (the harness) and `previewAssembly` (the Prompt Inspector) run, so the inspector
   * shows exactly what the harness would send. `noteExtras` is the part the note composer does not
   * read itself: background history and the clinician's own cited items.
   */
  private async buildAssembleParams(
    consultationId: string,
    tenantId: string,
    dto: HarnessAssembleRequest,
  ): Promise<{
    consultation: ConsultationEntity | null;
    params: PromptAssemblyParams;
    transcripts: Awaited<ReturnType<ContextItemRepository['findTranscripts']>>;
    caseNoteTexts: string[];
    noteExtras: { background: NoteSourceSnapshot['background']; results: NoteSnapshotText[] };
  }> {
    const consultation = await this.consultationRepository.findById(consultationId);
    assertEqualTenants(consultation, { tenantId });

    const transcripts = await this.contextItemRepository.findTranscripts(consultationId);
    const transcript = transcripts.map((t) => t.content).join('\n\n');

    const nerEntities = await this.loadNerEntities(consultationId);

    // Fold the doctor's case-notes / work-notes / attachments
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
    // Whole: the note budget decides what fits a model's window — an attachment is never cut.
    const attachments = attachmentItems
      .map((a) => {
        // Prefer the extracted file text (txt / csv / md / json, threaded onto
        // `metaData.extractedText` at upload); fall back to the stored
        // "Lab/exam result: <name>" filename label when none exists.
        const meta = a.metaData as Record<string, unknown> | undefined;
        const extracted = typeof meta?.extractedText === 'string' ? meta.extractedText.trim() : '';
        return extracted || a.content?.trim() || '';
      })
      .filter((c): c is string => !!c);

    // Thread the doctor's manual highlight spans into
    // the authoritative SOAP prompt, labeled `[highlight]` alongside the
    // clinician notes. Best-effort: optional repo + soft-deleted rows already
    // excluded by the repository's resourceStatus filter. A SEPARATE aggregate
    // from NamedEntity, so manual marks never pollute the NER aggregation.
    const highlightEntities = this.highlightRepository ? await this.highlightRepository.findByConsultation(consultationId) : [];
    const highlights = highlightEntities.filter((h) => h.exact?.trim()).map((h) => `[highlight] ${h.exact.trim()}`);

    // The live SOAP snapshot is no longer a note input (its text is retired as a source); only its
    // agent LINEAGE is read, so the resolver still pins finalize to the agent that ran the session.
    const liveLineage = readLiveAgentLineage(await this.loadLiveSoapSnapshot(consultationId));

    // Thread the doctor's preferred prompt id (Tier-0)
    // through the async/harness path too. Read-only from UserProfile via the
    // ConfigResolver, keyed off the consultation's doctor. Best-effort: when the
    // resolver is unwired (unit fixtures) or there is no doctor, the id is omitted
    // and assembly falls back to the department/global tier exactly as before.
    const preferredPromptTemplateId = this.configResolver
      ? await this.configResolver.resolvePreferredPromptTemplateId(consultation?.doctorId ?? null)
      : undefined;

    // Gate the DNA style on the effective decision
    // (tenant AND doctor). Drops to `undefined` (no DNA prompt) when the doctor
    // has opted out or the tenant flag is off. No-op (passes the requested id
    // through) when ConfigResolver is unwired (legacy fixtures).
    const effectiveDnaStyleId = await this.resolveEffectiveDnaStyleId(tenantId, consultation?.departmentId, consultation?.doctorId, dto.dnaStyleId);
    // TASK-1034 R3 — the redaction rules as INSTRUCTIONS, behind the REDACTION gate (not the style gate).
    const dnaRedactionRulesText = await this.resolveDnaRedactionRulesText(
      tenantId,
      consultation?.departmentId,
      consultation?.doctorId,
      consultationId,
    );

    // Re-visit carry-forward (F-18). Both conditions are load-bearing: a first
    // visit has nothing to carry, and a deployment that has not opted in must
    // behave exactly as before. Short-circuited so neither case pays for the
    // governance read or the context query.
    const priorVisitSummary =
      consultation?.parentConsultationId && (await this.resolveRevisitCarryForwardEnabled(tenantId, consultation))
        ? await this.loadPriorVisitSummary(consultation.parentConsultationId, tenantId)
        : null;

    // The measured readings and prior-visit history the client stated at `open`. Read from the
    // consultation's own rows, so the durable finalize sees exactly what the live lane saw.
    const clientReader = clientClinicalContextReaderFor(this.contextItemRepository, this.secretsService);
    const client = await clientReader.read(consultationId);
    // TASK-1020 — the client's lab results, and the same-day prequel (the patient's EARLIER visits
    // today, chained by `parentConsultationId`). The prequel is produced UNCONDITIONALLY when a
    // same-day ancestor exists: unlike `priorVisitSummary` above it rides no graph binding. Both
    // never throw, and both are spread only when present so the key is ABSENT otherwise — the same
    // regression-lock shape `priorVisitSummary` uses.
    const [testResults, sameDayPrequel] = await Promise.all([
      clientReader.readTestResults(consultationId),
      resolveSameDayPrequel(
        { consultationRepository: this.consultationRepository, contextItemRepository: this.contextItemRepository },
        consultation,
        { timeZone: await resolveSameDayPrequelTimeZone(this.effectiveSettings, tenantId) },
      ),
    ]);

    const params: PromptAssemblyParams = {
      vitals: client.vitals,
      previousVisits: client.previousVisits,
      ...(testResults ? { testResults } : {}),
      ...(sameDayPrequel.hasSameDayPrequel ? { sameDayPrequelSummary: sameDayPrequel.summary } : {}),
      // Explicit tenant so prompt assembly resolves the SAME effective policy (the harness runs
      // outside the API-edge CLS middleware).
      tenantId,
      departmentId: consultation?.departmentId ?? undefined,
      // The visit type comes from the shared vocabulary, not a literal: the value the caller
      // STATED at open (TASK-951 §D-3) first, `parentConsultationId` as the follow-up signal
      // when it stated none.
      promptType: (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).forConsultation(tenantId, {
        recorded: readRecordedVisitType(consultation?.metadata),
        isFollowUp: Boolean(consultation?.parentConsultationId),
      }).key,
      transcript,
      conversationLanguage: dto.conversationLanguage?.trim() || 'en',
      dnaStyleId: effectiveDnaStyleId,
      ...(dnaRedactionRulesText ? { dnaRedactionRulesText } : {}),
      explicitTemplate: dto.template,
      preferredPromptTemplateId,
      nerEntities,
      clinicianNotes,
      attachments,
      highlights,
      // Same agent reviews and finalizes: the resolver's agent tier pinned to the live session's
      // agent. Absent for every non-live consultation.
      pinnedAgentId: liveLineage?.agentId ?? undefined,
      // Spread rather than `?? undefined` so the key is ABSENT (not present-
      // and-undefined) when carry-forward is off — the assembler's regression
      // lock is "no such param", and an explicit undefined would still show up
      // in a caller assertion.
      ...(priorVisitSummary ? { priorVisitSummary } : {}),
    };
    const caseNoteTexts = caseNotes.map((note) => note.content?.trim() ?? '').filter((text) => text.length > 0);

    // What the note composer cannot read for itself. Background history is uncited reference;
    // the clinician's notes, highlights and the clinic's measured readings are cited `R<n>` sources.
    // Case notes the clinic materialised from its stated previous visits are already background.
    const background: NoteSourceSnapshot['background'] = [
      ...(priorVisitSummary ? [{ key: 'prior_visit_summary', label: 'Prior visit summary (reference only)', text: priorVisitSummary }] : []),
      ...(client.previousVisits?.trim()
        ? [{ key: 'previous_visits', label: 'Previous visits stated by the clinic', text: client.previousVisits }]
        : []),
      ...(sameDayPrequel.hasSameDayPrequel ? [{ key: 'same_day_prequel', label: 'Earlier visit(s) today', text: sameDayPrequel.summary }] : []),
    ];
    const materialised = clientCaseNoteRenderings(client.raw.previousVisits);
    const results: NoteSnapshotText[] = [
      ...caseNotes
        .filter((note) => note.content?.trim() && !materialised.has(note.content.trim()))
        .map((note) => ({ itemId: note.id, versionNumber: note.currentVersionNumber, text: `Case note: ${note.content!.trim()}` })),
      ...workNotes
        .filter((note) => note.content?.trim())
        .map((note) => ({ itemId: note.id, versionNumber: note.currentVersionNumber, text: `Work note: ${note.content!.trim()}` })),
      ...highlightEntities
        .filter((h) => h.exact?.trim())
        .map((h) => ({ itemId: h.id, versionNumber: h.version ?? 1, text: `Highlighted by the clinician: "${h.exact.trim()}"` })),
    ];
    if (client.vitals?.trim()) {
      // swallow-ok: the id only labels the citation; the reading itself is already in hand and is never dropped
      const item = await this.contextItemRepository.findLatestByKindKey(consultationId, CLIENT_VITALS_KIND_KEY).catch(() => null);
      results.push({
        itemId: item?.id ?? `${consultationId}:${CLIENT_VITALS_KIND_KEY}`,
        versionNumber: item?.currentVersionNumber ?? 1,
        text: `Measured vitals: ${client.vitals}`,
      });
    }
    if (testResults?.trim()) {
      // swallow-ok: the id only labels the citation; the reading itself is already in hand and is never dropped
      const item = await this.contextItemRepository.findLatestByKindKey(consultationId, CLIENT_INVESTIGATIONS_KIND_KEY).catch(() => null);
      results.push({
        itemId: item?.id ?? `${consultationId}:${CLIENT_INVESTIGATIONS_KIND_KEY}`,
        versionNumber: item?.currentVersionNumber ?? 1,
        text: `Test results stated by the clinic: ${testResults}`,
      });
    }

    return { consultation: consultation ?? null, params, transcripts, caseNoteTexts, noteExtras: { background, results } };
  }

  /**
   * Persist the generated draft: RAW_SUMMARY ContextItem + SummaryMeta + processing
   * + SSE progress + WORM audit. Never writes the consultation `status`.
   *
   * Two-phase (optimistic) delivery, gated by `dto.phase` (the wire literal
   * `DRAFT_PENDING_SENSORS` is the harness's phase name, not a consultation status):
   *   - EARLY (`DRAFT_PENDING_SENSORS`): persist the readable draft BEFORE the
   *     inferential assurance pass finishes. SummaryMeta carries the
   *     computational scores only; the inferential scores, gate verdict, and
   *     `assuranceCompletedAt` are withheld (NULL) and processing becomes
   *     `SUMMARIZING`. Only the GENERATE audit is written — no
   *     SENSOR_RUN, because no verdict exists yet (WORM truthfulness).
   *     `finalizeAssurance()` completes the meta + sets processing `IDLE`.
   *   - FINALIZE / absent (legacy single-shot): assurance is already complete, so
   *     the meta is fully scored, `assuranceCompletedAt` is stamped (the sign-off
   *     guard treats legacy drafts as assured), processing becomes `IDLE`,
   *     and GENERATE + SENSOR_RUN (+ REDUCED_ASSURANCE) are written.
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
        // Two-phase delivery discriminator. Default (absent) == legacy single-shot.
        const isEarly = dto.phase === HARNESS_DRAFT_PHASE.EARLY;
        const consultation = await this.consultationRepository.findById(consultationId);
        assertEqualTenants(consultation, { tenantId });
        this.assertConsultationWritable(consultation);

        // 0. Strip `[[seg:<id>]]` StrictCitations markers out of the generated note
        // BEFORE it ever becomes the persisted/delivered ContextItem content — the
        // model complies with the citation instruction, but a raw marker is not
        // clinician-facing text. `citedSegmentIds` is validated against the
        // consultation's own persisted transcript segments, so a hallucinated id is
        // stripped from the note but never recorded as evidence.
        const { content: strippedContent, citedSegmentIds } = await this.stripSegmentCitationMarkers(consultationId, tenantId, dto.content);
        const coverage = this.readDraftCoverage(consultationId, dto.coverage);

        // 1. RAW_SUMMARY context item for the generated note.
        //
        // ONE consultation gets ONE harness draft. `HarnessDocWorkflow`
        // has two start sites (`ConsultationEventHandler` → the gateway start, and
        // `ConsultationLoopWorkflow`'s `harness.finalize` child), both targeting the
        // deterministic id `harness-doc-{consultationId}` with NO `id_reuse_policy`.
        // Temporal's default `ALLOW_DUPLICATE` rejects the second start only while
        // the first execution is still OPEN, so a second execution is routine — and
        // it arrives here with its own key, which the Redis replay cache below cannot
        // dedup. Creating unconditionally therefore gave the consultation two clinical
        // notes. Adopting our own prior draft makes the note-row invariant a property
        // of the WRITE PATH, which matters because `withHarnessIdempotency` degrades
        // to `work()` whenever Redis is absent or throws: a cache can never be the
        // guarantee for a clinical artifact.
        const existingDraft = await this.findOwnHarnessDraft(consultationId);
        // TASK-1020 (probe → guard) — a re-delivery must never overwrite a note the clinician has
        // already APPROVED. Signed documentation is immutable (BP-2); a change after signing is an
        // explicit addendum, never a late workflow execution. Measured before this guard: the
        // adoption below re-wrote the RAW_SUMMARY body (and re-stamped its SummaryMeta) under a
        // SIGNED consultation, because the CAS predicate is read fresh here and so always matched.
        const adoptionRefused = existingDraft ? await this.isApprovedHarnessDraft(consultation, existingDraft.id) : false;
        let contextItemId: string;
        // TASK-1022 — why this delivery's content was NOT applied, if it was not. The closing log line
        // reads it: a skipped adoption used to be followed by "Harness draft persisted", which is false.
        let adoptionSkipped: 'approved' | 'empty' | 'occ-drift' | undefined;
        // The note's version once this delivery is done: the AI draft is v1, a replacing re-draft
        // the next number, anything not applied the version already on the row.
        let versionNumber: number | undefined = (existingDraft?.currentVersionNumber as number | null | undefined) ?? undefined;
        if (existingDraft && adoptionRefused) {
          contextItemId = existingDraft.id;
          adoptionSkipped = 'approved';
          this.logger.warn({
            message:
              'Harness draft adoption skipped — the note was already approved (signed). A late re-delivery never overwrites signed documentation; ' +
              'the signed note and its SummaryMeta were left untouched.',
            consultationId,
            contextItemId,
            currentStatus: consultation?.status,
          });
        } else if (existingDraft) {
          // capture the CAS predicate BEFORE mutating the entity
          // `entity.version` is the OCC compare-and-set counter (DB-owned),
          // distinct from `currentVersionNumber` (the content-revision
          // pointer `updateSummary` bumps on every clinician edit).
          const expectedVersion = existingDraft.version;
          contextItemId = existingDraft.id;
          // an EMPTY re-delivery must not touch the row at all.
          // `HarnessDraftRequest.content` is `@IsString()` with no
          // `@IsNotEmpty()`, and `stripSegmentCitationMarkers` can reduce a
          // marker-only note to `''`, so this is reachable. Pre-fix it committed
          // `updatedBy` + `_version` while `encryptContentIntoEntity` no-opped on
          // the empty string, leaving the OLD note body silently in place — a row
          // stamped as re-delivered over content nobody re-delivered.
          //
          // The fix is NOT to clear it, as it is for a clinician emptying their
          // own note: nobody INTENDED this deletion. A degenerate model output
          // must never blank a note the clinician can already see. So the
          // adoption is SKIPPED — the same degrade-and-continue posture this
          // branch already takes on OCC drift below, and for the same reason:
          // the content on the row is more trustworthy than what arrived.
          if (!strippedContent) {
            adoptionSkipped = 'empty';
            this.logger.warn({
              message:
                'Harness draft adoption skipped — the re-delivered note was empty after citation-marker stripping. ' +
                'The existing note was left untouched.',
              consultationId,
              contextItemId,
            });
          } else {
            // TASK-1022 A3 — a re-draft that REPLACES the content is a new revision of the note, and
            // the history must say so: the counter advances in the SAME CAS write as the content,
            // and the AI-draft snapshot for that number follows once the write lands (below). An
            // identical re-delivery is not a revision — no counter bump, no version row.
            const redraftVersionNumber = existingDraft.content !== strippedContent ? ((existingDraft.currentVersionNumber as number) ?? 0) + 1 : null;
            existingDraft.content = strippedContent;
            existingDraft.dnaWritingStyleId = dto.dnaStyleId ?? existingDraft.dnaWritingStyleId;
            existingDraft.updatedBy = userId;
            if (redraftVersionNumber !== null) existingDraft.currentVersionNumber = redraftVersionNumber;
            await this.encryptBestEffort('ContextItem content', () =>
              this.contextItemRepository.encryptContentIntoEntity(existingDraft, this.secretsService!),
            );
            try {
              // Compare-And-Set against `_version`, NOT the legacy
              // non-versioned `.update()`. `HarnessDocWorkflow`'s second
              // execution is routine (see the comment above), and this row's
              // adoption branch used to overwrite `content` unconditionally —
              // silently reverting a clinician edit made between the first and
              // second execution with no diff shown and no signal raised. A CAS
              // drift here means exactly that: a human touched this row since
              // the harness last read it.
              await this.contextItemRepository.updateWithVersion(existingDraft.id, existingDraft, expectedVersion);
              this.logger.log({
                message: 'Harness draft re-delivered — existing note updated in place (no second row)',
                consultationId,
                contextItemId,
                redraftVersionNumber,
              });
              if (redraftVersionNumber !== null) versionNumber = redraftVersionNumber;
              // After the CAS, never before: a drifted write (below) must leave no orphan version row.
              if (redraftVersionNumber !== null) await this.captureAiDraftSnapshot(existingDraft, redraftVersionNumber);
            } catch (error) {
              if (!(error instanceof OptimisticConcurrencyException)) throw error;
              adoptionSkipped = 'occ-drift';
              // Adoption skipped, not failed: the clinician's edit is
              // authoritative and stays on the row untouched. The workflow
              // itself must not fail loudly over this — degrade and continue so
              // the SummaryMeta/sensor-score work below still lands.
              this.logger.warn({
                message:
                  'Harness draft adoption skipped — a clinician edited this note since the harness last wrote it (OCC version drift). ' +
                  'The AI-generated content was NOT applied; the clinician edit is preserved.',
                consultationId,
                contextItemId,
              });
            }
          }
        } else {
          const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, strippedContent, dto.dnaStyleId, userId);
          // Pin the AI draft to v1 so the `ai_draft_v1`
          // snapshot below IS version 1 and the doctor's first edit becomes v2.
          contextItem.currentVersionNumber = 1;
          // Ownership marker — see HARNESS_DRAFT_SUBTYPE. Written on create so the
          // NEXT execution can find this row; rows without it are never adopted.
          contextItem.metaData = {
            ...((contextItem.metaData as Record<string, unknown> | undefined) ?? {}),
            subType: this.HARNESS_DRAFT_SUBTYPE,
          } as never;
          // Encrypt the generated note into `encryptedContent` before
          // persistence — the plaintext `content` column was dropped by the PHI
          // field-encryption migration, so an unencrypted create silently loses
          // the clinical note at rest (mirrors context.service.ts `encryptContent`).
          await this.encryptBestEffort('ContextItem content', () =>
            this.contextItemRepository.encryptContentIntoEntity(contextItem, this.secretsService!),
          );
          const savedContext = await this.contextItemRepository.create(contextItem);
          contextItemId = savedContext?.id ?? contextItem.id;
          versionNumber = 1;

          // Capture the immutable AI-draft `v1` snapshot at
          // this (harness/optimistic) generation boundary too, so the DNA
          // edit-capture corpus is populated regardless of which path generated the
          // draft. Best-effort: a snapshot failure must never roll back the draft.
          //
          // The update branch above writes its own snapshot (TASK-1022 A3) under the NEXT
          // version number, never a second v1: `v1` keeps its definition — the AI draft as
          // FIRST delivered.
          await this.captureAiDraftSnapshot(savedContext ?? contextItem);
        }

        // 2. SummaryMeta — sensor score columns + full sensor detail + citation map.
        // Record warm-start provenance. The consumed
        // snapshot id can't be threaded assemble->generate->persist_draft (no
        // Temporal workflow change), so re-resolve the same frozen LIVE_SOAP_SNAPSHOT
        // row via the shared helper (deterministic post-stop) and write its id.
        // Gated behind the kill-switch (default OFF): when disabled we skip the
        // lookup and record empty provenance.
        // Same rule as `assemble` above, driven by the same
        // deterministic (post-stop) helper so both call sites always agree on
        // WHICH row was consumed: lineage present ⇒ recorded regardless of the
        // flag; lineage absent ⇒ flag-gated, i.e. unchanged.
        const liveSnapshotRow = await this.loadLiveSoapSnapshot(consultationId);
        const liveLineage = readLiveAgentLineage(liveSnapshotRow);
        const liveSnapshot = liveLineage || (await this.resolveWarmStartEnabled(tenantId)) ? liveSnapshotRow : null;
        // enrich the verdict's citation map with per-segment provenance
        // (LEGACY path only; EARLY withholds the verdict citationsMap — NER
        // claims + segment provenance enrichment — until finalizeAssurance). The
        // EARLY phase still carries forward any `[[seg:]]`-cited (validated) segment
        // ids it already has at persist time (`{ segmentCitedIds: [...] }`, nothing
        // else) so finalizeAssurance can merge them into the real verdict map later —
        // mirrors the LEGACY merge via the same helper; a no-op (stays null) when
        // nothing was cited.
        const enrichedCitationsMap = isEarly
          ? this.mergeSegmentCitedIds(null, citedSegmentIds)
          : this.mergeSegmentCitedIds(await this.enrichCitationsWithSegments(consultationId, tenantId, dto.citationsMap ?? null), citedSegmentIds);
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
          // citationsMap is NOT blanket-withheld here — `enrichedCitationsMap`
          // already computed the correct EARLY value above (null unless the note
          // carried validated `[[seg:]]` markers, in which case it carries ONLY
          // `segmentCitedIds`; the verdict/claims lane still withholds separately
          // via `dto.citationsMap` never being read on the EARLY branch).
          citationsMap: (enrichedCitationsMap ?? null) as never,
          guardrailDecisions: (isEarly ? null : (dto.guardrailDecisions ?? null)) as never,
          gateDecision: isEarly ? null : (dto.gateDecision ?? null),
          assuranceCompletedAt: isEarly ? null : new Date(),
          // DNA redaction/rewrite audit. Stable data (unlike the verdict):
          // it lands on the SAME persist that carries the redacted note, so it is
          // recorded at BOTH the early and the legacy persist (never withheld/backfilled).
          // The manifest is encrypted-on-write below (encryptFieldsIntoEntity).
          redactionApplied: dto.redactionApplied ?? null,
          redactionManifest: (dto.redactionManifest ?? null) as never,
          preSummaryIds: liveSnapshot ? [liveSnapshot.id] : [],
          // Session-agent lineage. Null for every summary that no live agent
          // produced.
          sessionAgentId: liveLineage?.agentId ?? null,
          sessionAgentPromptVersion: formatSessionAgentPromptVersion(liveLineage),
          generatedAt: new Date(),
          // Plain status + count; the report (gap wording is clinical) is encrypted on write below.
          ...noteCoverageColumns(coverage),
        });
        // SummaryMeta is 1:1 with the ContextItem, so when the draft above
        // was ADOPTED rather than created we must re-stamp the existing meta row, not
        // insert a second one for the same `contextItemId`. Mirrors the read-modify-write
        // shape of `applyAssuranceBackfillWithCas` (fresh entity ⇒ fresh change tracking).
        const existingMeta = existingDraft && !adoptionRefused ? await this.summaryMetaRepository.findByContextItem(contextItemId) : null;
        if (adoptionRefused) {
          // TASK-1020 — the signed note's meta describes the run that produced what was signed; a
          // run whose content was NOT applied must not re-stamp it.
        } else if (existingMeta) {
          // TASK-869 — field-by-field, NOT `Object.assign(existingMeta, summaryMeta, …)`.
          // `BaseEntity.id` is getter-only, so copying a whole entity over another
          // threw `TypeError: Cannot set property id of #<BaseEntity> which has only
          // a getter` → 500 on EVERY adopted draft. The harness retried, the
          // workflow failed, and the BullMQ job sat at PENDING — which read as a
          // stalled queue rather than an unhandled write. Assigning the mutable
          // fields explicitly also keeps `setProperty` change-tracking intact, which
          // a bulk copy bypasses (`03-domain-layer.md`: never assign entity fields
          // wholesale), so `updateWithVersion` persists a real change set.
          existingMeta.modelName = summaryMeta.modelName;
          existingMeta.promptVersion = summaryMeta.promptVersion;
          existingMeta.entityFaithfulnessScore = summaryMeta.entityFaithfulnessScore;
          existingMeta.coverageScore = summaryMeta.coverageScore;
          existingMeta.ragTriadScore = summaryMeta.ragTriadScore;
          existingMeta.citationsMap = summaryMeta.citationsMap;
          existingMeta.guardrailDecisions = summaryMeta.guardrailDecisions;
          existingMeta.gateDecision = summaryMeta.gateDecision;
          existingMeta.assuranceCompletedAt = summaryMeta.assuranceCompletedAt;
          existingMeta.redactionApplied = summaryMeta.redactionApplied;
          existingMeta.redactionManifest = summaryMeta.redactionManifest;
          existingMeta.preSummaryIds = summaryMeta.preSummaryIds;
          existingMeta.sessionAgentId = summaryMeta.sessionAgentId;
          existingMeta.sessionAgentPromptVersion = summaryMeta.sessionAgentPromptVersion;
          existingMeta.generatedAt = summaryMeta.generatedAt;
          // Coverage describes the content just delivered, so it moves only when that content was
          // applied; a delivery without a plan clears the previous run's report.
          if (!adoptionSkipped) {
            existingMeta.coverageStatus = summaryMeta.coverageStatus;
            existingMeta.coverageGapCount = summaryMeta.coverageGapCount;
            existingMeta.coverageReport = summaryMeta.coverageReport;
            if (!coverage) existingMeta.encryptedCoverageReport = null;
          }
          await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(existingMeta, this.secretsService!));
          await this.summaryMetaRepository.updateWithVersion(existingMeta.id, existingMeta, existingMeta.version ?? 1);
        } else {
          await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(summaryMeta, this.secretsService!));
          // INTENTIONALLY NOT metered here. `dto`
          // (HarnessDraftRequest) carries no token fields, and this generation
          // is already billed by the agent-trajectory per-step path (WS-F):
          // the harness calls TEXT via its own TextClient, never through this
          // gateway's TEXT proxy, so `harness:step:<...>` already covers it.
          // Emitting a second `llm:<...>` row here would double-bill the same
          // generation. See the constructor's `usageLedgerService` doc comment
          // and the double-bill-guard test in harness-internal.service.test.ts.
          await this.summaryMetaRepository.create(summaryMeta);
        }

        // 3. Processing, never status. EARLY -> SUMMARIZING (readable, assurance pending, not yet
        // approvable); final -> IDLE (the note is written and waits for the clinician). Only a
        // STOPPED consultation is reported on: the BATCH entry point legitimately reaches here with
        // the consultation still OPEN (`sttInternal.service.ts` creates the TRANSCRIPT and emits
        // `TranscriptionCreated` without touching the lifecycle), and there is no transaction
        // around `persistDraft` — steps 1 and 2 have already committed the note, so a lifecycle
        // disagreement is logged and skipped, never thrown over (J5-F7: a throw here kept the
        // draft and failed the workflow). `status` stays the lifecycle commands' alone.
        //
        // A note whose coverage check left gaps waits for the clinician (AWAITING_REVIEW, the gap
        // count as the reason) in both phases — an EARLY one is still unapprovable until its
        // assurance completes, and `finalizeAssurance` only ever moves SUMMARIZING.
        if (consultation && coverage?.status === 'gaps' && !adoptionSkipped) {
          await this.setHarnessProcessing(
            consultation,
            ConsultationProcessing.AWAITING_REVIEW,
            'persistDraft (coverage gaps)',
            `NOTE_COVERAGE_GAPS:${coverage.gaps.length}`,
          );
        } else if (consultation) {
          await this.setHarnessProcessing(
            consultation,
            isEarly ? ConsultationProcessing.SUMMARIZING : ConsultationProcessing.IDLE,
            adoptionSkipped ? `persistDraft (adoption skipped: ${adoptionSkipped})` : 'persistDraft',
          );
        }

        // 4. SSE progress (best-effort — a Redis hiccup must not lose the draft). TASK-1014: the
        // single-shot draft IS the run's terminal point, so the job also reaches COMPLETED here; an
        // EARLY draft is not (assurance is still pending — `finalizeAssurance` completes it).
        if (dto.jobId) {
          await this.advanceHarnessJob(
            dto.jobId,
            isEarly ? 90 : 100,
            isEarly ? 'Draft ready — verifying safety' : 'Draft ready for review',
            isEarly ? null : { contextItemId, modelName: dto.modelName },
          );
        } else if (!isEarly) {
          // The interpreter's `onEnd` finalize persists through this same route but carries NO
          // summary `jobId` — the run payload's `jobId` is the harness RUN's, not a
          // ConsultationJob's — so the branch above can never fire for it and the console
          // learned nothing when the durable note landed. It discovered the note by polling.
          //
          // The push goes on the channel the console is ALREADY subscribed to for this
          // consultation (`consultation:harness-progress:<id>`), addressed by the id the UI
          // always knows. A terminal stage with no prior snapshot folds to
          // `{ stages: [], closed: true }`, which is precisely "the harness is done here" —
          // it ends the SSE relay without inventing a checklist the interpreter never emitted.
          //
          // Withheld on EARLY for the same reason the branch above sends 90 rather than 100:
          // assurance is still pending, and `closed: true` would tell the console the run is
          // over while `finalizeAssurance` is still to come.
          //
          // Best-effort, exactly like the jobId branch: a Redis hiccup must never lose a draft
          // that is already committed (steps 1-3 ran).
          try {
            await this.progressService?.reportProgress(consultationId, {
              stage: HARNESS_PROGRESS_TERMINAL_STAGE,
              tenantId,
            });
          } catch (error) {
            this.logger.warn({
              message: 'Harness terminal progress publish failed (best-effort)',
              consultationId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // 5. WORM audit trail. GENERATE (provenance) is written in BOTH phases.
        // SENSOR_RUN (the verdict, carrying sensorScores + guardrailDecisions) and
        // REDUCED_ASSURANCE are written only when a verdict EXISTS — the legacy
        // single-shot path here, or `finalizeAssurance()` in the two-phase flow. Early delivery
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
          message: adoptionSkipped
            ? 'Harness draft delivery recorded — the note content was NOT applied (adoption skipped)'
            : isEarly
              ? 'Harness early draft persisted (assurance pending)'
              : 'Harness draft persisted',
          consultationId,
          contextItemId,
          gateDecision: isEarly ? null : (dto.gateDecision ?? null),
          ...(adoptionSkipped ? { adoptionSkipped } : {}),
          ...(coverage ? { coverageStatus: coverage.status, coverageGapCount: coverage.gaps.length } : {}),
        });
        return { contextItemId, ...(versionNumber !== undefined ? { versionNumber } : {}) };
      }),
    );
  }

  /**
   * Second phase of optimistic delivery. The inferential
   * assurance pass has finished, so backfill the early-persisted SummaryMeta with
   * the inferential scores + gate verdict, stamp `assuranceCompletedAt`, move the
   * consultation's processing `SUMMARIZING → IDLE`, and record the
   * SENSOR_RUN (+ REDUCED_ASSURANCE) WORM audit — the verdict that early
   * `persistDraft()` deliberately withheld. Fail-closed: a missing early-persisted
   * SummaryMeta is a contract violation (no draft to finalize) and aborts.
   *
   * Idempotent on the processing move (only SUMMARIZING advances), so a
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
        this.assertConsultationWritable(consultation);

        // (Q2b) — did the clinician early-sign (Q2a) before this
        // verdict landed? If so the note is already immutable and STANDS; a late
        // adverse verdict is recorded as POST_SIGN_FLAG (below), never regressing it.
        const alreadySigned = !!consultation && APPROVED_STATUSES.has(consultation.status);

        // 1. Backfill the early-persisted SummaryMeta with the inferential verdict.
        //
        // This is a read-modify-write against a row `persistDraft` created moments
        // earlier, so it is guarded by COMPARE-AND-SET on `SummaryMeta._version`
        // (F-11) rather than a blind `update`. On drift the row is re-read once and
        // the backfill re-applied: both phases are idempotent (the verdict comes
        // from `dto`, not from the row), so a retry re-derives the same result from
        // the fresher row instead of clobbering whatever moved it. A SECOND
        // conflict is not retried — that is a genuine contention signal and the
        // caller (a Temporal activity with its own bounded retry policy) is the
        // right place to back off.
        await this.applyAssuranceBackfillWithCas(consultationId, tenantId, dto);

        // 2. Processing SUMMARIZING -> IDLE: the assured note now waits for the clinician.
        // EXPLICITLY only from SUMMARIZING — `finalizeAssurance` is the second phase of an EARLY
        // draft, so a retry after the move, or a consultation another writer has moved on, is a
        // no-op rather than a regression. No status write.
        if (consultation && consultation.processing === ConsultationProcessing.SUMMARIZING) {
          await this.setHarnessProcessing(consultation, ConsultationProcessing.IDLE, 'finalizeAssurance');
        }

        // 3. SSE progress (best-effort — a Redis hiccup must not lose the verdict). TASK-1014: the
        // second phase of an EARLY draft is the run's terminal point, so the job reaches COMPLETED.
        if (dto.jobId) {
          await this.advanceHarnessJob(dto.jobId, 100, 'Assurance complete', { contextItemId: dto.contextItemId, modelName: dto.modelName });
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

        // 4b. A late ADVERSE verdict (FLAG/REGEN) for a
        // note the clinician already early-signed. The signed note is immutable and
        // STANDS — never regressed (step 2 only moves a STOPPED consultation) — but we
        // append a POST_SIGN_FLAG WORM annotation so the amendment/follow-up path
        // (and the assurance SSE terminal event) can surface an alert.
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

        // 5. Close the live assurance SSE feed with the
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
   * The `finalizeAssurance` SummaryMeta backfill, as a compare-and-set with one
   * retry (F-11).
   *
   * Factored out of `finalizeAssurance` because the retry has to re-run the WHOLE
   * read-modify sequence, not just the write: the re-read returns a fresh entity
   * with fresh change-tracking, so re-applying the verdict to the STALE entity
   * would send a change set computed against a row that no longer exists.
   *
   * Fail-closed on a missing meta (no early draft to finalize = contract
   * violation) exactly as before.
   */
  private async applyAssuranceBackfillWithCas(consultationId: string, tenantId: string, dto: HarnessFinalizeAssuranceRequest): Promise<void> {
    const attempt = async (): Promise<void> => {
      const meta = await this.summaryMetaRepository.findByContextItem(dto.contextItemId);
      if (!meta) {
        throw new BadRequestException(`No draft SummaryMeta for contextItem ${dto.contextItemId} — finalizeAssurance requires a prior early persist`);
      }

      meta.ragTriadScore = dto.ragTriadScore ?? null;
      // Read back whatever the EARLY persist already carried forward —
      // ONLY `segmentCitedIds` ever survives on the early meta (persistDraft
      // withholds everything else) — BEFORE it gets overwritten below.
      const earlyCitedSegmentIds = HarnessInternalService.readSegmentCitedIds(meta.citationsMap as Record<string, unknown> | null | undefined);
      // enrich the (now-arriving) verdict citation map with segment
      // provenance before it is persisted + encrypted, then re-merge the EARLY
      // phase's `[[seg:]]`-cited ids so they are never dropped on the floor
      // (mirrors the LEGACY single-shot merge in persistDraft).
      const enrichedCitationsMap = this.mergeSegmentCitedIds(
        await this.enrichCitationsWithSegments(consultationId, tenantId, dto.citationsMap ?? null),
        earlyCitedSegmentIds,
      );
      meta.citationsMap = (enrichedCitationsMap ?? null) as never;
      meta.guardrailDecisions = (dto.guardrailDecisions ?? null) as never;
      meta.gateDecision = dto.gateDecision ?? null;
      meta.assuranceCompletedAt = new Date();
      // The EARLY persist wrote these JSONB blobs as NULL
      // (verdict withheld); this finalize is where citationsMap/guardrailDecisions
      // actually get their values, so re-encrypt here (after the backfill, before
      // the update) to keep the ciphertext columns in sync with the plaintext.
      await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(meta, this.secretsService!));
      await this.summaryMetaRepository.updateWithVersion(meta.id, meta, meta.version ?? 1);
    };

    try {
      await attempt();
    } catch (error) {
      if (!(error instanceof OptimisticConcurrencyException)) throw error;
      this.logger.warn({
        message: 'SummaryMeta assurance backfill lost a compare-and-set — re-reading and retrying once',
        consultationId,
        contextItemId: dto.contextItemId,
      });
      await attempt();
    }
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
        this.assertConsultationWritable(consultation);

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
   * Record a harness gate SLA-breach escalation as an
   * append-only WORM audit event. The durable workflow's `escalate_gate` activity
   * POSTs this when an un-signed gate passes its SLA; the `reason` encodes
   * terminal-ness (`gate_sla_abandoned` = the terminal escalation before the gate
   * abandons) and maps to GATE_ABANDONED, else GATE_ESCALATED. Either way the
   * note now wants a clinician, so a STOPPED consultation's processing becomes
   * `AWAITING_REVIEW` (reason = the escalation reason); the consultation is
   * never closed here — auto-close owns that. Re-establishes
   * CLS from the body `tenantId` (like the other handlers) and enforces the
   * 404-over-403 tenancy posture: a cross-tenant consultation surfaces as
   * NotFoundException, never leaking that it exists under another tenant.
   */
  async recordEscalation(consultationId: string, dto: HarnessEscalationRequest, idempotencyKey?: string): Promise<HarnessEscalationResponse> {
    const tenantId = dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    // The harness ships an Idempotency-Key on this POST too, so
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
        this.assertConsultationWritable(consultation);

        const isTerminalAbandon = dto.reason === 'gate_sla_abandoned';
        const action = isTerminalAbandon ? HarnessAuditAction.GATE_ABANDONED : HarnessAuditAction.GATE_ESCALATED;

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

        if (consultation) {
          await this.flagGateEscalation(consultation, dto, tenantId, isTerminalAbandon);
        }

        this.logger.log({ message: 'Harness gate escalation recorded', consultationId, reason: dto.reason, action });
        return { recorded: true };
      }),
    );
  }

  /**
   * A review gate escalated: the note waits for a clinician past its SLA. The consultation is
   * flagged `AWAITING_REVIEW` (the harness gate queue reads exactly that) and stays open — an
   * escalation never closes it; the auto-close sweep owns closing, and a late approval needs
   * nothing special. Only a STOPPED consultation is flagged: recording again means the clinician
   * resumed, and `APPROVED` / either `CLOSED_*` have moved past this gate — each a logged no-op
   * SUCCESS, never a 409, so a retried escalation is harmless.
   *
   * The TERMINAL abandon additionally notifies the clinician ("the clock never signs").
   * Best-effort: a notification failure never rolls back the WORM row or the flag.
   */
  private async flagGateEscalation(
    consultation: ConsultationEntity,
    dto: HarnessEscalationRequest,
    tenantId: string,
    isTerminalAbandon: boolean,
  ): Promise<void> {
    const flagged = await this.setHarnessProcessing(consultation, ConsultationProcessing.AWAITING_REVIEW, 'recordEscalation', dto.reason);
    if (!flagged || !isTerminalAbandon) return;

    try {
      await this.notificationService?.create({
        title: 'Consultation awaiting review',
        message: `Consultation ${consultation.id} reached its review SLA with no clinician sign-off. It stays open for approval.`,
        type: NotificationType.ACTION,
        read: false,
        targetUserId: consultation.doctorId,
        tenantId,
        data: { consultationId: consultation.id, action: 'GATE_ABANDONED' },
      } as CreateNotificationRequest);
    } catch (error) {
      this.logger.warn({
        message: 'Gate-abandon clinician notification failed (best-effort, escalation not rolled back)',
        consultationId: consultation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * TASK-1020 — has the clinician already APPROVED this harness draft? True when the consultation is
   * APPROVED / CLOSED_COMPLETE, or when the note carries an `approved` ContextItemVersion (the row
   * `SummaryService.approveSummary` writes) — the second catches a signed note whose consultation
   * has since moved on. A version-lookup failure answers from the status alone, so an unreadable
   * store never blocks the ordinary re-delivery of an unapproved draft.
   */
  private async isApprovedHarnessDraft(consultation: ConsultationEntity | null | undefined, contextItemId: string): Promise<boolean> {
    if (consultation && APPROVED_STATUSES.has(consultation.status)) return true;
    if (!this.contextItemVersionRepository?.getVersionsByChangeReason) return false;
    try {
      return ((await this.contextItemVersionRepository.getVersionsByChangeReason(contextItemId, 'approved')) ?? []).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * The harness's OWN prior draft for this consultation, or null.
   *
   * Scoped by the `HARNESS_DRAFT_SUBTYPE` marker, NOT by "newest RAW_SUMMARY":
   * five other production paths write RAW_SUMMARY rows for the same consultation,
   * and adopting one of theirs would let a harness draft overwrite a note this
   * workflow never authored. Unmarked rows (including any harness draft written
   * before the marker existed) are left alone, so the worst case is the pre-existing
   * behaviour — an extra row — never a destroyed note.
   *
   * Newest-wins among our own rows, matching `findLatestPreSummaryWithDecryptedContent`:
   * a consultation that already accumulated duplicates from the defect this fixes
   * converges onto the most recent one.
   */
  private async findOwnHarnessDraft(consultationId: string): Promise<ContextItemEntity | null> {
    const rows = (await this.contextItemRepository.findByType(consultationId, ContextItemType.RAW_SUMMARY)) ?? [];
    const owned = rows.filter((row) => (row.metaData as Record<string, unknown> | undefined)?.subType === this.HARNESS_DRAFT_SUBTYPE);
    if (owned.length === 0) return null;
    return owned.reduce((a, b) => ((a.createdAt ?? 0) >= (b.createdAt ?? 0) ? a : b));
  }

  /**
   * The NamedEntity rows THIS path wrote for `contextItemId`, in transcript
   * order. Never another producer's rows — see `HARNESS_NER_MODEL_ID`.
   *
   * Fails safe to CREATE: a lookup error yields an empty list, so the entities
   * are still persisted (an extra set, the pre-existing behaviour) rather than
   * lost. The alternative — letting the error propagate — would turn a read
   * blip into a dropped NER layer for the whole consultation.
   */
  private async findOwnHarnessEntities(contextItemId: string): Promise<NamedEntityEntity[]> {
    try {
      const rows = (await this.namedEntityRepository.findByContextItem(contextItemId)) ?? [];
      return rows.filter((row) => row.aiModelId === this.HARNESS_NER_MODEL_ID);
    } catch (error) {
      this.logger.warn({
        message: 'Harness NER ownership lookup failed — persisting a fresh entity set',
        contextItemId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Rewrite an adopted row in place from a freshly extracted entity. Assignment
   * routes through `BaseEntity.setProperty`, so `repository.update` persists
   * only the fields that actually moved. `contextItemId`, `tenantId` and the
   * ownership marker are deliberately NOT touched — they are what identified
   * this row as ours in the first place.
   */
  private rewriteHarnessEntity(row: NamedEntityEntity, next: NamedEntityEntity): void {
    row.text = next.text;
    row.className = next.className;
    row.normalizedText = next.normalizedText;
    row.startOffset = next.startOffset;
    row.endOffset = next.endOffset;
    row.confidence = next.confidence;
    row.assertion = next.assertion;
    row.umlsCui = next.umlsCui;
    row.snomedCode = next.snomedCode;
    row.rxnormCode = next.rxnormCode;
    row.icdCode = next.icdCode;
    row.loincCode = next.loincCode;
    row.transcriptContextItemId = next.transcriptContextItemId;
    row.transcriptStartOffset = next.transcriptStartOffset;
    row.transcriptEndOffset = next.transcriptEndOffset;
  }

  /**
   * Build the Redis dedup key for a WORM/draft callback. The
   * `idempotencyKey` value is the harness `{run_id}:{activity_id}` (already
   * globally unique); we additionally namespace by operation + tenantId so two
   * tenants can never collide and each callback dedups independently.
   */
  private buildIdempotencyKey(operation: string, tenantId: string, idempotencyKey: string): string {
    return `${this.IDEMPOTENCY_KEY_PREFIX}${operation}:${tenantId}:${idempotencyKey}`;
  }

  /**
   * Dedup a WORM/draft callback on the harness `Idempotency-Key`.
   * The durable workflow re-invokes these callbacks on each Temporal activity
   * retry; without dedup every retry re-appends the WORM/draft rows. This
   * caches-and-replays the prior RESPONSE BODY (not a bare seen-marker — e.g.
   * persistDraft's response carries the contextItemId) so a retried callback is
   * exactly one effect. The key is recorded AFTER a successful write; Temporal
   * activity retries are sequential, so a get-then-setex is adequate (no lock).
   * Best-effort: no key, no Redis, or a Redis throw ⇒ fall through to normal
   * processing (mirrors the consultation-job dedup).
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
   * The latest live SOAP snapshot for warm-start.
   * The live session upserts ONE PRE_SUMMARY row tagged metaData.subType =
   * 'LIVE_SOAP_SNAPSHOT'. Distinct from legacy case-notes pre-summaries, so we
   * filter on subType (findLatestPreSummary is NOT subType-aware). Returns the
   * newest matching row. Shared by assemble() (injects the text) and
   * persistDraft() (records the id) so both always agree on which row was
   * consumed.
   *
   * B-02: the plaintext `content` column was dropped — only `encryptedContent`
   * is persisted — so the returned entity's `.content` is decrypted here before
   * it reaches callers (`assemble()` reads `.content` directly for the
   * warm-start prompt injection). Best-effort: a missing SecretsService
   * (dev/test, no Vault) leaves `.content` as whatever decrypt-on-read already
   * populated (possibly null) rather than throwing.
   *
   * The find + subType-filter + newest-wins-reduce is delegated to
   * the shared repository helper
   * (`ContextItemRepository.findLatestPreSummaryWithDecryptedContent`) rather
   * than hand-rolled here — this was one of four copies of that exact logic.
   * The decrypt-only-when-secrets-wired / mutate-`.content` contract above is
   * preserved exactly: the helper always computes a `plaintext` (degrading to
   * the entity's transient `.content` when no SecretsService is passed), but
   * we only splice it onto the entity when `this.secretsService` is actually
   * wired, matching the pre-refactor behaviour byte-for-byte.
   */
  private async loadLiveSoapSnapshot(consultationId: string): Promise<ContextItemEntity | null> {
    const { entity, plaintext } = await this.contextItemRepository.findLatestPreSummaryWithDecryptedContent(consultationId, this.secretsService, {
      subType: 'LIVE_SOAP_SNAPSHOT',
    });
    if (entity && this.secretsService) {
      entity.content = plaintext;
    }
    return entity;
  }

  /**
   * Resolve the DNA style id to actually apply at the
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
   * TASK-1034 R3 — the doctor's redaction rules rendered as a bullet list for the prompt, or
   * `undefined`. Gated by `resolveEffectiveDnaRedactionEnabled` (tenant declaration + doctor
   * opt-in). FAIL-SAFE: an unwired dependency, a thrown gate, a missing report or a malformed rule
   * set all yield no text — the rules stay enforced by the deterministic post-generation pass.
   */
  private async resolveDnaRedactionRulesText(
    tenantId: string,
    departmentId: string | null | undefined,
    doctorId: string | null | undefined,
    consultationId: string,
  ): Promise<string | undefined> {
    if (!doctorId || !this.configResolver || !this.dnaReportRepository) return undefined;
    try {
      const { effective } = await this.configResolver.resolveEffectiveDnaRedactionEnabled({ tenantId, departmentId: departmentId ?? null, doctorId });
      if (!effective) return undefined;
      const report = await this.dnaReportRepository.findLatestForDoctor(doctorId);
      if (!report) return undefined;
      const { redactionRules } = await this.dnaReportRepository.decryptFieldsFromEntity(report, this.secretsService as SecretsService);
      if (!redactionRules) return undefined;
      return renderDnaRedactionRulesText(validateRedactionRuleSet(redactionRules).rules) || undefined;
    } catch (error) {
      this.logger.warn({
        message: 'DNA redaction rules could not be rendered for the harness prompt — generating without them (fail-safe)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Write the immutable AI-draft `v1` snapshot for the
   * DNA edit-capture corpus. Reuses `ContextItemVersion` with
   * `changeReason='ai_draft_v1'` / `changeSource='ai_model'` (no schema change),
   * mirroring the sync `SummaryService` path so both generation boundaries snapshot.
   * No-op when the version repository is unwired (legacy fixtures); best-effort
   * otherwise — a snapshot failure is logged and swallowed so it never rolls back
   * the committed draft.
   *
   * TASK-1022 A3 — an in-place AI RE-draft (a resumed recording re-finalised, by the default engine
   * or the governing graph) snapshots under the SAME reason and author at `versionNumber`, the
   * number the content write already advanced `currentVersionNumber` to. Keeping the reason is
   * deliberate: every reader (`SummaryService.resolveAiDraftBaseline`, the gate-edit miner, the
   * DNA processor) takes the NEWEST `ai_draft_v1` row (`versionNumber desc`) as the AI draft the
   * clinician edited, which after a re-draft is this one, not the first.
   */
  private async captureAiDraftSnapshot(savedContext: ContextItemEntity, versionNumber = 1): Promise<void> {
    if (!this.contextItemVersionRepository) return;
    try {
      const snapshot = ContextItemVersionFactory.CreateFromContextItem(
        savedContext,
        versionNumber,
        'ai_draft_v1',
        'system',
        'ai_model',
        versionNumber === 1 ? 'AI draft v1 snapshot' : `AI re-draft snapshot (v${versionNumber})`,
      );
      await this.encryptBestEffort('ContextItemVersion', () =>
        this.contextItemVersionRepository!.encryptFieldsIntoEntity(snapshot, this.secretsService!),
      );
      await this.contextItemVersionRepository.create(snapshot);
    } catch (error) {
      this.logger.warn({
        message: 'AI-draft snapshot capture failed (best-effort, draft not rolled back)',
        contextItemId: savedContext.id,
        versionNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Flatten a consultation's NER entities for prompt injection. Transcript-span
   * offsets are preferred over the raw source offsets so the model can cite the
   * source location (mirrors the same helper on the pre-summary/comprehensive
   * processors).
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
   * load PHI-safe segment citation refs for the assemble → generate
   * StrictCitations path. Returns `[]` when the segment repo is unwired, the
   * consultation has ≠1 transcript (same ambiguity gate as enrichment), or no
   * segments are persisted — so callers that omit/empty keep the prior prompt.
   */
  private async loadSegmentCitations(tenantId: string, transcripts: Array<{ id: string }>): Promise<HarnessSegmentCitationRef[]> {
    if (!this.transcriptSegmentRepository || transcripts.length !== 1) return [];
    try {
      const segments = await this.transcriptSegmentRepository.findByContextItem(tenantId, transcripts[0].id);
      return segments.map((s) => ({
        id: s.id,
        idx: s.idx,
        speaker: s.speaker ?? null,
        t0Ms: s.t0Ms ?? null,
        t1Ms: s.t1Ms ?? null,
      }));
    } catch (error) {
      this.logger.warn({
        message: 'assemble segmentCitations skipped (best-effort)',
        tenantId,
        contextItemId: transcripts[0]?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Annotate each citation evidence span with the transcript
   * `segmentId` whose [charStart, charEnd) span contains its transcript
   * `startOffset`, so `SummaryMeta.citationsMap` carries sentence-level segment
   * provenance (a future console click-to-source can seek the audio via t0/t1).
   *
   * Best-effort + non-destructive: returns the map unchanged when the segment
   * repo is absent, the consultation has no (or >1) transcript (offsets are
   * per-transcript, so a single unambiguous transcript is required to map by
   * offset alone), or no segments are persisted.
   */
  private async enrichCitationsWithSegments(
    consultationId: string,
    tenantId: string,
    citationsMap?: Record<string, unknown> | null,
  ): Promise<Record<string, unknown> | null | undefined> {
    if (!citationsMap || !this.transcriptSegmentRepository) return citationsMap;
    try {
      const transcripts = await this.contextItemRepository.findTranscripts(consultationId);
      if (transcripts.length !== 1) return citationsMap;
      const segments = await this.transcriptSegmentRepository.findByContextItem(tenantId, transcripts[0].id);
      if (segments.length === 0) return citationsMap;
      const refs: SegmentOffsetRef[] = segments.map((s) => ({
        id: s.id,
        charStart: s.charStart ?? null,
        charEnd: s.charEnd ?? null,
      }));
      return attachSegmentEvidence(citationsMap, refs);
    } catch (error) {
      this.logger.warn({
        message: 'citationsMap segment enrichment skipped (best-effort)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return citationsMap;
    }
  }

  /**
   * Strip `[[seg:<id>]]` StrictCitations markers out of a harness-generated note
   * BEFORE it is persisted, and return the ids actually cited (validated against
   * the consultation's own persisted transcript segments so a hallucinated id can
   * never be recorded as evidence — mirrors `extract_cited_segment_ids`,
   * `apps/harness/src/harness/temporal/prompt_cache.py`).
   *
   * The marker syntax is ALWAYS stripped from the returned content, even when the
   * transcript-segment repository is unwired or the consultation has no (or >1)
   * transcript — a raw `[[seg:...]]` marker must never reach the clinician-visible
   * note regardless of whether it can be validated. `citedSegmentIds` degrades to
   * empty in that case (best-effort, non-destructive to the content strip).
   */
  private async stripSegmentCitationMarkers(
    consultationId: string,
    tenantId: string,
    content: string,
  ): Promise<{ content: string; citedSegmentIds: string[] }> {
    let allowedIds: ReadonlySet<string> = new Set();
    if (this.transcriptSegmentRepository) {
      try {
        const transcripts = await this.contextItemRepository.findTranscripts(consultationId);
        if (transcripts.length === 1) {
          const segments = await this.transcriptSegmentRepository.findByContextItem(tenantId, transcripts[0].id);
          allowedIds = new Set(segments.map((s) => s.id));
        }
      } catch (error) {
        this.logger.warn({
          message: 'segment citation marker validation skipped (best-effort) — markers still stripped',
          consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return extractAndStripSegmentCitationMarkers(content, allowedIds);
  }

  /**
   * Fold `[[seg:]]`-cited segment ids into `citationsMap.segmentCitedIds`
   * (additive; leaves every other key untouched) so the consultation-review
   * click-to-source screen has real evidence to highlight even when the
   * disjoint NER-claims lane (`citationsMap.claims`) is empty or degraded.
   * A no-op (returns `citationsMap` as-is) when there is nothing cited.
   */
  private mergeSegmentCitedIds(citationsMap: Record<string, unknown> | null | undefined, citedSegmentIds: string[]): Record<string, unknown> | null {
    if (citedSegmentIds.length === 0) return (citationsMap ?? null) as Record<string, unknown> | null;
    return { ...(citationsMap ?? {}), segmentCitedIds: citedSegmentIds };
  }

  /**
   * Read back a `citationsMap.segmentCitedIds` array (the shape
   * `mergeSegmentCitedIds` writes), tolerant of null/malformed input. Used by
   * `finalizeAssurance` to recover the EARLY phase's `[[seg:]]`-cited ids before
   * they are overwritten by the arriving verdict citationsMap.
   */
  private static readSegmentCitedIds(citationsMap: Record<string, unknown> | null | undefined): string[] {
    const ids = citationsMap?.segmentCitedIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  }

  /**
   * True iff the inferential SAFETY dimension is a
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

/** The prompt params with a composed note plan's blocks as the user message. */
function withNoteInputs(params: PromptAssemblyParams, plan: Pick<NotePlanV1, 'blocks'>): PromptAssemblyParams {
  return { ...params, noteInputBlocks: plan.blocks.map(({ key, label, content }) => ({ key, label, content })) };
}
