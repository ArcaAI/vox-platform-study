/**
 * TASK-307 W4a.3 — Side-effect module that applies `@Public()`
 * (`SKIP_AUTH_KEY=true`) metadata to third-party controllers we don't
 * own. Each entry maps a route on a vendored controller class that is
 * legitimately unauthenticated (Prometheus scrape, OIDC well-known,
 * etc.). The runtime `AuthorizationGuard` reads metadata via
 * `Reflector.getAllAndOverride([method, class])`, so applying the key
 * here is functionally identical to writing `@Public()` at the source
 * declaration.
 *
 * Why a side-effect module — `apps/api` cannot edit
 * `@willsoto/nestjs-prometheus` (vendored) and cannot modify
 * `packages/applications/src/services/baseServices/observability/
 * observability.module.ts` (out of W4a's scope: that path is owned by
 * other waves' rebases). Patching at module-load time keeps the
 * decoration co-located with `apps/api`'s policy without forking the
 * vendor or re-registering the upstream module.
 *
 * Importing this module from any code path that walks routes
 * (production `auditAdminRoutePermissions` + the
 * `auth-coverage.spec.ts` integration test) ensures the metadata is
 * present before the walk runs.
 */

import { PrometheusController } from '@willsoto/nestjs-prometheus';
import { SKIP_AUTH_KEY } from '@arcaai/applications';

// Prometheus `/metrics` — set as global prefix exclusion in `main.ts`
// (`app.setGlobalPrefix('api/v1', { exclude: ['/metrics'] })`) and
// scraped by Prometheus without auth. When TASK-307 W4b registers
// `UnifiedAuthGuard` as `APP_GUARD`, this metadata stays the gate
// from auth requirement, mirroring `@Public()` at the source.
Reflect.defineMetadata(SKIP_AUTH_KEY, true, PrometheusController.prototype.index);
