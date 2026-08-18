import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { redirect308 } from '../../common';
import { Authorize, RequiredScopes } from '../../decorators';

/**
 * TASK-760 redirect shim — DELETE IN ALL-2.0.0. Old paths retired 2026-08-18.
 *
 * `usage/me/{summary,burndown}` folded into the tenant self alias as
 * `tenants/me/usage-{summary,burndown}`. The leaf carries the `usage-` prefix
 * because `tenants/me/summary` alone would not say what is being summarised
 * once billing, entitlements and usage share one collection.
 */
@ApiBearerAuth()
@ApiTags('usage')
@Controller('usage')
@RequiredScopes('tenant:account:read')
export class MyUsageRedirectShimController {
  @Get('me/summary')
  @Authorize(['read', 'Tenant'])
  @ApiExcludeEndpoint()
  summary(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'tenants/me/usage-summary');
  }

  @Get('me/burndown')
  @Authorize(['read', 'Tenant'])
  @ApiExcludeEndpoint()
  burndown(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'tenants/me/usage-burndown');
  }
}
