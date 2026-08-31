import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '@/shared/auth/ability';
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

describe('NAV_ENTRIES (capabilities-matrix section 3, reviewed 2026-07-04; playground tier)', () => {
  // /prompt-templates (tier 30-49), taking 45 -> 46.
  // /ai-operations/reconciliation (tier 10-19), taking 46 -> 47.
  // /allowed-origins retiered 10-19 -> 30-49 (tenant admins now reach
  // it for their own tenant's rows); total stays 47.
  // /releases (tier 10-19), taking 47 -> 48.
  // /context-schemas (tier 30-49), taking 48 -> 49.
  // /playground/workbench (tier 50-59, TASK-721), taking 49 -> 50.
  // /workflow-runs (tier 30-49, TASK-723 Phase C — the definition-scoped
  // runs/observability view, cross-linked with /ai-operations/runs), taking
  // 50 -> 51.
  // /workflow-studio (tier 30-49, TASK-719 — a concurrent sibling ticket's
  // graph-authoring surface, landed in this shared file alongside this
  // ticket's own edit), taking 51 -> 52.
  // /workflow-studio/assignments (tier 30-49, TASK-733 — the Studio
  // assignment-matrix screen), taking 53 -> 54.
  // /developer (tier 20-29, TASK-783 — the API documentation portal),
  // taking 54 -> 55.
  // /security-policy (tier 10-19, TASK-786 — the platform credential policy:
  // password complexity/rotation + issued-secret entropy), taking 55 -> 56.
  // TASK-788 Phase A moved /developer and /account OUT of the rail and into
  // USER_MENU_ENTRIES (they are personal chrome, not a capability domain),
  // taking 56 -> 54 and tier 20-29 from 8 -> 6. No route was deleted: both are
  // still declared, still gated identically, and still reachable — see the
  // USER_MENU_ENTRIES describe below.
  // TASK-799 Phase 4 added the two screens whose gateway routes had shipped
  // with no console consumer at all:
  //   /ai-runtime-profiles (tier 10-19, E.2 — the hyperparameter / capacity /
  //     timing plane; five operations under `admin/ai-runtime-profiles` and no
  //     feature folder), taking 54 -> 55 and tier 10-19 from 22 -> 23.
  //   /settings-registry (tier 20-29, E.1 — the descriptor-driven editor over
  //     `admin/settings/catalog` + `admin/settings/registry/:key`; 210
  //     descriptors with exactly ONE consumer, a single hardcoded category),
  //     taking 55 -> 56 and tier 20-29 from 6 -> 7.
  // TASK-805 added `/consent` (the consent register), taking 56 -> 57 and
  // tier 30-49 / domain `clinical` up by one.
  // `/settings` was NOT removed — it keeps the legacy raw-row and secret
  // administration and is relabelled "Settings rows & secrets" to say so.
  // TASK-810 added `/document-templates` (the clinical document SHAPE catalog —
  // the sibling of `/context-schemas`: that screen governs what context may be
  // SUBMITTED, this one what document comes BACK), taking 57 -> 58 and
  // tier 30-49 / domain `knowledge-agents` up by one.
  // TASK-815 REMOVED `/agents` (the Agent Catalog), taking 58 -> 57 and tier
  // 30-49 / domain `knowledge-agents` back down by one. The route itself keeps
  // a one-release `redirect()` to `/prompt-templates`, but a redirect is not a
  // navigable destination and has no place in the rail map.
  // The three platform AI BACKENDS that had no screen added
  // `/ai-services/lm-studio`, `/ai-services/vllm` and `/ai-services/mlflow`
  // (all tier 10-19, domain `ai-platform`), taking 57 -> 60 and tier 10-19 from
  // 23 -> 26. They are rail entries rather than tabs of `/ai-services` because
  // the rail is the platform's inventory of engines and registries.
  it('covers the full 60-route rail map across the four tiers (including /context-schemas, /document-templates, /playground/workbench, /workflow-runs, /workflow-studio, /security-policy)', () => {
    expect(NAV_ENTRIES).toHaveLength(60);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '10-19')).toHaveLength(26);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '20-29')).toHaveLength(7);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '30-49')).toHaveLength(21);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '50-59')).toHaveLength(6);
    // The two routes moved to the user menu are accounted for, not lost.
    expect(NAV_ENTRIES.length + USER_MENU_ENTRIES.length).toBe(62);
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

  // TASK-783's developer-portal gate assertions moved with the entry itself
  // into the USER_MENU_ENTRIES describe below — the ability contract
  // (`read:ApiDocumentation`, a DEDICATED delegable subject rather than
  // `manage:all`) is unchanged and still asserted there.
  it('no longer surfaces the developer portal or the account page from the rail', () => {
    const developerRules: PermissionRule[] = [{ action: 'read', subject: 'ApiDocumentation' }];
    expect(visibleNavEntries(developerRules, ['DOCTOR']).map((entry) => entry.route)).not.toContain('/developer');
    expect(visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN']).map((entry) => entry.route)).not.toContain('/account');
  });

  it('merges the standalone /stt-config, /tts-config and /ai-providers screens into the /ai-configuration hub', () => {
    for (const route of ['/stt-config', '/tts-config', '/ai-providers']) {
      expect(NAV_ENTRIES.some((entry) => entry.route === route)).toBe(false);
    }
    expect(NAV_ENTRIES.some((entry) => entry.route === '/ai-configuration')).toBe(true);
  });

  it('tiers the task-default surfaces: platform defaults global-only, tenant AI configuration tenant-scoped', () => {
    const platform = NAV_ENTRIES.find((entry) => entry.route === '/ai-task-defaults');
    expect(platform?.tier).toBe('10-19');
    expect(platform?.required).toEqual([['manage', 'all']]);
    expect(platform?.implemented).toBe(true);
    // Renamed from `/ai-model-defaults`; the old route now only
    // serves a redirect and must be gone from the nav.
    expect(NAV_ENTRIES.some((entry) => entry.route === '/ai-model-defaults')).toBe(false);
    const tenant = NAV_ENTRIES.find((entry) => entry.route === '/ai-configuration');
    expect(tenant?.label).toBe('AI Configuration');
    expect(tenant?.tier).toBe('30-49');
    // The hub spans four resources, so it is OR-gated over the four
    // reads (Models/Speech/Voice/Providers) — visible if the caller can read any.
    expect(tenant?.required).toEqual([
      ['read', 'AiTaskDefault'],
      ['read', 'TenantSttConfig'],
      ['read', 'TenantTtsConfig'],
      ['read', 'GlobalSetting'],
    ]);
    expect(tenant?.implemented).toBe(true);
  });

  it('re-tiers AI models to super-admin only and folds frontend config into the tenant detail', () => {
    const aiModels = NAV_ENTRIES.find((entry) => entry.route === '/ai-models');
    expect(aiModels?.tier).toBe('10-19');
    expect(aiModels?.required).toEqual([['manage', 'all']]);
    expect(NAV_ENTRIES.some((entry) => entry.route === '/tenants/frontend-config')).toBe(false);
  });

  // The entry was hidden (`implemented: false`, reachable only by
  // direct URL) while the screen was registry-only. It is now the AI-models
  // hub (registry + live discovery + register), so it is a first-class,
  // navigable super-admin surface.
  it('exposes /ai-models as an implemented, navigable hub', () => {
    const aiModels = NAV_ENTRIES.find((entry) => entry.route === '/ai-models');
    expect(aiModels?.implemented).toBe(true);
  });

  it('has unique routes and a section per tier', () => {
    const routes = NAV_ENTRIES.map((entry) => entry.route);
    expect(new Set(routes).size).toBe(routes.length);
    expect(NAV_SECTIONS.map((section) => section.tier)).toEqual(['10-19', '20-29', '30-49', '50-59']);
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

  it('routes every playground entry under /playground; the five demo planes keep an empty ability gate (role-gated instead)', () => {
    const playground = NAV_ENTRIES.filter((entry) => entry.tier === '50-59');
    expect(playground.map((entry) => entry.route)).toEqual([
      '/playground/consultation',
      '/playground/live-transcription',
      '/playground/voice-profiles',
      '/playground/dna-writing-style',
      '/playground/llm',
      '/playground/workbench',
    ]);
    const demoPlanes = playground.filter((entry) => entry.route !== '/playground/workbench');
    expect(demoPlanes.every((entry) => entry.required.length === 0)).toBe(true);
  });

  // TASK-721 Phase C: the Workbench deliberately breaks the tier's
  // `required: []` convention because it reads/executes tenant
  // WorkflowDefinition/WorkflowRun rows (resource abilities), not an
  // own-account demo action. Reconciled against the real, now-landed
  // decorators: WorkflowDefinitionController's class-level
  // @CanManage('WorkflowDefinition') and WorkflowSandboxRunController's
  // @CanCreate/@CanRead/@CanUpdate('WorkflowRun') (all subsumed by
  // manage:WorkflowRun).
  it('gates the Workbench on WorkflowDefinition/WorkflowRun abilities, unlike its playground siblings', () => {
    const workbench = NAV_ENTRIES.find((entry) => entry.route === '/playground/workbench');
    expect(workbench?.tier).toBe('50-59');
    expect(workbench?.required).toEqual([
      ['manage', 'WorkflowDefinition'],
      ['manage', 'WorkflowRun'],
    ]);
    expect(workbench?.implemented).toBe(true);
    // Still requires the admin-tier role check (isAdminTier) like every
    // other tier-50-59 entry — an ability grant alone is not enough.
    const workflowAbilityRules: PermissionRule[] = [{ action: 'manage', subject: 'WorkflowDefinition' }];
    expect(visibleNavEntries(workflowAbilityRules, ['DOCTOR']).map((entry) => entry.route)).not.toContain('/playground/workbench');
    // An admin role WITHOUT the ability also does not see it (ability gate
    // still applies on top of the role check) — TENANT_ADMIN_RULES above is
    // deliberately narrower than the real seed and omits both abilities.
    expect(visibleNavEntries(TENANT_ADMIN_RULES, ['TENANT_ADMIN']).map((entry) => entry.route)).not.toContain('/playground/workbench');
    // Either ability alone is sufficient (canAny/OR) — mirrors the seeded
    // tenant-admin grant, which holds both together.
    expect(visibleNavEntries(workflowAbilityRules, ['TENANT_ADMIN']).map((entry) => entry.route)).toContain('/playground/workbench');
  });

  /**
   * Console IA cleanup: `/prompt-studio` folded into `/agents`, `/ai-services`
   * took its slot. `/allowed-origins` moved OUT of tier 10-19;
   * see the dedicated retier test below.
   */
  describe('console IA cleanup', () => {
    it('retires /prompt-studio (governance moved into the prompt-template Governance tab)', () => {
      expect(NAV_ENTRIES.some((entry) => entry.route === '/prompt-studio')).toBe(false);
      // The surface it folded into now has its own nav entry.
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
  it('shows a super admin every implemented entry (manage:all grants all tiers)', () => {
    const visible = visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN']);
    const implemented = NAV_ENTRIES.filter((entry) => entry.implemented);
    expect(visible.map((entry) => entry.route)).toEqual(implemented.map((entry) => entry.route));
  });

  it('shows /ai-models to a super admin now that the hub is implemented', () => {
    expect(visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN']).map((entry) => entry.route)).toContain('/ai-models');
  });

  it('hides super-admin-only entries from tenant admins but keeps shared screens and the playground', () => {
    const visible = visibleNavEntries(TENANT_ADMIN_RULES, ['TENANT_ADMIN']).map((entry) => entry.route);
    expect(visible).not.toContain('/dashboard');
    expect(visible).not.toContain('/monitoring');
    // Still super-admin only (manage:all) — now visible to super admins,
    // never to tenant admins.
    expect(visible).not.toContain('/ai-models');
    expect(visible).toContain('/users');
    expect(visible).toContain('/tenant-profile');
    // TASK-788: /account left the rail for the user menu.
    expect(visible).not.toContain('/account');
    expect(visibleUserMenuEntries(TENANT_ADMIN_RULES).map((entry) => entry.route)).toContain('/account');
    expect(visible).toContain('/playground/consultation');
    expect(visible).toContain('/playground/llm');
    // A tenant admin now reaches the retiered allowed-origins screen.
    expect(visible).toContain('/allowed-origins');
  });

  it('shows an authenticated user with zero grants nothing in the rail', () => {
    // Every rail route is now ability-gated: /account was the one ungated entry
    // and TASK-788 moved it to the user menu, where it still renders.
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
    const visible = visibleNavEntries(SUPER_ADMIN_RULES, ['SUPER_ADMIN']);
    expect(visible.every((entry) => entry.implemented)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TASK-788 Phase A — the capability-DOMAIN axis.
//
// The rail groups by capability domain (OD-2); the existing NavTier keeps
// answering *who may open a screen* and is untouched (OD-3). AC-1/AC-2 promise
// the new axis is PURELY additive, so the guard below pins every route string,
// tier and ability pair verbatim: a future edit cannot relocate a guard without
// the diff also touching this table.
// ---------------------------------------------------------------------------

/**
 * FROZEN 2026-08-22 (dev-2.2, pre-Phase-A). The 54 rail routes with their tier
 * and ability gate, dumped from `NAV_ENTRIES` before the `domain` field was
 * added. Declaration order is pinned too — it is the order the sidebar renders.
 */
const FROZEN_RAIL_ENTRIES: ReadonlyArray<readonly [string, NavTier, ReadonlyArray<readonly [string, string]>]> = [
  ['/dashboard', '10-19', [['manage', 'PlatformMetrics']]],
  [
    '/monitoring',
    '10-19',
    [
      ['manage', 'all'],
      ['read', 'TenantTelemetry'],
    ],
  ],
  [
    '/releases',
    '10-19',
    [
      ['manage', 'all'],
      ['read', 'TenantTelemetry'],
    ],
  ],
  [
    '/tenants',
    '10-19',
    [
      ['manage', 'Tenant'],
      ['update', 'Tenant'],
    ],
  ],
  ['/entitlements', '10-19', [['manage', 'all']]],
  [
    '/tenants/storage',
    '10-19',
    [
      ['manage', 'Tenant'],
      ['read', 'Storage'],
    ],
  ],
  ['/ai-models', '10-19', [['manage', 'all']]],
  ['/ai-task-defaults', '10-19', [['manage', 'all']]],
  // TASK-799 Phase 4 E.2 — hyperparameters/capacity/timing, SYSTEM-tenant only.
  ['/ai-runtime-profiles', '10-19', [['manage', 'all']]],
  ['/rate-limits', '10-19', [['manage', 'all']]],
  ['/security-policy', '10-19', [['manage', 'all']]],
  ['/agentic-policy', '10-19', [['manage', 'all']]],
  ['/ai-services', '10-19', [['manage', 'all']]],
  // The three platform AI backends that had no screen. Same gate as their
  // parent: platform infrastructure, cross-tenant, SUPER_ADMIN only.
  ['/ai-services/lm-studio', '10-19', [['manage', 'all']]],
  ['/ai-services/vllm', '10-19', [['manage', 'all']]],
  ['/ai-services/mlflow', '10-19', [['manage', 'all']]],
  ['/ai-operations/runs', '10-19', [['manage', 'all']]],
  ['/ai-operations/metrics', '10-19', [['manage', 'all']]],
  ['/ai-operations/consumption', '10-19', [['manage', 'all']]],
  ['/ai-operations/reconciliation', '10-19', [['manage', 'all']]],
  ['/billing', '10-19', [['manage', 'all']]],
  ['/tools-mcp', '10-19', [['manage', 'all']]],
  ['/queues', '10-19', [['manage', 'all']]],
  ['/schedulers', '10-19', [['manage', 'all']]],
  ['/audit-logs', '10-19', [['read', 'AuditLog']]],
  ['/db-studio', '10-19', [['manage', 'all']]],
  ['/users', '20-29', [['manage', 'User']]],
  [
    '/rbac/roles',
    '20-29',
    [
      ['read', 'Role'],
      ['manage', 'Role'],
    ],
  ],
  [
    '/rbac/policies',
    '20-29',
    [
      ['read', 'Policy'],
      ['manage', 'Policy'],
    ],
  ],
  [
    '/api-keys',
    '20-29',
    [
      ['read', 'ApiKey'],
      ['manage', 'ApiKey'],
    ],
  ],
  // TASK-799 Phase 4 E.1 — the descriptor-driven registry lane. `read` as well
  // as `manage`: the catalog is RBAC-filtered and readable by any admin, and
  // which keys are WRITABLE (and at which scope) is decided per descriptor.
  ['/settings-registry', '20-29', [
    ['read', 'GlobalSetting'],
    ['manage', 'GlobalSetting'],
  ]],
  ['/settings', '20-29', [['manage', 'GlobalSetting']]],
  [
    '/tenant-profile',
    '20-29',
    [
      ['read', 'Tenant'],
      ['update', 'Tenant'],
    ],
  ],
  ['/departments', '30-49', [['manage', 'Department']]],
  [
    '/identity-providers',
    '30-49',
    [
      ['read', 'TenantIdentityProvider'],
      ['manage', 'TenantIdentityProvider'],
    ],
  ],
  [
    '/allowed-origins',
    '30-49',
    [
      ['read', 'TenantAllowedOrigin'],
      ['manage', 'TenantAllowedOrigin'],
    ],
  ],
  [
    '/storage',
    '30-49',
    [
      ['read', 'Storage'],
      ['manage', 'Storage'],
    ],
  ],
  ['/prompt-templates', '30-49', [['manage', 'PromptTemplate']]],
  ['/context-schemas', '30-49', [['manage', 'ConsultationContextSchema']]],
  // TASK-810 — the clinical document SHAPE catalog. `manage:DocumentTemplate`
  // is the whole gate (`DocumentTemplateAdminController`'s class-level
  // `@CanManage`); this resource carries no imperative privilege check.
  ['/document-templates', '30-49', [['manage', 'DocumentTemplate']]],
  ['/knowledge', '30-49', [['manage', 'KnowledgeDocument']]],
  ['/dna-writing-styles', '30-49', [['manage', 'DnaWritingStyleReport']]],
  // TASK-805 — the consent register.
  ['/consent', '30-49', [['manage', 'ConsentGrant']]],
  ['/audio/pipelines', '30-49', [['manage', 'AsrPipeline']]],
  [
    '/audio/transcription-jobs',
    '30-49',
    [
      ['read', 'AsrPipeline'],
      ['manage', 'Tenant'],
    ],
  ],
  [
    '/harness/policy',
    '30-49',
    [
      ['read', 'HarnessPolicy'],
      ['manage', 'HarnessPolicy'],
    ],
  ],
  [
    '/harness/observability',
    '30-49',
    [
      ['read', 'HarnessAudit'],
      ['read', 'HarnessEval'],
      ['read', 'HarnessWorkflow'],
    ],
  ],
  [
    '/harness/workflows',
    '30-49',
    [
      ['read', 'HarnessWorkflow'],
      ['manage', 'HarnessWorkflow'],
    ],
  ],
  [
    '/harness/pipeline-policy',
    '30-49',
    [
      ['read', 'PipelinePolicy'],
      ['manage', 'PipelinePolicy'],
    ],
  ],
  ['/workflow-runs', '30-49', [['read', 'WorkflowRun']]],
  ['/workflow-studio', '30-49', [['manage', 'WorkflowDefinition']]],
  ['/workflow-studio/assignments', '30-49', [['manage', 'WorkflowDefinition']]],
  [
    '/ai-configuration',
    '30-49',
    [
      ['read', 'AiTaskDefault'],
      ['read', 'TenantSttConfig'],
      ['read', 'TenantTtsConfig'],
      ['read', 'GlobalSetting'],
    ],
  ],
  ['/consultations', '30-49', [['manage', 'Consultation']]],
  ['/playground/consultation', '50-59', []],
  ['/playground/live-transcription', '50-59', []],
  ['/playground/voice-profiles', '50-59', []],
  ['/playground/dna-writing-style', '50-59', []],
  ['/playground/llm', '50-59', []],
  [
    '/playground/workbench',
    '50-59',
    [
      ['manage', 'WorkflowDefinition'],
      ['manage', 'WorkflowRun'],
    ],
  ],
];

/** The 9 domains of the ticket's Domain Model, verbatim. */
const FROZEN_DOMAIN_MEMBERSHIP: ReadonlyArray<readonly [NavDomainId, readonly string[]]> = [
  ['overview', ['/dashboard', '/monitoring', '/releases']],
  ['tenancy', ['/tenants', '/tenants/storage', '/entitlements', '/billing', '/tenant-profile', '/departments']],
  [
    'ai-platform',
    [
      '/ai-models',
      '/ai-task-defaults',
      '/ai-services',
      '/agentic-policy',
      '/ai-configuration',
      '/tools-mcp',
      '/ai-operations/runs',
      '/ai-operations/metrics',
      '/ai-operations/consumption',
      '/ai-operations/reconciliation',
      // TASK-799 Phase 4 E.2.
      '/ai-runtime-profiles',
      // The self-hosted engines and the model registry of record.
      '/ai-services/lm-studio',
      '/ai-services/vllm',
      '/ai-services/mlflow',
    ],
  ],
  // `/document-templates` (TASK-810) sits next to `/context-schemas`: the two
  // halves of one contract — what context may go in, what document comes out.
  ['knowledge-agents', ['/prompt-templates', '/context-schemas', '/document-templates', '/knowledge', '/dna-writing-styles']],
  ['clinical', ['/consultations', '/consent', '/audio/pipelines', '/audio/transcription-jobs']],
  [
    'workflow-harness',
    [
      '/harness/policy',
      '/harness/observability',
      '/harness/workflows',
      '/harness/pipeline-policy',
      '/workflow-runs',
      '/workflow-studio',
      '/workflow-studio/assignments',
    ],
  ],
  ['identity-access', ['/users', '/rbac/roles', '/rbac/policies', '/api-keys', '/identity-providers', '/allowed-origins', '/security-policy']],
  // `/settings-registry` (TASK-799 Phase 4 E.1) joins `/settings` here: same
  // domain, different resource — descriptor-governed keys vs raw rows/secrets.
  ['platform-ops', ['/queues', '/schedulers', '/audit-logs', '/db-studio', '/rate-limits', '/settings-registry', '/settings', '/storage']],
  [
    'playground',
    [
      '/playground/consultation',
      '/playground/live-transcription',
      '/playground/voice-profiles',
      '/playground/dna-writing-style',
      '/playground/llm',
      '/playground/workbench',
    ],
  ],
];

describe('TASK-788 AC-2 — the domain axis is purely additive', () => {
  it('leaves every route string, tier and ability pair exactly where it was', () => {
    expect(NAV_ENTRIES.map((entry) => [entry.route, entry.tier, entry.required.map(([action, subject]) => [action, subject])])).toEqual(
      FROZEN_RAIL_ENTRIES.map(([route, tier, required]) => [route, tier, required.map(([action, subject]) => [action, subject])]),
    );
  });

  it('keeps the four tier sections and their labels (OD-3 — tier still governs the guards)', () => {
    expect(NAV_SECTIONS).toEqual([
      { tier: '10-19', label: 'Platform' },
      { tier: '20-29', label: 'Administration' },
      { tier: '30-49', label: 'Tenant' },
      { tier: '50-59', label: 'Playground' },
    ]);
  });
});

describe('NAV_DOMAINS', () => {
  it('declares the 9 rail domains in a stable, unique order', () => {
    expect(NAV_DOMAINS.map((domain) => domain.id)).toEqual(FROZEN_DOMAIN_MEMBERSHIP.map(([id]) => id));
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

  // 3·6·11·5·4·7·7·8·6 — ai-platform 10 -> 11 (/ai-runtime-profiles) and
  // platform-ops 7 -> 8 (/settings-registry), both TASK-799 Phase 4; clinical
  // 3 -> 4 (/consent, TASK-805).
  // knowledge-agents 6 -> 5 (TASK-815 removed /agents).
  // ai-platform 11 -> 14: LM Studio, vLLM and MLflow.
  it('partitions the 60 rail routes exactly as the ticket Domain Model does (3·6·14·5·4·7·7·8·6)', () => {
    for (const [id, routes] of FROZEN_DOMAIN_MEMBERSHIP) {
      expect(
        NAV_ENTRIES.filter((entry) => entry.domain === id)
          .map((entry) => entry.route)
          .sort(),
        `domain "${id}" membership drifted`,
      ).toEqual([...routes].sort());
    }
    expect(NAV_ENTRIES).toHaveLength(60);
  });

  it('keeps domain orthogonal to tier — /ai-configuration is tenant-tier but AI Platform (OD-2)', () => {
    const aiConfiguration = NAV_ENTRIES.find((entry) => entry.route === '/ai-configuration');
    expect(aiConfiguration?.tier).toBe('30-49');
    expect(aiConfiguration?.domain).toBe('ai-platform');
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
  it('shows a super admin every domain', () => {
    expect(visibleNavDomains(SUPER_ADMIN_RULES, ['SUPER_ADMIN']).map((domain) => domain.id)).toEqual(NAV_DOMAINS.map((domain) => domain.id));
  });

  it('derives visibility from the same entry gate the sidebar uses, never a hardcoded list', () => {
    const visible = visibleNavDomains(TENANT_ADMIN_RULES, ['TENANT_ADMIN']);
    const expected = NAV_DOMAINS.filter((domain) =>
      visibleNavEntries(TENANT_ADMIN_RULES, ['TENANT_ADMIN']).some((entry) => entry.domain === domain.id),
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

describe('activeNavDomainId (TASK-788 AC-6 — selection is derived from the URL)', () => {
  const all = [...NAV_ENTRIES];

  it('resolves an exact route to its domain', () => {
    expect(activeNavDomainId('/queues', all)).toBe('platform-ops');
  });

  it('resolves a detail route through its parent entry', () => {
    expect(activeNavDomainId('/tenants/t-123', all)).toBe('tenancy');
  });

  it('prefers the longest prefix, so /tenants/storage keeps its own entry', () => {
    expect(activeNavDomainId('/tenants/storage', all)).toBe('tenancy');
    expect(activeNavDomainId('/workflow-studio/assignments', all)).toBe('workflow-harness');
  });

  it('follows the domain axis, not the tier axis (OD-2)', () => {
    // Tier 30-49 but domain ai-platform — the divergence OD-2 exists for.
    expect(activeNavDomainId('/ai-configuration', all)).toBe('ai-platform');
    // …and the converse: a tier-10-19 route that is NOT AI platform work.
    expect(activeNavDomainId('/rate-limits', all)).toBe('platform-ops');
  });

  it('returns undefined for a route the rail does not own', () => {
    // Both moved to the user menu in Phase A; neither belongs to a domain.
    expect(activeNavDomainId('/account', all)).toBeUndefined();
    expect(activeNavDomainId('/developer', all)).toBeUndefined();
    expect(activeNavDomainId('/nope', all)).toBeUndefined();
  });

  it('is computed against the VISIBLE subset, so a hidden route never selects its domain', () => {
    const clinicalOnly: PermissionRule[] = [{ action: 'manage', subject: 'Consultation' }];
    const visible = visibleNavEntries(clinicalOnly, ['DOCTOR']);
    expect(activeNavDomainId('/consultations', visible)).toBe('clinical');
    expect(activeNavDomainId('/queues', visible)).toBeUndefined();
  });
});

describe('domainLandingRoute (TASK-788 Open Question — a rail click always navigates)', () => {
  it('lands on the domain\'s first visible entry', () => {
    expect(domainLandingRoute('overview', [...NAV_ENTRIES])).toBe('/dashboard');
    expect(domainLandingRoute('platform-ops', [...NAV_ENTRIES])).toBe('/rate-limits');
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
    // /rate-limits (manage:all) is the first platform-ops entry declared; a
    // caller holding only read:AuditLog must land on the audit log instead.
    const auditOnly: PermissionRule[] = [{ action: 'read', subject: 'AuditLog' }];
    expect(domainLandingRoute('platform-ops', visibleNavEntries(auditOnly, ['DOCTOR']))).toBe('/audit-logs');
  });

  it('returns undefined for a domain with nothing visible', () => {
    expect(domainLandingRoute('playground', visibleNavEntries([{ action: 'read', subject: 'AuditLog' }], ['DOCTOR']))).toBeUndefined();
  });
});
