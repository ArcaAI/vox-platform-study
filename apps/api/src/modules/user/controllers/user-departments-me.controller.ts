import { IUserDepartmentService, UserDepartmentResponse, IActiveUserContext } from '@arcaai/applications';
import { Controller, Get, Inject, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, RequiredScopes } from '../../../decorators';

/**
 * Self-service department read. Mirrors
 * `UserDepartmentsController.list` but resolves the caller from CLS instead
 * of an admin-supplied `:id`, so any authenticated user (including one being
 * impersonated — the act-as JWT carries the target's own id) can see their
 * own department(s). The admin route stays `@CanManage('User')`-gated.
 */
/**
 * the `me` semantics an integrator cannot infer from the path.
 *
 * `UnifiedAuthGuard.handleApiKeyAuth` sets the CLS principal from
 * `apiKeyEntity.userId`, so under a key `me` is the BOUND USER — not the key's
 * tenant, and not "whoever the integrator meant". Pinned per route by
 * `src/modules/user/controllers/__tests__/me-semantics-openapi.test.ts`.
 */
const ME_IS_THE_BOUND_USER =
  "Under API-key authentication, `me` resolves to the **user the key is bound to** — never to the key's tenant. " +
  'A `SERVICE_ACCOUNT` key with no linked user cannot call this route (403).';

@ApiBearerAuth()
@ApiTags('user')
@Controller('users/me/departments')
@Authorize()
// API-KEY-NOTE: policy A1. A `me` surface: resolves to the key's BOUND USER,
// never to its tenant (see the OpenAPI description on the route). Reuses
// `user:profile:read` — the caller's own membership is part of that profile.
@RequiredScopes('user:profile:read')
export class UserDepartmentsMeController {
  constructor(
    @Inject(IUserDepartmentService)
    private readonly userDepartmentService: IUserDepartmentService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the caller's own department assignments (tenant-scoped)", description: ME_IS_THE_BOUND_USER })
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
