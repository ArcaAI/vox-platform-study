import { IUserDepartmentService, UserDepartmentResponse, IActiveUserContext } from '@arcaai/applications';
import { Controller, Get, Inject, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize } from '../../../decorators';

/**
 * Self-service department read (BUG-005 Issue 4). Mirrors
 * `UserDepartmentsController.list` but resolves the caller from CLS instead
 * of an admin-supplied `:id`, so any authenticated user (including one being
 * impersonated — the act-as JWT carries the target's own id) can see their
 * own department(s). The admin route stays `@CanManage('User')`-gated.
 */
@ApiBearerAuth()
@ApiTags('user')
@Controller('user/me/departments')
@Authorize()
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
