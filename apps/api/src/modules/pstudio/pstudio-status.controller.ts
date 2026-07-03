import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Authorize } from '../../decorators';
import { shouldEnablePrismaStudio } from './pstudio.module';

/** Response for `GET /admin/pstudio/status`. */
export class PrismaStudioStatusResponse {
  @ApiProperty({ description: 'Whether the dev-only Prisma Studio shell is enabled in this environment.' })
  enabled!: boolean;
}

/**
 * TASK-403 — always-registered availability probe for the dev-only Prisma
 * Studio module. `PrismaStudioModule` (the shell + BFF) is only registered
 * when `shouldEnablePrismaStudio()` is true, so from the admin console a 404
 * on `/admin/pstudio` is ambiguous (disabled? wrong URL? server down?). This
 * controller is registered unconditionally and reports the same env decision,
 * letting the Prisma Studio surface render a truthful enabled/disabled card.
 *
 * Read-only, leaks no connection details, and — like the Studio surface
 * itself — is gated to SUPER_ADMIN (`manage all`).
 */
@ApiTags('admin-pstudio')
@ApiBearerAuth()
@Authorize(['manage', 'all'])
@Controller('admin/pstudio/status')
export class PrismaStudioStatusController {
  @Get()
  @ApiOperation({ summary: 'Report whether the dev-only Prisma Studio shell is enabled in this environment.' })
  @ApiOkResponse({ type: PrismaStudioStatusResponse })
  getStatus(): PrismaStudioStatusResponse {
    return { enabled: shouldEnablePrismaStudio(process.env) };
  }
}
