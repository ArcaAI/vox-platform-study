import {
  IUserSettingsService,
  UserSettingsResponse,
  UserSettingsDtoMapper,
  UpdateUserSettingByKeyRequest,
  IActiveUserContext,
  PipelineService,
  USER_SETTINGS_NAMESPACES,
  validateUiDataGridValue,
} from '@arcaai/applications';
import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize } from '../../../decorators';

/**
 * Setting namespace/key reserved for the doctor's chosen pipeline. The
 * validator below enforces that the value identifies a pipeline the
 * caller's tenant owns before persisting.
 */
const SELECTED_PIPELINE_NAMESPACE = 'arcaai-sdk';
const SELECTED_PIPELINE_KEY = 'selectedPipelineId';

/**
 * Controller for current user's raw settings (key-value by namespace).
 */
@ApiBearerAuth()
@ApiTags('user')
@Controller('user/me/settings')
@Authorize()
export class UserSettingsController {
  constructor(
    @Inject(IUserSettingsService)
    private readonly userSettingsService: IUserSettingsService,
    private readonly pipelineService: PipelineService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get all settings for current user' })
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
  @ApiOperation({ summary: 'Update a specific setting by namespace and key' })
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
    await this.validateSettingValue(namespace, key, request.value);
    const updated = await this.userSettingsService.upsertByUserKeyNamespace(userId, namespace, key, request);
    return UserSettingsDtoMapper.ToResponse(updated);
  }

  /**
   * Per-key validators run BEFORE the upsert hits the DB. The endpoint stays
   * open to arbitrary namespaces (the SDK lets clients choose their own), so
   * these are targeted, per-namespace guards — not a rejecting allow-list.
   *
   * - `arcaai-sdk:selectedPipelineId` must reference a pipeline
   *   owned by the caller's tenant (PipelineService.getById is tenant-scoped,
   *   so a `null` result is sufficient to reject).
   * - `ui.data-grid` layout values must be well-formed
   *   JSON within the byte cap. This is an early-reject (fast 400) that
   *   delegates to the shared {@link validateUiDataGridValue}; the service
   *   layer enforces the SAME guard so the admin path is covered too.
   */
  private async validateSettingValue(namespace: string, key: string, value: string): Promise<void> {
    if (namespace === SELECTED_PIPELINE_NAMESPACE && key === SELECTED_PIPELINE_KEY) {
      const pipeline = await this.pipelineService.getById(value);
      if (!pipeline) {
        throw new BadRequestException(`Pipeline '${value}' is not available for the current tenant`);
      }
      return;
    }

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
