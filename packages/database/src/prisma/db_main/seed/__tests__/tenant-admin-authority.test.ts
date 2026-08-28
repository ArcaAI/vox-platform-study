import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICIES } from '../01-policy';
import { DEFAULT_ROLES } from '../03-role';

/**
 * TASK-766 — "the ArcaAI tenant admin genuinely holds ALL rights within the
 * ArcaAI tenant", turned into a checked fact.
 *
 * ## What was measured
 *
 * Every `@Authorize` / `@CanRead|List|Create|Update|Delete|Manage` decorator in
 * `apps/api/src/modules/**` (excluding `__tests__`) was extracted and reduced to
 * the `action:subject` pairs a caller must satisfy. That inventory is
 * reproduced in `ROUTE_DECLARED_PAIRS` below — hardcoded rather than scanned at
 * test time, following `reader-plane-mintability.test.ts`, because
 * `packages/database` sits BELOW `apps/api` in the dependency graph and reaching
 * across the package boundary (by import or by `readFileSync`) would invert it.
 *
 * Re-derive it with:
 *
 * ```
 * grep -rhoE "@(Authorize|CanRead|CanList|CanCreate|CanUpdate|CanDelete|CanManage)\(([^)]*)\)" \
 *   apps/api/src/modules | sort -u
 * ```
 *
 * ## The result, and why the ten exceptions are correct
 *
 * TENANT_ADMIN satisfies every declared pair except ten. All ten are
 * PLATFORM-plane, and granting any of them from a tenant-scoped role would be
 * cross-tenant escalation rather than "completing" the role:
 *
 * | Missing ability | Why it must stay missing |
 * |---|---|
 * | `manage:all` | The SUPER_ADMIN wildcard |
 * | `manage:Tenant` | Tenant CRUD/provisioning across the platform |
 * | `manage:Role`, `manage:Policy` | `Role` and `Policy` are GLOBAL tables — no `tenantId` column at all. CASL `conditions` are in SHADOW MODE (`policy.engine.ts`: the guard is a type-only check), so an `isSystemRole: false` condition would NOT constrain the grant at request time. A tenant admin holding these could edit or delete the SYSTEM roles every other tenant depends on. |
 * | `manage:ServiceAccount` | Machine-identity issuance is SUPER_ADMIN-only and additionally enforced imperatively in `ServiceAccountService.assertMayIssue` |
 * | `manage:UsageAnalytics`, `manage:PlatformMetrics` | Cross-tenant platform telemetry |
 * | `manage:PrismaStudio` | Direct database access |
 * | `manage:AiPriceBook` | The platform rate card |
 * | `manage:ChangelogEntry` | Platform-wide release notes (tenant admins hold `read` via `user-profile-own`) |
 *
 * The role DOES hold the tenant-scoped read/list side of the two RBAC surfaces
 * (`read:Role` via `rbac-tenant-manage`, `read`/`list:Policy`, `manage:RolePolicy`,
 * `create:Role`), which is what makes `GET /admin/rbac/roles`, role CLONE and
 * policy attach/detach reachable. Full custom-role mutation is not — see the
 * ticket README §Owner Decisions.
 *
 * ## Why this test exists rather than a one-off audit
 *
 * A new tenant-scoped admin surface whose subject no policy grants is
 * code-correct and unreachable-by-role — the exact failure shape that produced
 * the `BillingInvoice`, `KnowledgeDocument` and `WorkflowTestFixture` grants
 * already present in `tenant-full-access`. This turns the next instance into a
 * failing test instead of a bug report.
 */

/** Union of `action:subject` pairs a role's policy set grants, following `parentRoleId`. */
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
      for (const action of Array.isArray(rule.action) ? rule.action : [rule.action]) {
        abilities.add(`${action}:${rule.subject}`);
      }
    }
  }
  return abilities;
}

/** CASL semantics: `manage` subsumes every action, `all` subsumes every subject. */
function can(abilities: Set<string>, action: string, subject: string): boolean {
  return (
    abilities.has('manage:all') || abilities.has(`manage:${subject}`) || abilities.has(`${action}:all`) || abilities.has(`${action}:${subject}`)
  );
}

/** The `action:subject` inventory declared by `apps/api/src/modules/**` (see the module doc). */
const ROUTE_DECLARED_PAIRS: ReadonlyArray<readonly [action: string, subject: string]> = [
  ['create', 'ApiKey'],
  ['create', 'Consultation'],
  ['create', 'GlobalSetting'],
  ['create', 'PromptTemplate'],
  ['create', 'Role'],
  ['create', 'Storage'],
  ['create', 'UserVoiceProfile'],
  ['create', 'WorkflowRun'],
  ['delete', 'ApiKey'],
  ['delete', 'GlobalSetting'],
  ['delete', 'PromptTemplate'],
  ['delete', 'Storage'],
  ['delete', 'UserVoiceProfile'],
  ['list', 'WorkflowDefinition'],
  ['manage', 'AiPriceBook'],
  ['manage', 'AiTaskDefault'],
  ['manage', 'ApiKey'],
  ['manage', 'AsrPipeline'],
  ['manage', 'BillingInvoice'],
  ['manage', 'ChangelogEntry'],
  ['manage', 'ConsentGrant'],
  ['manage', 'Consultation'],
  ['manage', 'ConsultationContextSchema'],
  ['manage', 'Department'],
  ['manage', 'DnaWritingStyleReport'],
  ['manage', 'GlobalSetting'],
  ['manage', 'HarnessEval'],
  ['manage', 'HarnessPolicy'],
  ['manage', 'HarnessWorkflow'],
  ['manage', 'KnowledgeDocument'],
  ['manage', 'McpServer'],
  ['manage', 'Notification'],
  ['manage', 'PipelinePolicy'],
  ['manage', 'PlatformMetrics'],
  ['manage', 'Policy'],
  ['manage', 'PrismaStudio'],
  ['manage', 'PromptTemplate'],
  ['manage', 'ResourceSubscription'],
  ['manage', 'Role'],
  ['manage', 'RolePolicy'],
  ['manage', 'ServiceAccount'],
  ['manage', 'Tenant'],
  ['manage', 'TenantAllowedOrigin'],
  ['manage', 'TenantIdentityProvider'],
  ['manage', 'TenantNlpTaskInstructions'],
  ['manage', 'TenantSttConfig'],
  ['manage', 'TenantTtsConfig'],
  ['manage', 'UsageAnalytics'],
  ['manage', 'User'],
  ['manage', 'UserRoleAssignment'],
  ['manage', 'UserVoiceProfile'],
  ['manage', 'Webhook'],
  ['manage', 'WorkflowDefinition'],
  ['manage', 'WorkflowTestFixture'],
  ['manage', 'all'],
  ['read', 'AgentTrajectory'],
  ['read', 'AiTaskDefault'],
  ['read', 'ApiKey'],
  ['read', 'AsrPipeline'],
  ['read', 'AuditLog'],
  ['read', 'Consultation'],
  ['read', 'GlobalSetting'],
  ['read', 'HarnessAudit'],
  ['read', 'HarnessEval'],
  ['read', 'HarnessPolicy'],
  ['read', 'HarnessWorkflow'],
  ['read', 'KnowledgeDocument'],
  ['read', 'McpServer'],
  ['read', 'PipelinePolicy'],
  ['read', 'PromptTemplate'],
  ['read', 'ServiceAccount'],
  ['read', 'Storage'],
  ['read', 'Tenant'],
  ['read', 'TenantIdentityProvider'],
  ['read', 'TenantNlpTaskInstructions'],
  ['read', 'TenantSttConfig'],
  ['read', 'TenantTtsConfig'],
  ['read', 'User'],
  ['read', 'UserVoiceProfile'],
  ['read', 'WebhookRunHistory'],
  ['read', 'WorkflowDefinition'],
  ['read', 'WorkflowRun'],
  ['update', 'ApiKey'],
  ['update', 'GlobalSetting'],
  ['update', 'PromptTemplate'],
  ['update', 'Storage'],
  ['update', 'Tenant'],
  ['update', 'UserVoiceProfile'],
  ['update', 'WorkflowRun'],
];

/**
 * The ten abilities a tenant administrator deliberately does NOT hold. Every
 * one is platform-plane; see the module doc for the per-row justification.
 *
 * This is an EXACT set, asserted in both directions: an eleventh appearing means
 * a tenant surface became unreachable, and one disappearing means a tenant-scoped
 * role acquired platform authority. Both are regressions.
 */
const DELIBERATE_PLATFORM_ONLY: ReadonlyArray<readonly [action: string, subject: string]> = [
  ['manage', 'AiPriceBook'],
  ['manage', 'ChangelogEntry'],
  ['manage', 'PlatformMetrics'],
  ['manage', 'Policy'],
  ['manage', 'PrismaStudio'],
  ['manage', 'Role'],
  ['manage', 'ServiceAccount'],
  ['manage', 'Tenant'],
  ['manage', 'UsageAnalytics'],
  ['manage', 'all'],
];

describe('TENANT_ADMIN holds every tenant-scoped ability the API declares', () => {
  const abilities = abilitiesFor('TENANT_ADMIN');
  const platformOnly = new Set(DELIBERATE_PLATFORM_ONLY.map(([a, s]) => `${a}:${s}`));

  for (const [action, subject] of ROUTE_DECLARED_PAIRS) {
    if (platformOnly.has(`${action}:${subject}`)) continue;
    it(`can ${action}:${subject}`, () => {
      expect(
        can(abilities, action, subject),
        `A route declares ${action}:${subject} but no seeded policy grants it to a tenant admin — the surface is code-correct and unreachable by its intended audience.`,
      ).toBe(true);
    });
  }

  it('lacks EXACTLY the ten platform-plane abilities, no more and no fewer', () => {
    const missing = ROUTE_DECLARED_PAIRS.filter(([a, s]) => !can(abilities, a, s))
      .map(([a, s]) => `${a}:${s}`)
      .sort();
    expect(missing).toEqual([...platformOnly].sort());
  });
});

describe('the tenant-scoped role does not leak into the platform plane', () => {
  const abilities = abilitiesFor('TENANT_ADMIN');

  it.each(DELIBERATE_PLATFORM_ONLY)('does not hold %s:%s', (action, subject) => {
    expect(can(abilities, action, subject)).toBe(false);
  });

  it('holds the READ side of the two global RBAC tables, and only the read side', () => {
    // `Role` and `Policy` have no `tenantId` column, and CASL conditions are in
    // shadow mode — so `read`/`list` is the widest safe grant.
    expect(can(abilities, 'read', 'Role')).toBe(true);
    expect(can(abilities, 'list', 'Policy')).toBe(true);
    expect(can(abilities, 'manage', 'Role')).toBe(false);
    expect(can(abilities, 'manage', 'Policy')).toBe(false);
  });

  it('SUPER_ADMIN keeps the manage:all grant that covers all ten', () => {
    const superAdmin = abilitiesFor('SUPER_ADMIN');
    for (const [action, subject] of DELIBERATE_PLATFORM_ONLY) {
      expect(can(superAdmin, action, subject)).toBe(true);
    }
  });
});
