import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPrismaAbility } from '@casl/prisma';
import { describe, expect, it } from 'vitest';
import { isValidServiceAccountScope, resolveServiceAccountImpliedPermissions, serviceAccountPolicyRules } from '../service-account-scopes.registry';

/**
 * TASK-873 — every `svc:*` scope a route DECLARES must carry the abilities that
 * same route DEMANDS.
 *
 * ─── The defect class this exists to make impossible ────────────────────────
 *
 * A service account's authority IS its scope set: `serviceAccountPolicyRules`
 * builds its CASL ability from the scopes' `implies` alone — no user, no role,
 * no database read (`unified-auth.guard.ts`, `enforceServiceAccountAbilities`).
 * So a route is reachable by a machine identity only if BOTH gates agree:
 *
 *   1. `enforceServiceAccountScopes` — pure string matching over
 *      `@RequiredSvcScopes(...)`, `required.some(...)`;
 *   2. `enforceServiceAccountAbilities` — CASL over the scopes' `implies`,
 *      against the route's `@Authorize`/`@CanXxx` declaration.
 *
 * When (1) passes and (2) does not, the credential is 403'd while holding
 * exactly the scope the route advertises — the worst failure in this system to
 * debug, because every artifact (the decorator, the manifest, the OpenAPI
 * description, the SDK) says the call should have worked. Before TASK-873 that
 * was true of 31 route×scope pairs across 9 admin controllers.
 *
 * ─── Why it could not be caught before ──────────────────────────────────────
 *
 * The `svc:admin:*` vocabulary is DERIVED: `buildRegistry()` renamespaces every
 * `admin:<area>` entry of `API_KEY_SCOPE_REGISTRY`, carrying its `implies`
 * verbatim. On the API-key plane those `implies` are only a CEILING intersected
 * with the linked human's abilities, so an under-specified entry is invisible
 * there — the human's own grants decide. The identical row is the WHOLE grant on
 * the machine plane. Boot-audit assertion A5 already refuses a scope resolving
 * to ZERO abilities; nothing asked whether the abilities it does resolve are the
 * ones its routes require. This test is that question.
 *
 * ─── Why the check is per (route, scope) and not per union ──────────────────
 *
 * `enforceServiceAccountScopes` accepts a caller holding ANY ONE of a route's
 * declared scopes, so each declared scope is independently sufficient to reach
 * it — and must therefore independently carry the route's abilities. Checking
 * the UNION of a route's declared scopes hides exactly the case where one half
 * of a declared pair is short: `WebhookController.fetchDeliveries` declares
 * `svc:webhook:event:read` AND `svc:webhook:event:write` and needs
 * `read:WebhookRunHistory`; the `:read` half carries it, the `:write` half did
 * not, and a `:write`-only token was 403'd.
 *
 * ─── Why it reads the manifest rather than booting Nest ─────────────────────
 *
 * `apps/api/route-manifest.json` is the authorization ORACLE the whole e2e
 * conformance layer already runs on (`05-nestjs-api.md` §API Test Standard), it
 * is committed and drift-gated by `pnpm api:route-manifest`, and reading it
 * keeps this test in the package that OWNS the registry — where the fix lands.
 * The alternative (a Nest boot in `apps/api`) would put the guard a layer away
 * from the thing it guards and could not run in this package at all.
 */

const MANIFEST_PATH = fileURLToPath(new URL('../../../../../../apps/api/route-manifest.json', import.meta.url));

type RequiredPermissionTuple = [action: string, subject: string];

interface ManifestRoute {
  controller: string;
  handler: string;
  method: string;
  path: string;
  svcScopes: string[] | null;
  forbidServiceAccount: boolean;
  requiredPermissions: RequiredPermissionTuple[] | null;
  isPublic: boolean;
  permissionMode: 'AND' | 'OR';
}

function loadRoutes(): ManifestRoute[] {
  let raw: string;
  try {
    raw = readFileSync(MANIFEST_PATH, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read the route manifest at ${MANIFEST_PATH}. It is a committed artifact — regenerate it with \`pnpm api:route-manifest\`. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return (JSON.parse(raw) as { routes: ManifestRoute[] }).routes;
}

/**
 * The pairs (route, one of its declared scopes) that must hold. A route is
 * excluded when no machine identity can reach it in the first place —
 * `@Public()` short-circuits the guard before the machine path,
 * `@ForbidServiceAccount()` closes it outright, and a route with no
 * `requiredPermissions` has no ability gate to fail.
 */
function machineReachablePairs(): Array<{ route: ManifestRoute; scope: string }> {
  const pairs: Array<{ route: ManifestRoute; scope: string }> = [];
  for (const route of loadRoutes()) {
    if (route.isPublic || route.forbidServiceAccount) continue;
    if (!route.svcScopes || route.svcScopes.length === 0) continue;
    if (!route.requiredPermissions || route.requiredPermissions.length === 0) continue;
    for (const scope of route.svcScopes) pairs.push({ route, scope });
  }
  return pairs;
}

/**
 * `evaluatePermissions`' two lines, over an ability built the way the guard
 * builds it (`policyEngine.buildAbilityFromRules` IS `createPrismaAbility`).
 * Using real CASL rather than a hand-rolled matcher is deliberate: `manage`
 * covering every action and `all` covering every subject are CASL's semantics,
 * and a local re-implementation of them would be the next thing to drift.
 */
function abilitySatisfies(scope: string, route: ManifestRoute): { allowed: boolean; missing: string[] } {
  const ability = createPrismaAbility(serviceAccountPolicyRules([scope]) as never);
  const required = route.requiredPermissions ?? [];
  const results = required.map(([action, subject]) => ({ pair: `${action}:${subject}`, allowed: ability.can(action, subject) }));
  const allowed = route.permissionMode === 'OR' ? results.some((r) => r.allowed) : results.every((r) => r.allowed);
  return { allowed, missing: results.filter((r) => !r.allowed).map((r) => r.pair) };
}

const PAIRS = machineReachablePairs();

describe('every declared svc:* scope satisfies its own routes (TASK-873)', () => {
  it('the manifest actually carries service-account declarations to check', () => {
    // A regenerated-but-empty manifest, or a shape change, would otherwise make
    // this whole file pass by iterating nothing.
    expect(PAIRS.length).toBeGreaterThan(100);
  });

  it.each(PAIRS.map(({ route, scope }) => [`${route.controller}.${route.handler} ${route.method} ${route.path}`, scope, route] as const))(
    '%s is reachable holding only %s',
    (_label, scope, route) => {
      expect(isValidServiceAccountScope(scope), `${scope} is not in SERVICE_ACCOUNT_SCOPE_REGISTRY — hasServiceAccountScope would still match the string`).toBe(
        true,
      );

      const { allowed, missing } = abilitySatisfies(scope, route);
      expect(
        allowed,
        `${route.controller}.${route.handler} (${route.method} ${route.path}) declares '${scope}', so a service account holding ONLY that scope ` +
          `passes enforceServiceAccountScopes — and is then refused by enforceServiceAccountAbilities for ${missing.join(', ')}. ` +
          `The route requires [${(route.requiredPermissions ?? []).map((p) => p.join(':')).join(', ')}] (mode ${route.permissionMode}) while the scope ` +
          `implies [${resolveServiceAccountImpliedPermissions(scope)
            .map((p) => `${p.action}:${p.subject}`)
            .join(', ')}]. ` +
          `Fix it in the API-key registry entry this scope is renamespaced from (widen its \`implies\`), or narrow the route to the ` +
          `action+subject it actually touches — never by adding 'manage:all' to a scope, which is the CASL wildcard.`,
      ).toBe(true);
    },
  );
});
