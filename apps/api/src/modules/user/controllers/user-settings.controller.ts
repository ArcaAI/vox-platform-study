import {
    IUserSettingsService,
    UserSettingsResponse,
    UserSettingsDtoMapper,
    UpdateUserSettingByKeyRequest,
    IActiveUserContext,
} from '@arcaai/applications';
import {
    Controller,
    Get,
    Patch,
    Body,
    Param,
    Inject,
    UnauthorizedException,
} from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiResponse,
    ApiParam,
} from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize } from '../../../decorators';

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
        const updated = await this.userSettingsService.upsertByUserKeyNamespace(
            userId,
            namespace,
            key,
            request,
        );
        return UserSettingsDtoMapper.ToResponse(updated);
    }

    private resolveUserId(): string {
        const user = this.clsService.get('user');
        if (!user?.id) {
            throw new UnauthorizedException('User context not available');
        }
        return user.id;
    }
}
