import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { redirect308 } from '../../common';
import { Authorize, RequiredScopes } from '../../decorators';

/**
 * redirect shim — DELETE IN ALL-2.0.0. Old paths retired 2026-08-18.
 *
 * `text` was the NAME OF A SERVICE (`apps/text`, port 8862) leaking through
 * the gateway as a public prefix. The capability is text generation, so the
 * collection is `text-generations` (decision D-2).
 *
 * `@StreamScope` is deliberately NOT reproduced on the stream shim: that
 * metadata tells `TenantOwnedResourceSseGuard` which stream a single-use
 * ticket is allowed to open, and this handler opens no stream — it answers a
 * 308 and closes. The guard still runs at the TARGET, on the request that
 * actually streams. A stream-ticket caller therefore reaches the same gate it
 * always did, one hop later.
 */
@ApiTags('text')
@ApiBearerAuth()
@Controller('text')
@RequiredScopes('consultation:report:write')
export class TextProxyRedirectShimController {
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @ApiExcludeEndpoint()
  generate(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'text-generations/generate');
  }

  @Post('generate/assembled')
  @Authorize()
  @ApiExcludeEndpoint()
  generateAssembled(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'text-generations/generate/assembled');
  }

  @Get('tasks/:taskId')
  @Authorize()
  @ApiExcludeEndpoint()
  getTask(@Param('taskId') taskId: string, @Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, `text-generations/tasks/${encodeURIComponent(taskId)}`);
  }

  @Post('tasks/:taskId/cancel')
  @Authorize()
  @ApiExcludeEndpoint()
  cancelTask(@Param('taskId') taskId: string, @Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, `text-generations/tasks/${encodeURIComponent(taskId)}/cancel`);
  }

  @Get('tasks/:taskId/stream')
  @Authorize()
  @ApiExcludeEndpoint()
  streamTaskEvents(@Param('taskId') taskId: string, @Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, `text-generations/tasks/${encodeURIComponent(taskId)}/stream`);
  }

  @Get('providers')
  @Authorize()
  @ApiExcludeEndpoint()
  providers(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'text-generations/providers');
  }

  @Get('guardrail-providers')
  @Authorize()
  @ApiExcludeEndpoint()
  guardrailProviders(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'text-generations/guardrail-providers');
  }
}
