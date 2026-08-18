import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request as ExpressRequest, Response } from 'express';
import { redirect308 } from '../../common';
import { Authorize, RequiredScopes } from '../../decorators';

/**
 * TASK-760 redirect shim — DELETE IN ALL-2.0.0. Old path retired 2026-08-18.
 *
 * `tenant/me/context-schema` became `tenants/me/context-schema` along with the
 * rest of the tenant self plane. Auth posture copied verbatim from the target.
 */
@ApiBearerAuth()
@ApiTags('tenant')
@Controller('tenant/me/context-schema')
@Authorize()
@RequiredScopes('tenant:context-schema:read')
export class MyTenantContextSchemaRedirectShimController {
  @Get()
  @ApiExcludeEndpoint()
  getEffective(@Req() request: ExpressRequest, @Res() response: Response): void {
    redirect308(request, response, 'tenants/me/context-schema');
  }
}
