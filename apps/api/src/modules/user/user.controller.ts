import {
    IUserService,
    IApiKeyService,
    IUserSettingsService,
    PaginatedQuery,
    UserResponse,
    CreateUserRequest,
    PaginatedUserResponse,
    UpdateUserRequest,
    UserDtoMapper,
    UserSettingsResponse,
    UserSettingsDtoMapper,
    UpdateUserSettingByKeyRequest,
    HttpMethod,
    ApiKeyDtoMapper,
    PaginatedApiKeyResponse,
} from '@arcaai/applications';
import { Controller, Body, Param, Inject, Query, Get, Patch } from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiBody,
    ApiParam,
    ApiQuery,
    ApiResponse,
    ApiOperation,
} from '@nestjs/swagger';
import { ApiEndpoint, Authorize } from '../../decorators';

@ApiBearerAuth()
@ApiTags('admin-users')
@Controller('admin/users')
@Authorize()
export class UserController {
    constructor(
        @Inject(IUserService)
        private readonly userService: IUserService,
        @Inject(IApiKeyService)
        private readonly apiKeyService: IApiKeyService,
        @Inject(IUserSettingsService)
        private readonly userSettingsService: IUserSettingsService,
    ) {}

    @ApiEndpoint({
        returnedModel: UserResponse,
        method: HttpMethod.POST,
    })
    @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
    async create(@Body() request: CreateUserRequest): Promise<UserResponse> {
        const result = await this.userService.create(request);
        return UserDtoMapper.ToResponse(result);
    }

    @ApiEndpoint({
        returnedModel: UserResponse,
        multi: true,
    })
    @ApiQuery({ name: 'page', required: false, type: Number })
    @ApiQuery({ name: 'pageSize', required: false, type: Number })
    async fetchAll(
        @Query() queryParams: PaginatedQuery,
    ): Promise<PaginatedUserResponse> {
        const result = await this.userService.fetchAll({
            ...queryParams,
        });
        return UserDtoMapper.ToPaginatedResponse(result);
    }

    @ApiEndpoint({
        returnedModel: UserResponse,
        path: '/:id',
        by: ['id'],
    })
    @ApiParam({ name: 'id', description: 'User ID', type: String })
    @ApiResponse({ status: 404, description: 'User not found' })
    async fetchById(@Param('id') id: string): Promise<UserResponse> {
        const result = await this.userService.fetchById(id);
        return UserDtoMapper.ToResponse(result);
    }

    @ApiEndpoint({
        returnedModel: UserResponse,
        path: 'tenant/:tenantId',
        multi: true,
        by: ['tenantId'],
    })
    @ApiParam({ name: 'tenantId', description: 'Tenant ID', type: String })
    async fetchByTenant(
        @Param('tenantId') tenantId: string,
        @Query() queryParams: PaginatedQuery,
    ): Promise<PaginatedUserResponse> {
        const result = await this.userService.fetchAllByTenantId({
            ...queryParams,
            tenantId,
        });
        return UserDtoMapper.ToPaginatedResponse(result);
    }

    @ApiEndpoint({
        returnedModel: UserResponse,
        method: HttpMethod.PATCH,
        path: ':id',
        by: ['id'],
    })
    @ApiParam({ name: 'id', description: 'User ID', type: String })
    @ApiResponse({ status: 404, description: 'User not found' })
    async update(
        @Param('id') id: string,
        @Body() request: UpdateUserRequest,
    ): Promise<UserResponse> {
        const result = await this.userService.update(id, request);
        return UserDtoMapper.ToResponse(result);
    }

    @ApiEndpoint({
        returnedModel: UserResponse,
        method: HttpMethod.PATCH,
        path: ':id/status',
        by: ['id'],
        append: '(enable/disable)',
    })
    @ApiParam({ name: 'id', description: 'User ID', type: String })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                resourceStatus: {
                    type: 'string',
                    enum: ['ENABLED', 'DISABLED'],
                },
            },
            required: ['resourceStatus'],
        },
    })
    @ApiResponse({ status: 404, description: 'User not found' })
    async updateStatus(
        @Param('id') id: string,
        @Body() body: { resourceStatus: string },
    ): Promise<UserResponse> {
        const result = await this.userService.update(id, {
            resourceStatus: body.resourceStatus,
        } as UpdateUserRequest);
        return UserDtoMapper.ToResponse(result);
    }

    @ApiEndpoint({
        returnedModel: UserResponse,
        method: HttpMethod.DELETE,
        path: '/:id',
        by: ['id'],
    })
    @ApiParam({ name: 'id', description: 'User ID', type: String })
    @ApiResponse({ status: 404, description: 'User not found' })
    async delete(@Param('id') id: string): Promise<UserResponse> {
        const result = await this.userService.deleteById(id);
        return UserDtoMapper.ToResponse(result);
    }

    @ApiEndpoint({
        returnedModel: UserResponse,
        method: HttpMethod.DELETE,
        path: 'bulk',
        append: '(bulk delete)',
    })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                ids: { type: 'array', items: { type: 'string' } },
            },
            required: ['ids'],
        },
    })
    async bulkDelete(
        @Body() body: { ids: string[] },
    ): Promise<UserResponse[]> {
        const results: UserResponse[] = [];
        for (const id of body.ids) {
            const result = await this.userService.deleteById(id);
            results.push(UserDtoMapper.ToResponse(result));
        }
        return results;
    }

    @ApiEndpoint({
        returnedModel: PaginatedApiKeyResponse,
        path: ':id/api-keys',
        by: ['userId'],
        multi: true,
    })
    @ApiParam({ name: 'id', description: 'User ID', type: String })
    @ApiQuery({ name: 'page', required: false, type: Number })
    @ApiQuery({ name: 'pageSize', required: false, type: Number })
    async fetchUserApiKeys(
        @Param('id') id: string,
        @Query() queryParams: PaginatedQuery,
    ): Promise<PaginatedApiKeyResponse> {
        const result = await this.apiKeyService.fetchAllByUserId({
            ...queryParams,
            userId: id,
        });
        return ApiKeyDtoMapper.ToPaginatedResponse(result);
    }

    // -------------------------------------------------------------------------
    // TASK-245: Admin user settings management
    // -------------------------------------------------------------------------

    @Get(':id/settings')
    @ApiOperation({ summary: 'Get all settings for a specific user (admin)' })
    @ApiParam({ name: 'id', description: 'User ID', type: String })
    @ApiResponse({
        status: 200,
        description: 'User settings retrieved',
        schema: { type: 'array', items: { $ref: '#/components/schemas/UserSettingsResponse' } },
    })
    @ApiResponse({ status: 404, description: 'User not found' })
    async fetchUserSettings(
        @Param('id') id: string,
    ): Promise<UserSettingsResponse[]> {
        const settings = await this.userSettingsService.fetchAllByUserId(id);
        return settings.map((s) => UserSettingsDtoMapper.ToResponse(s));
    }

    @Patch(':id/settings/:namespace/:key')
    @ApiOperation({ summary: 'Upsert a setting for a specific user (admin)' })
    @ApiParam({ name: 'id', description: 'User ID', type: String })
    @ApiParam({ name: 'namespace', description: 'Setting namespace', type: String })
    @ApiParam({ name: 'key', description: 'Setting key', type: String })
    @ApiResponse({ status: 200, description: 'Setting updated', type: UserSettingsResponse })
    @ApiResponse({ status: 400, description: 'Bad request' })
    async updateUserSetting(
        @Param('id') id: string,
        @Param('namespace') namespace: string,
        @Param('key') key: string,
        @Body() request: UpdateUserSettingByKeyRequest,
    ): Promise<UserSettingsResponse> {
        const updated = await this.userSettingsService.upsertByUserKeyNamespace(
            id,
            namespace,
            key,
            request,
        );
        return UserSettingsDtoMapper.ToResponse(updated);
    }
}
