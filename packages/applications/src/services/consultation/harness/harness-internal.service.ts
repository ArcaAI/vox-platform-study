import { Inject, Injectable, Logger, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationRepository,
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
  HarnessAuditAction,
  HighlightRepository,
  ContextItemEntity,
  NamedEntityEntity,
  ContextItemType,
  TranscriptSegmentRepository,
  McpServerRepository,
  SYSTEM_TENANT_ID,
  ResourceStatusType,
} from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { attachSegmentEvidence, extractAndStripSegmentCitationMarkers, type SegmentOffsetRef } from '../lib/transcript-segments';
import { HarnessAuditService } from '../../harness-audit';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IRedisCacheService } from '../../baseServices/redis';
import { HarnessAssuranceService } from './harness-assurance.service';
import { ConfigResolver } from '../../config-resolver';
import { HarnessPolicyService } from '../../harness-policy/harness-policy.service';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import {
  AGENTIC_REVISIT_CARRY_FORWARD_DEFAULT,
  AGENTIC_REVISIT_CARRY_FORWARD_KEY,
  truncatePriorVisitSummary,
} from '../../settings-registry/descriptors/agentic-revisit.descriptors';
import { PromptAssemblyService, type NerEntityForPrompt } from '../prompt/prompt-assembly.service';
import { formatSessionAgentPromptVersion, readLiveAgentLineage } from '../prompt/live-agent-lineage';
import { IConsultationJobService } from '../jobs/consultation-job.service';
import { IUsageLedgerService } from '../../usageLedger';
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
  HarnessEntitiesResponse,
  HarnessGateDecisionRequest,
  HarnessGateDecisionResponse,
  HarnessPersistEntitiesRequest,
  HarnessPersistEntitiesResponse,
  HarnessSegmentCitationRef,
} from './dto';

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
export class HarnessInternalService {
  private readonly logger = new Logger(HarnessInternalService.name);

  // Warm-start kill-switch. When OFF the harness injects no
  // prior draft and records no preSummaryIds provenance; enable for a
  // cold-vs-warm A/B.
  //
  // `HarnessPolicy.warmStartEnabled` is now the authority, resolved
  // per call (see `resolveWarmStartEnabled`). This env var survives only as the
  // fallback for a null policy value, reproducing the legacy behaviour exactly.
  private readonly warmStartEnvFallback: boolean;

  // Idempotency-Key dedup namespace + TTL for the WORM/draft
  // callbacks. The key value is the harness `{run_id}:{activity_id}` (globally
  // unique); the Redis key additionally namespaces by operation + tenantId.
  private readonly IDEMPOTENCY_KEY_PREFIX = 'idempotency:harness:';
  private readonly IDEMPOTENCY_TTL = 86400; // 24 hours

  // `metaData.subType` marker stamped on the RAW_SUMMARY ContextItem
  // that `persistDraft` creates, so a LATER persist can recognise the harness's
  // OWN prior draft and update it instead of adding a second note.
  //
  // The marker is what makes the adoption safe. FIVE other production paths create
  // RAW_SUMMARY rows for the same consultation — `SummaryService.generateSummary`,
  // `ChainSummaryService.generateComprehensiveSummary`, `ContextService.addRawSummary`,
  // and the two BullMQ summary processors — none of which coordinate with the harness.
  // Adopting the newest RAW_SUMMARY unconditionally would let a harness draft
  // OVERWRITE a note this workflow never authored, which is strictly worse than a
  // duplicate. Unmarked rows are therefore never touched: the lookup fails safe to
  // create. (Same `metaData.subType` convention as `LIVE_SOAP_SNAPSHOT`.)
  private readonly HARNESS_DRAFT_SUBTYPE = 'HARNESS_DRAFT';

  // The same ownership idea, for `persistEntities`. `NamedEntity`
  // has no `metaData` column to mark: its `metadata` is Vault-Transit ciphertext
  // (`encryptedMetadata`; the plaintext column was DROPPED) and encryption is a
  // soft no-op outside `SECRETS_PROVIDER=vault`, so it is neither queryable nor
  // reliably present. `aiModelId` is the plaintext, nullable "which recognizer
  // produced this span" column, and it is the honest home for this: these rows
  // ARE the harness NER pass's output.
  //
  // FOUR other production paths create NamedEntity rows — `ContextService`,
  // `SummaryService`, `NerProcessor` and `ChainSummaryService`'s NER writes — all
  // through `namedEntityPropsFromNlp`, which sets NO `aiModelId`. They routinely
  // cover the SAME transcript ContextItem and the same spans, so scoping by
  // `contextItemId` alone would let this path rewrite rows it never authored.
  // Filtering on this marker means unmarked rows (including harness rows written
  // before this change) are never read, never updated and never removed — the
  // lookup fails safe to CREATE, exactly as `HARNESS_DRAFT_SUBTYPE` does.
  private readonly HARNESS_NER_MODEL_ID = 'HARNESS_NER';

  // F-03: attachment text (metaData.extractedText or, absent that, the raw
  // content label) is folded verbatim into the prompt with only a
  // `[highlight]`-style label prefix — no other transformation. This caps the
  // per-attachment contribution so one oversized upload can't dominate the
  // context window / injection surface (SOTA §5.1/§5.2); the explicit suffix
  // marker keeps the truncation visible in the assembled prompt rather than
  // silently cutting the text.
  private static readonly ATTACHMENT_TEXT_MAX_LENGTH = 20_000;
  private static readonly ATTACHMENT_TRUNCATION_MARKER = '…[attachment truncated for context]';

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
    // constructor arity; production DI supplies it via ConfigModule (added to
    // HarnessInternalServiceModule). Absent ⇒ flag OFF, matching the prod default.
    @Optional() private readonly configService?: ConfigService,
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
    // Governed read facade for the `agentic.*` control plane — today only
    // `agentic.revisit.carryForwardEnabled` (F-18). Optional + trailing so
    // existing positional unit fixtures keep their arity; absent ⇒ the code
    // default (carry-forward OFF), which is also the fail-safe direction.
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    // Injected but DELIBERATELY NEVER CALLED.
    // `persistDraft`'s `HarnessDraftRequest` carries no token fields, and
    // harness-originated LLM calls are already metered PER-STEP by the
    // agent-trajectory path (WS-F: `harness:step:<sessionId>:<runId>:<seq>`
    // idempotency keys) — the harness calls SMR via its own `SmrClient`
    // directly, never through this gateway's SMR proxy, so the
    // `llm:<requestId>` and `harness:step:<...>` id-spaces are disjoint by
    // construction. Adding emission here would double-bill the same
    // generation under a second, unrelated key. Wired only so
    // `harness-internal.service.test.ts`'s double-bill-guard test can assert
    // `recordUsage` is never called — see that test for the regression net.
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedgerService?: IUsageLedgerService,
  ) {
    const raw = String(this.configService?.get('HARNESS_WARM_START_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    this.warmStartEnvFallback = raw === 'true' || raw === '1';
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
   * Effective warm-start decision for `tenantId`.
   *
   * Policy wins; a null policy value means "not configured" and falls through to the
   * env fallback. Resolved on every call so a global admin's console flip takes
   * effect with no redeploy. A policy-backend failure degrades to the env value —
   * this sits on the harness generation path and must not fail closed on a
   * governance lookup.
   */
  private async resolveWarmStartEnabled(tenantId: string): Promise<boolean> {
    if (!this.harnessPolicyService) {
      return this.warmStartEnvFallback;
    }
    try {
      const effective = await this.harnessPolicyService.getEffectivePolicy(tenantId);
      return effective.warmStartEnabled ?? this.warmStartEnvFallback;
    } catch (error) {
      this.logger.warn({
        message: 'Harness policy lookup failed while resolving warmStartEnabled — falling back to env',
        error: error instanceof Error ? error.message : String(error),
      });
      return this.warmStartEnvFallback;
    }
  }

  /**
   * Effective re-visit carry-forward decision (F-18).
   *
   * Fails SAFE toward OFF in every degraded case (no facade, unknown key,
   * resolver outage, non-boolean value). That direction is deliberate and is the
   * opposite of `resolveWarmStartEnabled`'s: warm-start degrades toward its
   * configured value because losing it only costs quality, whereas carrying a
   * PRIOR VISIT's content into a new note on the back of a failed governance read
   * is a clinical-safety regression (SOTA §4.5).
   */
  private async resolveRevisitCarryForwardEnabled(tenantId: string): Promise<boolean> {
    if (!this.effectiveSettings) {
      return AGENTIC_REVISIT_CARRY_FORWARD_DEFAULT;
    }
    try {
      const resolved = await this.effectiveSettings.resolveEffective(AGENTIC_REVISIT_CARRY_FORWARD_KEY, { tenantId });
      return resolved.value === true || resolved.value === 'true';
    } catch (error) {
      this.logger.warn({
        message: 'agentic.revisit.carryForwardEnabled lookup failed — carry-forward stays OFF for this run',
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return AGENTIC_REVISIT_CARRY_FORWARD_DEFAULT;
    }
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
   * Content arrives already decrypted (repository decrypt-on-read) and is capped
   * before it leaves this method, so an oversized prior note can never reach the
   * assembler unbounded.
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
      for (const type of [ContextItemType.SIGNED_NOTE, ContextItemType.MODIFIED_SUMMARY, ContextItemType.RAW_SUMMARY]) {
        const items = (await this.contextItemRepository.findByType(parentConsultationId, type)) ?? [];
        const usable = items.filter((item) => item?.content?.trim());
        if (usable.length === 0) continue;
        const newest = usable.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
        return truncatePriorVisitSummary(newest.content!.trim());
      }
      return null;
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
      const attachments = attachmentItems
        .map((a) => {
          // Prefer the extracted file text (txt / csv / md /
          // json, threaded onto `metaData.extractedText` at upload); fall back to
          // the stored "Lab/exam result: <name>" filename label when none exists.
          const meta = a.metaData as Record<string, unknown> | undefined;
          const extracted = typeof meta?.extractedText === 'string' ? meta.extractedText.trim() : '';
          return HarnessInternalService.truncateAttachmentText(extracted || a.content?.trim() || '');
        })
        .filter((c): c is string => !!c);

      // Thread the doctor's manual highlight spans into
      // the authoritative SOAP prompt, labeled `[highlight]` alongside the
      // clinician notes. Best-effort: optional repo + soft-deleted rows already
      // excluded by the repository's resourceStatus filter. A SEPARATE aggregate
      // from NamedEntity, so manual marks never pollute the NER aggregation.
      const highlightEntities = this.highlightRepository ? await this.highlightRepository.findByConsultation(consultationId) : [];
      const highlights = highlightEntities.filter((h) => h.exact?.trim()).map((h) => `[highlight] ${h.exact.trim()}`);

      // Warm-start `generate` from the live SOAP
      // snapshot instead of cold-generating: inject the running SOAP note as
      // {pre_summary_text} so the model refines it. Cold path when absent.
      // Gated behind the kill-switch (default OFF): when disabled we skip the
      // snapshot lookup entirely so nothing is injected.
      // The snapshot load is now UNCONDITIONAL, because the
      // load is what tells us whether a live agent ran at all. Lineage present
      // (the live loop stamped `metaData.agent`) ⇒ inject unconditionally, per
      // R-N2 / DR-4; lineage absent ⇒ the flag gates the injection exactly as
      // before, so the legacy case-notes path is byte-identical.
      const liveSnapshot = await this.loadLiveSoapSnapshot(consultationId);
      const liveLineage = readLiveAgentLineage(liveSnapshot);
      const injectPriorDraft = liveLineage !== null || (await this.resolveWarmStartEnabled(tenantId));

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

      // Re-visit carry-forward (F-18). Both conditions are load-bearing: a first
      // visit has nothing to carry, and a deployment that has not opted in must
      // behave exactly as before. Short-circuited so neither case pays for the
      // governance read or the context query.
      const priorVisitSummary =
        consultation?.parentConsultationId && (await this.resolveRevisitCarryForwardEnabled(tenantId))
          ? await this.loadPriorVisitSummary(consultation.parentConsultationId, tenantId)
          : null;

      const assembled = await this.promptAssemblyService.assemble({
        // Explicit tenant so prompt assembly resolves the SAME
        // effective warm-start policy this method just gated the snapshot on
        // (the harness runs outside the API-edge CLS middleware).
        tenantId,
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
        preSummaryText: injectPriorDraft ? (liveSnapshot?.content ?? undefined) : undefined,
        // Same agent reviews and finalizes: unconditional
        // injection on the lineage path + the resolver's agent tier pinned to
        // that exact agent. Both absent for every non-live consultation.
        preSummaryLineage: liveLineage ?? undefined,
        pinnedAgentId: liveLineage?.agentId ?? undefined,
        // Spread rather than `?? undefined` so the key is ABSENT (not present-
        // and-undefined) when carry-forward is off — the assembler's regression
        // lock is "no such param", and an explicit undefined would still show up
        // in a caller assertion.
        ...(priorVisitSummary ? { priorVisitSummary } : {}),
      });

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
      const segmentCitations = await this.loadSegmentCitations(tenantId, transcripts);

      return {
        userPrompt: assembled.userPrompt,
        systemPrompt: assembled.systemPrompt,
        hyperparameters: assembled.hyperparameters,
        responseFormat: assembled.responseFormat,
        promptTemplateId,
        promptVersion,
        resolvedFrom: assembled.resolvedFrom,
        segmentCitations,
      };
    });
  }

  /**
   * Persist the generated draft: RAW_SUMMARY ContextItem + SummaryMeta + status
   * + SSE progress + WORM audit.
   *
   * Two-phase (optimistic) delivery, gated by `dto.phase`:
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
        let contextItemId: string;
        if (existingDraft) {
          existingDraft.content = strippedContent;
          existingDraft.dnaWritingStyleId = dto.dnaStyleId ?? existingDraft.dnaWritingStyleId;
          existingDraft.updatedBy = userId;
          await this.encryptBestEffort('ContextItem content', () =>
            this.contextItemRepository.encryptContentIntoEntity(existingDraft, this.secretsService!),
          );
          await this.contextItemRepository.update(existingDraft.id, existingDraft);
          contextItemId = existingDraft.id;
          this.logger.log({
            message: 'Harness draft re-delivered — existing note updated in place (no second row)',
            consultationId,
            contextItemId,
          });
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

          // Capture the immutable AI-draft `v1` snapshot at
          // this (harness/optimistic) generation boundary too, so the DNA
          // edit-capture corpus is populated regardless of which path generated the
          // draft. Best-effort: a snapshot failure must never roll back the draft.
          //
          // Deliberately NOT re-run on the update branch above: `ContextItemVersion`
          // rows are immutable history and `captureAiDraftSnapshot` always writes
          // versionNumber 1, so calling it again would add a SECOND v1 for the same
          // note. `v1` keeps its definition — the AI draft as FIRST delivered.
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
          // Session-agent lineage, stamped identically to
          // the synchronous `SummaryService.generateSummary` path. Null for
          // every summary that no live agent produced.
          sessionAgentId: liveLineage?.agentId ?? null,
          sessionAgentPromptVersion: formatSessionAgentPromptVersion(liveLineage),
          generatedAt: new Date(),
        });
        // SummaryMeta is 1:1 with the ContextItem, so when the draft above
        // was ADOPTED rather than created we must re-stamp the existing meta row, not
        // insert a second one for the same `contextItemId`. Mirrors the read-modify-write
        // shape of `applyAssuranceBackfillWithCas` (fresh entity ⇒ fresh change tracking).
        const existingMeta = existingDraft ? await this.summaryMetaRepository.findByContextItem(contextItemId) : null;
        if (existingMeta) {
          Object.assign(existingMeta, summaryMeta, { id: existingMeta.id, contextItemId });
          await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(existingMeta, this.secretsService!));
          await this.summaryMetaRepository.updateWithVersion(existingMeta.id, existingMeta, existingMeta.version ?? 1);
        } else {
          await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(summaryMeta, this.secretsService!));
          // INTENTIONALLY NOT metered here. `dto`
          // (HarnessDraftRequest) carries no token fields, and this generation
          // is already billed by the agent-trajectory per-step path (WS-F):
          // the harness calls SMR via its own SmrClient, never through this
          // gateway's SMR proxy, so `harness:step:<...>` already covers it.
          // Emitting a second `llm:<...>` row here would double-bill the same
          // generation. See the constructor's `usageLedgerService` doc comment
          // and the double-bill-guard test in harness-internal.service.test.ts.
          await this.summaryMetaRepository.create(summaryMeta);
        }

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
   * Second phase of optimistic delivery. The inferential
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
        this.assertConsultationWritable(consultation);

        // (Q2b) — did the clinician early-sign (Q2a) before this
        // verdict landed? If so the note is already immutable and STANDS; a late
        // adverse verdict is recorded as POST_SIGN_FLAG (below), never regressing it.
        const alreadySigned = consultation?.status === ConsultationStatus.SIGNED;

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

        // 4b. A late ADVERSE verdict (FLAG/REGEN) for a
        // note the clinician already early-signed. The signed note is immutable and
        // STANDS — never regressed (step 2's flip is skipped for SIGNED) — but we
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
   * abandons) and maps to GATE_ABANDONED, else GATE_ESCALATED. Re-establishes
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
   * Write the immutable AI-draft `v1` snapshot for the
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
   * Fold-cap for a single attachment's text (F-03) — bounds the
   * per-attachment contribution to the prompt at
   * `ATTACHMENT_TEXT_MAX_LENGTH` chars, appending an explicit truncation
   * marker so the cut is visible in the assembled prompt rather than silent.
   * A no-op for text already at or under the cap.
   */
  private static truncateAttachmentText(text: string): string {
    if (text.length <= HarnessInternalService.ATTACHMENT_TEXT_MAX_LENGTH) return text;
    return text.slice(0, HarnessInternalService.ATTACHMENT_TEXT_MAX_LENGTH) + HarnessInternalService.ATTACHMENT_TRUNCATION_MARKER;
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
