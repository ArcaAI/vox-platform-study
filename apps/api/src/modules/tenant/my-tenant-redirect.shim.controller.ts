import { Controller, Get, Patch, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { redirect308 } from '../../common';
import { Authorize, RequiredScopes } from '../../decorators';

/**
 * redirect shim — DELETE IN ALL-2.0.0. Old paths retired 2026-08-18.
 *
 * `tenant/me[/config]` became `tenants/me[/config]`: plural collection, and
 * the `me` segment now belongs to the collection rather than being a literal
 * inside a singular prefix.
 *
 * `@RequiresIfMatch()` is deliberately NOT reproduced on the PATCH shim. The
 * precondition belongs to the write, and the write happens at the TARGET —
 * enforcing it twice would 428 a client that is merely being told where the
 * route moved to, before it ever gets the chance to send `If-Match` to the
 * handler that actually CASes on it. The header rides through the 308
 * untouched, so the target still enforces it.
 */
@ApiBearerAuth()
@ApiTags('tenant')
@Controller('tenant')
@Authorize()
@RequiredScopes('tenant:profile:read')
export class MyTenantRedirectShimController {
  @Get('me')
  @ApiExcludeEndpoint()
  me(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'tenants/me');
  }

  @Get('me/config')
  @ApiExcludeEndpoint()
  myConfig(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'tenants/me/config');
  }

  @Patch('me/config')
  @ApiExcludeEndpoint()
  @Authorize(['update', 'Tenant'])
  @RequiredScopes('tenant:profile:write')
  updateMyConfig(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'tenants/me/config');
  }
}
