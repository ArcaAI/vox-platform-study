import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '../../decorators';
import { AiInferenceClient } from './ai-inference.client';
import { AnalyzeGuardrailRequest } from './dto/analyze-guardrail.request';
import { ExtractEntitiesRequest } from './dto/extract-entities.request';

/**
 * AiInferenceController (TASK-446) — the USER-PLANE `/ai/*` inference proxy over
 * the Guardrail and NLP Python services, backing the Agent Playground's
 * Guardrails and NER tabs (matrix row 38). `@Authorize()` (no permission pair):
 * any authenticated caller — GLOBAL_ADMIN or TENANT_ADMIN acting under their
 * OWN account — may call it, mirroring `SmrProxyController` (`/text/*`). These
 * are stateless inference calls over caller-supplied text — no tenant-owned
 * resource is read, so there is no by-id/tenancy surface here.
 *
 * Contrast: `/admin/ai-services/*` (AiServiceAdminController) is the
 * GLOBAL_ADMIN-only READ-ONLY status/config plane over the same services.
 */
@ApiTags('ai-inference')
@ApiBearerAuth()
@Controller('ai')
export class AiInferenceController {
  constructor(private readonly client: AiInferenceClient) {}

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
    return this.client.classifyTokens({
      text: body.text,
      aggregation_strategy: body.aggregationStrategy ?? 'simple',
      ...(body.language ? { language: body.language } : {}),
    });
  }
}
