import {
  IUserRoleAssignmentService,
  PaginatedQuery,
  UserRoleAssignmentDtoMapper,
  PaginatedUserRoleAssignmentResponse,
  IActiveUserContext,
} from '@arcaai/applications';
import { Controller, ForbiddenException, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, ForbidApiKey } from '../../../decorators';

/**
 * Controller for the current user's role assignments (self-only).
 *
 * Uses the explicit `/users/:id/roles` path (not `/user/me/roles`) per the
 * "mirror_admin" decision: admins call `/admin/users/:id/roles` and
 * end-users call this route with their own id. Cross-user access is rejected
 * with 403 (rather than a silent 404) to give an unambiguous security signal.
 */
@ApiBearerAuth()
@ApiTags('user')
@Controller('users')
@Authorize()
// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Reason: privilege-relevant role-assignment read; TASK-708 bucketed it (b) with no non-admin scope available.
// This route family declared nothing about API-key access, which under the
// deny-by-default rule is a boot failure. Rather than guess a scope (guessing
// permissive is how the original gap was created), it is closed explicitly.
// Reversing it is a one-line change to @RequiredScopes('<scope>') once the
// owner confirms a real API-key use case — see the TASK-708 README's
// "Reachability changes awaiting owner review" table.
@ForbidApiKey()
export class UserRolesController {
  constructor(
    @Inject(IUserRoleAssignmentService)
    private readonly userRoleAssignmentService: IUserRoleAssignmentService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  @Get(':id/roles')
  @ApiOperation({ summary: 'List roles assigned to the current user (self-only)' })
  @ApiParam({ name: 'id', description: 'User ID — must equal current user', type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Role assignments listed', type: PaginatedUserRoleAssignmentResponse })
  @ApiResponse({ status: 403, description: 'Cannot list roles for a different user' })
  async listMyRoleAssignments(@Param('id') id: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedUserRoleAssignmentResponse> {
    const currentUser = this.clsService.get('user');
    if (!currentUser?.id || currentUser.id !== id) {
      throw new ForbiddenException('Cannot list roles for a different user');
    }
    const result = await this.userRoleAssignmentService.fetchAllByUserId({
      ...queryParams,
      userId: id,
    });
    return UserRoleAssignmentDtoMapper.ToPaginatedResponse(result);
  }
}
