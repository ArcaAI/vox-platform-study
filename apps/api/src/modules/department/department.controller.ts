import {
  IDepartmentService,
  DepartmentResponse,
  CreateDepartmentRequest,
  UpdateDepartmentRequest,
  UpdateDepartmentPromptConfigRequest,
  HttpMethod,
} from '@arcaai/applications';
import { Controller, Body, Param, Inject, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ApiEndpoint, Authorize, CanManage } from '../../decorators';

@ApiBearerAuth()
@ApiTags('admin-departments')
@Controller('admin/departments')
// Phase 0 Item 3 (TASK-302 Stream A): explicit permission required.
@CanManage('Department')
export class DepartmentController {
  constructor(
    @Inject(IDepartmentService)
    private readonly departmentService: IDepartmentService,
  ) {}

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input or duplicate code' })
  async create(@Body() request: CreateDepartmentRequest): Promise<DepartmentResponse> {
    return this.departmentService.create(request);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    multi: true,
  })
  @ApiQuery({ name: 'includeDisabled', required: false, type: Boolean, description: 'Include disabled departments in results' })
  async fetchAll(@Query('includeDisabled') includeDisabled?: string): Promise<DepartmentResponse[]> {
    return this.departmentService.getAll({
      includeDisabled: includeDisabled === 'true',
    });
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    path: 'roots',
    multi: true,
  })
  async fetchRoots(): Promise<DepartmentResponse[]> {
    return this.departmentService.getRootDepartments();
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Department ID', type: String })
  @ApiResponse({ status: 404, description: 'Department not found' })
  async fetchById(@Param('id') id: string): Promise<DepartmentResponse | null> {
    return this.departmentService.getById(id);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    path: 'code/:code',
    by: ['code'],
  })
  @ApiParam({ name: 'code', description: 'Department code', type: String })
  @ApiResponse({ status: 404, description: 'Department not found' })
  async fetchByCode(@Param('code') code: string): Promise<DepartmentResponse | null> {
    return this.departmentService.getByCode(code);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    path: ':id/children',
    by: ['id'],
    multi: true,
  })
  @ApiParam({ name: 'id', description: 'Parent department ID', type: String })
  async fetchChildren(@Param('id') id: string): Promise<DepartmentResponse[]> {
    return this.departmentService.getChildren(id);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Department ID', type: String })
  @ApiResponse({ status: 404, description: 'Department not found' })
  async update(@Param('id') id: string, @Body() request: UpdateDepartmentRequest): Promise<DepartmentResponse> {
    return this.departmentService.update(id, request);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    method: HttpMethod.PATCH,
    path: ':id/prompt-config',
    by: ['id'],
    append: '(prompt config)',
  })
  @Authorize(['manage', 'Department'])
  @ApiParam({ name: 'id', description: 'Department ID', type: String })
  @ApiResponse({ status: 404, description: 'Department not found' })
  async updatePromptConfig(@Param('id') id: string, @Body() request: UpdateDepartmentPromptConfigRequest): Promise<DepartmentResponse> {
    return this.departmentService.updatePromptConfig(id, request);
  }

  @ApiEndpoint({
    returnedModel: DepartmentResponse,
    method: HttpMethod.DELETE,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Department ID', type: String })
  @ApiResponse({ status: 400, description: 'Cannot delete department with children' })
  @ApiResponse({ status: 404, description: 'Department not found' })
  async delete(@Param('id') id: string): Promise<DepartmentResponse> {
    return this.departmentService.deleteById(id);
  }
}
