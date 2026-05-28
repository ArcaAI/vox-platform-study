import { Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, HttpCode, HttpStatus, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { IPolicyService } from '@arcaai/applications';
import { CanManage } from '../../decorators';
import {
  CreatePolicyDto,
  UpdatePolicyDto,
  PolicyResponse,
  PaginatedPolicyResponse,
  ValidatePolicyDto,
  PolicyValidationResponse,
  PolicyScopeDto,
} from './dto';

/**
 * RBAC Policies Controller
 *
 * Manages policies in the RBAC system.
 * All endpoints require 'manage' permission on 'Policy' subject.
 *
 * TASK-307 W6.2 (audit C-10 / F-1 / H-9) — every Prisma call used to live
 * here. The controller is now a thin transport-layer wrapper around
 * `IPolicyService`; direct `CoreDatabaseService` access is forbidden by
 * the W6.4 ESLint rule.
 */
@ApiTags('RBAC - Policies')
@ApiBearerAuth()
@Controller('admin/rbac/policies')
// Phase 0 Item 3 (TASK-302 Stream A): explicit permission required.
@CanManage('Policy')
export class PoliciesController {
  constructor(
    @Inject(IPolicyService)
    private readonly policyService: IPolicyService,
  ) {}

  /**
   * List all policies
   */
  @Get()
  @CanManage('Policy')
  @ApiOperation({ summary: 'List all policies' })
  @ApiResponse({ status: 200, description: 'List of policies', type: PaginatedPolicyResponse })
  async findAll(
    @Query('page') page: number = 1,
    @Query('pageSize') pageSize: number = 20,
    @Query('search') search?: string,
    @Query('scope') scope?: PolicyScopeDto,
  ): Promise<PaginatedPolicyResponse> {
    const { data, total } = await this.policyService.findAll({
      page,
      pageSize,
      search,
      scope: scope as 'GLOBAL' | 'TENANT' | undefined,
    });

    return {
      data: data.map((policy) => this.toResponse(policy)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Get a policy by ID
   */
  @Get(':id')
  @CanManage('Policy')
  @ApiOperation({ summary: 'Get policy by ID' })
  @ApiResponse({ status: 200, description: 'Policy details', type: PolicyResponse })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async findOne(@Param('id') id: string): Promise<PolicyResponse> {
    const policy = await this.policyService.findOne(id);
    if (!policy) {
      throw new Error('Policy not found');
    }
    return this.toResponse(policy);
  }

  /**
   * Create a new policy
   */
  @Post()
  @CanManage('Policy')
  @ApiOperation({ summary: 'Create a new policy' })
  @ApiResponse({ status: 201, description: 'Policy created', type: PolicyResponse })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  async create(@Body() dto: CreatePolicyDto): Promise<PolicyResponse> {
    const policy = await this.policyService.create({
      name: dto.name,
      description: dto.description,
      scope: dto.scope as 'GLOBAL' | 'TENANT',
      rules: dto.rules,
    });
    return this.toResponse(policy);
  }

  /**
   * Update a policy
   */
  @Put(':id')
  @CanManage('Policy')
  @ApiOperation({ summary: 'Update a policy' })
  @ApiResponse({ status: 200, description: 'Policy updated', type: PolicyResponse })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async update(@Param('id') id: string, @Body() dto: UpdatePolicyDto): Promise<PolicyResponse> {
    const policy = await this.policyService.update(id, {
      name: dto.name,
      description: dto.description,
      scope: dto.scope as 'GLOBAL' | 'TENANT' | undefined,
      rules: dto.rules,
    });
    return this.toResponse(policy);
  }

  /**
   * Partially update a policy
   */
  @Patch(':id')
  @CanManage('Policy')
  @ApiOperation({ summary: 'Partially update a policy' })
  @ApiResponse({ status: 200, description: 'Policy updated', type: PolicyResponse })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async patch(@Param('id') id: string, @Body() dto: UpdatePolicyDto): Promise<PolicyResponse> {
    const policy = await this.policyService.patch(id, {
      name: dto.name,
      description: dto.description,
      scope: dto.scope as 'GLOBAL' | 'TENANT' | undefined,
      rules: dto.rules,
      resourceStatus: dto.resourceStatus,
    });
    return this.toResponse(policy);
  }

  /**
   * Delete a policy (soft delete)
   */
  @Delete(':id')
  @CanManage('Policy')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a policy' })
  @ApiResponse({ status: 204, description: 'Policy deleted' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async remove(@Param('id') id: string): Promise<void> {
    // The service throws NestJS `NotFoundException` when the row is
    // missing, which the global filter maps to 404. Pre-W6 the
    // controller raised a bare `Error('Policy not found')` (mapped to
    // 500); the RBAC E2E suite accepts `[404, 500]` for this case
    // (`apps/api/tests/e2e/rbac.spec.ts` line 159), so the new 404 is
    // within the contract.
    await this.policyService.softDelete(id);
  }

  /**
   * Validate policy rules
   */
  @Post('validate')
  @CanManage('Policy')
  @ApiOperation({ summary: 'Validate policy rules' })
  @ApiResponse({ status: 200, description: 'Validation result', type: PolicyValidationResponse })
  async validate(@Body() dto: ValidatePolicyDto): Promise<PolicyValidationResponse> {
    return this.policyService.validateRules(dto.rules);
  }

  private toResponse(policy: {
    id: string;
    name: string;
    description: string | null;
    scope: string;
    rules: unknown;
    resourceStatus: string;
    createdAt: Date;
    updatedAt: Date;
  }): PolicyResponse {
    return {
      id: policy.id,
      name: policy.name,
      description: policy.description || undefined,
      scope: policy.scope as PolicyScopeDto,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rules: policy.rules as any[],
      resourceStatus: policy.resourceStatus,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
    };
  }
}
