import {
    IPromptManagementService,
    PromptTemplateResponse,
    PromptVersionResponse,
    CreatePromptTemplateRequest,
    UpdatePromptTemplateRequest,
    HttpMethod,
} from '@arcaai/applications';
import { Controller, Body, Param, Inject, Query, Get, Post, NotFoundException, ParseIntPipe } from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiResponse,
} from '@nestjs/swagger';
import { ApiEndpoint, Authorize } from '../../decorators';
import { PaginatedPromptTemplateResponse, PromptUsageStatsResponse } from './dto';

@ApiBearerAuth()
@ApiTags('prompt-templates')
@Controller('prompt-templates')
@Authorize()
export class PromptManagementController {
    constructor(
        @Inject(IPromptManagementService)
        private readonly promptService: IPromptManagementService,
    ) {}

    @ApiEndpoint({
        returnedModel: PromptTemplateResponse,
        method: HttpMethod.POST,
    })
    @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
    async create(@Body() request: CreatePromptTemplateRequest): Promise<PromptTemplateResponse> {
        return this.promptService.createPromptTemplate(request);
    }

    @ApiEndpoint({
        returnedModel: PromptTemplateResponse,
        multi: true,
    })
    @ApiQuery({ name: 'category', required: false, type: String })
    @ApiQuery({ name: 'departmentId', required: false, type: String })
    @ApiQuery({ name: 'search', required: false, type: String })
    @ApiQuery({ name: 'includeDisabled', required: false, type: Boolean, description: 'Include disabled templates in results' })
    @ApiQuery({ name: 'page', required: false, type: Number })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    async list(
        @Query() queryParams: { category?: string; departmentId?: string; search?: string; includeDisabled?: string; page?: number; limit?: number },
    ): Promise<PaginatedPromptTemplateResponse> {
        const templates = await this.promptService.listPromptTemplates({
            category: queryParams.category,
            departmentId: queryParams.departmentId,
            search: queryParams.search,
            includeDisabled: queryParams.includeDisabled === 'true',
        });

        const page = Number(queryParams.page) || 1;
        const limit = Number(queryParams.limit) || 50;
        const start = (page - 1) * limit;
        const paginated = templates.slice(start, start + limit);

        return {
            data: paginated,
            count: templates.length,
            limit,
            page,
        };
    }

    @ApiEndpoint({
        returnedModel: PromptTemplateResponse,
        path: '/:id',
        by: ['id'],
    })
    @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
    @ApiResponse({ status: 404, description: 'Template not found' })
    async getById(@Param('id') id: string): Promise<PromptTemplateResponse> {
        const result = await this.promptService.getPromptTemplate(id);
        if (!result) throw new NotFoundException(`Prompt template ${id} not found`);
        return result;
    }

    @ApiEndpoint({
        returnedModel: PromptTemplateResponse,
        method: HttpMethod.PATCH,
        path: ':id',
        by: ['id'],
    })
    @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
    @ApiResponse({ status: 404, description: 'Template not found' })
    async update(
        @Param('id') id: string,
        @Body() request: UpdatePromptTemplateRequest,
    ): Promise<PromptTemplateResponse> {
        return this.promptService.updatePromptTemplate(id, request);
    }

    @ApiEndpoint({
        returnedModel: PromptTemplateResponse,
        method: HttpMethod.DELETE,
        path: '/:id',
        by: ['id'],
    })
    @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
    @ApiResponse({ status: 404, description: 'Template not found' })
    async remove(@Param('id') id: string): Promise<PromptTemplateResponse> {
        return this.promptService.softDeletePromptTemplate(id);
    }

    @ApiEndpoint({
        returnedModel: PromptVersionResponse,
        path: ':id/versions',
        by: ['id'],
        multi: true,
    })
    @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
    async getVersions(@Param('id') id: string): Promise<PromptVersionResponse[]> {
        return this.promptService.getVersions(id);
    }

    @ApiEndpoint({
        returnedModel: PromptVersionResponse,
        path: ':id/versions/:versionNumber',
        by: ['id', 'versionNumber'],
    })
    @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
    @ApiParam({ name: 'versionNumber', description: 'Version number', type: Number })
    @ApiResponse({ status: 404, description: 'Version not found' })
    async getVersion(
        @Param('id') id: string,
        @Param('versionNumber', ParseIntPipe) versionNumber: number,
    ): Promise<PromptVersionResponse> {
        const svc = this.promptService as any;
        const result = await svc.getVersion(id, versionNumber);
        if (!result) throw new NotFoundException(`Version ${versionNumber} not found for template ${id}`);
        return result;
    }

    @Get(':id/usage')
    @ApiOperation({ summary: 'Get usage statistics for a prompt template' })
    @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
    @ApiResponse({ status: 200, description: 'Usage statistics', type: PromptUsageStatsResponse })
    async getUsageStats(
        @Param('id') id: string,
    ): Promise<PromptUsageStatsResponse> {
        const svc = this.promptService as any;
        return svc.getUsageStats(id);
    }

    @ApiEndpoint({
        returnedModel: PromptTemplateResponse,
        method: HttpMethod.POST,
        path: ':id/versions/:versionNumber/activate',
        by: ['id', 'versionNumber'],
    })
    @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
    @ApiParam({ name: 'versionNumber', description: 'Version number to activate', type: Number })
    @ApiResponse({ status: 404, description: 'Version not found' })
    async activateVersion(
        @Param('id') id: string,
        @Param('versionNumber', ParseIntPipe) versionNumber: number,
    ): Promise<PromptTemplateResponse> {
        const svc = this.promptService as any;
        const version = await svc.getVersion(id, versionNumber);
        if (!version) throw new NotFoundException(`Version ${versionNumber} not found for template ${id}`);

        return this.promptService.updatePromptTemplate(id, {
            content: version.content,
            variables: version.variables,
            changeReason: `Activated version ${versionNumber}`,
        } as UpdatePromptTemplateRequest);
    }
}
