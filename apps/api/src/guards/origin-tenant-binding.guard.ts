/**
 * `OriginTenantBindingGuard` — post-auth tenant isolation for browser
 * origins (many-to-many origins ↔ tenants).
 *
 * CORS is ADVISORY BROWSER BEHAVIOUR. It proves nothing about a caller: any
 * non-browser client ignores it outright, and a browser only ever declines to
 * hand the RESPONSE to page script — the request still reached the gateway
 * and still ran. So the CORS allow-list (`cors.config.ts`) is not a tenant
 * boundary; it decides which origins EXIST at all.
 *
 * This guard is the boundary. It answers one question:
 *
 *     the request carries `Origin: X`, and X is granted to a SET of tenants —
 *     is the tenant this request resolved to a member of that set?
 *
 * `IOriginRegistry.allows(origin, tenantId)` is the ONE place the
 * SYSTEM-admits-every-tenant rule is implemented. This guard MUST NOT
 * re-derive that rule itself (e.g. by reading `tenantsFor()` and comparing to
 * a locally-declared SYSTEM constant) — this ticket already paid for that
 * mistake once (copying the HTTP/WS rule into both places, then consolidating).
 *
 * ALL OF THIS IS GATED BY `origin.enforcementEnabled`, which DEFAULTS TO
 * TRUE — for every tenant including SYSTEM and GLOBAL, in every environment,
 * with no row present and no opt-in step (`platform-ops.descriptors.ts`;
 * TASK-641 FR-6 reversed the original permissive-by-default posture). While
 * it is off (rule 0 below — an operator's deliberate flip, not the default)
 * this guard passes every request. Nothing here is deleted — one settings
 * write re-arms it.
 *
 * Two outcomes integrators actually hit, and they are NOT the same: an
 * origin that is not registered AT ALL (rule 3) always PASSES THROUGH, with
 * only a warning logged — there is no grant to violate. The 404 (rule 4)
 * fires ONLY when the origin IS registered to some tenant set and this
 * request's resolved tenant is not a member of it.
 *
 * Five rules, each with a SILENT failure mode (nothing goes red; the wrong
 * requests are simply allowed, or the platform quietly breaks):
 *
 *  0. Origin enforcement disabled (an operator opt-OUT — enforcement is ON by
 * default) → PASS THROUGH, without consulting the registry.
 *
 *  1. No `Origin` header  → PASS THROUGH. Server-to-server, CLI, worker and
 *     internal callers send none, and CORS already admits them
 *     (`no_origin_provided`). This is the MAJORITY of gateway traffic, not an
 *     edge case — enforcing a binding here would break every internal caller
 *     on the platform.
 *  2. No resolved tenant → PASS THROUGH. Public/unauthenticated routes (login,
 *     health, password reset) have none, and the origin already passed the
 *     CORS gate. 404-ing an anonymous login request would take the login page
 *     down. A super admin carries `tenantId: ''` — treated as "no tenant",
 *     not compared against real owners (see `resolveTenantId`).
 *  3. Origin not registered at all (`registry.has(origin)` is false — i.e.
 *     `tenantsFor(origin)` is empty) → PASS THROUGH + warn. An unregistered
 *     origin has no grant to violate, and a non-browser client that can forge
 *     an `Origin` header can equally OMIT it and take rule 1 — denying here
 *     would only inconvenience an attacker who chose the noisier of two
 *     equivalent paths, while breaking real callers (dev loopback, a registry
 *     miss that the CORS gate already denied but that still reached the
 *     server on a non-preflighted "simple" request).
 *  4. Otherwise `registry.allows(origin, resolvedTenantId)` decides: allowed
 *     ⇒ pass; denied ⇒ `NotFoundException` (404), never `ForbiddenException`
 *     — the house 404-over-403 posture (`05-nestjs-api.md`): a cross-tenant
 *     access must not confirm that the resource, route or tenant exists.
 *     `allows()` internally admits SYSTEM-granted origins for every tenant —
 *     this guard does not know or care that SYSTEM is special.
 *
 * ORDERING (Integrator note): this guard MUST be registered as an `APP_GUARD`
 * AFTER `UnifiedAuthGuard` — that is what populates the CLS `tenantId` /
 * `user` this guard reads. Registered before it, `resolveTenantId()` is always
 * empty, rule 2 fires for every request, and the guard silently degrades to a
 * no-op that still passes all of its own unit tests.
 *
 * Note that `ContextInterceptor`'s super-admin `x-tenant-id` elevation runs
 * AFTER all guards, so a super admin "acting as" a tenant is still seen here
 * with their own empty tenant and takes rule 2. That is correct: they arrive
 * on the SYSTEM-granted console origin, which rule 4's `allows()` admits
 * anyway.
 */
import { CanActivate, ExecutionContext, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { IOriginRegistry } from '@arcaai/applications';
import { isOriginEnforcementEnabled } from '../cors.config';

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
    // RULE 0 — origin
    // enforcement is now ON BY DEFAULT (`origin.enforcementEnabled` defaults
    // `true`), so this guard is LIVE unless an operator has turned the switch
    // off — or the process has not yet installed the resolver (the pre-boot
    // window; see `cors.config.ts`). While it IS off this guard is a
    // pass-through: it never 404s a tenant mismatch and never touches the
    // registry. The consequence of that state is:
    // "a request from any origin may act on any tenant it can authenticate to";
    // authentication and tenancy remain the enforcing controls, the ORIGIN
    // binding simply does not apply.
    //
    // `isOriginEnforcementEnabled()` is imported rather than re-resolved here:
    // it is the ONE source of truth shared with `cors.config.ts` and
    // `SttWsGateway`, so the three points can never disagree about whether the
    // switch is on (this ticket has already paid for a rule that lived
    // in two places).
    if (!isOriginEnforcementEnabled()) {
      return true;
    }

    // HTTP only. The WebSocket handshake is NOT covered here — browsers exempt
    // WS from CORS entirely, and `SttWsGateway` runs its own registry check
    // against the handshake `Origin`. Returning true for a WS
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

    // Rule 2 — nothing to bind against.
    if (tenantId === null) {
      return true;
    }

    // `has`/`allows` normalize the raw header themselves (case, default port)
    // and never throw on malformed input — a hostile `Origin` yields `false`,
    // not an unhandled 500. The raw header is passed through UNMODIFIED so
    // the registry's normalizer stays the single source of truth for origin
    // syntax; pre-processing it here would be a second, divergent parser.

    // DECISION — an origin that is present but NOT registered at all (empty
    // tenant set) passes through.
    //
    // Reaching this branch in production means either (a) the `development`
    // loopback allowance in `cors.config.ts`, which deliberately admits
    // origins that have no registry row so a fresh clone with an empty
    // database still works, (b) the CORS gate DENIED this origin (registry
    // miss, or the registry unavailable — the
    // `CORS_ALLOWED_ORIGINS` bootstrap fallback that used to admit it instead was removed)
    // but the request reached the gateway anyway — CORS is enforced by the
    // BROWSER refusing to hand the response to page script, not by the server
    // refusing to route the request, so a non-preflighted "simple" request
    // still runs even when the CORS callback answered `false` — or (c) a
    // non-browser client that forged an `Origin` header.
    //
    // Denying here would be actively harmful and buys nothing:
    //   - It would break the documented dev loopback path.
    //   - It closes nothing. An unregistered origin grants NO tenant, so
    //     there is no binding to violate. And a non-browser client that can
    //     forge an `Origin` can equally OMIT it and take rule 1 — denying
    //     would only inconvenience an attacker who chose the noisier of two
    //     equivalent paths, while breaking real callers.
    // Registration is enforced one layer up, at the CORS gate, which is the
    // layer that owns "which origins exist at all" — and which now
    // fails CLOSED rather than degrading to an env allow-list.
    //
    // It is logged at warn so a registry miss is diagnosable in one grep
    // (ship the registry-miss log line in the same release that
    // closes the catch-all).
    if (!this.registry.has(origin)) {
      this.logger.warn({
        message: 'Origin is not registered in the origin registry — passing through (no grant ⇒ no tenant binding to enforce)',
        origin,
        tenantId,
        path: this.readPath(context),
      });
      return true;
    }

    // Rule 4 — the origin is registered; `allows()` is the SINGLE place that
    // decides membership, including the SYSTEM-admits-every-tenant rule. This
    // guard does not re-derive it.
    if (this.registry.allows(origin, tenantId)) {
      return true;
    }

    this.logger.warn({
      message: 'Cross-tenant origin binding violation — rejecting with 404',
      origin,
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
   * string means "no tenant context": super admins authenticate without a
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
