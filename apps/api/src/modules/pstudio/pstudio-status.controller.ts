import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Authorize, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
import { shouldEnablePrismaStudio } from './pstudio.module';

/** Response for `GET /admin/pstudio/status`. */
export class PrismaStudioStatusResponse {
  @ApiProperty({ description: 'Whether the Prisma Studio shell is enabled in this environment (ENABLE_PRISMA_STUDIO flag).' })
  enabled!: boolean;
}

/**
 * Always-registered availability probe for the Prisma Studio
 * module. `PrismaStudioModule` (the shell + BFF) is only registered when
 * `shouldEnablePrismaStudio()` is true, so from the admin console a 404 on
 * `/admin/pstudio` is ambiguous (disabled? wrong URL? server down?). This
 * controller is registered unconditionally and reports the same env decision,
 * letting the Prisma Studio surface render a truthful enabled/disabled card.
 *
 * The enablement is production-capable (`ENABLE_PRISMA_STUDIO`
 * only, fail-closed when unset) and the probe is gated by the same DEDICATED
 * `manage:PrismaStudio` subject as the studio itself. Read-only, leaks no
 * connection details.
 */
@ApiTags('admin-pstudio')
@ApiBearerAuth()
@Authorize(['manage', 'PrismaStudio'])
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:pstudio:manage')
@Controller('admin/pstudio/status')
export class PrismaStudioStatusController {
  @Get()
  @ApiOperation({ summary: 'Report whether the Prisma Studio shell is enabled in this environment.' })
  @ApiOkResponse({ type: PrismaStudioStatusResponse })
  getStatus(): PrismaStudioStatusResponse {
    return { enabled: shouldEnablePrismaStudio(process.env) };
  }
}
