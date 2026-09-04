import { ModelResponse, RegisterDiscoveredModelRequest } from '@arcaai/applications';
import { Body, Controller, Get, GoneException, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Authorize, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
import { AiModelDiscoveryService, DiscoveryResponse } from './ai-model-discovery.service';

/**
 * LM Studio / Ollama model discovery.
 *
 * Joins the `admin/ai-models` controller family with the identical guard
 * (`manage:all`, the super-admin registry plane). Thin by
 * rule 05: the TEXT fetch and the merge live in `AiModelDiscoveryService`.
 *
 * The registry stays authoritative for task routing (`AiTaskDefault` reads the
 * DB only). Discovery is an OPERATOR AFFORDANCE — it never mutates rows, and
 * the only way a discovered model enters governance is the explicit, audited
 * `POST discovery/register` below.
 */
@ApiBearerAuth()
@ApiTags('admin-ai-models')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:ai-model:manage')
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
  @ApiQuery({ name: 'provider', required: false, type: String, description: 'TEXT registry key, e.g. `ollama` or `lm-studio`.' })
  @ApiResponse({ status: 200, type: DiscoveryResponse })
  async discover(@Query('provider') provider?: string): Promise<DiscoveryResponse> {
    return this.discoveryService.discover(provider);
  }

  /**
   * @deprecated TASK-860 — removed in R3. Registration is from the catalogue
   * (`POST admin/ai-models`, optionally with a `bucketPrefix` for weights the
   * inventory found "in bucket, not registered"); discovery is READ-ONLY. Per
   * the program's deprecation policy a deprecated WRITE path refuses once its
   * replacement ships, so this answers `410 Gone` and never reaches the
   * service. The route stays mounted (and documented as deprecated) so an
   * old console build gets an actionable error rather than a 404.
   */
  @Post('discovery/register')
  @HttpCode(HttpStatus.GONE)
  @ApiOperation({
    deprecated: true,
    summary: 'DEPRECATED (TASK-860, removed in R3) — register a discovered model',
    description:
      'Refuses with `410 Gone`. Discovery is read-only since TASK-860; register a model through `POST admin/ai-models` ' +
      '(the inventory report lists prefixes already in the bucket, which register with their `bucketPrefix`).',
  })
  @ApiResponse({
    status: 410,
    description: "Deprecated — use POST admin/ai-models (register from the catalogue / the inventory's unregistered prefixes).",
  })
  async register(@Body() _request: RegisterDiscoveredModelRequest): Promise<ModelResponse> {
    throw new GoneException(
      'POST admin/ai-models/discovery/register is deprecated (TASK-860): discovery is read-only. ' +
        'Register the model through POST admin/ai-models — run POST admin/ai-models/inventory to list weights already in the bucket and register from the bucket with their bucketPrefix.',
    );
  }
}
