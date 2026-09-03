import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { redirect308 } from '../../common';
import { Authorize, RequiredScopes } from '../../decorators';

/**
 * redirect shim — DELETE IN ALL-2.0.0. Old paths retired 2026-08-18.
 *
 * The bare `billing/me/*` "mine" surface folded into the tenant self alias.
 * These reads are `read:Tenant`, CLS-tenant-scoped — they belong under
 * `tenants/me`, NOT under `users/me`, which would assert that a tenant's
 * invoices are owned by the calling user (decision D-1).
 */
@ApiBearerAuth()
@ApiTags('billing')
@Controller('billing')
@RequiredScopes('tenant:account:read')
export class MyBillingRedirectShimController {
  @Get('me/invoices')
  @Authorize(['read', 'Tenant'])
  @ApiExcludeEndpoint()
  listMine(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'tenants/me/invoices');
  }

  @Get('me/invoices/:id')
  @Authorize(['read', 'Tenant'])
  @ApiExcludeEndpoint()
  getMine(@Param('id') id: string, @Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, `tenants/me/invoices/${encodeURIComponent(id)}`);
  }

  @Get('me/spend')
  @Authorize(['read', 'Tenant'])
  @ApiExcludeEndpoint()
  spend(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'tenants/me/spend');
  }
}
