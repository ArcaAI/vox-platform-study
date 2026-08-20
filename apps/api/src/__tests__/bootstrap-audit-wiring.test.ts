/**
 * TASK-761 T-8 — every boot audit is actually CALLED from `bootstrap()`.
 *
 * This is the one failure mode none of the per-audit suites can catch. Each of
 * those builds a synthetic app and calls its audit directly, so an audit that
 * is written, tested, exported — and never wired into `main.ts` — passes every
 * test it has while enforcing precisely nothing in production. The gate would
 * exist only in the repository, not in the running gateway.
 *
 * Reading `main.ts` as TEXT rather than importing it is deliberate: importing
 * it executes module-scope bootstrap wiring (Nest factory, secrets warm-up,
 * process handlers). The same file-as-text technique is used by
 * `controller-route-renames.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAIN_TS = readFileSync(resolve(__dirname, '../main.ts'), 'utf8');

/**
 * Comments are stripped before matching. Without this, commenting a call OUT
 * still leaves its text in the file and the assertion keeps passing — which is
 * exactly the "disabled gate" this test is supposed to catch, and the first
 * draft of it did not. (Verified by commenting out
 * `auditWebSocketGatewayOwnerBinding(app)` and watching the suite stay green.)
 */
const MAIN_TS_CODE = MAIN_TS.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * Every audit `bootstrap()` must invoke. Adding an audit to
 * `apps/api/src/bootstrap/` without adding it here is the drift this test
 * exists to catch — the list is hand-maintained on purpose, because a
 * directory scan would happily accept "no audits at all".
 */
const WIRED_AUDITS = [
  'auditAdminRoutePermissions',
  'auditApiKeyRequiredScopes',
  'auditInternalRoutesOffApiKeySurface',
  'auditAdminControllersDeclareNoApiKeyScopes',
  'auditAdminScopedControllers',
  'auditEveryApiKeyReachableRouteDeclaresScopes',
  'auditBusinessPlaneApiKeyExemptions',
  'auditConsentRouteCoverage',
  'auditServiceAccountSurface',
  'auditWebSocketGatewayOwnerBinding',
  'auditCaslEnforcePairReachability',
] as const;

describe('bootstrap audit wiring (TASK-761 T-8)', () => {
  // An import with no call site is a gate that never runs, so the CALL is what
  // is asserted here; the import is asserted separately below.
  it.each(WIRED_AUDITS)('%s is called in main.ts', (auditName) => {
    const called = MAIN_TS_CODE.includes(`${auditName}(app)`) || MAIN_TS_CODE.includes(`${auditName}()`);
    expect(called, `${auditName} is never called in main.ts`).toBe(true);
  });

  it('every audit name appears in an import statement', () => {
    const importedNames = new Set(
      [...MAIN_TS_CODE.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/bootstrap\/[^']*'/g)].flatMap((m) =>
        m[1]
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean),
      ),
    );
    for (const auditName of WIRED_AUDITS) {
      expect(importedNames.has(auditName), `${auditName} is not imported from ./bootstrap/*`).toBe(true);
    }
  });
});
