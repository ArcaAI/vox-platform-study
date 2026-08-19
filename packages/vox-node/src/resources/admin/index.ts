/**
 * Barrel for `@arcaai/vox-node`'s `/api/v1/admin/**` surface (TASK-773).
 *
 * Today it carries only the hand-authored {@link AdminResource} base — the
 * part that holds judgment (pagination, `If-Match` plumbing, scope-aware error
 * mapping). The per-area resources that build on it are GENERATED from the
 * cross-checked Nest + OpenAPI route manifest (ticket §3.2, Phase D3) and will
 * be re-exported from here; keep the generated exports below the hand-authored
 * ones so a drift-gate diff stays readable.
 *
 * Three admin areas are deliberately ABSENT from this surface and will stay
 * absent — `admin/service-accounts` (a machine must not mint another machine),
 * `AdminImpersonationController` (a machine assuming a human identity defeats
 * the audit attribution service accounts exist to provide), and
 * `ConsentGrantController` (consent is an act of a person). All three carry
 * `@ForbidServiceAccount()` on the gateway, so a generated method would always
 * 403 — and a method that always 403s is worse than no method. See ticket
 * §2.6 / D-3; re-opening any of them is an owner decision, not a code-review
 * call.
 *
 * NOTE: this barrel is not yet wired into `src/resources/index.ts` or
 * `HopeClient` — that lands with the generated surface.
 */

export type {
  AdminListOptions,
  AdminListQuery,
  AdminPreconditionedRequestSpec,
  AdminRequestOptions,
  AdminRequestSpec,
  IfMatchPrecondition,
  PaginatedPage,
} from './admin-resource';
export { AdminResource, DEFAULT_ADMIN_PAGE_SIZE, toIfMatchHeader } from './admin-resource';
