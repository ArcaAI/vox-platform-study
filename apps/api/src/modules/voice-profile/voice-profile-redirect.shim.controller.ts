import { Controller, Delete, Get, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { redirect308 } from '../../common';
import { Authorize, ForbidApiKey } from '../../decorators';

/**
 * TASK-760 redirect shim — DELETE IN ALL-2.0.0. Old paths retired 2026-08-18.
 *
 * `voice-profile` (singular) became `voice-profiles`.
 *
 * API-KEY-NOTE — `@ForbidApiKey()` is reproduced verbatim from the target: voice biometrics
 * are JWT-only (TASK-758's reasoned exemption from policy A1), and a shim that
 * accepted a key would be a way of reaching an enrolment route with a
 * credential the target refuses. `@TenantOwnedResource` is NOT reproduced —
 * that interceptor resolves the row to enforce 404-over-403, and this handler
 * reads no row; the target still runs it after the redirect.
 */
@ApiBearerAuth()
@ApiTags('voice-profile')
@Controller('voice-profile')
@ForbidApiKey()
export class VoiceProfileRedirectShimController {
  @Post('enroll')
  @Authorize(['create', 'UserVoiceProfile'])
  @ApiExcludeEndpoint()
  enroll(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'voice-profiles/enroll');
  }

  @Get()
  @Authorize(['read', 'UserVoiceProfile'])
  @ApiExcludeEndpoint()
  list(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'voice-profiles');
  }

  @Patch(':id/activate')
  @Authorize(['update', 'UserVoiceProfile'])
  @ApiExcludeEndpoint()
  activate(@Param('id') id: string, @Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, `voice-profiles/${encodeURIComponent(id)}/activate`);
  }

  @Patch(':id/deactivate')
  @Authorize(['update', 'UserVoiceProfile'])
  @ApiExcludeEndpoint()
  deactivate(@Param('id') id: string, @Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, `voice-profiles/${encodeURIComponent(id)}/deactivate`);
  }

  @Delete(':id')
  @Authorize(['delete', 'UserVoiceProfile'])
  @ApiExcludeEndpoint()
  remove(@Param('id') id: string, @Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, `voice-profiles/${encodeURIComponent(id)}`);
  }
}
