import { ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { STREAM_SCOPE_METADATA, type StreamScopeConfig } from '../modules/auth/decorators/stream-scope.decorator';
import { StreamTicketService } from '../modules/auth/stream-ticket.service';

/**
 * JwtAuthGuard (TASK-263 W0-1 extension)
 *
 * Two authentication paths:
 *   1. `Authorization: Bearer <jwt>` — handled by the underlying passport-jwt
 *      strategy via `super.canActivate(context)`.
 *   2. `?ticket=<ticket>` query parameter — handled here. The ticket is
 *      atomically consumed from Redis, its scope is validated against the
 *      route's `@StreamScope` declaration, and `req.user` is populated from
 *      the ticket payload.
 *
 * The ticket path exists so SSE clients (e.g. the Vox SDK) can authenticate
 * without putting the long-lived JWT in the URL — a HIPAA-sensitive pattern
 * because the JWT would leak into proxy logs, browser history, etc. Tickets
 * are single-use and TTL=30s.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly streamTicketService: StreamTicketService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      query?: Record<string, unknown>;
      params?: Record<string, string>;
      user?: unknown;
    }>();

    const ticket = this.extractTicket(request?.query?.ticket);
    if (ticket) {
      return this.handleTicketAuth(context, request, ticket);
    }

    return super.canActivate(context) as boolean | Promise<boolean>;
  }

  /**
   * Extracts the ticket value from the query string. Express may parse
   * repeated `?ticket=…&ticket=…` into an array; we take the first value.
   */
  private extractTicket(raw: unknown): string | null {
    if (typeof raw === 'string' && raw.length > 0) return raw;
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string' && raw[0].length > 0) {
      return raw[0];
    }
    return null;
  }

  private async handleTicketAuth(
    context: ExecutionContext,
    request: { params?: Record<string, string>; user?: unknown },
    ticket: string,
  ): Promise<boolean> {
    const stored = await this.streamTicketService.consumeTicket(ticket);
    if (!stored) {
      this.logger.warn({ message: 'Stream ticket invalid or already consumed' });
      throw new UnauthorizedException('Invalid or expired stream ticket');
    }

    const scopeConfig = this.reflector.getAllAndOverride<StreamScopeConfig | undefined>(STREAM_SCOPE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!scopeConfig) {
      this.logger.warn({
        message: 'Ticket presented on a route that does not declare @StreamScope',
      });
      throw new UnauthorizedException('Ticket authentication not allowed on this route');
    }

    const resourceId = request?.params?.[scopeConfig.param];
    if (!resourceId) {
      this.logger.warn({
        message: 'Stream-scope route is missing the required path param',
        param: scopeConfig.param,
      });
      throw new UnauthorizedException('Stream-scope route is missing the required path param');
    }

    const expectedScope = `${scopeConfig.namespace}:${resourceId}`;
    if (stored.scope !== expectedScope) {
      this.logger.warn({
        message: 'Stream ticket scope does not match the requested route',
        expected: expectedScope,
        actual: stored.scope,
      });
      throw new UnauthorizedException('Stream ticket scope does not match this route');
    }

    request.user = { id: stored.userId, tenantId: stored.tenantId };
    return true;
  }
}
