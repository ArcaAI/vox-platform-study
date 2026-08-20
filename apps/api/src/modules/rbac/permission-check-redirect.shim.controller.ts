import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request as ExpressRequest, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '@arcaai/applications';
import { redirect308 } from '../../common';
import { Authorize, RequiredScopes } from '../../decorators';

/**
 * TASK-760 redirect shim — DELETE IN ALL-2.0.0. Old paths retired 2026-08-18.
 *
 * `rbac/check{,/bulk,/my-permissions}` was the review's one verb-as-resource
 * finding. The single/bulk checks redirect to the CALLER's own by-id
 * collection: the retired path carried no user in the URI at all, so the only
 * faithful target is the caller, and the body's `userId` (the thing that
 * actually selected another user) rides through the 308 unchanged.
 */
@ApiTags('rbac-permission-check')
@ApiBearerAuth()
@Controller('rbac/check')
@RequiredScopes('user:profile:read')
export class PermissionCheckRedirectShimController {
  constructor(@Inject(ClsService) private readonly cls: ClsService<IActiveUserContext>) {}

  @Post()
  @Authorize()
  @ApiExcludeEndpoint()
  checkPermission(@Req() req: ExpressRequest, @Res() res: Response): void {
    redirect308(req, res, `users/${encodeURIComponent(this.callerId())}/permission-checks`);
  }

  @Post('bulk')
  @Authorize()
  @ApiExcludeEndpoint()
  checkPermissionsBulk(@Req() req: ExpressRequest, @Res() res: Response): void {
    redirect308(req, res, `users/${encodeURIComponent(this.callerId())}/permission-checks/bulk`);
  }

  @Post('my-permissions')
  @Authorize()
  @ApiExcludeEndpoint()
  getMyPermissions(@Req() req: ExpressRequest, @Res() res: Response): void {
    redirect308(req, res, 'users/me/permission-checks');
  }

  private callerId(): string {
    return this.cls.get('user')?.id ?? 'me';
  }
}
