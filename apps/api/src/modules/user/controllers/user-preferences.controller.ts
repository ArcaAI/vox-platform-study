import { IUserPreferencesService, UserPreferencesResponse, UpdateUserPreferencesRequest } from '@arcaai/applications';
import { Controller, Get, Patch, Body, Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Authorize, RequiredScopes } from '../../../decorators';

/**
 * Controller for current user's SDK preferences.
 * Returns typed preferences aggregated from UserSettings (namespace: arcaai-sdk).
 */
/**
 * TASK-758 — the `me` semantics an integrator cannot infer from the path.
 *
 * `UnifiedAuthGuard.handleApiKeyAuth` sets the CLS principal from
 * `apiKeyEntity.userId`, so under a key `me` is the BOUND USER — not the key's
 * tenant, and not "whoever the integrator meant". Pinned per route by
 * `src/modules/user/controllers/__tests__/me-semantics-openapi.test.ts`.
 */
const ME_IS_THE_BOUND_USER =
  "Under API-key authentication, `me` resolves to the **user the key is bound to** — never to the key's tenant. " +
  'A `SERVICE_ACCOUNT` key with no linked user cannot call this route (403).';

@ApiBearerAuth()
@ApiTags('user')
@Controller('user/me/preferences')
@Authorize()
// TASK-742: maps 1:1 onto the pre-existing, previously unwired
// `user:preferences:*` scopes that seeded SDK keys already carry.
@RequiredScopes('user:preferences:write')
export class UserPreferencesController {
  constructor(
    @Inject(IUserPreferencesService)
    private readonly userPreferencesService: IUserPreferencesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get current user preferences', description: ME_IS_THE_BOUND_USER })
  @ApiResponse({
    status: 200,
    description: 'User preferences retrieved successfully',
    type: UserPreferencesResponse,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getPreferences(): Promise<UserPreferencesResponse> {
    return this.userPreferencesService.getPreferences();
  }

  @Patch()
  @ApiOperation({ summary: 'Update current user preferences (partial)', description: ME_IS_THE_BOUND_USER })
  @ApiResponse({
    status: 200,
    description: 'User preferences updated successfully',
    type: UserPreferencesResponse,
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updatePreferences(@Body() request: UpdateUserPreferencesRequest): Promise<UserPreferencesResponse> {
    return this.userPreferencesService.updatePreferences(request);
  }
}
