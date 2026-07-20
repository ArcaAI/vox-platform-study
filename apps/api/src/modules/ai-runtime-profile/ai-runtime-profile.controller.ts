import { AiRuntimeProfileResponse, IAiRuntimeProfileService, UpsertAiRuntimeProfileRequest } from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Authorize, ExpectedVersion, RequiresIfMatch } from '../../decorators';

/**
 * AiRuntimeProfileController (TASK-524) — the admin surface for runtime
 * profiles (hyperparameters / context / concurrency), mounted at
 * `/admin/ai-runtime-profiles`.
 *
 *  - `GET ''`         → every SYSTEM profile row.
 *  - `GET 'row'`      → ONE row by `?provider=&modelSlug=` (`version` drives
 *                       the OCC token; `version: 0` placeholder when absent).
 *  - `GET 'resolve'`  → the RESOLVED cascade for a (provider, modelSlug) —
 *                       a debug/inspection read showing exactly what the
 *                       gateway would inject.
 *  - `PUT 'row'`      → create (`expectedVersion` 0) or CAS-update under
 *                       `If-Match` (drift → 412, missing → 428).
 *  - `DELETE 'row'`   → soft-delete.
 *
 * `modelSlug` is a QUERY parameter rather than a path segment because its
 * provider-level-default value is the EMPTY STRING, which cannot be expressed
 * as a path segment. Omitting it therefore addresses the provider default —
 * exactly matching the storage sentinel.
 *
 * GOVERNANCE: hyperparameters are GLOBAL-ADMIN-ONLY and live only on the SYSTEM
 * tenant (owner expectation E5). `@Authorize(['manage', 'all'])` gates the
 * route; `AiRuntimeProfileService` re-asserts both rules with a
 * `ForbiddenException` so a service-to-service caller cannot bypass them.
 */
@ApiTags('Admin: AI Runtime Profiles')
@ApiBearerAuth()
@Controller('admin/ai-runtime-profiles')
export class AiRuntimeProfileController {
  constructor(
    @Inject(IAiRuntimeProfileService)
    private readonly profileService: IAiRuntimeProfileService,
  ) {}

  @Get()
  @Authorize(['manage', 'all'])
  @ApiOperation({ summary: 'List every platform runtime profile.' })
  @ApiResponse({ status: 200, type: [AiRuntimeProfileResponse] })
  async list(): Promise<AiRuntimeProfileResponse[]> {
    return this.profileService.list();
  }

  @Get('row')
  @Authorize(['manage', 'all'])
  @ApiOperation({ summary: 'Read one runtime profile row (placeholder when absent).' })
  @ApiQuery({ name: 'provider', required: true, description: 'Serving provider, e.g. `lm-studio`.' })
  @ApiQuery({
    name: 'modelSlug',
    required: false,
    description: 'Model slug. Omit (or send empty) for the provider-level default row.',
  })
  @ApiResponse({ status: 200, type: AiRuntimeProfileResponse })
  async getRow(@Query('provider') provider: string, @Query('modelSlug') modelSlug?: string): Promise<AiRuntimeProfileResponse> {
    return this.profileService.getProfile(provider, modelSlug ?? '');
  }

  @Get('resolve')
  @Authorize(['manage', 'all'])
  @ApiOperation({
    summary: 'Resolve the effective runtime profile for a (provider, modelSlug).',
    description:
      'Shows the per-field merge of the model-scoped row over the provider-level default — exactly what the ' +
      'gateway would inject. `isEmpty: true` means nothing is injected and the consuming service keeps its own ' +
      'env/pydantic defaults.',
  })
  @ApiQuery({ name: 'provider', required: true })
  @ApiQuery({ name: 'modelSlug', required: false })
  @ApiResponse({ status: 200, description: 'The resolved profile with an `isEmpty` discriminator.' })
  async resolve(@Query('provider') provider: string, @Query('modelSlug') modelSlug?: string) {
    return this.profileService.resolveProfile(provider, modelSlug ?? '');
  }

  @Put('row')
  @Authorize(['manage', 'all'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Create or update one runtime profile row.',
    description:
      'Optimistic concurrency is enforced: `If-Match` (RFC 7232) is REQUIRED and the server runs a Compare-And-Set ' +
      "against the row's `_version`. The header overrides the body-field `expectedVersion`. Drift → `412`; missing " +
      'header → `428`. Use `expectedVersion: 0` to create. Every knob is optional — omitting one leaves it ' +
      'unchanged, sending `null` clears it back to "no opinion" so the cascade falls through.',
  })
  @ApiQuery({ name: 'provider', required: true })
  @ApiQuery({ name: 'modelSlug', required: false })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiResponse({ status: 200, type: AiRuntimeProfileResponse })
  @ApiResponse({ status: 400, description: 'A knob is outside its permitted range.' })
  @ApiResponse({ status: 403, description: 'Not a global admin, or a non-SYSTEM tenant was targeted.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async upsert(
    @Body() request: UpsertAiRuntimeProfileRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('provider') provider?: string,
    @Query('modelSlug') modelSlug?: string,
  ): Promise<AiRuntimeProfileResponse> {
    const dto = { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion };
    return this.profileService.upsertProfile(provider ?? '', modelSlug ?? '', dto);
  }

  @Delete('row')
  @Authorize(['manage', 'all'])
  @ApiOperation({ summary: 'Soft-delete one runtime profile row.' })
  @ApiQuery({ name: 'provider', required: true })
  @ApiQuery({ name: 'modelSlug', required: false })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  @ApiResponse({ status: 403, description: 'Not a global admin.' })
  async remove(@Query('provider') provider: string, @Query('modelSlug') modelSlug?: string): Promise<void> {
    return this.profileService.deleteProfile(provider, modelSlug ?? '');
  }
}
