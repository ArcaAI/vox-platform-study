import {
  IUserSettingsService,
  UserSettingsResponse,
  UserSettingsDtoMapper,
  UpdateUserSettingByKeyRequest,
  IActiveUserContext,
  USER_SETTINGS_NAMESPACES,
  validateUiDataGridValue,
} from '@arcaai/applications';
import { Body, Controller, Get, Inject, Param, Patch, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, RequiredScopes } from '../../../decorators';

/**
 * Controller for current user's raw settings (key-value by namespace).
 */
/**
 * the `me` semantics an integrator cannot infer from the path.
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
@Controller('users/me/settings')
@Authorize()
// API-KEY-NOTE: policy A1. Direct sibling of the already-keyed
// `UserPreferencesController` (the typed view over these same rows). Read at
// class level; the PATCH narrows to `user:settings:write` on the handler, so
// a read-only key cannot write. Resolves to the key's BOUND USER — see the
// `me`-semantics note in each route's OpenAPI description.
@RequiredScopes('user:settings:read')
export class UserSettingsController {
  constructor(
    @Inject(IUserSettingsService)
    private readonly userSettingsService: IUserSettingsService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get all settings for current user', description: ME_IS_THE_BOUND_USER })
  @ApiResponse({
    status: 200,
    description: 'User settings retrieved successfully',
    schema: { type: 'array', items: { $ref: '#/components/schemas/UserSettingsResponse' } },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMySettings(): Promise<UserSettingsResponse[]> {
    const userId = this.resolveUserId();
    const settings = await this.userSettingsService.fetchAllByUserId(userId);
    return settings.map((s) => UserSettingsDtoMapper.ToResponse(s));
  }

  @Patch(':namespace/:key')
  // Narrows past the class-level `user:settings:read` — method metadata wins,
  // so a read-only key is refused here by `enforceApiKeyScopes`.
  @RequiredScopes('user:settings:write')
  @ApiOperation({ summary: 'Update a specific setting by namespace and key', description: ME_IS_THE_BOUND_USER })
  @ApiParam({ name: 'namespace', description: 'Setting namespace' })
  @ApiParam({ name: 'key', description: 'Setting key' })
  @ApiResponse({
    status: 200,
    description: 'Setting updated successfully',
    type: UserSettingsResponse,
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updateSetting(
    @Param('namespace') namespace: string,
    @Param('key') key: string,
    @Body() request: UpdateUserSettingByKeyRequest,
  ): Promise<UserSettingsResponse> {
    const userId = this.resolveUserId();
    this.validateSettingValue(namespace, request.value);
    const updated = await this.userSettingsService.upsertByUserKeyNamespace(userId, namespace, key, request);
    return UserSettingsDtoMapper.ToResponse(updated);
  }

  /**
   * Per-namespace validators run BEFORE the upsert hits the DB. The endpoint
   * stays open to arbitrary namespaces (the SDK lets clients choose their own),
   * so these are targeted guards — not a rejecting allow-list.
   *
   * - `ui.data-grid` layout values must be well-formed
   *   JSON within the byte cap. This is an early-reject (fast 400) that
   *   delegates to the shared {@link validateUiDataGridValue}; the service
   *   layer enforces the SAME guard so the admin path is covered too.
   *
   * (`arcaai-sdk:selectedPipelineId` used to be validated against the tenant's
   * `AsrPipeline` catalogue here. That catalogue is gone (TASK-1006): the key
   * selects nothing any more, so it is an ordinary client-owned setting.)
   */
  private validateSettingValue(namespace: string, value: string): void {
    if (namespace === USER_SETTINGS_NAMESPACES.UI_DATA_GRID) {
      validateUiDataGridValue(value);
    }
  }

  private resolveUserId(): string {
    const user = this.clsService.get('user');
    if (!user?.id) {
      throw new UnauthorizedException('User context not available');
    }
    return user.id;
  }
}
