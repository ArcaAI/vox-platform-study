import { IUserDepartmentService, UserDepartmentResponse, IActiveUserContext } from '@arcaai/applications';
import { Controller, Get, Inject, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, ForbidApiKey } from '../../../decorators';

/**
 * Self-service department read. Mirrors
 * `UserDepartmentsController.list` but resolves the caller from CLS instead
 * of an admin-supplied `:id`, so any authenticated user (including one being
 * impersonated — the act-as JWT carries the target's own id) can see their
 * own department(s). The admin route stays `@CanManage('User')`-gated.
 */
@ApiBearerAuth()
@ApiTags('user')
@Controller('user/me/departments')
@Authorize()
// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Reason: self-service department membership read.
// This route family declared nothing about API-key access, which under the
// deny-by-default rule is a boot failure. Rather than guess a scope (guessing
// permissive is how the original gap was created), it is closed explicitly.
// Reversing it is a one-line change to @RequiredScopes('<scope>') once the
// owner confirms a real API-key use case — see the TASK-708 README's
// "Reachability changes awaiting owner review" table.
@ForbidApiKey()
export class UserDepartmentsMeController {
  constructor(
    @Inject(IUserDepartmentService)
    private readonly userDepartmentService: IUserDepartmentService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the caller's own department assignments (tenant-scoped)" })
  @ApiResponse({ status: 200, description: 'Assignments listed', type: [UserDepartmentResponse] })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async myDepartments(): Promise<UserDepartmentResponse[]> {
    const userId = this.resolveUserId();
    return this.userDepartmentService.getByUser(userId);
  }

  private resolveUserId(): string {
    const user = this.clsService.get('user');
    if (!user?.id) {
      throw new UnauthorizedException('User context not available');
    }
    return user.id;
  }
}
