import { AiModelService, IAiTaskDefaultService } from '@arcaai/applications';
import { ModelTaskType } from '@arcaai/domains';
import { BadRequestException, Body, Controller, Inject, Logger, Optional, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '../../decorators';
import { AiInferenceClient } from './ai-inference.client';
import { AnalyzeGuardrailRequest } from './dto/analyze-guardrail.request';
import { ExtractEntitiesRequest } from './dto/extract-entities.request';
import { SuggestDiagnosisRequest } from './dto/suggest-diagnosis.request';

/**
 * AiInferenceController (TASK-446) — the USER-PLANE `/ai/*` inference proxy over
 * the Guardrail and NLP Python services, backing the Agent Playground's
 * Guardrails and NER tabs (matrix row 38). `@Authorize()` (no permission pair):
 * any authenticated caller — GLOBAL_ADMIN or TENANT_ADMIN acting under their
 * OWN account — may call it, mirroring `SmrProxyController` (`/text/*`). These
 * are stateless inference calls over caller-supplied text — no tenant-owned
 * resource is read, so there is no by-id/tenancy surface here.
 *
 * TASK-506 — the NLP routes resolve the tenant's effective default model
 * (`nlp.ner` / `nlp.classification` via `AiTaskDefault`) and inject it as the
 * upstream `model_name` (the AiModel row's `sourceUri`, an HF id) when the
 * caller supplies none. Resolution FAILS OPEN: any resolver error forwards the
 * request without `model_name` so NLP falls back to its env bootstrap default
 * (mirrors the speech-proxy fail-open posture).
 *
 * Contrast: `/admin/ai-services/*` (AiServiceAdminController) is the
 * GLOBAL_ADMIN-only READ-ONLY status/config plane over the same services.
 */
@ApiTags('ai-inference')
@ApiBearerAuth()
@Controller('ai')
export class AiInferenceController {
  private readonly logger = new Logger(AiInferenceController.name);

  constructor(
    private readonly client: AiInferenceClient,
    // TASK-506 — optional so unit fixtures (and deployments without the
    // AiTaskDefault surface) construct cleanly; absent = no model injection.
    @Optional() @Inject(IAiTaskDefaultService) private readonly aiTaskDefaultService?: IAiTaskDefaultService,
    // r2605 Finding B — validates a caller-supplied model override against the
    // registry. Optional for fixture compatibility, but an OVERRIDE with the
    // service absent is rejected (fail-closed) — see resolveValidatedModelOverride.
    @Optional() @Inject(AiModelService) private readonly aiModelService?: AiModelService,
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
    // r2605 Finding B — an explicit override is VALIDATED against the registry
    // (fail-closed); only the absent-override default injection stays fail-open.
    const modelName = body.modelName ? await this.resolveValidatedModelOverride(body.modelName) : await this.resolveDefaultModelName('nlp.ner');
    return this.client.classifyTokens({
      text: body.text,
      aggregation_strategy: body.aggregationStrategy ?? 'simple',
      ...(body.language ? { language: body.language } : {}),
      ...(modelName ? { model_name: modelName } : {}),
    });
  }

  @Post('nlp/diagnosis')
  @Authorize()
  @ApiOperation({
    summary: 'Derive diagnosis suggestions from the supplied clinical text (proxied to the NLP diagnosis endpoint, TASK-506).',
  })
  @ApiOkResponse({ description: 'Upstream `{ suggestions[], ... }`, proxied verbatim.' })
  async suggestDiagnosis(@Body() body: SuggestDiagnosisRequest): Promise<Record<string, unknown>> {
    const modelName = await this.resolveDefaultModelName('nlp.classification');
    return this.client.suggestDiagnosis({
      text: body.text,
      ...(body.minConfidence !== undefined ? { min_confidence: body.minConfidence } : {}),
      ...(body.language ? { language: body.language } : {}),
      ...(modelName ? { model_name: modelName } : {}),
    });
  }

  /**
   * r2605 Finding B (security) — validate a caller-supplied `modelName`
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
  private async resolveValidatedModelOverride(requested: string): Promise<string> {
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
    return match.sourceUri;
  }

  /**
   * TASK-506 — resolve the tenant's effective default model for a task key and
   * return its `sourceUri` (the HF id NLP loads). FAIL OPEN: any error (or a
   * null resolution) yields `undefined`, so the request forwards without a
   * `model_name` and the service uses its env bootstrap default.
   */
  private async resolveDefaultModelName(taskKey: 'nlp.ner' | 'nlp.classification'): Promise<string | undefined> {
    if (!this.aiTaskDefaultService) return undefined;
    try {
      const effective = await this.aiTaskDefaultService.getEffective(taskKey);
      return effective.model?.sourceUri ?? undefined;
    } catch (err) {
      this.logger.warn({
        message: 'AI task default resolution failed; forwarding without model_name (fail-open)',
        taskKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }
}
