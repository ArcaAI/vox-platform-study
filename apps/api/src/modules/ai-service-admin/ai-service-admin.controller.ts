import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '../../decorators';
import { AiServiceProxyClient, GuardrailConfigResult } from './ai-service-proxy.client';

/**
 * AiServiceAdminController.
 *
 * READ-ONLY status/config plane over the Guardrail and NLP Python services,
 * proxied through the gateway (the console never reaches them directly).
 * Platform-infrastructure tier — class-level `manage:all` (SUPER_ADMIN),
 * matching the queue/platform-metrics posture: these documents expose engine,
 * model, and infra internals, not tenant data.
 *
 * Deliberately no mutation routes: neither Python service exposes internal
 * config writes, so the gateway does not invent them (config changes are
 * deploy-time env/settings changes on those services).
 */
@ApiTags('admin-ai-services')
@ApiBearerAuth()
@Authorize(['manage', 'all'])
@Controller('admin/ai-services')
export class AiServiceAdminController {
  constructor(private readonly proxyClient: AiServiceProxyClient) {}

  @Get('guardrail/status')
  @ApiOperation({
    summary: 'Guardrail service health (proxied /api/health): LLM engine, GLiNER, and Redis component checks.',
  })
  @ApiOkResponse({ description: 'Upstream guardrail health document, proxied verbatim.' })
  async guardrailStatus(): Promise<Record<string, unknown>> {
    return this.proxyClient.guardrailStatus();
  }

  @Get('guardrail/config')
  @ApiOperation({
    summary: 'Guardrail read-only configuration: medical-validation engine settings + supported analysis types.',
  })
  @ApiOkResponse({ description: 'Merged `{ medicalValidation, analysisTypes }` document from the guardrail service.' })
  async guardrailConfig(): Promise<GuardrailConfigResult> {
    return this.proxyClient.guardrailConfig();
  }

  @Get('nlp/status')
  @ApiOperation({
    summary: 'NLP service health (proxied /api/v1/health): per-model component checks with load status.',
  })
  @ApiOkResponse({ description: 'Upstream NLP health document, proxied verbatim.' })
  async nlpStatus(): Promise<Record<string, unknown>> {
    return this.proxyClient.nlpStatus();
  }
}
