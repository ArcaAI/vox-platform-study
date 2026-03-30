import { IPrismaStudioService } from '@arcaai/applications';
import { Controller, Get, Post, Body, Req, Res, HttpCode, Inject, Logger, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint, ApiBearerAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Authorize, Public } from '../../decorators';
import { getStudioHtml } from './pstudio.html';

@ApiTags('admin-pstudio')
@Controller('admin/pstudio')
export class PrismaStudioController {
  private readonly logger = new Logger(PrismaStudioController.name);

  constructor(
    @Inject(IPrismaStudioService)
    private readonly studioService: IPrismaStudioService,
  ) {}

  @Get()
  @Public()
  @ApiExcludeEndpoint()
  serveStudio(@Req() req: Request, @Res() res: Response, @Query('token') token?: string) {
    if (!token) {
      res
        .status(401)
        .type('text/plain')
        .send('Access denied. Provide a valid JWT token as ?token= query parameter.\n\n' + 'Usage: /api/v1/admin/pstudio?token=<your-jwt-token>');
      return;
    }

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
