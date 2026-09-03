import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize, RequiredScopes } from '../../decorators';
import { AiInferenceClient } from './ai-inference.client';
import { AnalyzeGuardrailRequest } from './dto/analyze-guardrail.request';

/**
 * SafetyCheckController — content-safety / PII / prompt-injection verdicts on
 * caller-supplied text, proxied to the Guardrail service.
 *
 * (decision D-2): split out of the retired `ai` prefix. `ai` named
 * neither of the two capabilities it hosted; a safety verdict is its own
 * resource — you POST a piece of text and get back a check — so it gets its
 * own collection rather than sharing one with the NLP analyses.
 *
 * Stateless: no tenant-owned resource is read, only caller-supplied text, so
 * there is no by-id or tenancy surface here.
 */
@ApiTags('ai-inference')
@ApiBearerAuth()
@Controller('safety-checks')
// API-KEY-NOTE: policy A1 (JWT + API key on the business plane). Carried over
// verbatim from `AiInferenceController`, which hosted this route before the
// split — a stateless safety proxy is a core capability an integrator calls
// headlessly. `@Authorize()` is re-evaluated against the key's bound user by
// `enforceApiKeyAbilities`, so the scope widens reach, never authority.
@RequiredScopes('ai:inference:write')
export class SafetyCheckController {
  constructor(private readonly client: AiInferenceClient) {}

  @Post()
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
}
