/**
 * TASK-889 — the MEMBERSHIP-BOUNDED cross-tenant step.
 *
 * ## Why this exists, and why it is NOT `assertElevatedTenantlessContext`
 *
 * `tenant-scope.ts` pins every read and write on the extended Prisma client to the ONE tenant in
 * CLS: a `where` gets that tenant merged in, and a `data` carrying a DIFFERENT one throws
 * `TenantScope: tenantId mismatch`. Exactly one caller is exempt — a `SUPER_ADMIN` with NO tenant
 * pinned, which is the pass-through `AgentPromotionService` deliberately requires
 * (`assertElevatedTenantlessContext`). That is the PLATFORM-admin path and it must stay that
 * narrow: widening it to serve a customer admin would hand a customer the same unfiltered client
 * the platform uses.
 *
 * A multi-tenant customer admin needs something different and strictly smaller. Owner decision #4
 * (TASK-884/885) says: *an admin managing several tenants promotes/syncs among **their own**
 * tenants.* Their sync is not one unscoped operation over the estate; it is a SEQUENCE of
 * ordinary, fully-scoped operations — read tenant A, write tenant B, write tenant C — each of
 * which the caller is separately entitled to perform, and each of which must therefore SAY which
 * tenant it means instead of inheriting whichever tenant happened to be pinned when the request
 * arrived.
 *
 * That is all this helper does: it runs one step of such a sequence under one named tenant, so
 * the tenant-scope extension filters and asserts it exactly as it would an ordinary
 * single-tenant request. Nothing is bypassed and no privilege is granted — the AUTHORISATION
 * (`manage` in the source and in every target, resolved from `UserRoleAssignment` through
 * `PolicyEngine`) has already run at the call site, and this must never be reached with a tenant
 * that has not passed it.
 *
 * ## The mechanism
 *
 * `ClsService.run({ ifNested: 'inherit' })` COPIES the current store (so `user`, the correlation
 * id and everything else a service reads survive) and gives the step its own `tenantId`. The
 * parent context is untouched when the step returns — the same `cls.run` + `cls.set('tenantId')`
 * shape the internal controllers use to serve a peer service under the tenant it named
 * (`apps/api/src/modules/internal/agent-internal.controller.ts`).
 *
 * ## What it does NOT change
 *
 * The write itself. Both syncs commit through `CoreDatabaseService.baseClient.$transaction`, and
 * that stays: the copy has to read the SOURCE tenant's model row while standing in the TARGET's
 * context (`AgentService.resolveModelIdForTarget`), and version minting has to see soft-deleted
 * rows (`findMaxVersionNumber` is documented as deliberately unfiltered by `resourceStatus`).
 * Both are genuinely cross-tenant reads with an EXPLICIT tenant argument, which is what the
 * unscoped transaction client is for. What this helper fixes is everything else — every step
 * that goes through the SCOPED client and would otherwise silently inherit the caller's own
 * working tenant while claiming to act on another.
 */
import type { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '../../interfaces';

/**
 * Run one step of a cross-tenant sequence under `tenantId`.
 *
 * @param cls the request's CLS service — the store is INHERITED, not replaced
 * @param tenantId the tenant this step acts on; the caller must already have proven the actor
 *                 holds the required ability in it
 * @param work the step
 */
export function runInTenantContext<T>(cls: ClsService<IActiveUserContext>, tenantId: string, work: () => Promise<T>): Promise<T> {
  return cls.run({ ifNested: 'inherit' }, async () => {
    cls.set('tenantId', tenantId);
    return work();
  });
}
