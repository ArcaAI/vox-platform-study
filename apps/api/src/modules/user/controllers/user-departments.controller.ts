import {
  IUserDepartmentService,
  IUserService,
  IUserRoleAssignmentService,
  UserDepartmentResponse,
  AssignUserDepartmentRequest,
  UpdateUserDepartmentRequest,
  isSuperAdmin,
  IActiveUserContext,
} from '@arcaai/applications';
import { DataNotFoundException } from '@arcaai/exceptions';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanManage, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../../decorators';

/**
 * Admin CRUD for user ↔ department assignments.
 *
 * Tenant scoping mirrors the other admin controllers: the active tenant comes
 * from the CLS request context. For a super-admin that context is set by a
 * role-gated elevation in `ContextInterceptor` — only a SUPER_ADMIN whose JWT
 * tenant is empty may have a syntactically valid `X-Tenant-Id` promoted into
 * CLS; the header can never override a tenant-bound JWT. A tenant admin's
 * context is set from their session. The service rejects calls with no
 * tenant context, so no per-route guard is needed beyond `@CanManage('User')`.
 */
@ApiBearerAuth()
@ApiTags('admin-user-departments')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:user:write')
@Controller('admin/users')
@CanManage('User')
export class UserDepartmentsController {
  constructor(
    @Inject(IUserDepartmentService)
    private readonly userDepartmentService: IUserDepartmentService,
    @Inject(IUserService)
    private readonly userService: IUserService,
    @Inject(IUserRoleAssignmentService)
    private readonly userRoleAssignmentService: IUserRoleAssignmentService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get(':id/departments')
  @ApiOperation({ summary: "List a user's department assignments (tenant-scoped)" })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 200, description: 'Assignments listed', type: [UserDepartmentResponse] })
  @ApiResponse({ status: 404, description: 'User not found (or cross-tenant)' })
  async list(@Param('id') id: string): Promise<UserDepartmentResponse[]> {
    await this.assertUserInScope(id);
    return this.userDepartmentService.getByUser(id);
  }

  /**
   * Mirrors `UserController.assertUserInScope` (F-07): proves the target
   * user EXISTS before returning its sub-collection, then — unless the
   * caller is an unscoped SUPER_ADMIN performing the deliberate cross-tenant
   * read `UserDepartmentService.getByUser` itself supports — proves the
   * caller's tenant is among the user's ENABLED tenant memberships. Both
   * failure modes 404 (never a 200 empty list, never a 403) so a bogus id
   * and a real cross-tenant id are indistinguishable.
   */
  private async assertUserInScope(id: string): Promise<void> {
    try {
      await this.userService.fetchById(id);
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        throw new NotFoundException('User not found');
      }
      throw err;
    }

    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId');
    if (isSuperAdmin(user)) {
      // An unscoped SUPER_ADMIN (no working tenant selected) reads
      // cross-tenant by design — mirrors `UserDepartmentService.getByUser`'s
      // own `crossTenant` branch. A SUPER_ADMIN with a working tenant
      // selected is exempt from the membership check too, matching
      // `UserController.assertUserInScope`.
      return;
    }
    if (!callerTenantId) {
      throw new NotFoundException('User not found');
    }
    const tenantIds = await this.userRoleAssignmentService.findActiveTenantIdsForUser(id);
    if (!tenantIds.includes(callerTenantId)) {
      throw new NotFoundException('User not found');
    }
  }

  @Post(':id/departments')
  @ApiOperation({ summary: 'Assign a user to a department' })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 201, description: 'Department assigned', type: UserDepartmentResponse })
  @ApiResponse({ status: 400, description: 'User already assigned to this department' })
  async assign(@Param('id') id: string, @Body() body: AssignUserDepartmentRequest): Promise<UserDepartmentResponse> {
    return this.userDepartmentService.assign(id, body);
  }

  @Patch(':id/departments/:assignmentId')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a user-department assignment (e.g. toggle primary)',
    description:
      'Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED and folds onto ' +
      '`expectedVersion`. On version drift the response is `412`; a missing header is `428`.',
  })
  @ApiHeader({ name: 'If-Match', description: 'Row version the client read (e.g. `"1"`).', required: true, example: '"1"' })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiParam({ name: 'assignmentId', description: 'User department assignment ID', type: String })
  @ApiResponse({ status: 200, description: 'Assignment updated', type: UserDepartmentResponse })
  @ApiResponse({ status: 404, description: 'Assignment not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('assignmentId') assignmentId: string,
    @Body() body: UpdateUserDepartmentRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<UserDepartmentResponse> {
    const effectiveRequest: UpdateUserDepartmentRequest = expectedFromHeader !== undefined ? { ...body, expectedVersion: expectedFromHeader } : body;
    return this.userDepartmentService.update(assignmentId, effectiveRequest);
  }

  @Delete(':id/departments/:assignmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unassign a user from a department (soft delete)' })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiParam({ name: 'assignmentId', description: 'User department assignment ID', type: String })
  @ApiResponse({ status: 204, description: 'Assignment removed' })
  @ApiResponse({ status: 404, description: 'Assignment not found' })
  async unassign(@Param('assignmentId') assignmentId: string): Promise<void> {
    await this.userDepartmentService.unassign(assignmentId);
  }
}
