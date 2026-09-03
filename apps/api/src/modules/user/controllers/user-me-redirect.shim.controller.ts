import { Controller, Get, Param, Patch, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { redirect308 } from '../../../common';
import { Authorize, RequiredScopes } from '../../../decorators';

/**
 * redirect shim — DELETE IN ALL-2.0.0. Old paths retired 2026-08-18.
 *
 * `user/me/**` (singular) became `users/me/**` (plural) so the self plane sits
 * inside the same `users` collection that already hosts `users/:id/roles` and
 * `users/password-reset`.
 *
 * The auth posture is a VERBATIM copy of each target's — same `@Authorize()`,
 * same `@RequiredScopes`. A shim must never be a cheaper way in than the route
 * it points at: an unauthenticated caller is rejected here, before any
 * `Location` header is written.
 */
@ApiBearerAuth()
@ApiTags('user')
@Controller('user/me')
@Authorize()
@RequiredScopes('user:profile:read')
export class UserMeRedirectShimController {
  @Get('preferences')
  @ApiExcludeEndpoint()
  @RequiredScopes('user:preferences:write')
  getPreferences(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'users/me/preferences');
  }

  @Patch('preferences')
  @ApiExcludeEndpoint()
  @RequiredScopes('user:preferences:write')
  updatePreferences(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'users/me/preferences');
  }

  @Get('settings')
  @ApiExcludeEndpoint()
  @RequiredScopes('user:settings:read')
  listSettings(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'users/me/settings');
  }

  @Patch('settings/:namespace/:key')
  @ApiExcludeEndpoint()
  @RequiredScopes('user:settings:write')
  updateSettingByKey(@Param('namespace') namespace: string, @Param('key') key: string, @Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, `users/me/settings/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`);
  }

  @Get('departments')
  @ApiExcludeEndpoint()
  @RequiredScopes('user:profile:read')
  listDepartments(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'users/me/departments');
  }
}
