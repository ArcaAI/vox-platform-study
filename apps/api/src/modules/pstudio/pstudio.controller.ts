import { IPrismaStudioService, IAuditLogService } from '@arcaai/applications';
import { AuditAction, ResourceType } from '@arcaai/domains';
import { Controller, Get, Post, Body, Res, HttpCode, Inject, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { Authorize, CanManage, RequiredScopes } from '../../decorators';
import { getStudioHtml } from './pstudio.html';

// Audit categorisation for raw Prisma Studio access. The
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
@RequiredScopes('admin:pstudio:manage')
@Controller('admin/pstudio')
// Pinned to the DEDICATED `manage:PrismaStudio` subject
// (production-capable enablement; `manage:all` still passes via the CASL
// wildcard). Class-level baseline; method decorators re-state it.
@CanManage('PrismaStudio')
export class PrismaStudioController {
  private readonly logger = new Logger(PrismaStudioController.name);

  constructor(
    @Inject(IPrismaStudioService)
    private readonly studioService: IPrismaStudioService,
    @Inject(IAuditLogService)
    private readonly auditLogService: IAuditLogService,
  ) {}

  // GET does not accept a JWT via `?token=`
  // query string. Authentication is enforced at the guard layer.
  // The served body carries no secret; it is also no-store so
  // no proxy / CDN caches the studio shell.
  // The shell posts queries back to the path that served it
  // (window.location.pathname), so the authenticating BFF proxy in front of
  // this route carries the credential on GET and POST alike. No Host-derived
  // absolute endpoint is embedded (it bypassed the proxy → empty bearer → 401).
  @Get()
  @Authorize(['manage', 'PrismaStudio'])
  @ApiBearerAuth()
  @ApiExcludeEndpoint()
  serveStudio(@Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/html').send(getStudioHtml());
  }

  @Post()
  @Authorize(['manage', 'PrismaStudio'])
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Execute Prisma Studio query (internal BFF endpoint)' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleStudioRequest(@Body() body: Record<string, any>) {
    const { procedure, query, sequence } = body;

    if (procedure === 'sequence' && sequence) {
      // Studio runs raw SQL against the unscoped
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
      // A `query` is the read path; audit it as a READ.
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
