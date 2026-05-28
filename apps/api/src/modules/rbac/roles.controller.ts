import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { IRbacRoleService } from '@arcaai/applications';
import { CanManage } from '../../decorators';
import {
  CreateRoleDto,
  UpdateRoleDto,
  AssignPolicyToRoleDto,
  RoleResponse,
  PaginatedRoleResponse,
  AssignPolicyResponse,
} from './dto';

/**
 * RBAC Roles Controller
 *
 * Manages roles in the RBAC system.
 * All endpoints require 'manage' permission on 'Role' subject.
 *
 * TASK-307 W6.3 (audit C-10 / F-1 / H-9) — every Prisma call used to live
 * here. The controller is now a thin transport-layer wrapper around
 * `IRbacRoleService`; direct `CoreDatabaseService` access is forbidden
 * by the W6.4 ESLint rule.
 */
@ApiTags('RBAC - Roles')
@ApiBearerAuth()
@Controller('admin/rbac/roles')
// Phase 0 Item 3 (TASK-302 Stream A): explicit permission required.
@CanManage('Role')
export class RolesController {
  constructor(
    @Inject(IRbacRoleService)
    private readonly roleService: IRbacRoleService,
  ) {}

  /**
   * List all roles
   */
  @Get()
  @CanManage('Role')
  @ApiOperation({ summary: 'List all roles' })
  @ApiResponse({ status: 200, description: 'List of roles', type: PaginatedRoleResponse })
  async findAll(
    @Query('page') page: number = 1,
    @Query('pageSize') pageSize: number = 20,
    @Query('search') search?: string,
  ): Promise<PaginatedRoleResponse> {
    const { data, total } = await this.roleService.findAll({ page, pageSize, search });
    return {
      data: data.map((role) => this.toResponse(role)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Get a role by ID
   */
  @Get(':id')
  @CanManage('Role')
  @ApiOperation({ summary: 'Get role by ID' })
  @ApiResponse({ status: 200, description: 'Role details', type: RoleResponse })
  @ApiResponse({ status: 404, description: 'Role not found' })
  async findOne(@Param('id') id: string): Promise<RoleResponse> {
    const role = await this.roleService.findOne(id);
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    return this.toResponse(role);
  }

  /**
   * Create a new role
   */
  @Post()
  @CanManage('Role')
  @ApiOperation({ summary: 'Create a new role' })
  @ApiResponse({ status: 201, description: 'Role created', type: RoleResponse })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  async create(@Body() dto: CreateRoleDto): Promise<RoleResponse> {
    const role = await this.roleService.create({
      name: dto.name,
      description: dto.description,
      externalName: dto.externalName,
      externalId: dto.externalId,
      parentRoleId: dto.parentRoleId,
    });
    return this.toResponse(role);
  }

  /**
   * Update a role
   */
  @Put(':id')
  @CanManage('Role')
  @ApiOperation({ summary: 'Update a role' })
  @ApiResponse({ status: 200, description: 'Role updated', type: RoleResponse })
  @ApiResponse({ status: 404, description: 'Role not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateRoleDto): Promise<RoleResponse> {
    const role = await this.roleService.update(id, {
      name: dto.name,
      description: dto.description,
      externalName: dto.externalName,
      externalId: dto.externalId,
      parentRoleId: dto.parentRoleId,
    });
    return this.toResponse(role);
  }

  /**
   * Partially update a role
   */
  @Patch(':id')
  @CanManage('Role')
  @ApiOperation({ summary: 'Partially update a role' })
  @ApiResponse({ status: 200, description: 'Role updated', type: RoleResponse })
  @ApiResponse({ status: 404, description: 'Role not found' })
  async patch(@Param('id') id: string, @Body() dto: UpdateRoleDto): Promise<RoleResponse> {
    const role = await this.roleService.patch(id, {
      name: dto.name,
      description: dto.description,
      externalName: dto.externalName,
      externalId: dto.externalId,
      parentRoleId: dto.parentRoleId,
      resourceStatus: dto.resourceStatus,
    });
    return this.toResponse(role);
  }

  /**
   * Delete a role (soft delete)
   */
  @Delete(':id')
  @CanManage('Role')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a role' })
  @ApiResponse({ status: 204, description: 'Role deleted' })
  @ApiResponse({ status: 400, description: 'Cannot delete system role' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.roleService.softDelete(id);
  }

  /**
   * Assign a policy to a role
   */
  @Post(':roleId/policies/:policyId')
  @CanManage('RolePolicy')
  @ApiOperation({ summary: 'Assign a policy to a role' })
  @ApiResponse({ status: 201, description: 'Policy assigned to role', type: AssignPolicyResponse })
  @ApiResponse({ status: 404, description: 'Role or policy not found' })
  async assignPolicy(
    @Param('roleId') roleId: string,
    @Param('policyId') policyId: string,
    @Body() dto: AssignPolicyToRoleDto,
  ): Promise<AssignPolicyResponse> {
    await this.roleService.assignPolicy(roleId, policyId, { priority: dto.priority });
    return { message: 'Policy assigned to role successfully' };
  }

  /**
   * Remove a policy from a role
   */
  @Delete(':roleId/policies/:policyId')
  @CanManage('RolePolicy')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a policy from a role' })
  @ApiResponse({ status: 204, description: 'Policy removed from role' })
  @ApiResponse({ status: 404, description: 'Assignment not found' })
  async removePolicy(@Param('roleId') roleId: string, @Param('policyId') policyId: string): Promise<void> {
    await this.roleService.removePolicy(roleId, policyId);
  }

  private toResponse(role: {
    id: string;
    name: string;
    description: string | null;
    externalName: string | null;
    externalId: string | null;
    isSystemRole: boolean;
    parentRoleId: string | null;
    resourceStatus: string;
    createdAt: Date;
    updatedAt: Date;
    RolePolicies: { Policy: { id: string; name: string } | null; priority: number }[];
  }): RoleResponse {
    return {
      id: role.id,
      name: role.name,
      description: role.description || undefined,
      externalName: role.externalName || undefined,
      externalId: role.externalId || undefined,
      isSystemRole: role.isSystemRole,
      parentRoleId: role.parentRoleId || undefined,
      resourceStatus: role.resourceStatus,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
      policies: role.RolePolicies.map((rp) => ({
        id: rp.Policy?.id || '',
        name: rp.Policy?.name || '',
        priority: rp.priority,
      })),
    };
  }
}
