import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { redirect308 } from '../../common';
import { Authorize, RequiredScopes } from '../../decorators';

/**
 * redirect shim — DELETE IN ALL-2.0.0. Old path retired 2026-08-18.
 *
 * `entitlements/me` folded into the tenant self alias as
 * `tenants/me/entitlements`.
 */
@ApiTags('entitlements')
@ApiBearerAuth()
@Controller('entitlements')
@RequiredScopes('tenant:account:read')
export class MyEntitlementsRedirectShimController {
  @Get('me')
  @Authorize(['read', 'Tenant'])
  @ApiExcludeEndpoint()
  me(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'tenants/me/entitlements');
  }
}
