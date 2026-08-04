/**
 * `OriginTenantBindingGuard` — TASK-610 FR-4, plan §3.0 / §3.4.
 *
 * CORS is ADVISORY BROWSER BEHAVIOUR. It proves nothing about a caller: any
 * non-browser client ignores it outright, and a browser only ever declines to
 * hand the RESPONSE to page script — the request still reached the gateway
 * and still ran. So the CORS allow-list (`cors.config.ts`) is not a tenant
 * boundary; it decides which origins EXIST at all.
 *
 * This guard is the boundary. It answers one question:
 *
 *     the request carries `Origin: X`, and X belongs to tenant O —
 *     is the tenant this request resolved to allowed to act from X?
 *
 * Four rules, each with a SILENT failure mode (nothing goes red; the wrong
 * requests are simply allowed, or the platform quietly breaks):
 *
 *  1. No `Origin` header  → PASS THROUGH. Server-to-server, CLI, worker and
 *     internal callers send none, and CORS already admits them
 *     (`no_origin_provided`). This is the MAJORITY of gateway traffic, not an
 *     edge case — enforcing a binding here would break every internal caller
 *     on the platform.
 *  2. Origin owned by the reserved SYSTEM tenant → allow for ANY tenant. The
 *     admin console serves every tenant from ONE origin; binding SYSTEM
 *     origins strictly would break the console for all tenants on day one.
 *  3. Otherwise the owner MUST equal the resolved tenant. Mismatch →
 *     `NotFoundException` (404), never `ForbiddenException` — the house
 *     404-over-403 posture (`05-nestjs-api.md`): a cross-tenant access must
 *     not confirm that the resource, route or tenant exists.
 *  4. No resolved tenant → PASS THROUGH. Public/unauthenticated routes (login,
 *     health, password reset) have none, and the origin already passed the
 *     CORS gate. 404-ing an anonymous login request would take the login page
 *     down.
 *
 * ORDERING (Integrator note): this guard MUST be registered as an `APP_GUARD`
 * AFTER `UnifiedAuthGuard` — that is what populates the CLS `tenantId` /
 * `user` this guard reads. Registered before it, `resolveTenantId()` is always
 * empty, rule 4 fires for every request, and the guard silently degrades to a
 * no-op that still passes all of its own unit tests.
 *
 * Note that `ContextInterceptor`'s global-admin `x-tenant-id` elevation runs
 * AFTER all guards, so a global admin "acting as" a tenant is still seen here
 * with their own empty tenant and takes rule 4. That is correct: they arrive
 * on the SYSTEM-owned console origin, which rule 2 admits anyway.
 */
import { CanActivate, ExecutionContext, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { IOriginRegistry } from '@arcaai/applications';

/**
 * Reserved platform tenant. Declared locally, matching the house pattern used
 * by every consumer of this constant (`base.service.ts`, `policy.engine.ts`,
 * `appSettings.service.ts`, …) rather than introducing a new cross-package
 * export for a single comparison.
 */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Deliberately generic. A cross-tenant caller learns nothing from it — same
 * body every other 404-over-403 rejection in the gateway returns.
 */
const RESOURCE_NOT_FOUND = 'Resource not found';

@Injectable()
export class OriginTenantBindingGuard implements CanActivate {
  private readonly logger = new Logger(OriginTenantBindingGuard.name);

  constructor(
    private readonly cls: ClsService,
    @Inject(IOriginRegistry) private readonly registry: IOriginRegistry,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // HTTP only. The WebSocket handshake is NOT covered here — browsers exempt
    // WS from CORS entirely, and `SttWsGateway` runs its own registry check
    // against the handshake `Origin` (D-6, lane W3-C). Returning true for a WS
    // context is a delegation, not a gap.
    if (context.getType() !== 'http') {
      return true;
    }

    const origin = this.readOriginHeader(context);

    // Rule 1 — no Origin: pass through without touching the registry.
    if (origin === null) {
      return true;
    }

    const tenantId = this.resolveTenantId();

    // Rule 4 — nothing to bind against.
    if (tenantId === null) {
      return true;
    }

    // `ownerOf` normalizes the raw header itself (case, default port) and
    // never throws on malformed input — a hostile `Origin` yields `null`, not
    // an unhandled 500. The raw header is passed through UNMODIFIED so the
    // registry's normalizer stays the single source of truth for origin
    // syntax; pre-processing it here would be a second, divergent parser.
    const owner = this.registry.ownerOf(origin);

    // DECISION — an origin that is present but NOT registered passes through.
    //
    // Reaching this branch in production means either (a) the `development`
    // loopback allowance in `cors.config.ts`, which deliberately admits
    // origins that have no registry row so a fresh clone with an empty
    // database still works, (b) the FR-6 bootstrap fallback, where the table
    // is empty or unreadable and CORS falls back to `CORS_ALLOWED_ORIGINS`,
    // or (c) a non-browser client that forged an `Origin` header.
    //
    // Denying here would be actively harmful and buys nothing:
    //   - It would DEFEAT FR-6. An empty or unreadable registry would 404
    //     every browser request platform-wide, turning a degraded-but-serving
    //     gateway into a total outage — the exact failure the bootstrap
    //     fallback exists to prevent.
    //   - It would break the documented dev loopback path.
    //   - It closes nothing. An unregistered origin has NO owner, so there is
    //     no tenant binding to violate. And a non-browser client that can
    //     forge an `Origin` can equally OMIT it and take rule 1 — denying
    //     would only inconvenience an attacker who chose the noisier of two
    //     equivalent paths, while breaking real callers.
    // Registration is enforced one layer up, at the CORS gate, which is the
    // layer that owns "which origins exist at all".
    //
    // It is logged at warn so a registry miss is diagnosable in one grep
    // (plan §3.8: ship the registry-miss log line in the same release that
    // closes the catch-all).
    if (owner === null) {
      this.logger.warn({
        message: 'Origin is not registered in the origin registry — passing through (no owner ⇒ no tenant binding to enforce)',
        origin,
        tenantId,
        path: this.readPath(context),
      });
      return true;
    }

    // Rule 2 — a SYSTEM-owned origin is valid for every tenant.
    if (owner === SYSTEM_TENANT_ID) {
      return true;
    }

    // Rule 3 — owner must equal the resolved tenant.
    if (owner === tenantId) {
      return true;
    }

    this.logger.warn({
      message: 'Cross-tenant origin binding violation — rejecting with 404',
      origin,
      ownerTenantId: owner,
      requestTenantId: tenantId,
      path: this.readPath(context),
    });
    throw new NotFoundException(RESOURCE_NOT_FOUND);
  }

  /**
   * The raw `Origin` header, or `null` when it is absent / not a usable single
   * string.
   *
   * A duplicated `Origin` (array-valued, or comma-joined by an upstream proxy)
   * is ambiguous — there is no defensible way to pick which of two origins the
   * request "really" came from — so it is treated as absent. That is the same
   * outcome as the unregistered-origin decision above and opens no path a
   * caller does not already have by simply omitting the header.
   */
  private readOriginHeader(context: ExecutionContext): string | null {
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> } | undefined>();
    const raw = request?.headers?.['origin'];
    if (typeof raw !== 'string') {
      return null;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private readPath(context: ExecutionContext): string | undefined {
    return context.switchToHttp().getRequest<{ url?: string } | undefined>()?.url;
  }

  /**
   * The tenant this request resolved to, or `null` when there is none.
   *
   * Same resolution the DB tenant-scope adapter uses
   * (`database/tenant-context.provider.ts#getTenantId`) — `cls.get('tenantId')`
   * with the CLS user as fallback — rather than a new accessor. An EMPTY
   * string means "no tenant context": global admins authenticate without a
   * tenant binding and carry `tenantId: ''`, so `??` alone would leak the
   * empty string through and make it compare unequal to every real owner.
   */
  private resolveTenantId(): string | null {
    if (!this.cls.isActive()) {
      return null;
    }
    const direct = this.cls.get('tenantId') as unknown;
    const fromUser = (this.cls.get('user') as { tenantId?: string | null } | undefined)?.tenantId;
    const resolved = typeof direct === 'string' && direct.length > 0 ? direct : fromUser;
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : null;
  }
}
