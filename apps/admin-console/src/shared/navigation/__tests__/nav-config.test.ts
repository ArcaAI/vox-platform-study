import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '@/shared/auth/ability';
import { FEATURE_GATE_KEYS, type FeatureGateKey, type FeatureGateMap } from '@/shared/feature-gates/keys';
import {
  activeNavDomainId,
  domainLandingRoute,
  matchNavEntry,
  NAV_DOMAINS,
  NAV_ENTRIES,
  NAV_SECTIONS,
  USER_MENU_ENTRIES,
  visibleNavDomains,
  visibleNavEntries,
  visibleUserMenuEntries,
  type NavDomainId,
  type NavTier,
} from '../nav-config';

const SUPER_ADMIN_RULES: PermissionRule[] = [{ action: 'manage', subject: 'all' }];

// Approximation of the seeded TENANT_ADMIN policy set (tenant-full-access,
// rbac-tenant-manage, prompt-template-manage, audit-log-read). Adds
// manage:TenantAllowedOrigin (own-tenant condition) to tenant-full-access.
const TENANT_ADMIN_RULES: PermissionRule[] = [
  { action: 'read', subject: 'AuditLog' },
  { action: 'manage', subject: 'Department' },
  { action: 'manage', subject: 'User' },
  { action: 'manage', subject: 'PromptTemplate' },
  { action: 'manage', subject: 'TenantAllowedOrigin' },
  { action: 'read,update', subject: 'Tenant' },
  { action: 'read', subject: 'Role' },
];

/** Every platform-wide feature gate resolved `true` — the "nothing is hidden by the matrix" baseline most ability-only tests want. */
const ALL_GATES_OPEN: FeatureGateMap = Object.fromEntries(FEATURE_GATE_KEYS.map((key) => [key, true]));

describe('NAV_ENTRIES (TASK-932 §3.1 — Platform Ops regrouped, feature gates added)', () => {
  // TASK-932: net zero. `/ai-configuration` ("Speech & Voice") left the rail
  // entirely — its remaining binding retires with the ASR Agent and the route
  // becomes a one-release redirect (see retired-route-redirects.test.tsx) —
  // and `/features` (the feature-availability matrix) joined Platform Ops, so
  // the total and the tier-30-49 count both hold at their pre-ticket values
  // minus one, plus the new tier-10-19 entry: 58 total, 25/9/19/5 by tier
  // (was 24/9/20/5; `/ai-configuration` was tier 30-49, `/features` is
  // tier 10-19).
  it('covers the full 58-route rail map across the four tiers', () => {
    expect(NAV_ENTRIES).toHaveLength(58);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '10-19')).toHaveLength(25);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '20-29')).toHaveLength(9);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '30-49')).toHaveLength(19);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '50-59')).toHaveLength(5);
    // The two routes moved to the user menu are accounted for, not lost.
    expect(NAV_ENTRIES.length + USER_MENU_ENTRIES.length).toBe(60);
  });

  it('gates the credential policy on manage:all — every backing key is a globalOnly descriptor', () => {
    const policy = NAV_ENTRIES.find((entry) => entry.route === '/security-policy');

    expect(policy).toBeDefined();
    // Tier 10-19: cross-tenant, never requires a selected working tenant. The
    // gateway 403s a tenant admin regardless of what the nav shows, but showing
    // an entry that always 403s is its own defect.
    expect(policy?.tier).toBe('10-19');
    expect(policy?.required).toEqual([['manage', 'all']]);
    expect(policy?.implemented).toBe(true);
  });

  it('no longer surfaces the developer portal or the account page from the rail', () => {
    const developerRules: PermissionRule[] = [{ action: 'read', subject: 'ApiDocumentation' }];
    expect(visibleNavEntries(developerRules, ['DOCTOR']).map((entry) => entry.route)).not.toContain('/developer');
    expect(visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN']).map((entry) => entry.route)).not.toContain('/account');
  });

  it('keeps the retired per-capability credential screens (/stt-config, /tts-config, /ai-configuration) out of the rail', () => {
    // TASK-932: "Speech & Voice" left the rail entirely — the route now
    // redirects to /agents?task=SPEECH_TO_TEXT (retired-route-redirects.test.tsx).
    for (const route of ['/stt-config', '/tts-config', '/ai-configuration']) {
      expect(NAV_ENTRIES.some((entry) => entry.route === route)).toBe(false);
    }
  });

  it('lists the ONE AI provider screen (TASK-862) and none of the surfaces it absorbed', () => {
    // `/ai-platform` (hub), `/ai-task-defaults` and `/ai-model-defaults` all
    // keep or kept a one-release redirect; a redirect is not a navigable
    // destination and has no place in the rail.
    for (const route of ['/ai-platform', '/ai-task-defaults', '/ai-model-defaults']) {
      expect(NAV_ENTRIES.some((entry) => entry.route === route)).toBe(false);
    }

    const providers = NAV_ENTRIES.find((entry) => entry.route === '/ai-providers');
    expect(providers?.label).toBe('AI providers');
    // Tier 20-29: cross-tenant for a super admin (SYSTEM tier), tenant-scoped
    // for a tenant admin — the two tiers of one cascade, one screen.
    expect(providers?.tier).toBe('20-29');
    expect(providers?.domain).toBe('ai-platform');
    // Mirrors `ProviderConnectionController`'s `CanRead`/`CanManage('GlobalSetting')`.
    expect(providers?.required).toEqual([
      ['read', 'GlobalSetting'],
      ['manage', 'GlobalSetting'],
    ]);
    expect(providers?.implemented).toBe(true);
  });

  it('carries no /ai-runtime-profiles entry — the route was removed with AiRuntimeProfile (TASK-862)', () => {
    expect(NAV_ENTRIES.some((entry) => entry.route === '/ai-runtime-profiles')).toBe(false);
  });

  it('no longer lists provider reconciliation — the feature was removed outright (TASK-862)', () => {
    // The route keeps a one-release redirect to `/ai-operations/consumption`,
    // and a redirect has no place in a navigation list.
    expect(NAV_ENTRIES.some((entry) => entry.route === '/ai-operations/reconciliation')).toBe(false);
  });

  it('re-tiers AI models to super-admin only and folds frontend config into the tenant detail', () => {
    const aiModels = NAV_ENTRIES.find((entry) => entry.route === '/ai-models');
    expect(aiModels?.tier).toBe('10-19');
    expect(aiModels?.required).toEqual([['manage', 'all']]);
    expect(NAV_ENTRIES.some((entry) => entry.route === '/tenants/frontend-config')).toBe(false);
  });

  it('exposes /ai-models as an implemented, navigable hub', () => {
    const aiModels = NAV_ENTRIES.find((entry) => entry.route === '/ai-models');
    expect(aiModels?.implemented).toBe(true);
  });

  it('has unique routes, a section per tier, and a unique order within every domain+tier group', () => {
    const routes = NAV_ENTRIES.map((entry) => entry.route);
    expect(new Set(routes).size).toBe(routes.length);
    expect(NAV_SECTIONS.map((section) => section.tier)).toEqual(['10-19', '20-29', '30-49', '50-59']);

    // `order` is "position within domain+tier" (rule: nav-config.ts §NavEntry) —
    // declaration order in NAV_ENTRIES must match it exactly, so a reorder
    // always touches both the field and the array position.
    const byGroup = new Map<string, number[]>();
    for (const entry of NAV_ENTRIES) {
      const key = `${entry.domain}::${entry.tier}`;
      byGroup.set(key, [...(byGroup.get(key) ?? []), entry.order]);
    }
    for (const [group, orders] of byGroup) {
      expect(orders, `${group} orders`).toEqual(orders.map((_, index) => index + 1));
    }
  });

  it('marks every tier-10-19 entry implemented (unhid /ai-models)', () => {
    const byTier = (tier: string) => NAV_ENTRIES.filter((entry) => entry.tier === tier);
    expect(
      byTier('10-19')
        .filter((entry) => !entry.implemented)
        .map((entry) => entry.route),
    ).toEqual([]);
    expect(byTier('20-29').every((entry) => entry.implemented)).toBe(true);
    expect(byTier('30-49').every((entry) => entry.implemented)).toBe(true);
    expect(byTier('50-59').every((entry) => entry.implemented)).toBe(true);
  });

  it('routes every playground entry under /playground; all five demo planes keep an empty ability gate (role-gated instead)', () => {
    const playground = NAV_ENTRIES.filter((entry) => entry.tier === '50-59');
    expect(playground.map((entry) => entry.route)).toEqual([
      '/playground/consultation',
      '/playground/live-transcription',
      '/playground/voice-profiles',
      '/playground/dna-writing-style',
      '/playground/llm',
    ]);
    expect(playground.every((entry) => entry.required.length === 0)).toBe(true);
  });

  describe('console IA cleanup', () => {
    it('retires /prompt-studio (governance moved into the prompt-template Governance tab)', () => {
      expect(NAV_ENTRIES.some((entry) => entry.route === '/prompt-studio')).toBe(false);
      const promptTemplates = NAV_ENTRIES.find((entry) => entry.route === '/prompt-templates');
      expect(promptTemplates?.tier).toBe('30-49');
      expect(promptTemplates?.required).toEqual([['manage', 'PromptTemplate']]);
      expect(promptTemplates?.implemented).toBe(true);
    });

    it('renames /pstudio to /db-studio with unambiguous copy (M-08)', () => {
      expect(NAV_ENTRIES.some((entry) => entry.route === '/pstudio')).toBe(false);
      const dbStudio = NAV_ENTRIES.find((entry) => entry.route === '/db-studio');
      expect(dbStudio?.label).toBe('Database Studio');
      expect(dbStudio?.tier).toBe('10-19');
      expect(dbStudio?.implemented).toBe(true);
    });

    it('adds /ai-services as a super-admin surface over the unused backends (M-09)', () => {
      const aiServices = NAV_ENTRIES.find((entry) => entry.route === '/ai-services');
      expect(aiServices?.tier).toBe('10-19');
      expect(aiServices?.required).toEqual([['manage', 'all']]);
      expect(aiServices?.implemented).toBe(true);
    });

    it('keeps every route unique after the rename', () => {
      const routes = NAV_ENTRIES.map((entry) => entry.route);
      expect(new Set(routes).size).toBe(routes.length);
    });

    it('retiers /allowed-origins to tenant scope now that TENANT_ADMIN can manage their own rows', () => {
      const allowedOrigins = NAV_ENTRIES.find((entry) => entry.route === '/allowed-origins');
      expect(allowedOrigins?.tier).toBe('30-49');
      expect(allowedOrigins?.required).toEqual([
        ['read', 'TenantAllowedOrigin'],
        ['manage', 'TenantAllowedOrigin'],
      ]);
      expect(allowedOrigins?.implemented).toBe(true);
    });
  });

  it('ships a unique icon per entry (the icon-collapsed rail renders icons only)', () => {
    for (const entry of NAV_ENTRIES) {
      expect(entry.icon, `${entry.route} is missing an icon`).toBeDefined();
    }
    expect(new Set(NAV_ENTRIES.map((entry) => entry.icon)).size).toBe(NAV_ENTRIES.length);
  });
});

describe('matchNavEntry', () => {
  it('returns an exact match', () => {
    expect(matchNavEntry('/dashboard')?.route).toBe('/dashboard');
  });

  it('returns the parent for a detail route', () => {
    expect(matchNavEntry('/tenants/t-123')?.route).toBe('/tenants');
  });

  it('prefers the longest prefix (/tenants/storage over /tenants)', () => {
    expect(matchNavEntry('/tenants/storage')?.route).toBe('/tenants/storage');
  });

  it('returns undefined for an unknown route', () => {
    expect(matchNavEntry('/does-not-exist')).toBeUndefined();
  });

  it('accepts a custom entries subset', () => {
    const subset = NAV_ENTRIES.filter((e) => e.route === '/tenants/storage');
    expect(matchNavEntry('/tenants/storage', subset)?.route).toBe('/tenants/storage');
    expect(matchNavEntry('/dashboard', subset)).toBeUndefined();
  });
});

describe('visibleNavEntries', () => {
  it('shows a super admin every implemented entry with every gate open (manage:all grants all tiers)', () => {
    const visible = visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN'], ALL_GATES_OPEN);
    const implemented = NAV_ENTRIES.filter((entry) => entry.implemented);
    expect(visible.map((entry) => entry.route)).toEqual(implemented.map((entry) => entry.route));
  });

  it('shows /ai-models to a super admin now that the hub is implemented', () => {
    expect(visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN']).map((entry) => entry.route)).toContain('/ai-models');
  });

  it('hides super-admin-only entries from tenant admins but keeps shared screens and the playground', () => {
    const visible = visibleNavEntries(TENANT_ADMIN_RULES, ['TENANT_ADMIN'], ALL_GATES_OPEN).map((entry) => entry.route);
    expect(visible).not.toContain('/dashboard');
    expect(visible).not.toContain('/monitoring');
    // Still super-admin only (manage:all) — now visible to super admins,
    // never to tenant admins.
    expect(visible).not.toContain('/ai-models');
    expect(visible).toContain('/users');
    expect(visible).toContain('/tenant-profile');
    // /account left the rail for the user menu.
    expect(visible).not.toContain('/account');
    expect(visibleUserMenuEntries(TENANT_ADMIN_RULES).map((entry) => entry.route)).toContain('/account');
    expect(visible).toContain('/playground/consultation');
    expect(visible).toContain('/playground/llm');
    // A tenant admin now reaches the retiered allowed-origins screen.
    expect(visible).toContain('/allowed-origins');
  });

  it('shows an authenticated user with zero grants nothing in the rail', () => {
    // Every rail route is now ability-gated: /account was the one ungated entry
    // and moved it to the user menu, where it still renders.
    expect(visibleNavEntries([]).map((entry) => entry.route)).toEqual([]);
    expect(visibleUserMenuEntries([]).map((entry) => entry.route)).toEqual(['/account']);
  });

  it('hides the playground tier from non-admin roles even though its ability gate is empty', () => {
    const visible = visibleNavEntries([], ['DOCTOR']).map((entry) => entry.route);
    expect(visible).toEqual([]);
    expect(visibleNavEntries([]).some((entry) => entry.tier === '50-59')).toBe(false);
  });

  it('shows nothing while permissions are unknown', () => {
    expect(visibleNavEntries(null, ['SUPER_ADMIN'])).toEqual([]);
    expect(visibleNavEntries(undefined)).toEqual([]);
  });

  it('filters unimplemented entries even when the ability grants them', () => {
    const visible = visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN'], ALL_GATES_OPEN);
    expect(visible.every((entry) => entry.implemented)).toBe(true);
  });

  describe('platform-wide feature gates (TASK-932 §3.2)', () => {
    const GATED_ROUTES: ReadonlyArray<readonly [route: string, key: FeatureGateKey]> = [
      ['/agentic-policy', 'console.agenticPolicy.enabled'],
      ['/ai-services/mlflow', 'console.mlflow.enabled'],
      ['/tools-mcp', 'console.tools.mcp.enabled'],
      ['/harness/policy', 'console.workflowHarness.enabled'],
      ['/harness/observability', 'console.workflowHarness.enabled'],
      ['/harness/workflows', 'console.workflowHarness.enabled'],
      ['/workflow-runs', 'console.workflowHarness.enabled'],
    ];

    it.each(GATED_ROUTES)('carries the %s -> %s gate contract', (route, key) => {
      expect(NAV_ENTRIES.find((entry) => entry.route === route)?.gate).toBe(key);
    });

    it('hides every gated entry when no gate map is supplied at all — undefined fails closed, not "assume on"', () => {
      const visible = visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN']).map((entry) => entry.route);
      for (const [route] of GATED_ROUTES) {
        expect(visible, `${route} must be hidden with no gate map`).not.toContain(route);
      }
    });

    it('hides a gated entry when its key resolves false, even though the ability grants it', () => {
      const gates: FeatureGateMap = { 'console.mlflow.enabled': false };
      expect(visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN'], gates).map((entry) => entry.route)).not.toContain('/ai-services/mlflow');
    });

    it('shows a gated entry once its key resolves true', () => {
      const gates: FeatureGateMap = { 'console.mlflow.enabled': true };
      expect(visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN'], gates).map((entry) => entry.route)).toContain('/ai-services/mlflow');
    });

    it('never affects an ungated entry — the gate map is additive, not a global switch', () => {
      const gates: FeatureGateMap = {};
      const visible = visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN'], gates).map((entry) => entry.route);
      expect(visible).toContain('/rate-limits');
      expect(visible).toContain('/features');
    });

    it('leaves each gate independent — closing one does not close the others', () => {
      const gates: FeatureGateMap = { 'console.mlflow.enabled': false, 'console.agenticPolicy.enabled': true, 'console.tools.mcp.enabled': true, 'console.workflowHarness.enabled': true };
      const visible = visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN'], gates).map((entry) => entry.route);
      expect(visible).not.toContain('/ai-services/mlflow');
      expect(visible).toContain('/agentic-policy');
      expect(visible).toContain('/tools-mcp');
      expect(visible).toContain('/workflow-runs');
    });
  });
});

// ---------------------------------------------------------------------------
// The exhaustive route/domain/tier/order/ability/gate pin (TASK-932 §3.1/§3.2).
//
// Declaration order in `NAV_ENTRIES` IS the render order within a domain+tier
// (nav-config.ts filters preserve array order), so this table doubles as the
// order pin the ticket asks for: a future reorder, re-domain, re-tier or gate
// change must edit BOTH `nav-config.ts` and this table in the same diff.
// ---------------------------------------------------------------------------

type PinnedEntry = readonly [
  route: string,
  domain: NavDomainId,
  tier: NavTier,
  order: number,
  required: ReadonlyArray<readonly [string, string]>,
  gate?: FeatureGateKey,
];

const EXPECTED_NAV_ENTRIES: readonly PinnedEntry[] = [
  // Overview
  ['/dashboard', 'overview', '10-19', 1, [['manage', 'PlatformMetrics']]],
  [
    '/monitoring',
    'overview',
    '10-19',
    2,
    [
      ['manage', 'all'],
      ['read', 'TenantTelemetry'],
    ],
  ],
  [
    '/releases',
    'overview',
    '10-19',
    3,
    [
      ['manage', 'all'],
      ['read', 'TenantTelemetry'],
    ],
  ],
  // Tenancy
  [
    '/tenants',
    'tenancy',
    '10-19',
    1,
    [
      ['manage', 'Tenant'],
      ['update', 'Tenant'],
    ],
  ],
  ['/entitlements', 'tenancy', '10-19', 2, [['manage', 'all']]],
  [
    '/tenants/storage',
    'tenancy',
    '10-19',
    3,
    [
      ['manage', 'Tenant'],
      ['read', 'Storage'],
    ],
  ],
  ['/billing', 'tenancy', '10-19', 4, [['manage', 'all']]],
  [
    '/tenant-profile',
    'tenancy',
    '20-29',
    1,
    [
      ['read', 'Tenant'],
      ['update', 'Tenant'],
    ],
  ],
  ['/departments', 'tenancy', '30-49', 1, [['manage', 'Department']]],
  // Platform Ops — TASK-932 R-2 (moved ahead of AI Platform), R-4 (gained the
  // three gated entries it absorbed from AI Platform / Knowledge & Agents
  // plus the new /features matrix).
  ['/features', 'platform-ops', '10-19', 1, [['manage', 'all']]],
  ['/rate-limits', 'platform-ops', '10-19', 2, [['manage', 'all']]],
  ['/ai-operations/runs', 'platform-ops', '10-19', 3, [['manage', 'all']]],
  ['/ai-operations/metrics', 'platform-ops', '10-19', 4, [['manage', 'all']]],
  ['/ai-operations/consumption', 'platform-ops', '10-19', 5, [['manage', 'all']]],
  ['/queues', 'platform-ops', '10-19', 6, [['manage', 'all']]],
  ['/schedulers', 'platform-ops', '10-19', 7, [['manage', 'all']]],
  ['/audit-logs', 'platform-ops', '10-19', 8, [['read', 'AuditLog']]],
  ['/db-studio', 'platform-ops', '10-19', 9, [['manage', 'all']]],
  ['/agentic-policy', 'platform-ops', '10-19', 10, [['manage', 'all']], 'console.agenticPolicy.enabled'],
  ['/ai-services/mlflow', 'platform-ops', '10-19', 11, [['manage', 'all']], 'console.mlflow.enabled'],
  [
    '/settings-registry',
    'platform-ops',
    '20-29',
    1,
    [
      ['read', 'GlobalSetting'],
      ['manage', 'GlobalSetting'],
    ],
  ],
  ['/settings', 'platform-ops', '20-29', 2, [['manage', 'GlobalSetting']]],
  ['/tools-mcp', 'platform-ops', '20-29', 3, [['manage', 'McpServer']], 'console.tools.mcp.enabled'],
  [
    '/storage',
    'platform-ops',
    '30-49',
    1,
    [
      ['read', 'Storage'],
      ['manage', 'Storage'],
    ],
  ],
  // AI Platform — narrowed to tiers 10-19/20-29 now that the sole tier-30-49
  // member (`/ai-configuration`) is gone.
  ['/ai-models', 'ai-platform', '10-19', 1, [['manage', 'all']]],
  ['/ai-services', 'ai-platform', '10-19', 2, [['manage', 'all']]],
  ['/ai-services/lm-studio', 'ai-platform', '10-19', 3, [['manage', 'all']]],
  ['/ai-services/vllm', 'ai-platform', '10-19', 4, [['manage', 'all']]],
  ['/ai-services/ollama', 'ai-platform', '10-19', 5, [['manage', 'all']]],
  ['/ai-services/llama-cpp', 'ai-platform', '10-19', 6, [['manage', 'all']]],
  [
    '/ai-providers',
    'ai-platform',
    '20-29',
    1,
    [
      ['read', 'GlobalSetting'],
      ['manage', 'GlobalSetting'],
    ],
  ],
  // Knowledge & Agents — /tools-mcp left for Platform Ops (TASK-932 R-4).
  ['/agents', 'knowledge-agents', '30-49', 1, [['manage', 'Agent']]],
  ['/prompt-templates', 'knowledge-agents', '30-49', 2, [['manage', 'PromptTemplate']]],
  ['/context-schemas', 'knowledge-agents', '30-49', 3, [['manage', 'ConsultationContextSchema']]],
  ['/document-templates', 'knowledge-agents', '30-49', 4, [['manage', 'DocumentTemplate']]],
  ['/knowledge', 'knowledge-agents', '30-49', 5, [['manage', 'KnowledgeDocument']]],
  ['/dna-writing-styles', 'knowledge-agents', '30-49', 6, [['manage', 'DnaWritingStyleReport']]],
  ['/workflow-studio', 'knowledge-agents', '30-49', 7, [['manage', 'WorkflowDefinition']]],
  ['/workflow-studio/assignments', 'knowledge-agents', '30-49', 8, [['manage', 'WorkflowDefinition']]],
  // Clinical
  ['/consent', 'clinical', '30-49', 1, [['manage', 'ConsentGrant']]],
  [
    '/audio/transcription-jobs',
    'clinical',
    '30-49',
    2,
    [
      ['read', 'AsrPipeline'],
      ['manage', 'Tenant'],
    ],
  ],
  ['/consultations', 'clinical', '30-49', 3, [['manage', 'Consultation']]],
  // Workflow & Harness — the WHOLE domain is gated (TASK-932 R-4).
  [
    '/harness/policy',
    'workflow-harness',
    '30-49',
    1,
    [
      ['read', 'HarnessPolicy'],
      ['manage', 'HarnessPolicy'],
    ],
    'console.workflowHarness.enabled',
  ],
  [
    '/harness/observability',
    'workflow-harness',
    '30-49',
    2,
    [
      ['read', 'HarnessAudit'],
      ['read', 'HarnessEval'],
      ['read', 'HarnessWorkflow'],
    ],
    'console.workflowHarness.enabled',
  ],
  [
    '/harness/workflows',
    'workflow-harness',
    '30-49',
    3,
    [
      ['read', 'HarnessWorkflow'],
      ['manage', 'HarnessWorkflow'],
    ],
    'console.workflowHarness.enabled',
  ],
  ['/workflow-runs', 'workflow-harness', '30-49', 4, [['read', 'WorkflowRun']], 'console.workflowHarness.enabled'],
  // Identity & Access
  ['/security-policy', 'identity-access', '10-19', 1, [['manage', 'all']]],
  ['/users', 'identity-access', '20-29', 1, [['manage', 'User']]],
  [
    '/rbac/roles',
    'identity-access',
    '20-29',
    2,
    [
      ['read', 'Role'],
      ['manage', 'Role'],
    ],
  ],
  [
    '/rbac/policies',
    'identity-access',
    '20-29',
    3,
    [
      ['read', 'Policy'],
      ['manage', 'Policy'],
    ],
  ],
  [
    '/api-keys',
    'identity-access',
    '20-29',
    4,
    [
      ['read', 'ApiKey'],
      ['manage', 'ApiKey'],
    ],
  ],
  [
    '/identity-providers',
    'identity-access',
    '30-49',
    1,
    [
      ['read', 'TenantIdentityProvider'],
      ['manage', 'TenantIdentityProvider'],
    ],
  ],
  [
    '/allowed-origins',
    'identity-access',
    '30-49',
    2,
    [
      ['read', 'TenantAllowedOrigin'],
      ['manage', 'TenantAllowedOrigin'],
    ],
  ],
  // Playground — unchanged.
  ['/playground/consultation', 'playground', '50-59', 1, []],
  ['/playground/live-transcription', 'playground', '50-59', 2, []],
  ['/playground/voice-profiles', 'playground', '50-59', 3, []],
  ['/playground/dna-writing-style', 'playground', '50-59', 4, []],
  ['/playground/llm', 'playground', '50-59', 5, []],
];

describe('EXPECTED_NAV_ENTRIES — the full route/domain/tier/order/ability/gate pin', () => {
  it('matches NAV_ENTRIES exactly, in declaration order', () => {
    expect(
      NAV_ENTRIES.map((entry) => [entry.route, entry.domain, entry.tier, entry.order, entry.required.map(([action, subject]) => [action, subject]), entry.gate]),
    ).toEqual(EXPECTED_NAV_ENTRIES.map(([route, domain, tier, order, required, gate]) => [route, domain, tier, order, required.map(([action, subject]) => [action, subject]), gate]));
  });

  it('pins exactly 58 entries, matching NAV_ENTRIES', () => {
    expect(EXPECTED_NAV_ENTRIES).toHaveLength(NAV_ENTRIES.length);
  });
});

describe('NAV_DOMAINS (TASK-932 R-2 — Platform Ops moved ahead of AI Platform)', () => {
  it('declares the 9 rail domains in the §3.1 order', () => {
    expect(NAV_DOMAINS.map((domain) => domain.id)).toEqual([
      'overview',
      'tenancy',
      'platform-ops',
      'ai-platform',
      'knowledge-agents',
      'clinical',
      'workflow-harness',
      'identity-access',
      'playground',
    ]);
    expect(new Set(NAV_DOMAINS.map((domain) => domain.order)).size).toBe(NAV_DOMAINS.length);
    expect([...NAV_DOMAINS].sort((a, b) => a.order - b.order).map((domain) => domain.id)).toEqual(NAV_DOMAINS.map((domain) => domain.id));
  });

  it('gives every domain a label and a unique icon', () => {
    for (const domain of NAV_DOMAINS) {
      expect(domain.label, `${domain.id} is missing a label`).toBeTruthy();
      expect(domain.icon, `${domain.id} is missing an icon`).toBeDefined();
    }
    expect(new Set(NAV_DOMAINS.map((domain) => domain.icon)).size).toBe(NAV_DOMAINS.length);
  });

  it('assigns every nav entry to a declared domain', () => {
    const ids = new Set<string>(NAV_DOMAINS.map((domain) => domain.id));
    for (const entry of NAV_ENTRIES) {
      expect(entry.domain, `${entry.route} has no domain`).toBeDefined();
      expect(ids.has(entry.domain), `${entry.route} has an undeclared domain "${entry.domain}"`).toBe(true);
    }
  });

  it('gives every declared domain at least one entry', () => {
    for (const domain of NAV_DOMAINS) {
      expect(NAV_ENTRIES.filter((entry) => entry.domain === domain.id).length, `domain "${domain.id}" has no entries`).toBeGreaterThanOrEqual(1);
    }
  });

  it('partitions the rail routes exactly as EXPECTED_NAV_ENTRIES does', () => {
    const expectedByDomain = new Map<NavDomainId, string[]>();
    for (const [route, domain] of EXPECTED_NAV_ENTRIES) {
      expectedByDomain.set(domain, [...(expectedByDomain.get(domain) ?? []), route]);
    }
    for (const [domain, routes] of expectedByDomain) {
      expect(
        NAV_ENTRIES.filter((entry) => entry.domain === domain)
          .map((entry) => entry.route)
          .sort(),
        `domain "${domain}" membership drifted`,
      ).toEqual([...routes].sort());
    }
  });

  it('keeps domain orthogonal to tier — /storage is tenant-tier but Platform Ops (OD-2)', () => {
    const storage = NAV_ENTRIES.find((entry) => entry.route === '/storage');
    expect(storage?.tier).toBe('30-49');
    expect(storage?.domain).toBe('platform-ops');
    // Two domains deliberately span more than one tier; that is the point.
    const tiersOf = (id: NavDomainId) => new Set(NAV_ENTRIES.filter((entry) => entry.domain === id).map((entry) => entry.tier));
    expect(tiersOf('ai-platform').size).toBeGreaterThan(1);
    expect(tiersOf('platform-ops').size).toBeGreaterThan(1);
  });

  it('separates the storage BROWSER (Platform Ops) from tenant storage CONFIG (Tenancy)', () => {
    expect(NAV_ENTRIES.find((entry) => entry.route === '/storage')?.domain).toBe('platform-ops');
    expect(NAV_ENTRIES.find((entry) => entry.route === '/tenants/storage')?.domain).toBe('tenancy');
  });
});

describe('USER_MENU_ENTRIES — the two routes that leave the rail', () => {
  it('removes /developer and /account from the rail', () => {
    expect(NAV_ENTRIES.some((entry) => entry.route === '/developer')).toBe(false);
    expect(NAV_ENTRIES.some((entry) => entry.route === '/account')).toBe(false);
  });

  it('keeps both reachable from the topbar user menu with an unchanged gate (AC-2)', () => {
    expect(USER_MENU_ENTRIES.map((entry) => entry.route)).toEqual(['/developer', '/account']);

    const developer = USER_MENU_ENTRIES.find((entry) => entry.route === '/developer');
    expect(developer?.tier).toBe('20-29');
    expect(developer?.required).toEqual([['read', 'ApiDocumentation']]);
    expect(developer?.implemented).toBe(true);

    const account = USER_MENU_ENTRIES.find((entry) => entry.route === '/account');
    expect(account?.tier).toBe('20-29');
    expect(account?.required).toEqual([]);
    expect(account?.implemented).toBe(true);
  });

  it('still resolves both for the breadcrumb (matchNavEntry spans rail + user menu)', () => {
    expect(matchNavEntry('/developer')?.label).toBe('Developer');
    expect(matchNavEntry('/account')?.label).toBe('Account');
  });

  it('gates the developer portal on the dedicated ApiDocumentation subject, not on manage:all', () => {
    expect(visibleUserMenuEntries([{ action: 'read', subject: 'ApiDocumentation' }]).map((entry) => entry.route)).toEqual(['/developer', '/account']);
    expect(visibleUserMenuEntries([{ action: 'manage', subject: 'Consultation' }]).map((entry) => entry.route)).toEqual(['/account']);
    // Permissions still loading: nothing is asserted, exactly as the sidebar does.
    expect(visibleUserMenuEntries(null)).toEqual([]);
  });
});

describe('visibleNavDomains (AC-3)', () => {
  it('shows a super admin every domain when every gate is open', () => {
    expect(visibleNavDomains(SUPER_ADMIN_RULES, ['SUPER_ADMIN'], ALL_GATES_OPEN).map((domain) => domain.id)).toEqual(NAV_DOMAINS.map((domain) => domain.id));
  });

  it('hides a domain whose every entry is gated closed (Workflow & Harness)', () => {
    const gates: FeatureGateMap = { 'console.workflowHarness.enabled': false };
    expect(visibleNavDomains(SUPER_ADMIN_RULES, ['SUPER_ADMIN'], gates).map((domain) => domain.id)).not.toContain('workflow-harness');
    // Platform Ops keeps showing — most of its entries are ungated.
    expect(visibleNavDomains(SUPER_ADMIN_RULES, ['SUPER_ADMIN'], gates).map((domain) => domain.id)).toContain('platform-ops');
  });

  it('derives visibility from the same entry gate the sidebar uses, never a hardcoded list', () => {
    const visible = visibleNavDomains(TENANT_ADMIN_RULES, ['TENANT_ADMIN'], ALL_GATES_OPEN);
    const expected = NAV_DOMAINS.filter((domain) =>
      visibleNavEntries(TENANT_ADMIN_RULES, ['TENANT_ADMIN'], ALL_GATES_OPEN).some((entry) => entry.domain === domain.id),
    );
    expect(visible).toEqual(expected);
    // A tenant admin holds none of the manage:all platform surfaces.
    expect(visible.map((domain) => domain.id)).not.toContain('overview');
  });

  it('hides a domain whose only routes the caller cannot see', () => {
    const clinicalOnly: PermissionRule[] = [{ action: 'manage', subject: 'Consultation' }];
    expect(visibleNavDomains(clinicalOnly, ['DOCTOR']).map((domain) => domain.id)).toEqual(['clinical']);
  });

  it('honours the playground role check, not just the ability gate', () => {
    const workflowRules: PermissionRule[] = [{ action: 'manage', subject: 'WorkflowDefinition' }];
    expect(visibleNavDomains(workflowRules, ['DOCTOR']).map((domain) => domain.id)).not.toContain('playground');
    expect(visibleNavDomains(workflowRules, ['TENANT_ADMIN']).map((domain) => domain.id)).toContain('playground');
  });

  it('shows nothing while permissions are unknown', () => {
    expect(visibleNavDomains(null, ['SUPER_ADMIN'])).toEqual([]);
    expect(visibleNavDomains(undefined)).toEqual([]);
  });
});

describe('activeNavDomainId (AC-6 — selection is derived from the URL)', () => {
  const all = [...NAV_ENTRIES];

  it('resolves an exact route to its domain', () => {
    expect(activeNavDomainId('/queues', all)).toBe('platform-ops');
  });

  it('resolves a detail route through its parent entry', () => {
    expect(activeNavDomainId('/tenants/t-123', all)).toBe('tenancy');
  });

  it('prefers the longest prefix, so /tenants/storage keeps its own entry', () => {
    expect(activeNavDomainId('/tenants/storage', all)).toBe('tenancy');
    expect(activeNavDomainId('/workflow-studio/assignments', all)).toBe('knowledge-agents');
  });

  it('follows the domain axis, not the tier axis (OD-2)', () => {
    // Tier 30-49 but domain platform-ops — the divergence OD-2 exists for.
    expect(activeNavDomainId('/storage', all)).toBe('platform-ops');
    // …and the converse: a tier-10-19 route that is NOT AI platform work.
    expect(activeNavDomainId('/rate-limits', all)).toBe('platform-ops');
  });

  it('returns undefined for a route the rail does not own', () => {
    // Both moved to the user menu in Phase A; neither belongs to a domain.
    // /ai-configuration is gone from the rail entirely (TASK-932) — the route
    // now redirects, so it resolves no domain either.
    expect(activeNavDomainId('/account', all)).toBeUndefined();
    expect(activeNavDomainId('/developer', all)).toBeUndefined();
    expect(activeNavDomainId('/ai-configuration', all)).toBeUndefined();
    expect(activeNavDomainId('/nope', all)).toBeUndefined();
  });

  it('is computed against the VISIBLE subset, so a hidden route never selects its domain', () => {
    const clinicalOnly: PermissionRule[] = [{ action: 'manage', subject: 'Consultation' }];
    const visible = visibleNavEntries(clinicalOnly, ['DOCTOR']);
    expect(activeNavDomainId('/consultations', visible)).toBe('clinical');
    expect(activeNavDomainId('/queues', visible)).toBeUndefined();
  });
});

describe('domainLandingRoute (Open Question — a rail click always navigates)', () => {
  it("lands on the domain's first visible entry", () => {
    expect(domainLandingRoute('overview', [...NAV_ENTRIES])).toBe('/dashboard');
    // TASK-932: /features is now the first Platform Ops entry (order 1).
    expect(domainLandingRoute('platform-ops', [...NAV_ENTRIES])).toBe('/features');
  });

  it('needs no special case when a domain has exactly one visible route', () => {
    const clinicalOnly: PermissionRule[] = [{ action: 'manage', subject: 'Consultation' }];
    const visible = visibleNavEntries(clinicalOnly, ['DOCTOR']);
    expect(visible.filter((entry) => entry.domain === 'clinical')).toHaveLength(1);
    // The general rule already lands on that one route — no dead click, and no
    // branch in the rail that only a narrow permission set would ever exercise.
    expect(domainLandingRoute('clinical', visible)).toBe('/consultations');
  });

  it('skips entries the caller cannot see rather than linking to a 403', () => {
    // /features and /rate-limits (both manage:all) are declared first in
    // Platform Ops; a caller holding only read:AuditLog must land on the
    // audit log instead.
    const auditOnly: PermissionRule[] = [{ action: 'read', subject: 'AuditLog' }];
    expect(domainLandingRoute('platform-ops', visibleNavEntries(auditOnly, ['DOCTOR']))).toBe('/audit-logs');
  });

  it('returns undefined for a domain with nothing visible', () => {
    expect(domainLandingRoute('playground', visibleNavEntries([{ action: 'read', subject: 'AuditLog' }], ['DOCTOR']))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The rendered inventory (TASK-932 §3.1) — per domain, per tier, as a super
// admin and a tenant admin actually SEE it (through `visibleNavEntries`, not
// the raw declaration), with every gate open so ability is the only variable.
// A future reorder is now a deliberate edit to a literal table, not a diff
// that only touches nav-config.ts.
// ---------------------------------------------------------------------------

/** Builds the same {domain: {tier: [label, ...]}} shape the rail actually renders. */
function renderedInventory(rules: readonly PermissionRule[] | null, roles: readonly string[], gates: FeatureGateMap): Record<string, Record<string, string[]>> {
  const visible = visibleNavEntries(rules, roles, gates);
  const table: Record<string, Record<string, string[]>> = {};
  for (const domain of NAV_DOMAINS) {
    const domainEntries = visible.filter((entry) => entry.domain === domain.id);
    if (domainEntries.length === 0) continue;
    const byTier: Record<string, string[]> = {};
    for (const section of NAV_SECTIONS) {
      const labels = domainEntries.filter((entry) => entry.tier === section.tier).map((entry) => entry.label);
      if (labels.length > 0) byTier[section.tier] = labels;
    }
    table[domain.id] = byTier;
  }
  return table;
}

describe('nav inventory (TASK-932 §3.1) — rendered per domain, per tier', () => {
  it('renders the exact §3.1 inventory for a super admin with every gate open', () => {
    expect(renderedInventory(SUPER_ADMIN_RULES, ['SUPER_ADMIN'], ALL_GATES_OPEN)).toEqual({
      overview: { '10-19': ['Dashboard', 'Monitoring', 'Releases'] },
      tenancy: {
        '10-19': ['Tenants', 'Entitlements & plans', 'Tenant storage', 'Billing & invoices'],
        '20-29': ['Tenant profile'],
        '30-49': ['Departments'],
      },
      'platform-ops': {
        '10-19': [
          'Feature availability',
          'Rate limits',
          'AI operations — runs',
          'AI operations — metrics',
          'Consumption & cost',
          'Queues & jobs',
          'Schedulers',
          'Audit logs',
          'Database Studio',
          'Agentic policy',
          'MLflow',
        ],
        '20-29': ['Settings registry', 'Settings rows & secrets', 'Tools & MCP'],
        '30-49': ['Storage browser'],
      },
      'ai-platform': {
        '10-19': ['AI models', 'AI services', 'LM Studio', 'vLLM', 'Ollama', 'llama.cpp'],
        '20-29': ['AI providers'],
      },
      'knowledge-agents': {
        '30-49': ['Agents', 'Prompt templates', 'Context Schemas', 'Document Templates', 'Knowledge Base', 'DNA writing styles', 'Workflow Studio', 'Workflow Assignments'],
      },
      clinical: { '30-49': ['Patient consent', 'Transcription jobs', 'Consultations'] },
      'workflow-harness': { '30-49': ['Harness policy', 'Harness observability', 'Harness workflows', 'Workflow Runs'] },
      'identity-access': {
        '10-19': ['Security policy'],
        '20-29': ['Users', 'Roles', 'Policies', 'API keys'],
        '30-49': ['Identity providers', 'Allowed origins'],
      },
      playground: {
        '50-59': ['Consultation Scribe', 'Live Transcription', 'My Voice Enrollment & Profiles', 'My DNA Writing Style', 'LLM Playground'],
      },
    });
  });

  it('renders the platform-tier gates as CLOSED by default (D-1) — a super admin sees none of the four gated entries with no gate map', () => {
    const inventory = renderedInventory(SUPER_ADMIN_RULES, ['SUPER_ADMIN'], {});
    expect(inventory['platform-ops']?.['10-19']).not.toContain('Agentic policy');
    expect(inventory['platform-ops']?.['10-19']).not.toContain('MLflow');
    expect(inventory['platform-ops']?.['20-29']).not.toContain('Tools & MCP');
    expect(inventory['workflow-harness']).toBeUndefined();
  });

  it('renders the tenant-admin-visible subset — every platform-tier and gated entry disappears', () => {
    // Reflects the CASL fixture above verbatim (canAny over TENANT_ADMIN_RULES):
    // manage:Department, manage:User, manage:PromptTemplate,
    // manage:TenantAllowedOrigin, read+update:Tenant, read:AuditLog, read:Role.
    // /tenants and /rbac/roles are read-satisfied by that last pair even
    // though the tenant admin holds no `manage` on either — client-side
    // ability ignores row conditions (server enforces them; see ability.ts).
    expect(renderedInventory(TENANT_ADMIN_RULES, ['TENANT_ADMIN'], ALL_GATES_OPEN)).toEqual({
      tenancy: { '10-19': ['Tenants'], '20-29': ['Tenant profile'], '30-49': ['Departments'] },
      'platform-ops': { '10-19': ['Audit logs'] },
      'knowledge-agents': { '30-49': ['Prompt templates'] },
      'identity-access': { '20-29': ['Users', 'Roles'], '30-49': ['Allowed origins'] },
      playground: {
        '50-59': ['Consultation Scribe', 'Live Transcription', 'My Voice Enrollment & Profiles', 'My DNA Writing Style', 'LLM Playground'],
      },
    });
  });

  it('never widens the tenant-admin inventory when every gate is CLOSED — a tenant admin held none of the gated entries anyway', () => {
    expect(renderedInventory(TENANT_ADMIN_RULES, ['TENANT_ADMIN'], {})).toEqual(renderedInventory(TENANT_ADMIN_RULES, ['TENANT_ADMIN'], ALL_GATES_OPEN));
  });
});
