import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCAAI_TENANT_ADMIN_SVC_SCOPES,
  BOOTSTRAP_SERVICE_ACCOUNT_ENV_VAR,
  BOOTSTRAP_SERVICE_ACCOUNT_SECRET_MIN_LENGTH,
  SEEDED_SERVICE_ACCOUNTS,
  computeSecretVerifier,
  credentialsRefFor,
  resolveBootstrapServiceAccountSecret,
  shouldSeedServiceAccountSecrets,
} from '../94-service-account';
import { DEFAULT_POLICIES } from '../01-policy';
import { DEFAULT_ROLES } from '../03-role';
import { SEED_CUSTOMER_TENANT_IDS, SEED_SERVICE_ACCOUNT_DEV_SECRETS, SYSTEM_TENANT_ID, SEED_TENANT_ID } from '../00-constants';

/**
 * the ArcaAI machine identity.
 *
 * The load-bearing assertion here is the SCOPE DERIVATION. A service account's
 * authority IS its scope set (`serviceAccountPolicyRules` builds its CASL
 * ability from the scopes alone — no user, no role, no database read), so a
 * hand-written list is a privilege decision with nothing checking it. The rule
 * this seed applies is:
 *
 *   include `svc:admin:<area>` iff EVERY ability it implies is one the seeded
 *   TENANT_ADMIN role already holds.
 *
 * `SVC_SCOPE_IMPLICATIONS` below mirrors the `implies` of the `admin:*` scopes
 * in `packages/applications/src/services/apiKey/apikey-scopes.registry.ts`
 * (which `service-account-scopes.registry.ts` renamespaces verbatim to
 * `svc:admin:*`). It is mirrored rather than imported because
 * `packages/database` sits BELOW `packages/applications` in the dependency
 * graph — the same reason `reader-plane-mintability.test.ts` mirrors its own
 * scope table.
 */

/** `svc:admin:<area>` → the CASL pairs it implies, mirroring `API_KEY_SCOPE_REGISTRY`. */
const SVC_SCOPE_IMPLICATIONS: Readonly<Record<string, ReadonlyArray<readonly [action: string, subject: string]>>> = {
  // standalone-feature scopes — all three renamespace an API-key scope
  // whose `implies` is `create:Consultation`.
  'svc:stt:transcription:write': [['create', 'Consultation']],
  'svc:stt:stream:write': [['create', 'Consultation']],
  'svc:consultation:report:write': [['create', 'Consultation']],
  'svc:admin:user:read': [['read', 'User']],
  // TASK-873 — `manage:UserRoleAssignment` was added to `admin:user:write`'s
  // `implies` so `POST admin/users/:id/roles` (which declares this scope and
  // demands that subject) stops 403-ing a machine identity holding exactly it.
  // TENANT_ADMIN holds `manage:UserRoleAssignment` (`rbac-tenant-manage`), so
  // the derivation rule below still admits the scope.
  'svc:admin:user:write': [
    ['manage', 'User'],
    ['manage', 'UserRoleAssignment'],
  ],
  'svc:admin:apikey:read': [['read', 'ApiKey']],
  'svc:admin:apikey:write': [['manage', 'ApiKey']],
  'svc:admin:role:read': [['read', 'Role']],
  'svc:admin:tenant:read': [['read', 'Tenant']],
  'svc:admin:audit:read': [['read', 'AuditLog']],
  'svc:admin:department:manage': [['manage', 'Department']],
  'svc:admin:agent-promotion:manage': [['manage', 'WorkflowDefinition']],
  // TASK-873 — `POST admin/prompt-templates/assign-department` writes a
  // Department's prompt config, so its route was NARROWED from
  // `manage:Department` to `update:Department` and this scope carries that one
  // pair (never `manage:Department` — a prompt-template credential does not
  // administer departments). TENANT_ADMIN holds `manage:Department`, which
  // subsumes it.
  'svc:admin:prompt-template:manage': [
    ['manage', 'PromptTemplate'],
    ['update', 'Department'],
  ],
  'svc:admin:consultation-context-schema:manage': [['manage', 'ConsultationContextSchema']],
  'svc:admin:document-template:manage': [['manage', 'DocumentTemplate']],
  'svc:admin:dna-writing-style:manage': [['manage', 'DnaWritingStyleReport']],
  'svc:admin:knowledge:manage': [['manage', 'KnowledgeDocument']],
  'svc:admin:consultation-admin:manage': [['manage', 'Consultation']],
  'svc:admin:harness:manage': [
    ['manage', 'HarnessPolicy'],
    ['manage', 'HarnessEval'],
    ['manage', 'HarnessWorkflow'],
    ['read', 'HarnessAudit'],
  ],
  'svc:admin:agentic:manage': [['manage', 'HarnessPolicy']],
  'svc:admin:agent-trajectory:read': [['read', 'AgentTrajectory']],
  'svc:admin:audio-pipeline:manage': [['manage', 'AsrPipeline']],
  'svc:admin:transcription-job:read': [['read', 'AsrPipeline']],
  'svc:admin:tenant-stt-config:manage': [['manage', 'TenantSttConfig']],
  'svc:admin:ai-provider:manage': [['manage', 'GlobalSetting']],
  'svc:admin:settings:manage': [['manage', 'GlobalSetting']],
  'svc:admin:nlp-task-instructions:manage': [['manage', 'TenantNlpTaskInstructions']],
  'svc:admin:allowed-origin:manage': [['manage', 'TenantAllowedOrigin']],
  'svc:admin:tenant-frontend-config:manage': [['update', 'Tenant']],
  'svc:admin:tenant-idp-config:manage': [['manage', 'TenantIdentityProvider']],
  'svc:admin:mcp-server:manage': [['manage', 'McpServer']],
  'svc:admin:notification:manage': [['manage', 'Notification']],
  'svc:admin:resource-subscription:manage': [['manage', 'ResourceSubscription']],
  'svc:admin:service-release:manage': [['read', 'TenantTelemetry']],
  // TASK-873 — `WorkflowSandboxRunController` hangs off the definition
  // (`admin/workflow-definitions/:id/sandbox-runs/*`) and declares this scope
  // while demanding `WorkflowRun`. Only the three actions those four routes use
  // are granted — not `manage:WorkflowRun`, which would silently confer delete.
  // TENANT_ADMIN holds `manage:WorkflowRun` (`tenant-full-access`).
  'svc:admin:workflow-definition:manage': [
    ['manage', 'WorkflowDefinition'],
    ['create', 'WorkflowRun'],
    ['read', 'WorkflowRun'],
    ['update', 'WorkflowRun'],
  ],
  'svc:admin:workflow-node:read': [['read', 'WorkflowDefinition']],
  'svc:admin:workflow-run:read': [['read', 'WorkflowRun']],
  'svc:admin:workflow-test-fixture:manage': [['manage', 'WorkflowTestFixture']],
  // TASK-930 (INTERFACES §3) — the invocation plane, renamespaced from the API-key scopes whose
  // `implies` are pinned in `apikey-scopes.registry.ts`.
  'svc:agent:definition:read': [['list', 'Agent']],
  'svc:agent:invocation:write': [['read', 'Agent']],
  'svc:workflow:definition:read': [['list', 'WorkflowDefinition']],
  'svc:workflow:run:read': [['read', 'WorkflowRun']],
  'svc:workflow:run:write': [
    ['create', 'WorkflowRun'],
    ['update', 'WorkflowRun'],
  ],
  // TASK-933 §3.1 — the realtime CONSULTATION plane, renamespaced from the API-key scopes whose
  // `implies` are pinned in `apikey-scopes.registry.ts` (`CONSULTATION_REALTIME_SCOPE_SOURCES`).
  // Every one implies an ability TENANT_ADMIN already holds, so the derivation rule admits them:
  // `manage:Consultation` subsumes create/read, `manage:ConsultationContextSchema` subsumes the
  // schema read, and `execute:ConsultationWorkflow` is granted outright by `tenant-full-access`.
  'svc:consultation:session:write': [['create', 'Consultation']],
  'svc:consultation:session:read': [['read', 'Consultation']],
  'svc:consultation:report:read': [['read', 'Consultation']],
  'svc:tenant:context-schema:read': [['read', 'ConsultationContextSchema']],
  'svc:workflows:execute': [
    ['execute', 'ConsultationWorkflow'],
    ['create', 'WorkflowRun'],
  ],
};

/**
 * The `admin:*` areas that FAIL the derivation rule — kept explicit so the test
 * proves the rule EXCLUDES things, not merely that the included list is
 * self-consistent. Each implies at least one ability a tenant admin does not
 * hold (several imply `manage:all` or `manage:Tenant`).
 */
const PLATFORM_ONLY_SVC_SCOPES: Readonly<Record<string, ReadonlyArray<readonly [action: string, subject: string]>>> = {
  'svc:admin:tenant:write': [['manage', 'Tenant']],
  // TASK-873 — the two role↔policy routes demand `manage:RolePolicy`; the scope
  // is described as "manage roles AND POLICIES" and now says so. Still excluded:
  // `manage:Role` alone exceeds a tenant admin (Role/Policy are GLOBAL tables).
  'svc:admin:role:write': [
    ['manage', 'Role'],
    ['manage', 'RolePolicy'],
  ],
  'svc:admin:rbac-policy:write': [['manage', 'Policy']],
  'svc:admin:rate-limit:manage': [['manage', 'all']],
  'svc:admin:usage:manage': [['manage', 'UsageAnalytics']],
  'svc:admin:ai-model:manage': [['manage', 'all']],
  'svc:admin:ai-runtime-profile:manage': [['manage', 'all']],
  'svc:admin:ai-service:manage': [['manage', 'all']],
  'svc:admin:entitlement:manage': [['manage', 'all']],
  'svc:admin:queue:manage': [['manage', 'all']],
  'svc:admin:scheduler:manage': [['manage', 'all']],
  'svc:admin:platform-metrics:read': [['manage', 'PlatformMetrics']],
  'svc:admin:pstudio:manage': [['manage', 'PrismaStudio']],
  'svc:admin:changelog:manage': [['manage', 'ChangelogEntry']],
  // TASK-873 — the three key routes demand `read/create/delete:Storage`; no
  // route declaring this scope updates a Storage row, so `update` is withheld.
  // Still excluded: the pre-existing `manage:Tenant` exceeds a tenant admin.
  'svc:admin:storage-key:manage': [
    ['manage', 'Tenant'],
    ['read', 'Storage'],
    ['create', 'Storage'],
    ['delete', 'Storage'],
  ],
  // TASK-873 — the 17 bucket/config routes demand the full `Storage` CRUD, so
  // `manage:Storage` is exactly the reachable set. `manage:Tenant` stays: it is
  // load-bearing for `POST .../buckets/provision/:tenantId`, and it is also why
  // this scope remains excluded from the seeded set.
  'svc:admin:tenant-storage:manage': [
    ['manage', 'Tenant'],
    ['manage', 'Storage'],
  ],
  'svc:admin:billing:manage': [
    ['manage', 'BillingInvoice'],
    ['manage', 'AiPriceBook'],
  ],
};

function abilitiesFor(roleName: string): Set<string> {
  const byName = new Map(DEFAULT_POLICIES.map((policy) => [policy.name, policy]));
  const role = DEFAULT_ROLES.find((r) => r.name === roleName);
  if (!role) throw new Error(`No seeded role named ${roleName}`);
  const policyNames = [...role.policies];
  let current: (typeof DEFAULT_ROLES)[number] | undefined = role;
  while (current?.parentRoleId) {
    const parent: (typeof DEFAULT_ROLES)[number] | undefined = DEFAULT_ROLES.find((r) => r.id === current!.parentRoleId);
    if (!parent) break;
    policyNames.push(...parent.policies);
    current = parent;
  }
  const abilities = new Set<string>();
  for (const name of policyNames) {
    const policy = byName.get(name);
    if (!policy) throw new Error(`Role references a policy that is not seeded: ${name}`);
    for (const rule of policy.rules) {
      for (const action of Array.isArray(rule.action) ? rule.action : [rule.action]) abilities.add(`${action}:${rule.subject}`);
    }
  }
  return abilities;
}

const can = (abilities: Set<string>, action: string, subject: string): boolean =>
  abilities.has('manage:all') || abilities.has(`manage:${subject}`) || abilities.has(`${action}:all`) || abilities.has(`${action}:${subject}`);

describe('the seeded scope set never exceeds the tenant admin it automates', () => {
  const tenantAdmin = abilitiesFor('TENANT_ADMIN');

  it.each([...ARCAAI_TENANT_ADMIN_SVC_SCOPES])('%s implies only abilities TENANT_ADMIN already holds', (scope) => {
    const implied = SVC_SCOPE_IMPLICATIONS[scope];
    expect(implied, `${scope} has no recorded implication — add it to SVC_SCOPE_IMPLICATIONS from the registry`).toBeDefined();
    for (const [action, subject] of implied!) {
      expect(can(tenantAdmin, action, subject), `${scope} would grant ${action}:${subject}, which a tenant admin does not hold`).toBe(true);
    }
  });

  it.each(Object.keys(PLATFORM_ONLY_SVC_SCOPES))('%s is EXCLUDED — it exceeds the tenant admin', (scope) => {
    const implied = PLATFORM_ONLY_SVC_SCOPES[scope]!;
    const exceeds = implied.some(([action, subject]) => !can(tenantAdmin, action, subject));
    expect(exceeds, `${scope} no longer exceeds the tenant admin — it should now be SEEDED, not excluded`).toBe(true);
    expect(ARCAAI_TENANT_ADMIN_SVC_SCOPES as readonly string[]).not.toContain(scope);
  });

  it('the seeded set is exactly the derivation, with nothing omitted', () => {
    // The other direction: a scope that PASSES the rule but is missing from the
    // seed would silently under-provision the account.
    const eligible = Object.keys(SVC_SCOPE_IMPLICATIONS).sort();
    expect([...ARCAAI_TENANT_ADMIN_SVC_SCOPES].sort()).toEqual(eligible);
  });
});

describe('namespace and wildcard discipline', () => {
  it('every seeded scope lives in the svc: namespace', () => {
    // `ServiceAccountEntity.validate()` refuses a foreign scope outright; this
    // catches it before a database round trip.
    for (const scope of ARCAAI_TENANT_ADMIN_SVC_SCOPES) expect(scope.startsWith('svc:')).toBe(true);
  });

  it('carries no admin:* or bare * scope', () => {
    for (const scope of ARCAAI_TENANT_ADMIN_SVC_SCOPES) {
      expect(scope.startsWith('admin:')).toBe(false);
      expect(scope).not.toBe('*');
    }
  });

  it('uses NO wildcard — a tenant-bound credential must not expand into the platform plane', () => {
    // `hasServiceAccountScope` matches `svc:*` against ANY `svc:` requirement,
    // and `svc:admin:*` expands to every renamespaced admin scope including the
    // `manage:all` ones. Either would silently defeat the derivation above.
    for (const scope of ARCAAI_TENANT_ADMIN_SVC_SCOPES) expect(scope.endsWith(':*')).toBe(false);
  });

  it('declares at least one scope — the entity refuses an authority-less account', () => {
    for (const account of SEEDED_SERVICE_ACCOUNTS) expect(account.scopes.length).toBeGreaterThan(0);
  });
});

describe('tenant binding', () => {
  it('is bound to the ArcaAI CUSTOMER tenant', () => {
    expect(SEEDED_SERVICE_ACCOUNTS.map((a) => a.tenantId)).toEqual([SEED_CUSTOMER_TENANT_IDS.ARCAAI]);
  });

  it.each([
    ['SYSTEM (a config TIER)', SYSTEM_TENANT_ID],
    ['"Global" (a customer tenant used as a platform playground)', SEED_TENANT_ID],
  ])('is never bound to %s', (_label, reservedTenantId) => {
    // `ServiceAccountService.resolveIssuanceTenant` refuses `50000000-…`
    // outright; SYSTEM would make this a PLATFORM account with cross-tenant
    // reach. Neither is what a tenant's automation identity is.
    for (const account of SEEDED_SERVICE_ACCOUNTS) expect(account.tenantId).not.toBe(reservedTenantId);
  });

  it('carries no superAdmin flag and no allowedTenantIds', () => {
    const src = readFileSync(join(__dirname, '../94-service-account.ts'), 'utf8');
    expect(src).toContain('superAdmin: false');
    // `allowedTenantIds` is the PLATFORM-account working-tenant allow-list;
    // `ServiceAccountEntity.validate()` rejects it on a tenant-bound row. The
    // column is left unset (SQL NULL) rather than written as an empty array.
    expect(src).not.toMatch(/^\s*allowedTenantIds:/m);
    expect(src).not.toMatch(/^\s*allowedIps:/m);
  });
});

describe('credential posture — no recoverable secret on a production path', () => {
  it('only seeds a usable secret in development and test', () => {
    expect(shouldSeedServiceAccountSecrets('development')).toBe(true);
    expect(shouldSeedServiceAccountSecrets('test')).toBe(true);
    expect(shouldSeedServiceAccountSecrets('production')).toBe(false);
  });

  it('marks the dev fixture secret as a test value', () => {
    // Same convention as `SEED_API_KEY_RAW`: `_test_` in the literal keeps the
    // intent legible to a human and to a secret scanner.
    for (const secret of Object.values(SEED_SERVICE_ACCOUNT_DEV_SECRETS)) expect(secret).toContain('_test_');
  });

  it('computes the verifier the way ServiceAccountService does — HMAC always, never plain SHA-256', () => {
    // `hashApiKey` (02-apikey) falls back to plain SHA-256 with no pepper
    // because `ApiKeyService.hashKey` does. `computeSecretVerifier` never does:
    // it HMACs with the literal 'hope-service-account'. Copying the API-key
    // shape here would seed a verifier the gateway can never reproduce.
    const unpeppered = computeSecretVerifier('secret-value');
    const peppered = computeSecretVerifier('secret-value', 'a-pepper');
    expect(unpeppered).toMatch(/^[0-9a-f]{64}$/);
    expect(peppered).toMatch(/^[0-9a-f]{64}$/);
    expect(unpeppered).not.toBe(peppered);
    // Deterministic for a given (secret, pepper) — that is what makes a
    // re-seeded dev fixture keep authenticating.
    expect(computeSecretVerifier('secret-value', 'a-pepper')).toBe(peppered);
  });

  it('the non-dev, non-bootstrap path writes a verifier with NO generated preimage', () => {
    const src = readFileSync(join(__dirname, '../94-service-account.ts'), 'utf8');
    // The inert branch must generate the VERIFIER directly. Generating a secret
    // and hashing it would create a plaintext credential in process memory (and
    // in any log line someone later adds) for no benefit.
    expect(src).toContain("randomBytes(32).toString('hex')");
    // Precedence order: bootstrap env secret, then dev/test fixture, then inert.
    expect(src).toMatch(/if \(bootstrapSecret\)\s*\{\s*secretVerifier = computeSecretVerifier\(bootstrapSecret, pepper\);/);
    expect(src).toMatch(/else if \(devFixture\)\s*\{\s*secretVerifier = computeSecretVerifier\(account\.devSecret, pepper\);/);
  });

  it('records a Vault path, matching ServiceAccountService.credentialsRefFor', () => {
    expect(credentialsRefFor('hope_svc_abc')).toBe('service-accounts/hope_svc_abc/current');
    for (const account of SEEDED_SERVICE_ACCOUNTS) {
      expect(credentialsRefFor(account.clientId)).toBe(`service-accounts/${account.clientId}/current`);
    }
  });

  it('a re-seed never rewrites the credential, so a rotated secret survives', () => {
    const src = readFileSync(join(__dirname, '../94-service-account.ts'), 'utf8');

    // An upsert would rewrite `secretVerifier` on every run, invalidating the
    // secret the operator obtained through `rotate`.
    expect(src).not.toContain('serviceAccount.upsert');

    // The existing-account branch reconciles AUTHORITY (scopes) but must never
    // touch the CREDENTIAL. Assert the invariant rather than a log string: the
    // update payload carries `scopes` and nothing secret-bearing.
    const update = /serviceAccount\.update\(\{[\s\S]*?\}\)/.exec(src);
    expect(update, 'the reconcile branch must use serviceAccount.update').not.toBeNull();
    expect(update![0]).toContain('scopes');
    for (const secretField of ['secretVerifier', 'clientSecret', 'credentialsRef', 'secretPreview']) {
      expect(update![0], `a re-seed must never write ${secretField}`).not.toContain(secretField);
    }
  });

  it('reconciles scopes on an existing account, so authority converges on re-seed', () => {
    const src = readFileSync(join(__dirname, '../94-service-account.ts'), 'utf8');
    // Without this, an environment provisioned before a scope was added stays
    // stuck on the set the account was created with — which is exactly how the
    // seeded account missed the standalone-feature scopes.
    expect(src).toContain('reconciled scopes');
  });
});

describe('OD-2 revisited (2026-08-20 owner ruling) — day-1 bootstrap secret for CI/automation', () => {
  const V = BOOTSTRAP_SERVICE_ACCOUNT_ENV_VAR;
  const GOOD_SECRET = 'a-high-entropy-day-one-automation-secret-value';

  it('is a no-op when the variable is unset — the seed must not invent a credential', () => {
    expect(resolveBootstrapServiceAccountSecret({})).toBeUndefined();
  });

  it('is a no-op for an empty string, the same as unset', () => {
    expect(resolveBootstrapServiceAccountSecret({ [V]: '' })).toBeUndefined();
  });

  it('returns the operator-supplied secret verbatim when it clears the bar', () => {
    expect(resolveBootstrapServiceAccountSecret({ [V]: GOOD_SECRET })).toBe(GOOD_SECRET);
  });

  it('refuses a well-known value, case-insensitively — same stop-list as the human bootstrap credentials', () => {
    expect(() => resolveBootstrapServiceAccountSecret({ [V]: 'password123' })).toThrow(/well-known value/);
    expect(() => resolveBootstrapServiceAccountSecret({ [V]: 'ChangeMe' })).toThrow(/well-known value/);
  });

  it(`refuses a secret shorter than ${BOOTSTRAP_SERVICE_ACCOUNT_SECRET_MIN_LENGTH} characters`, () => {
    const short = 'x'.repeat(BOOTSTRAP_SERVICE_ACCOUNT_SECRET_MIN_LENGTH - 1);
    expect(() => resolveBootstrapServiceAccountSecret({ [V]: short })).toThrow(new RegExp(`at least ${BOOTSTRAP_SERVICE_ACCOUNT_SECRET_MIN_LENGTH}`));
  });

  it('accepts a secret exactly at the floor length', () => {
    const exact = 'y'.repeat(BOOTSTRAP_SERVICE_ACCOUNT_SECRET_MIN_LENGTH);
    expect(resolveBootstrapServiceAccountSecret({ [V]: exact })).toBe(exact);
  });

  it('never appears as a literal anywhere in the tracked seed source', () => {
    const src = readFileSync(join(__dirname, '../94-service-account.ts'), 'utf8');
    expect(src).not.toContain(GOOD_SECRET);
    // The mechanism reads from process.env, never a hardcoded fallback.
    expect(src).toMatch(/env\[BOOTSTRAP_SERVICE_ACCOUNT_ENV_VAR\]/);
  });

  it('resolves via the SAME peppered HMAC construction the dev/test fixture and the runtime both use — non-recoverable, never plaintext', () => {
    const verifier = computeSecretVerifier(GOOD_SECRET, 'a-pepper');
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(verifier).not.toContain(GOOD_SECRET);
    // One-way: nothing in this codebase can turn a verifier back into a secret.
    expect(verifier.length).toBeLessThan(GOOD_SECRET.length * 2);
  });

  it('takes precedence over the dev/test fixture in source, so setting it in dev/test still uses the operator value', () => {
    const src = readFileSync(join(__dirname, '../94-service-account.ts'), 'utf8');
    const ifIndex = src.indexOf('if (bootstrapSecret) {\n      secretVerifier');
    const elseIfIndex = src.indexOf('else if (devFixture) {\n      secretVerifier');
    expect(ifIndex).toBeGreaterThan(-1);
    expect(elseIfIndex).toBeGreaterThan(-1);
    expect(ifIndex).toBeLessThan(elseIfIndex);
  });

  it('is resolved in EVERY environment, not gated to dev/test like shouldSeedServiceAccountSecrets', () => {
    const src = readFileSync(join(__dirname, '../94-service-account.ts'), 'utf8');
    // `resolveBootstrapServiceAccountSecret()` is called unconditionally — no
    // `shouldSeedServiceAccountSecrets`/env guard wraps it, unlike the dev fixture.
    expect(src).toMatch(/const bootstrapSecret = resolveBootstrapServiceAccountSecret\(\);/);
  });
});

describe('client identity', () => {
  it('uses the runtime hope_svc_ shape so nothing has to special-case a seeded account', () => {
    for (const account of SEEDED_SERVICE_ACCOUNTS) expect(account.clientId).toMatch(/^hope_svc_[0-9a-f]{24}$/);
  });

  it('bounds the token TTL to the platform ceiling (3600s)', () => {
    for (const account of SEEDED_SERVICE_ACCOUNTS) {
      expect(account.tokenTtlSeconds).toBeGreaterThan(0);
      expect(account.tokenTtlSeconds).toBeLessThanOrEqual(3600);
    }
  });
});
