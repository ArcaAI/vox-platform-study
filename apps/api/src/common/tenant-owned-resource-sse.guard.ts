/**
 * `TenantOwnedResourceSseGuard` — TASK-309 SSE cross-tenant leak fix.
 *
 * The global `TenantOwnedResourceInterceptor` asserts `@TenantOwnedResource`
 * ownership and throws `404` on a tenant mismatch. That works for normal
 * request/response handlers, but NOT for `@Sse()` handlers: an SSE handler
 * returns its `Observable<MessageEvent>` synchronously and NestJS begins the
 * `text/event-stream` response before the interceptor's post-handler rejection
 * can take effect — so a cross-tenant probe of `:id/stream` leaks a `200` open
 * stream instead of a `404`.
 *
 * Guards run BEFORE the handler executes, so re-running the SAME ownership
 * assertion here rejects the request with `404` before the stream opens.
 *
 * Scope: this guard only acts on `@Sse()` handlers — every other route keeps
 * its existing single enforcement point (the interceptor). It MUST run after
 * `UnifiedAuthGuard` (which populates the CLS `tenantId` the assertion reads);
 * registration order in `AppModule.guards` guarantees that.
 *
 * TASK-460 C4-03 — the pre-stream check alone admits the stream exactly ONCE:
 * a `CanActivate` guard has no per-event re-evaluation, so once the
 * `text/event-stream` opened, the ownership assertion never ran again for the
 * stream's whole lifetime (PHI relays on `:id/live-summary/stream`). The guard
 * therefore ALSO re-runs the same RESOURCE-OWNERSHIP assertion periodically
 * while the stream is open and ends the response when it reports 404 — i.e. it
 * catches the streamed resource being soft-DELETED or re-tenanted mid-stream.
 *
 * Scope limit (review I-3): this re-check revalidates the RESOURCE side only.
 * The CLS caller context (tenantId, user) is frozen for the stream's async
 * lifetime, so identity-side revocation — JWT/session invalidation, user
 * disable, role downgrade, a global admin switching working tenant — is NOT
 * detected here (a session-revocation signal is an explicit ticket non-goal).
 * Transient re-check failures (DB timeout, pool exhaustion) never terminate:
 * only the interceptor's own `NotFoundException` does. A terminated client's
 * EventSource reconnect faces the pre-stream check (and full auth) again.
 */
import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { TENANT_OWNED_RESOURCE_KEY, type TenantOwnedResourceOptions } from './tenant-owned-resource.decorator';
import { TenantOwnedResourceInterceptor } from './tenant-owned-resource.interceptor';

/**
 * Re-check cadence for open SSE streams (TASK-460 C4-03). 30s bounds the
 * window in which a soft-DELETED or re-tenanted resource keeps streaming, at
 * one cheap indexed read per open stream per interval. The CLS request
 * context propagates into the timer callback via AsyncLocalStorage and stays
 * FROZEN for the stream's lifetime — the re-check therefore revalidates
 * resource ownership only, never identity-side revocation (see class doc).
 */
export const SSE_OWNERSHIP_RECHECK_INTERVAL_MS = 30_000;

/** Minimal response surface the re-check needs (express `Response` satisfies it). */
interface SseResponseLike {
  writableEnded?: boolean;
  end?: () => void;
  on?: (event: 'close', listener: () => void) => void;
}

@Injectable()
export class TenantOwnedResourceSseGuard implements CanActivate {
  private readonly logger = new Logger(TenantOwnedResourceSseGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly interceptor: TenantOwnedResourceInterceptor,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    // Only @Sse() handlers need the pre-stream check; the interceptor already
    // guards every non-SSE @TenantOwnedResource route correctly.
    const isSse = this.reflector.get<boolean | undefined>(SSE_METADATA, context.getHandler());
    if (!isSse) {
      return true;
    }

    // Throws NotFoundException (404) on a tenant mismatch; no-op when the
    // handler doesn't carry @TenantOwnedResource.
    await this.interceptor.assertAccess(context);

    // TASK-460 C4-03 — keep re-asserting while the stream is open.
    this.scheduleOwnershipRecheck(context);
    return true;
  }

  /**
   * Periodically re-run the SAME `assertAccess` the stream was admitted with,
   * ending the response when it reports an ownership 404 (the streamed
   * resource was soft-deleted or re-tenanted). Only routes that actually carry
   * `@TenantOwnedResource` schedule the loop — for anything else
   * `assertAccess` is a no-op that could never fail, so there is nothing to
   * re-check.
   */
  private scheduleOwnershipRecheck(context: ExecutionContext): void {
    const opts = this.reflector.getAllAndOverride<TenantOwnedResourceOptions | undefined>(TENANT_OWNED_RESOURCE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!opts) {
      return;
    }

    const response = context.switchToHttp().getResponse<SseResponseLike>();
    const timer = setInterval(() => {
      void this.recheckOwnership(context, response, timer);
    }, SSE_OWNERSHIP_RECHECK_INTERVAL_MS);

    // The stream's own teardown (client disconnect, server end) clears the loop.
    response.on?.('close', () => clearInterval(timer));
  }

  private async recheckOwnership(context: ExecutionContext, response: SseResponseLike, timer: ReturnType<typeof setInterval>): Promise<void> {
    if (response.writableEnded) {
      clearInterval(timer);
      return;
    }
    try {
      await this.interceptor.assertAccess(context);
    } catch (err) {
      const request = context.switchToHttp().getRequest<{ url?: string }>();

      // Review I-2 — only the interceptor's own ownership-failure signal
      // (NotFoundException, 404-over-403) terminates the stream. Any other
      // error is a TRANSIENT infrastructure failure (Prisma pool exhaustion,
      // DB timeout, deadlock, Redis blip) — ending a valid multi-hour PHI
      // stream on those would cut live consultations, so log and let the
      // next interval re-check.
      if (!(err instanceof NotFoundException)) {
        this.logger.warn({
          message: 'SSE ownership re-check errored transiently — keeping stream open',
          path: request?.url,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      clearInterval(timer);
      this.logger.warn({
        message: 'SSE ownership re-check failed — terminating open stream',
        path: request?.url,
      });
      if (!response.writableEnded) {
        response.end?.();
      }
    }
  }
}
