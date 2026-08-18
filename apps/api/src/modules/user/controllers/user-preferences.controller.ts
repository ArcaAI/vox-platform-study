import { IUserPreferencesService, UserPreferencesResponse, UpdateUserPreferencesRequest } from '@arcaai/applications';
import { Controller, Get, Patch, Body, Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Authorize, RequiredScopes } from '../../../decorators';

/**
 * Controller for current user's SDK preferences.
 * Returns typed preferences aggregated from UserSettings (namespace: arcaai-sdk).
 */
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
  @ApiOperation({ summary: 'Get current user preferences' })
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
  @ApiOperation({ summary: 'Update current user preferences (partial)' })
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
