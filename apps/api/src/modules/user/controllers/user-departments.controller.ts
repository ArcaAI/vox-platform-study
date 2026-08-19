import { IUserDepartmentService, UserDepartmentResponse, AssignUserDepartmentRequest, UpdateUserDepartmentRequest } from '@arcaai/applications';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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
  ) {}

  @Get(':id/departments')
  @ApiOperation({ summary: "List a user's department assignments (tenant-scoped)" })
  @ApiParam({ name: 'id', description: 'User ID', type: String })
  @ApiResponse({ status: 200, description: 'Assignments listed', type: [UserDepartmentResponse] })
  async list(@Param('id') id: string): Promise<UserDepartmentResponse[]> {
    return this.userDepartmentService.getByUser(id);
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
