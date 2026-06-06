import { IPrismaStudioService, IAuditLogService } from '@arcaai/applications';
import { AuditAction, ResourceType } from '@arcaai/domains';
import { Controller, Get, Post, Body, Req, Res, HttpCode, Inject, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint, ApiBearerAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Authorize, CanManage } from '../../decorators';
import { getStudioHtml } from './pstudio.html';

// TASK-326 X1 — audit categorisation for raw Prisma Studio access. The
// ResourceType enum has no Studio-specific value; rather than force a DB
// migration we tag the rows with this `eventType` (the dedicated audit
// categorisation field) and keep `resourceType: AuditLog`.
const PRISMA_STUDIO_EVENT = 'PRISMA_STUDIO';

/**
 * Bound the audited request payload so a large Studio query cannot bloat the
 * audit row. We capture the *action* (the query shape) for the trail — never
 * the result set, which is the sensitive (potentially PHI) surface.
 */
function summarizeStudioRequest(payload: unknown): string {
  try {
    const json = JSON.stringify(payload);
    return json.length > 2000 ? `${json.slice(0, 2000)}…[truncated ${json.length} chars]` : json;
  } catch {
    return '[unserializable studio payload]';
  }
}

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
    @Inject(IAuditLogService)
    private readonly auditLogService: IAuditLogService,
  ) {}

  // TASK-307 W5.2 (AC-16, audit C-9): GET does not accept a JWT via `?token=`
  // query string. Authentication is enforced at the guard layer.
  // TASK-336 OB-11 (audit OB-11): the bearer token is NO LONGER embedded in the
  // served HTML — the shell sources it from the URL fragment at runtime — so the
  // response body carries no secret. We also mark it no-store so no proxy / CDN
  // caches the dev-only studio shell.
  @Get()
  @Authorize(['manage', 'all'])
  @ApiBearerAuth()
  @ApiExcludeEndpoint()
  serveStudio(@Req() req: Request, @Res() res: Response) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const studioEndpointUrl = `${protocol}://${host}/api/v1/admin/pstudio`;

    const html = getStudioHtml(studioEndpointUrl);
    res.setHeader('Cache-Control', 'no-store');
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
      // TASK-326 X1 (audit C-9): Studio runs raw SQL against the unscoped
      // client — a privileged, untenanted surface. A `sequence` carries the
      // write path (mutation + refetch), so audit it as an UPDATE. The audit
      // is best-effort (never throws) so it cannot block a legitimate operator.
      await this.auditLogService.recordSystemAction({
        action: AuditAction.UPDATE,
        eventType: PRISMA_STUDIO_EVENT,
        resourceType: ResourceType.AuditLog,
        data: { kind: 'sequence', procedure, request: summarizeStudioRequest(sequence) },
      });
      return this.studioService.executeSequence(sequence);
    }

    if (query) {
      // TASK-326 X1 — a `query` is the read path; audit it as a READ.
      await this.auditLogService.recordSystemAction({
        action: AuditAction.READ,
        eventType: PRISMA_STUDIO_EVENT,
        resourceType: ResourceType.AuditLog,
        data: { kind: 'query', request: summarizeStudioRequest(query) },
      });
      return this.studioService.executeQuery(query);
    }

    this.logger.warn('Invalid studio request: missing query or sequence');
    return [{ message: 'Invalid request: missing query or sequence', name: 'BadRequest' }];
  }
}
