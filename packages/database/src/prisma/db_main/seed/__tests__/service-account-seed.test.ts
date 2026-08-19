import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCAAI_TENANT_ADMIN_SVC_SCOPES,
  SEEDED_SERVICE_ACCOUNTS,
  computeSecretVerifier,
  credentialsRefFor,
  shouldSeedServiceAccountSecrets,
} from '../94-service-account';
import { DEFAULT_POLICIES } from '../01-policy';
import { DEFAULT_ROLES } from '../03-role';
import { SEED_CUSTOMER_TENANT_IDS, SEED_SERVICE_ACCOUNT_DEV_SECRETS, SYSTEM_TENANT_ID, SEED_TENANT_ID } from '../00-constants';

/**
 * TASK-766 — the ArcaAI machine identity.
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
  'svc:admin:user:read': [['read', 'User']],
  'svc:admin:user:write': [['manage', 'User']],
  'svc:admin:apikey:read': [['read', 'ApiKey']],
  'svc:admin:apikey:write': [['manage', 'ApiKey']],
  'svc:admin:role:read': [['read', 'Role']],
  'svc:admin:tenant:read': [['read', 'Tenant']],
  'svc:admin:audit:read': [['read', 'AuditLog']],
  'svc:admin:department:manage': [['manage', 'Department']],
  'svc:admin:agent-promotion:manage': [['manage', 'DepartmentAgent']],
  'svc:admin:prompt-template:manage': [['manage', 'PromptTemplate']],
  'svc:admin:consultation-context-schema:manage': [['manage', 'ConsultationContextSchema']],
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
  'svc:admin:tenant-tts-config:manage': [['manage', 'TenantTtsConfig']],
  'svc:admin:ai-task-default:manage': [['manage', 'AiTaskDefault']],
  'svc:admin:ai-provider:manage': [['manage', 'GlobalSetting']],
  'svc:admin:settings:manage': [['manage', 'GlobalSetting']],
  'svc:admin:nlp-task-instructions:manage': [['manage', 'TenantNlpTaskInstructions']],
  'svc:admin:pipeline-policy:manage': [['manage', 'PipelinePolicy']],
  'svc:admin:allowed-origin:manage': [['manage', 'TenantAllowedOrigin']],
  'svc:admin:tenant-frontend-config:manage': [['update', 'Tenant']],
  'svc:admin:tenant-idp-config:manage': [['manage', 'TenantIdentityProvider']],
  'svc:admin:mcp-server:manage': [['manage', 'McpServer']],
  'svc:admin:notification:manage': [['manage', 'Notification']],
  'svc:admin:resource-subscription:manage': [['manage', 'ResourceSubscription']],
  'svc:admin:service-release:manage': [['read', 'TenantTelemetry']],
  'svc:admin:workflow-definition:manage': [['manage', 'WorkflowDefinition']],
  'svc:admin:workflow-node:read': [['read', 'WorkflowDefinition']],
  'svc:admin:workflow-run:read': [['read', 'WorkflowRun']],
  'svc:admin:workflow-test-fixture:manage': [['manage', 'WorkflowTestFixture']],
};

/**
 * The `admin:*` areas that FAIL the derivation rule — kept explicit so the test
 * proves the rule EXCLUDES things, not merely that the included list is
 * self-consistent. Each implies at least one ability a tenant admin does not
 * hold (several imply `manage:all` or `manage:Tenant`).
 */
const PLATFORM_ONLY_SVC_SCOPES: Readonly<Record<string, ReadonlyArray<readonly [action: string, subject: string]>>> = {
  'svc:admin:tenant:write': [['manage', 'Tenant']],
  'svc:admin:role:write': [['manage', 'Role']],
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
  'svc:admin:storage-key:manage': [['manage', 'Tenant']],
  'svc:admin:tenant-storage:manage': [['manage', 'Tenant']],
  'svc:admin:billing:manage': [
    ['manage', 'BillingInvoice'],
    ['manage', 'AiPriceBook'],
  ],
  'svc:admin:department-agent:manage': [
    ['manage', 'DepartmentAgent'],
    ['manage', 'Tenant'],
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

  it('the non-dev path writes a verifier with NO generated preimage', () => {
    const src = readFileSync(join(__dirname, '../94-service-account.ts'), 'utf8');
    // The inert branch must generate the VERIFIER directly. Generating a secret
    // and hashing it would create a plaintext credential in process memory (and
    // in any log line someone later adds) for no benefit.
    expect(src).toContain("randomBytes(32).toString('hex')");
    expect(src).toMatch(/withUsableSecret \? computeSecretVerifier\(account\.devSecret, pepper\) : randomBytes\(32\)/);
  });

  it('records a Vault path, matching ServiceAccountService.credentialsRefFor', () => {
    expect(credentialsRefFor('hope_svc_abc')).toBe('service-accounts/hope_svc_abc/current');
    for (const account of SEEDED_SERVICE_ACCOUNTS) {
      expect(credentialsRefFor(account.clientId)).toBe(`service-accounts/${account.clientId}/current`);
    }
  });

  it('the seed is CREATE-ONLY, so a rotated secret survives a re-seed', () => {
    const src = readFileSync(join(__dirname, '../94-service-account.ts'), 'utf8');
    expect(src).toContain('already exists — leaving it untouched');
    // An upsert would rewrite `secretVerifier` on every run, invalidating the
    // secret the operator obtained through `rotate`.
    expect(src).not.toContain('serviceAccount.upsert');
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
