import { IPrismaStudioService } from '@arcaai/applications';
import { Controller, Get, Post, Body, Req, Res, HttpCode, Inject, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint, ApiBearerAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Authorize, CanManage } from '../../decorators';
import { getStudioHtml } from './pstudio.html';

@ApiTags('admin-pstudio')
@Controller('admin/pstudio')
// Phase 0 Item 3 (TASK-302 Stream A): class-level baseline; method
// @Authorize(['manage', 'all']) decorators override.
@CanManage('all')
export class PrismaStudioController {
  private readonly logger = new Logger(PrismaStudioController.name);

  constructor(
    @Inject(IPrismaStudioService)
    private readonly studioService: IPrismaStudioService,
  ) {}

  // TASK-307 W5.2 (AC-16, audit C-9): GET no longer accepts a JWT via
  // `?token=` query string (it leaks through proxy / CDN / browser
  // history logs). Authentication is required at the guard layer, and
  // the same Bearer credential is read from the Authorization header
  // here so it can be embedded in the studio shell for the BFF client.
  @Get()
  @Authorize(['manage', 'all'])
  @ApiBearerAuth()
  @ApiExcludeEndpoint()
  serveStudio(@Req() req: Request, @Res() res: Response) {
    const auth = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      // Defensive: the guard normally catches missing/invalid bearer
      // tokens before this handler runs. If reached anyway, refuse
      // without naming a "?token=" alternative.
      res
        .status(401)
        .type('text/plain')
        .send('Access denied. A valid Authorization: Bearer <jwt> header is required.');
      return;
    }
    const token = match[1].trim();

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const studioEndpointUrl = `${protocol}://${host}/api/v1/admin/pstudio`;

    const html = getStudioHtml(studioEndpointUrl, token);
    res.type('text/html').send(html);
  }

  @Post()
  @Authorize(['manage', 'all'])
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Execute Prisma Studio query (internal BFF endpoint)' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleStudioRequest(@Body() body: Record<string, any>) {
    const { procedure, query, sequence } = body;

    if (procedure === 'sequence' && sequence) {
      return this.studioService.executeSequence(sequence);
    }

    if (query) {
      return this.studioService.executeQuery(query);
    }

    this.logger.warn('Invalid studio request: missing query or sequence');
    return [{ message: 'Invalid request: missing query or sequence', name: 'BadRequest' }];
  }
}
