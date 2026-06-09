import { ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { SKIP_AUTH_KEY, type UserSession } from '@arcaai/applications';
import { ClsService } from 'nestjs-cls';
import { STREAM_SCOPE_METADATA, type StreamScopeConfig } from '../modules/auth/decorators/stream-scope.decorator';
import { StreamTicketService } from '../modules/auth/stream-ticket.service';
import type { RequestWithAuth } from '../types/request-with-auth';

/**
 * Request-scoped marker holding the stream ticket already consumed + validated
 * on an earlier guard pass for THIS request.
 *
 * `UnifiedAuthGuard` is applied BOTH as the global `APP_GUARD` (TASK-307 W4b)
 * and via `@Authorize()`'s `@UseGuards(UnifiedAuthGuard)`, so its `canActivate`
 * — and therefore this guard's `canActivate` — runs twice per request. Stream
 * tickets are single-use (`StreamTicketService.consumeTicket` does GET+DEL), so
 * without this marker the first pass consumes the ticket and the second pass
 * 401s on the now-deleted key. The marker is scoped to the request object, so
 * cross-request ticket reuse still fails as intended.
 */
const CONSUMED_STREAM_TICKET = Symbol('consumedStreamTicket');

type RequestWithConsumedTicket = RequestWithAuth & { [CONSUMED_STREAM_TICKET]?: string };

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
    private readonly clsService: ClsService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) {
      return true;
    }

    // TASK-310 E-6 (AC-6): typed RequestWithAuth replaces the pre-W7
    // inline anonymous structural type. The ticket path writes to
    // `request.user`; using the typed interface keeps the assignment
    // type-checked against the canonical `UserSession` shape.
    const request = context.switchToHttp().getRequest<RequestWithAuth>();

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

  private async handleTicketAuth(context: ExecutionContext, request: RequestWithConsumedTicket, ticket: string): Promise<boolean> {
    // Reuse a ticket already consumed earlier in THIS request: `UnifiedAuthGuard`
    // runs twice per request (global APP_GUARD + @Authorize()'s @UseGuards), and
    // the single-use ticket would be rejected on the second pass. The first pass
    // populated `request.user` + CLS, so a repeat pass for the same ticket
    // short-circuits without re-consuming.
    if (request[CONSUMED_STREAM_TICKET] === ticket) {
      return true;
    }

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

    // TASK-295 SEC-A5-6 / M-8: when the ticket was minted under an active
    // impersonation, restore the `impersonatedBy` claim on `req.user`. This
    // is the only signal `ImpersonationAuditInterceptor` consults to decide
    // whether to emit an impersonation audit event for streaming requests.
    //
    // TASK-310 E-6 (AC-6): the cast is deliberate — the ticket-auth path
    // only restores the three claims downstream consumers
    // (`ImpersonationAuditInterceptor`, CLS lookups) actually read.
    // Building a full `UserSession` here would require re-fetching email /
    // roles / permissions just to satisfy the type, which is wasted work
    // for a session that's already pre-authenticated upstream by the
    // ticket issuer.
    const restoredUser: Partial<UserSession> & { id: string } = {
      id: stored.userId,
      tenantId: stored.tenantId,
      ...(stored.impersonatedBy ? { impersonatedBy: stored.impersonatedBy } : {}),
    };
    request.user = restoredUser as UserSession;

    // Mark the ticket consumed for this request so the second guard pass (see
    // CONSUMED_STREAM_TICKET) reuses this result instead of re-consuming.
    request[CONSUMED_STREAM_TICKET] = ticket;

    // Make the restored user visible to CLS-aware interceptors
    // (ImpersonationAuditInterceptor, BaseService.tenantId, etc.). Wrapped in
    // try/catch because some bootstrap paths (e.g. /metrics) have no CLS
    // context — we never want auth to crash the request on that.
    try {
      this.clsService.set('user', restoredUser);
      if (stored.tenantId) {
        this.clsService.set('tenantId', stored.tenantId);
      }
    } catch {
      // best-effort; the JWT path remains the primary CLS populator.
    }

    return true;
  }
}
