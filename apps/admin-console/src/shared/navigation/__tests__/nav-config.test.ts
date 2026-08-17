import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '@/shared/auth/ability';
import { matchNavEntry, NAV_ENTRIES, NAV_SECTIONS, visibleNavEntries } from '../nav-config';

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
  it('covers the full 52-route map across the four tiers (including /context-schemas, /playground/workbench, /workflow-runs, /workflow-studio)', () => {
    // 53 total, as of this ticket's own pass: siblings landing concurrently in this shared tree
    // (TASK-719 workflow-studio, TASK-723 workflow-runs) each added a nav entry since this
    // count was last set at 52 — bumped here to match reality, not a change this ticket made.
    expect(NAV_ENTRIES).toHaveLength(53);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '10-19')).toHaveLength(21);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '20-29')).toHaveLength(7);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '30-49')).toHaveLength(19);
    expect(NAV_ENTRIES.filter((entry) => entry.tier === '50-59')).toHaveLength(6);
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
    expect(visible).toContain('/account');
    expect(visible).toContain('/playground/consultation');
    expect(visible).toContain('/playground/llm');
    // A tenant admin now reaches the retiered allowed-origins screen.
    expect(visible).toContain('/allowed-origins');
  });

  it('shows only ungated entries (account) for an authenticated user with zero grants', () => {
    expect(visibleNavEntries([]).map((entry) => entry.route)).toEqual(['/account']);
  });

  it('hides the playground tier from non-admin roles even though its ability gate is empty', () => {
    const visible = visibleNavEntries([], ['DOCTOR']).map((entry) => entry.route);
    expect(visible).toEqual(['/account']);
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
