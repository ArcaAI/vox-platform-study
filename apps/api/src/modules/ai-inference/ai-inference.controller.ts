import {
  AiModelService,
  buildNerUsageEvent,
  IActiveUserContext,
  IAiRuntimeProfileService,
  IAiTaskDefaultService,
  IUsageLedgerService,
} from '@arcaai/applications';
import { generateId, ModelTaskType } from '@arcaai/domains';
import { BadRequestException, Body, Controller, Inject, Logger, Optional, Post, ServiceUnavailableException } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize } from '../../decorators';
import { AiInferenceClient } from './ai-inference.client';
import { AnalyzeGuardrailRequest } from './dto/analyze-guardrail.request';
import { ExtractEntitiesRequest } from './dto/extract-entities.request';
import { SuggestDiagnosisRequest } from './dto/suggest-diagnosis.request';

// The "clinician" definition this controller attributes NER usage to.
// Mirrors DnaWritingStyleController's DNA_DOCTOR_ROLES — the one other place
// in this codebase that already draws this exact line (an admin acting under
// their own account is not a clinician; DOCTOR/SPECIALIST/CONSULTANT are).
const CLINICIAN_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];

/**
 * AiInferenceController — the USER-PLANE `/ai/*` inference proxy over
 * the Guardrail and NLP Python services, backing the Agent Playground's
 * Guardrails and NER tabs (matrix row 38). `@Authorize()` (no permission pair):
 * any authenticated caller — SUPER_ADMIN or TENANT_ADMIN acting under their
 * OWN account — may call it, mirroring `SmrProxyController` (`/text/*`). These
 * are stateless inference calls over caller-supplied text — no tenant-owned
 * resource is read, so there is no by-id/tenancy surface here.
 *
 * The NLP routes resolve the SYSTEM `AiTaskDefault`
 * (`nlp.ner` for NER / `nlp.diagnosis` for diagnosis suggestions) and inject it
 * as the upstream `model_name` (the AiModel row's `sourceUri`, an HF id) when the
 * caller supplies none. Resolution FAILS CLOSED: missing/failed SYSTEM default →
 * 503 (no env bootstrap fallback for production selection).
 *
 * Contrast: `/admin/ai-services/*` (AiServiceAdminController) is the
 * SUPER_ADMIN-only READ-ONLY status/config plane over the same services.
 */
@ApiTags('ai-inference')
@ApiBearerAuth()
@Controller('ai')
export class AiInferenceController {
  private readonly logger = new Logger(AiInferenceController.name);

  constructor(
    private readonly client: AiInferenceClient,
    // Optional so unit fixtures (and deployments without the
    // AiTaskDefault surface) construct cleanly; absent = no model injection.
    @Optional() @Inject(IAiTaskDefaultService) private readonly aiTaskDefaultService?: IAiTaskDefaultService,
    // Validates a caller-supplied model override against the
    // registry. Optional for fixture compatibility, but an OVERRIDE with the
    // service absent is rejected (fail-closed) — see resolveValidatedModelOverride.
    @Optional() @Inject(AiModelService) private readonly aiModelService?: AiModelService,
    // Resolves the effective hyperparameter profile for the model
    // being called. Optional; absent = no parameter injection.
    @Optional()
    @Inject(IAiRuntimeProfileService)
    private readonly aiRuntimeProfileService?: IAiRuntimeProfileService,
    // (item 2) — tenantId + clinician-attribution source for
    // the playground NER usage-ledger row. Optional (mirrors AiInferenceClient's
    // own `cls` field) so unit fixtures compile without a mock; absent ⇒ no
    // tenantId is resolvable, so emission simply doesn't happen (see below).
    @Optional() private readonly cls?: ClsService<IActiveUserContext>,
    // Emits the `ner.extract` usage row for the playground
    // `/ai/nlp/entities` proxy — the ONE NER call site with no consultation
    // attribution. Optional + trailing so existing positional fixtures keep
    // compiling; absent ⇒ no emission (fail-open — metering must never block
    // the playground tool).
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedgerService?: IUsageLedgerService,
  ) {}

  @Post('guardrail/analyze')
  @Authorize()
  @ApiOperation({
    summary: 'Run a content-safety / PII / prompt-injection check on the supplied text (proxied to the Guardrail service).',
  })
  @ApiOkResponse({ description: 'Upstream guardrail verdict `{ safe, issues[], confidence, ... }`, proxied verbatim.' })
  async analyzeGuardrail(@Body() body: AnalyzeGuardrailRequest): Promise<Record<string, unknown>> {
    return this.client.analyzeGuardrail({
      text: body.text,
      guardrail_type: body.guardrailType ?? 'comprehensive',
    });
  }

  @Post('nlp/entities')
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
    let runtimeParams: Record<string, unknown> = {};
    if (body.modelName) {
      const override = await this.resolveValidatedModelOverride(body.modelName);
      modelName = override.sourceUri;
      modelPath = override.localPath;
    } else {
      const selection = await this.resolveDefaultModelSelection('nlp.ner');
      modelName = selection.sourceUri;
      modelPath = selection.localPath;
      runtimeParams = await this.resolveRuntimeParams(selection.provider, selection.modelSlug);
    }

    const result = await this.client.classifyTokens({
      text: body.text,
      aggregation_strategy: body.aggregationStrategy ?? 'simple',
      ...(body.language ? { language: body.language } : {}),
      ...(modelName ? { model_name: modelName } : {}),
      ...(modelPath ? { model_path: modelPath } : {}),
      ...runtimeParams,
    });

    await this.emitNerUsage(body.text, modelName || null);

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
  private async emitNerUsage(text: string, model: string | null): Promise<void> {
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

  @Post('nlp/diagnosis')
  @Authorize()
  @ApiOperation({
    summary: 'Derive diagnosis suggestions from the supplied clinical text (proxied to the NLP diagnosis endpoint).',
  })
  @ApiOkResponse({ description: 'Upstream `{ suggestions[], ... }`, proxied verbatim.' })
  async suggestDiagnosis(@Body() body: SuggestDiagnosisRequest): Promise<Record<string, unknown>> {
    const selection = await this.resolveDefaultModelSelection('nlp.diagnosis');
    const runtimeParams = await this.resolveRuntimeParams(selection.provider, selection.modelSlug);

    return this.client.suggestDiagnosis({
      text: body.text,
      ...(body.minConfidence !== undefined ? { min_confidence: body.minConfidence } : {}),
      ...(body.language ? { language: body.language } : {}),
      ...(selection.sourceUri ? { model_name: selection.sourceUri } : {}),
      // Omitted when the row carries no localPath.
      ...(selection.localPath ? { model_path: selection.localPath } : {}),
      ...runtimeParams,
    });
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
  private async resolveValidatedModelOverride(requested: string): Promise<{ sourceUri: string; localPath: string | null }> {
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
      localPath: (match as { localPath?: string | null }).localPath ?? null,
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
   * keyed on. Split out rather than re-calling `getEffective` a second time.
   */
  private async resolveDefaultModelSelection(
    taskKey: 'nlp.ner' | 'nlp.diagnosis',
  ): Promise<{ sourceUri: string; provider: string | null; modelSlug: string | null; localPath: string | null }> {
    if (!this.aiTaskDefaultService) {
      throw new ServiceUnavailableException(`SYSTEM AiTaskDefault for '${taskKey}' is unavailable (AiTaskDefaultService not wired).`);
    }
    try {
      const effective = await this.aiTaskDefaultService.getEffective(taskKey);
      const sourceUri = effective.model?.sourceUri;
      if (!sourceUri) {
        throw new ServiceUnavailableException(`SYSTEM AiTaskDefault for '${taskKey}' is missing or has no ENABLED model. Run db:seed.`);
      }
      return {
        sourceUri,
        provider: (effective.model as { provider?: string } | null)?.provider ?? null,
        modelSlug: effective.modelSlug ?? null,
        // Operator weight override from the registry row.
        localPath: (effective.model as { localPath?: string | null } | null)?.localPath ?? null,
      };
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.warn({
        message: 'AI task default resolution failed (fail-closed)',
        taskKey,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ServiceUnavailableException(`SYSTEM AiTaskDefault for '${taskKey}' could not be resolved.`);
    }
  }

  /**
   * Resolve the runtime profile for a (provider, modelSlug) and
   * project it onto the upstream NLP payload fields.
   *
   * FAIL-OPEN, in deliberate contrast to the model-IDENTITY path above: if the
   * profile cannot be resolved the request proceeds and the NLP service keeps
   * its own env defaults. Calling the right MODEL is a correctness/safety
   * property; calling it with the service's default concurrency is the status
   * quo. Returns `{}` — an empty spread — whenever there is nothing to inject,
   * so with zero profile rows seeded the payload is byte-identical to today's.
   */
  private async resolveRuntimeParams(provider: string | null, modelSlug: string | null): Promise<Record<string, unknown>> {
    if (!this.aiRuntimeProfileService || !provider) {
      return {};
    }
    try {
      const profile = await this.aiRuntimeProfileService.resolveProfile(provider, modelSlug ?? '');
      if (profile.isEmpty) {
        return {};
      }
      return {
        ...(profile.maxConcurrent !== null ? { max_concurrent: profile.maxConcurrent } : {}),
        ...(profile.timeoutS !== null ? { timeout_s: profile.timeoutS } : {}),
        ...(profile.contextLength !== null ? { context_length: profile.contextLength } : {}),
        ...(profile.extraJson ? { extra: profile.extraJson } : {}),
      };
    } catch (err) {
      this.logger.warn({
        message: 'Runtime-profile resolution failed; proceeding without injected parameters (fail-open)',
        provider,
        modelSlug,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }
}
