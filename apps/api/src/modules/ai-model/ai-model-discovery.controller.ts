import { ModelResponse, RegisterDiscoveredModelRequest } from '@arcaai/applications';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Authorize } from '../../decorators';
import { AiModelDiscoveryService, DiscoveryResponse } from './ai-model-discovery.service';

/**
 * LM Studio / Ollama model discovery.
 *
 * Joins the `admin/ai-models` controller family with the identical guard
 * (`manage:all`, the global-admin registry plane). Thin by
 * rule 05: the SMR fetch and the merge live in `AiModelDiscoveryService`.
 *
 * The registry stays authoritative for task routing (`AiTaskDefault` reads the
 * DB only). Discovery is an OPERATOR AFFORDANCE — it never mutates rows, and
 * the only way a discovered model enters governance is the explicit, audited
 * `POST discovery/register` below.
 */
@ApiBearerAuth()
@ApiTags('admin-ai-models')
@Controller('admin/ai-models')
@Authorize(['manage', 'all'])
export class AiModelDiscoveryController {
  constructor(private readonly discoveryService: AiModelDiscoveryService) {}

  @Get('discovery')
  @ApiOperation({
    summary: 'Merge the AI model registry with the live engine listings',
    description:
      'Returns every server-managed model known to either side, each tagged `registered`, `discovered` or ' +
      '`registered-missing-on-server`, plus per-provider probe outcomes and the probe timestamp. A provider whose ' +
      'probe did not succeed degrades its registry rows to `registered`/`unknown` — never to a false "missing".',
  })
  @ApiQuery({ name: 'provider', required: false, type: String, description: 'SMR registry key, e.g. `ollama` or `lm-studio`.' })
  @ApiResponse({ status: 200, type: DiscoveryResponse })
  async discover(@Query('provider') provider?: string): Promise<DiscoveryResponse> {
    return this.discoveryService.discover(provider);
  }

  @Post('discovery/register')
  @ApiOperation({
    summary: 'Register a discovered model into the AI model registry',
    description:
      'Creates one `AiModel` row from a discovered entry (slug derived from the engine-reported model name). ' +
      'Delegates to the existing create path, so the factory, the `ResourceCreated` sys-event and the slug-uniqueness ' +
      'check all apply. On a slug collision the response is 400 asking for an explicit `slug` — there is no silent suffixing.',
  })
  @ApiResponse({ status: 201, type: ModelResponse })
  @ApiResponse({ status: 400, description: 'Unknown/non-server-managed provider, or the derived slug is already taken.' })
  async register(@Body() request: RegisterDiscoveredModelRequest): Promise<ModelResponse> {
    return this.discoveryService.register(request);
  }
}
