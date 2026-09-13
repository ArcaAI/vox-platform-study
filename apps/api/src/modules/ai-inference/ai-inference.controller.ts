import {
  AiModelService,
  COMPUTE_DEVICES,
  IComputeDeviceResolver,
  buildGuardrailUsageBatches,
  buildLlmUsageBatches,
  buildNerUsageEvent,
  derivedLocalPath,
  IActiveUserContext,
  IAiRoutingPolicyService,
  ITenantNlpTaskInstructionsService,
  IUsageLedgerService,
  parseTextUsageDetail,
  resolveDeployment,
  toLedgerProvider,
  type ComputeAugmentedBatch,
  type TextUsageDetail,
  type UsageEventBatchInput,
} from '@arcaai/applications';
import type { ComputeDevice } from '@arcaai/applications';
import { AiDeploymentKind, generateId, ModelTaskType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { BadRequestException, Body, Controller, Inject, Logger, Optional, Post, ServiceUnavailableException } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, RequiredScopes } from '../../decorators';
import { recordUsageEmissionFailure } from '../../observability/usage-emission-metric';
import { AiInferenceClient } from './ai-inference.client';
import { buildNlpClassifyUsage } from './nlp-classify-usage';
import { ClassifyIntentRequest } from './dto/classify-intent.request';
import { ClassifyTopicRequest } from './dto/classify-topic.request';
import { ExtractEntitiesRequest } from './dto/extract-entities.request';
import { SuggestDiagnosisRequest } from './dto/suggest-diagnosis.request';

// The "clinician" definition this controller attributes NER usage to.
// Mirrors DnaWritingStyleController's DNA_DOCTOR_ROLES — the one other place
// in this codebase that already draws this exact line (an admin acting under
// their own account is not a clinician; DOCTOR/SPECIALIST/CONSULTANT are).
const CLINICIAN_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];

/**
 * TASK-959 §3.2 — `inference_ms` off the proxied upstream body, or `null`.
 *
 * The body is relayed verbatim and is typed `Record<string, unknown>`, so both readers are shape
 * checks on an untyped value rather than trust in a schema this controller does not own.
 */
function nerInferenceMs(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/**
 * TASK-959 §3.1 — the device, from the CLOSED vocabulary only. A near-miss spelling records no
 * compute row; it must never be coerced into the more expensive unit.
 */
function nerDevice(value: unknown): ComputeDevice | null {
  return typeof value === 'string' && (COMPUTE_DEVICES as readonly string[]).includes(value) ? (value as ComputeDevice) : null;
}

/**
 * AiInferenceController — the USER-PLANE `/text-analyses/*` proxy over the
 * NLP Python service, backing the Agent Playground's NER tab (matrix row 38).
 *
 * (decision D-2) — this used to be mounted at the bare `ai` prefix and
 * carried the guardrail check too. `ai` was one prefix over two unrelated
 * capabilities, named after neither: a SAFETY VERDICT on caller-supplied text
 * (now `safety-checks`, `SafetyCheckController`) and a set of LINGUISTIC
 * ANALYSES of caller-supplied text (here). The class name is deliberately
 * unchanged — it is referenced by the boot-audit fixtures owned by. `@Authorize()` (no permission pair):
 * any authenticated caller — SUPER_ADMIN or TENANT_ADMIN acting under their
 * OWN account — may call it, mirroring `TextProxyController` (`/text/*`). These
 * are stateless inference calls over caller-supplied text — no tenant-owned
 * resource is read, so there is no by-id/tenancy surface here.
 *
 * The NLP routes resolve the SYSTEM `AiRoutingPolicy`
 * (`nlp.ner` for NER / `nlp.diagnosis` for diagnosis suggestions) and inject it
 * as the upstream `model_name` (the AiModel row's `sourceUri`, an HF id) when the
 * caller supplies none. Resolution FAILS CLOSED: missing/failed SYSTEM default →
 * 503 (no env bootstrap fallback for production selection).
 *
 * Contrast: `/admin/ai-services/*` (AiServiceAdminController) is the
 * SUPER_ADMIN-only READ-ONLY status/config plane over the same services.
 */
/**
 * Pull the NER plane's clinical taxonomy off a registry row's `_metadata`
 * , or null.
 *
 * The same shape-only check `resolveNerModelInjection` applies on the clinical
 * path — validating the CONTENTS belongs to the executor that applies them, and
 * a gateway that quietly dropped a section it did not recognise would make a
 * platform admin's stored value unreachable without saying so.
 */
function readClinicalTaxonomy(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const candidate = (metadata as Record<string, unknown>).clinicalTaxonomy;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  return candidate as Record<string, unknown>;
}

@ApiTags('ai-inference')
@ApiBearerAuth()
@Controller('text-analyses')
// API-KEY-NOTE: policy A1 (JWT + API key on the business plane). A stateless
// inference proxy over Guardrail/NLP is a core capability an integrator calls
// headlessly — no tenant-owned resource is read, only caller-supplied text.
// The `@Authorize()` on each route is re-evaluated against the key's bound
// user by `enforceApiKeyAbilities`, so the scope widens reach, never authority.
@RequiredScopes('ai:inference:write')
export class AiInferenceController {
  private readonly logger = new Logger(AiInferenceController.name);

  constructor(
    private readonly client: AiInferenceClient,
    // Resolves the SYSTEM `nlp.*` routing elections (TASK-881: directly through
    // `resolveDefault`, the `AiTaskDefault` facade is gone). Optional so unit
    // fixtures construct cleanly; absent = the NLP routes refuse (fail-closed).
    @Optional() @Inject(IAiRoutingPolicyService) private readonly routingPolicies?: IAiRoutingPolicyService,
    // Validates a caller-supplied model override against the
    // registry. Optional for fixture compatibility, but an OVERRIDE with the
    // service absent is rejected (fail-closed) — see resolveValidatedModelOverride.
    @Optional() @Inject(AiModelService) private readonly aiModelService?: AiModelService,
    //  — tenantId + clinician-attribution source for
    // the playground NER usage-ledger row. Optional (mirrors AiInferenceClient's
    // own `cls` field) so unit fixtures compile without a mock; absent ⇒ no
    // tenantId is resolvable, so emission simply doesn't happen (see below).
    @Optional() private readonly cls?: ClsService<IActiveUserContext>,
    // Emits the `ner.extract` usage row for the playground
    // `/text-analyses/entities` proxy — the ONE NER call site with no consultation
    // attribution. Optional + trailing so existing positional fixtures keep
    // compiling; absent ⇒ no emission (fail-open — metering must never block
    // the playground tool).
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedgerService?: IUsageLedgerService,
    // resolves the tenant's nlp.topic/nlp.intent instruction
    // content (topic list / intent list) to inject into the NLP proxy body.
    // Optional so unit fixtures compile without a mock; absent = no
    // instructions injected (the NLP endpoint then fails closed with 503,
    // the same posture as a missing model_name).
    @Optional()
    @Inject(ITenantNlpTaskInstructionsService)
    private readonly tenantNlpTaskInstructionsService?: ITenantNlpTaskInstructionsService,
    // TASK-957 F-7b — which device a SELF-HOSTED LLM server ran on, for the `generate` rows the
    // DELEGATED topic/intent routes now write. The shared resolver, not a local read of the same
    // descriptor: it already owns the tenant → SYSTEM cascade, the membership check and the
    // warn-once, and it never raises. @Optional + trailing so every existing positional fixture
    // keeps its arity; absent ⇒ no compute row on a self-hosted leg, never a guessed one.
    @Optional() @Inject(IComputeDeviceResolver) private readonly computeDevice?: IComputeDeviceResolver,
  ) {}

  @Post('entities')
  @Authorize()
  @ApiOperation({
    summary: 'Extract medical entities (NER) from the supplied text (proxied to the NLP token-classification endpoint).',
  })
  @ApiOkResponse({ description: 'Upstream `{ entities[], model_version }`, proxied verbatim.' })
  async extractEntities(@Body() body: ExtractEntitiesRequest): Promise<Record<string, unknown>> {
    // An explicit override is VALIDATED against the registry
    // (fail-closed); only the absent-override default injection stays fail-open.
    // A caller-supplied override pins only the MODEL, and we have no
    // registry provider for an arbitrary override, so profile injection applies
    // to the resolved-default path only.
    let modelName: string;
    // The registry row's operator weight override. Always
    // registry-derived (never caller-supplied), and OMITTED when absent so the
    // payload stays byte-for-byte identical to pre-527 for every existing row.
    let modelPath: string | null = null;
    // The CLINICAL TAXONOMY the resolved checkpoint declares :
    // ontology vocabulary, vitals plausibility bands, ConText/NegEx triggers and
    // the NER contract, all previously Python literals / `TOKEN_CLASSIFIER_*`
    // env fields inside `apps/nlp`. It travels with the MODEL, so an override
    // gets the OVERRIDDEN row's taxonomy — not the default row's, which would
    // apply one checkpoint's conventions to another's output.
    let clinicalTaxonomy: Record<string, unknown> | null = null;
    if (body.modelName) {
      const override = await this.resolveValidatedModelOverride(body.modelName);
      modelName = override.sourceUri;
      modelPath = override.localPath;
      clinicalTaxonomy = override.clinicalTaxonomy;
    } else {
      const selection = await this.resolveDefaultModelSelection('nlp.ner');
      modelName = selection.sourceUri;
      modelPath = selection.localPath;
      clinicalTaxonomy = selection.clinicalTaxonomy;
    }

    const result = await this.client.classifyTokens({
      text: body.text,
      // Absent => the model row's own declared strategy applies downstream.
      ...(body.aggregationStrategy ? { aggregation_strategy: body.aggregationStrategy } : {}),
      ...(body.language ? { language: body.language } : {}),
      ...(modelName ? { model_name: modelName } : {}),
      ...(modelPath ? { model_path: modelPath } : {}),
      // OMITTED when the row declares none — the executor then disables the
      // passes it governs rather than substituting a literal.
      ...(clinicalTaxonomy ? { clinical_taxonomy: clinicalTaxonomy } : {}),
    });

    // TASK-959 §3.2 — the same compute reading the agent NER route records. `result` is the
    // upstream body proxied verbatim, so the two fields are read off it rather than re-derived.
    await this.emitNerUsage(body.text, modelName || null, result);

    return result;
  }

  /**
   * Emit the playground `ner.extract` usage row. This is the
   * ONE NER call site with no consultation context — `buildNerUsageEvent`
   * (shared with ner.processor.ts / summary.service.ts) omits
   * `consultationId` here and attributes `doctorId` instead, when the CLS
   * caller holds a clinician role. Fail-open: no tenantId, no ledger wired, or
   * a ledger rejection all degrade to "not metered" — never a failed request.
   */
  private async emitNerUsage(text: string, model: string | null, upstream?: Record<string, unknown>): Promise<void> {
    const tenantId = this.cls?.get('tenantId');
    if (!this.usageLedgerService || !tenantId) return;
    try {
      await this.usageLedgerService.recordUsage(
        buildNerUsageEvent({
          tenantId,
          requestId: generateId(),
          charCount: [...text].length,
          model,
          doctorId: this.resolveDoctorId(),
          // TASK-959 §3.2 — apps/nlp reports its own device and inference time. Neither is
          // guessed: an absent or unrecognised value records characters and no compute.
          inferenceMs: nerInferenceMs(upstream?.inference_ms),
          device: nerDevice(upstream?.device),
        }),
      );
    } catch (error) {
      this.logger.warn({
        message: 'Playground NER usage emission failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The acting user's id when their CLS roles include a clinician role, else null. */
  private resolveDoctorId(): string | null {
    const user = this.cls?.get('user');
    const roles = user?.roles ?? [];
    if (!user?.id || !roles.some((role: string) => CLINICIAN_ROLES.includes(role))) return null;
    return user.id;
  }

  @Post('diagnosis')
  @Authorize()
  @ApiOperation({
    summary: 'Derive diagnosis suggestions from the supplied clinical text (proxied to the NLP diagnosis endpoint).',
  })
  @ApiOkResponse({ description: 'Upstream `{ suggestions[], ... }`, proxied verbatim.' })
  async suggestDiagnosis(@Body() body: SuggestDiagnosisRequest): Promise<Record<string, unknown>> {
    // This route runs TWO models: `MedicalSuggester` extracts symptoms with an
    // internal NER, then classifies disease over them. Only the disease
    // selection was ever injected — the NER half was a hardcoded
    // `blaze999/Medical-NER` literal inside apps/nlp, so half of a clinical
    // route was un-configurable and invisible to the control plane.
    //
    // The NER half resolves the EXISTING `nlp.ner` key rather than a new one:
    // it is the same medical token-classification task the playground NER tab
    // and the three clinical NER callers already resolve, and its SYSTEM row
    // (`medical-ner`) carries exactly the `sourceUri` the removed literal
    // named — so one key governs every medical-NER surface, and re-pointing it
    // moves them together instead of leaving this one behind.
    //
    // BOTH resolutions FAIL CLOSED (503, never a literal, never a neighbouring
    // tenant's model), and both run BEFORE the upstream call, so an unresolved
    // NER can never produce a half-configured request.
    const selection = await this.resolveDefaultModelSelection('nlp.diagnosis');
    const nerSelection = await this.resolveDefaultModelSelection('nlp.ner');

    const result = await this.client.suggestDiagnosis({
      text: body.text,
      ...(body.minConfidence !== undefined ? { min_confidence: body.minConfidence } : {}),
      ...(body.language ? { language: body.language } : {}),
      ...(selection.sourceUri ? { model_name: selection.sourceUri } : {}),
      // Omitted when the row carries no localPath.
      ...(selection.localPath ? { model_path: selection.localPath } : {}),
      ...(nerSelection.sourceUri ? { ner_model_name: nerSelection.sourceUri } : {}),
      ...(nerSelection.localPath ? { ner_model_path: nerSelection.localPath } : {}),
    });

    // TASK-957 F-7b — this route runs TWO local models and recorded nothing. Its text units and
    // the seconds `apps/nlp` reports for them are billed under `nlp.classify`, a fresh key per
    // invocation (two diagnoses must be two rows, never one row and one silent replay).
    await this.emitNlpClassifyUsage({ charCount: [...body.text].length, model: selection.sourceUri || null, upstream: result });

    return result;
  }

  /**
   * Emit the `nlp.classify` row for a classification bench.
   *
   * Fail-open throughout, exactly like {@link emitNerUsage}: no tenant, no ledger wired, or a
   * ledger rejection all degrade to "not metered" — the analysis already happened and metering
   * must never fail a request that succeeded. The counter is what makes the loss alertable
   * rather than a warn line nobody reads (TASK-957 F-5).
   */
  private async emitNlpClassifyUsage(params: { charCount?: number | null; model: string | null; upstream?: Record<string, unknown> }): Promise<void> {
    const tenantId = this.cls?.get('tenantId');
    if (!this.usageLedgerService || !tenantId) return;
    const batch = buildNlpClassifyUsage({
      tenantId,
      requestId: generateId(),
      doctorId: this.resolveDoctorId(),
      charCount: params.charCount,
      model: params.model,
      // `apps/nlp` reports its own device and inference time. Neither is guessed: an absent or
      // unrecognised value records the text units and no compute.
      inferenceMs: nerInferenceMs(params.upstream?.inference_ms),
      device: nerDevice(params.upstream?.device),
    });
    if (!batch) return;
    try {
      await this.usageLedgerService.recordUsage(batch);
    } catch (error) {
      recordUsageEmissionFailure('nlp.classify');
      this.logger.warn({
        message: 'NLP classification usage emission failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Emit what a DELEGATED classification (`/topic`, `/intent`) actually consumed.
   *
   * Neither route runs a local model: `apps/nlp` builds a prompt and hands it to `apps/text`, so
   * the cost of one classification IS that LLM call plus the guardrail call it triggered. Since
   * TASK-957's nlp half, both blocks ride back verbatim as `llm_usage` / `llm_guardrail_usage`,
   * and this bills them as the SAME `generate` + `guardrail.validate` rows the playground's own
   * text proxy would have written — same builders, same keys (TEXT's task id), same compute and
   * byte rows. It is the same generation; it must not be a different row shape.
   *
   * NOTE the asymmetry with `/diagnosis`: no `TEXT_UNIT` row here. Charging text units on top of
   * the tokens would bill one activity twice, on two capabilities. An `nlp.classify` COMPUTE row
   * is still written if `apps/nlp` ever reports seconds of its own — its seconds are its own,
   * whoever ran the tokens.
   */
  private async emitDelegatedClassifyUsage(upstream?: Record<string, unknown>): Promise<void> {
    const tenantId = this.cls?.get('tenantId');
    if (!this.usageLedgerService || !tenantId) return;
    const ledger = this.usageLedgerService;
    const doctorId = this.resolveDoctorId();

    const generation = parseTextUsageDetail(upstream?.llm_usage);
    const screening = parseTextUsageDetail(upstream?.llm_guardrail_usage);

    try {
      const inputs: UsageEventBatchInput[] = [];
      if (generation) {
        inputs.push(
          ...halves(
            buildLlmUsageBatches({
              usage: generation,
              tenantId,
              operation: 'generate',
              doctorId,
              device: await this.llmDevice(tenantId, generation),
            }),
          ),
        );
      }
      if (screening) {
        // Its OWN provider call — own operation, own key, own device (a tenant may screen on one
        // engine and generate on another).
        inputs.push(
          ...halves(
            buildGuardrailUsageBatches({
              usage: screening,
              tenantId,
              doctorId,
              fallbackRequestId: generation?.taskId ?? null,
              device: await this.llmDevice(tenantId, screening),
            }),
          ),
        );
      }
      const computeOnly = buildNlpClassifyUsage({
        tenantId,
        requestId: generateId(),
        doctorId,
        model: null,
        inferenceMs: nerInferenceMs(upstream?.inference_ms),
        device: nerDevice(upstream?.device),
      });
      if (computeOnly) inputs.push(computeOnly);

      for (const input of inputs) {
        await ledger.recordUsage(input);
      }
    } catch (error) {
      recordUsageEmissionFailure('generate');
      this.logger.warn({
        message: 'Delegated NLP classification usage emission failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The device a parsed usage block's OWN provider ran on, or `null`.
   *
   * A CLOUD or BYOK leg is not the vendor's hardware — those seconds are the platform's own CPU
   * spent calling the vendor, which the shared appender meters as `cpu` whatever is passed — so
   * nothing is resolved for them and the cascade is not read at all. `null` also when the
   * resolver is unwired or raises despite its contract: no compute row, never a guessed one.
   */
  private async llmDevice(tenantId: string, usage: TextUsageDetail): Promise<ComputeDevice | null> {
    const provider = toLedgerProvider(usage.textProvider);
    if (resolveDeployment(provider, usage.byok) !== AiDeploymentKind.SELF_HOSTED) return null;
    try {
      return (await this.computeDevice?.resolve(tenantId, provider)) ?? null;
    } catch (error: unknown) {
      this.logger.warn({
        message: 'Compute device unresolved; metering this classification without a compute row',
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  @Post('topic')
  @Authorize()
  @ApiOperation({
    summary: 'Classify text into one of the caller tenant configured topics (open-taxonomy, delegated by NLP to text).',
    description:
      'The topic list is NEVER caller-supplied — resolved server-side from TenantNlpTaskInstructions (nlp.topic) and ' +
      'injected as `instructions`. A tenant with no configured topic list gets a 503 from NLP (fail-closed).',
  })
  @ApiOkResponse({ description: 'Upstream `{ predicted_topic, available_topics[] }`, proxied verbatim.' })
  async classifyTopic(@Body() body: ClassifyTopicRequest): Promise<Record<string, unknown>> {
    const tenantId = this.resolveTenantIdOrThrow();
    const instructions = await this.resolveNlpInstructions('nlp.topic', tenantId);
    const result = await this.client.classifyTopic({
      text: body.text,
      ...(body.language ? { language: body.language } : {}),
      ...(instructions ? { instructions } : {}),
      tenant_id: tenantId,
    });
    // TASK-957 F-7b — the delegated LLM call is what this classification cost.
    await this.emitDelegatedClassifyUsage(result);
    return result;
  }

  @Post('intent')
  @Authorize()
  @ApiOperation({
    summary: 'Classify text into one of the caller tenant configured intents (open-taxonomy, delegated by NLP to text).',
    description:
      'The intent list is NEVER caller-supplied — resolved server-side from TenantNlpTaskInstructions (nlp.intent) and ' +
      'injected as `instructions`. A tenant with no configured intent list gets a 503 from NLP (fail-closed).',
  })
  @ApiOkResponse({ description: 'Upstream `{ predicted_intent, available_intents[] }`, proxied verbatim.' })
  async classifyIntent(@Body() body: ClassifyIntentRequest): Promise<Record<string, unknown>> {
    const tenantId = this.resolveTenantIdOrThrow();
    const instructions = await this.resolveNlpInstructions('nlp.intent', tenantId);
    const result = await this.client.classifyIntent({
      text: body.text,
      ...(body.language ? { language: body.language } : {}),
      ...(instructions ? { instructions } : {}),
      tenant_id: tenantId,
    });
    // See `/topic` above.
    await this.emitDelegatedClassifyUsage(result);
    return result;
  }

  /** The caller's CLS tenant, or 503 — these two routes need a tenant to resolve instructions for. */
  private resolveTenantIdOrThrow(): string {
    const tenantId = this.cls?.get('tenantId');
    if (!tenantId) {
      throw new ServiceUnavailableException('Tenant context is required to resolve NLP task instructions.');
    }
    return tenantId;
  }

  /**
   * Resolve the tenant's `TenantNlpTaskInstructions` row for `taskKey` and
   * return its `instructionsJson`. Never throws: a missing service, a
   * missing/placeholder row, or a resolution error all degrade to `null`
   * (the NLP endpoint itself fails closed with 503 on an empty/absent list —
   * this only ever forwards tenant-authored content, never a model selection).
   */
  private async resolveNlpInstructions(taskKey: 'nlp.topic' | 'nlp.intent', tenantId: string): Promise<string[] | null> {
    if (!this.tenantNlpTaskInstructionsService) {
      return null;
    }
    try {
      const row = await this.tenantNlpTaskInstructionsService.getRow(taskKey, tenantId);
      return row.instructionsJson ?? null;
    } catch (err) {
      this.logger.warn({
        message: 'TenantNlpTaskInstructions resolution failed; proceeding without injected instructions (NLP fails closed)',
        taskKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Validate a caller-supplied `modelName`
   * override against the registry before forwarding it to NLP. Previously the
   * raw value was proxied verbatim, letting any authenticated user make the
   * clinical NLP service download/load an ARBITRARY HuggingFace model. The
   * override must match an ENABLED `TOKEN_CLASSIFICATION` registry row visible
   * in [tenant, SYSTEM] (shared-read) by `slug` OR `sourceUri`; the row's
   * `sourceUri` is what gets forwarded. FAILS CLOSED: an unknown value, a
   * registry read failure, or a missing registry service all reject with 400 —
   * an unvalidatable override is never forwarded (unlike the fail-open
   * default injection below, which only ever forwards registry-derived ids).
   */
  private async resolveValidatedModelOverride(
    requested: string,
  ): Promise<{ sourceUri: string; localPath: string | null; clinicalTaxonomy: Record<string, unknown> | null }> {
    const rejection = () =>
      new BadRequestException(
        `modelName '${requested}' is not an ENABLED TOKEN_CLASSIFICATION model in the registry (expected a registry slug or sourceUri).`,
      );
    if (!this.aiModelService) {
      throw rejection();
    }
    let rows;
    try {
      rows = await this.aiModelService.getByTaskTypeSharedRead(ModelTaskType.TOKEN_CLASSIFICATION);
    } catch (err) {
      this.logger.warn({
        message: 'Registry read failed while validating a modelName override; rejecting the override (fail-closed)',
        error: err instanceof Error ? err.message : String(err),
      });
      throw rejection();
    }
    const match = rows.find((row) => row.slug === requested || row.sourceUri === requested);
    if (!match) {
      throw rejection();
    }
    // The weight path comes from the MATCHED REGISTRY ROW, never
    // from the caller, so an override cannot point NLP at an arbitrary path.
    return {
      sourceUri: match.sourceUri,
      // TASK-890 §3.11 — DERIVED from the matched row's bucket identity, never a
      // stored column and never anything the caller supplied.
      localPath: derivedLocalPath(match),
      clinicalTaxonomy: readClinicalTaxonomy((match as { metaData?: unknown }).metaData),
    };
  }

  /**
   * Resolve the SYSTEM effective default model for a task key and
   * return its `sourceUri` (the HF id NLP loads). FAIL CLOSED: missing service,
   * resolver error, or null model → 503 (no silent env bootstrap).
   */
  private async resolveDefaultModelName(taskKey: 'nlp.ner' | 'nlp.diagnosis'): Promise<string> {
    return (await this.resolveDefaultModelSelection(taskKey)).sourceUri;
  }

  /**
   * The same fail-closed resolution as `resolveDefaultModelName`,
   * but keeping the `provider` / `modelSlug` the runtime-profile cascade is
   * keyed on. Split out rather than re-calling `resolveDefault` a second time.
   */
  private async resolveDefaultModelSelection(taskKey: 'nlp.ner' | 'nlp.diagnosis'): Promise<{
    sourceUri: string;
    provider: string | null;
    modelSlug: string | null;
    localPath: string | null;
    clinicalTaxonomy: Record<string, unknown> | null;
  }> {
    if (!this.routingPolicies) {
      throw new ServiceUnavailableException(`SYSTEM routing election for '${taskKey}' is unavailable (AiRoutingPolicyService not wired).`);
    }
    try {
      // `nlp.*` is platform-only: the SYSTEM election is the only tier read.
      const resolved = await this.routingPolicies.resolveDefault(SYSTEM_TENANT_ID, taskKey, { systemOnly: true });
      const sourceUri = resolved.model?.sourceUri;
      if (!sourceUri) {
        throw new ServiceUnavailableException(`SYSTEM routing election for '${taskKey}' is missing or names no ENABLED model. Run db:seed.`);
      }
      return {
        sourceUri,
        provider: resolved.model?.provider ?? null,
        modelSlug: resolved.model?.slug ?? null,
        // TASK-890 §3.11 — DERIVED from the elected row's bucket identity.
        localPath: derivedLocalPath(resolved.model),
        clinicalTaxonomy: readClinicalTaxonomy(resolved.model?.metaData),
      };
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.warn({
        message: 'AI task default resolution failed (fail-closed)',
        taskKey,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ServiceUnavailableException(`SYSTEM routing election for '${taskKey}' could not be resolved.`);
    }
  }
}

/**
 * Both halves of an augmented pair (TASK-959 §6.3).
 *
 * A BYOK call's platform CPU leg carries `costBasis: INTERNAL` while its token rows stay
 * `BYOK_NOTIONAL`, and `costBasis` lives on `common` — so saying both takes two batches. A
 * caller that records only the first loses that one row. A non-BYOK pair flattens to the one
 * batch it always was.
 */
function halves(pair: ComputeAugmentedBatch | null): UsageEventBatchInput[] {
  if (!pair) return [];
  return pair.platformBatch ? [pair.batch, pair.platformBatch] : [pair.batch];
}
