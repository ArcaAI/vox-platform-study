import {
  IconActivity,
  IconAdjustmentsAlt,
  IconAdjustmentsCog,
  IconBinaryTree2,
  IconBook2,
  IconBrain,
  IconBroadcast,
  IconBuilding,
  IconBuildings,
  IconCalendarTime,
  IconChartHistogram,
  IconDatabase,
  IconDatabaseSearch,
  IconDna,
  IconDna2,
  IconFileText,
  IconFingerprint,
  IconFlask,
  IconFolders,
  IconGauge,
  IconHeartbeat,
  IconHistory,
  IconKey,
  IconLayoutDashboard,
  IconLayoutGrid,
  IconLicense,
  IconListTree,
  IconMicrophone,
  IconPlugConnected,
  IconRobot,
  IconSchema,
  IconServerCog,
  IconRoute,
  IconSettings,
  IconShieldBolt,
  IconShieldCog,
  IconShieldLock,
  IconSitemap,
  IconSparkles,
  IconStack2,
  IconStethoscope,
  IconTargetArrow,
  IconTelescope,
  IconTimeline,
  IconUserCircle,
  IconUsers,
  IconUserScan,
  IconUserShield,
  IconVersions,
  IconWaveSine,
  IconWorld,
  IconReportMoney,
  IconScale,
  IconReceipt,
  type TablerIcon,
} from '@tabler/icons-react';
import { canAny, isElevated, type PermissionRule } from '@/shared/auth/ability';

/**
 * Full route map from the capabilities matrix (section 3, frames 10-40, as
 * reviewed 2026-07-04: AI models re-tiered to 10-19, tenant frontend config
 * folded into the tenant-detail tab). All design gates cleared (B0/B1/B2
 * approved 2026-07-05; Playground 50-59 approved 2026-07-06). The
 * sidebar only renders implemented entries the caller's ability grants;
 * AI models is hidden (implemented: false).
 */
export type NavTier = '10-19' | '20-29' | '30-49' | '50-59';

export interface NavEntry {
  route: string;
  label: string;
  tier: NavTier;
  /** Decorative leading icon; the icon-collapsed rail shows it alone (unique per entry). */
  icon: TablerIcon;
  /**
   * Ability gate: visible when ANY pair is granted (mirrors the gateway's
   * CanAny guards). An empty list means any authenticated user.
   */
  required: ReadonlyArray<readonly [string, string]>;
  implemented: boolean;
}

export interface NavSection {
  tier: NavTier;
  label: string;
}

export const NAV_SECTIONS: readonly NavSection[] = [
  { tier: '10-19', label: 'Platform' },
  { tier: '20-29', label: 'Administration' },
  { tier: '30-49', label: 'Tenant' },
  { tier: '50-59', label: 'Playground' },
];

export const NAV_ENTRIES: readonly NavEntry[] = [
  // Tier 10-19 — super admin (cross-tenant). Tenant frontend config is a
  // tenant-detail tab (matrix row 6), not a standalone nav entry.
  { route: '/dashboard', label: 'Dashboard', tier: '10-19', icon: IconLayoutDashboard, required: [['manage', 'PlatformMetrics']], implemented: true },
  {
    route: '/monitoring',
    label: 'Monitoring',
    tier: '10-19',
    icon: IconActivity,
    required: [
      ['manage', 'all'],
      ['read', 'TenantTelemetry'],
    ],
    implemented: true,
  },
  {
    // service version & release registry. Same gate as
    // `/admin/monitoring` and `/admin/health/services` (frozen contract): grouped
    // together in the sidebar.
    route: '/releases',
    label: 'Releases',
    tier: '10-19',
    icon: IconVersions,
    required: [
      ['manage', 'all'],
      ['read', 'TenantTelemetry'],
    ],
    implemented: true,
  },
  {
    route: '/tenants',
    label: 'Tenants',
    tier: '10-19',
    icon: IconBuildings,
    required: [
      ['manage', 'Tenant'],
      ['update', 'Tenant'],
    ],
    implemented: true,
  },
  { route: '/entitlements', label: 'Entitlements & plans', tier: '10-19', icon: IconLicense, required: [['manage', 'all']], implemented: true },
  {
    route: '/tenants/storage',
    label: 'Tenant storage',
    tier: '10-19',
    icon: IconDatabase,
    required: [
      ['manage', 'Tenant'],
      ['read', 'Storage'],
    ],
    implemented: true,
  },
  // Super-admin only per the 2026-07-04 review (backend guard re-pin:).
  // Unhidden: the screen is now the AI-models HUB (registry grid +
  // live LM Studio/Ollama discovery + register), i.e. the surface a super admin
  // uses to see what the serving engines actually host. It was hidden only while
  // it was registry-only. The manage:all gate is unchanged.
  { route: '/ai-models', label: 'AI models', tier: '10-19', icon: IconBrain, required: [['manage', 'all']], implemented: true },
  // SYSTEM-tenant task-default rows; guardrail config is super-admin-only by owner directive.
  {
    route: '/ai-task-defaults',
    label: 'AI task defaults',
    tier: '10-19',
    icon: IconAdjustmentsCog,
    required: [['manage', 'all']],
    implemented: true,
  },
  { route: '/rate-limits', label: 'Rate limits', tier: '10-19', icon: IconGauge, required: [['manage', 'all']], implemented: true },
  // Phase 3B agentic super-admin console (all SUPER_ADMIN-only).
  { route: '/agentic-policy', label: 'Agentic policy', tier: '10-19', icon: IconShieldBolt, required: [['manage', 'all']], implemented: true },
  // `/prompt-studio` retired — prompt governance folded
  // into the elevated-only Governance tab of `/agents` (one authoritative
  // surface per resource). `/prompt-studio` still resolves for one release
  // via a redirect page.: `/ai-services` takes the freed slot,
  // surfacing the guardrail/NLP status + config backends that had no screen.
  { route: '/ai-services', label: 'AI services', tier: '10-19', icon: IconServerCog, required: [['manage', 'all']], implemented: true },
  {
    route: '/ai-operations/runs',
    label: 'AI operations — runs',
    tier: '10-19',
    icon: IconTimeline,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    route: '/ai-operations/metrics',
    label: 'AI operations — metrics',
    tier: '10-19',
    icon: IconChartHistogram,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    route: '/ai-operations/consumption',
    label: 'Consumption & cost',
    tier: '10-19',
    icon: IconReportMoney,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    // the provider-reconciliation audit trail. Platform-wide
    // (a vendor bills the platform, not a tenant), so tier 10-19 with no
    // working-tenant gate, unlike its /ai-operations neighbours.
    route: '/ai-operations/reconciliation',
    label: 'Provider reconciliation',
    tier: '10-19',
    icon: IconScale,
    required: [['manage', 'all']],
    implemented: true,
  },
  { route: '/billing', label: 'Billing & invoices', tier: '10-19', icon: IconReceipt, required: [['manage', 'all']], implemented: true },
  { route: '/tools-mcp', label: 'Tools & MCP', tier: '10-19', icon: IconPlugConnected, required: [['manage', 'all']], implemented: true },
  { route: '/queues', label: 'Queues & jobs', tier: '10-19', icon: IconStack2, required: [['manage', 'all']], implemented: true },
  { route: '/schedulers', label: 'Schedulers', tier: '10-19', icon: IconCalendarTime, required: [['manage', 'all']], implemented: true },
  { route: '/audit-logs', label: 'Audit logs', tier: '10-19', icon: IconHistory, required: [['read', 'AuditLog']], implemented: true },
  // Renamed from `/pstudio` (read as a typo'd "prompt
  // studio"). Console-only rename — the gateway path stays `/admin/pstudio/*`.
  { route: '/db-studio', label: 'Database Studio', tier: '10-19', icon: IconDatabaseSearch, required: [['manage', 'all']], implemented: true },

  // Tier 20-29 — shared (cross-tenant or tenant-scoped)
  { route: '/users', label: 'Users', tier: '20-29', icon: IconUsers, required: [['manage', 'User']], implemented: true },
  {
    route: '/rbac/roles',
    label: 'Roles',
    tier: '20-29',
    icon: IconUserShield,
    required: [
      ['read', 'Role'],
      ['manage', 'Role'],
    ],
    implemented: true,
  },
  {
    route: '/rbac/policies',
    label: 'Policies',
    tier: '20-29',
    icon: IconShieldLock,
    required: [
      ['read', 'Policy'],
      ['manage', 'Policy'],
    ],
    implemented: true,
  },
  {
    route: '/api-keys',
    label: 'API keys',
    tier: '20-29',
    icon: IconKey,
    required: [
      ['read', 'ApiKey'],
      ['manage', 'ApiKey'],
    ],
    implemented: true,
  },
  { route: '/settings', label: 'Settings & secrets', tier: '20-29', icon: IconSettings, required: [['manage', 'GlobalSetting']], implemented: true },
  {
    route: '/tenant-profile',
    label: 'Tenant profile',
    tier: '20-29',
    icon: IconBuilding,
    required: [
      ['read', 'Tenant'],
      ['update', 'Tenant'],
    ],
    implemented: true,
  },
  { route: '/account', label: 'Account', tier: '20-29', icon: IconUserCircle, required: [], implemented: true },

  // Tier 30-49 — tenant-admin scope (a super admin needs a working tenant)
  { route: '/departments', label: 'Departments', tier: '30-49', icon: IconSitemap, required: [['manage', 'Department']], implemented: true },
  {
    route: '/identity-providers',
    label: 'Identity providers',
    tier: '30-49',
    icon: IconFingerprint,
    required: [
      ['read', 'TenantIdentityProvider'],
      ['manage', 'TenantIdentityProvider'],
    ],
    implemented: true,
  },
  // Retiered from 10-19: tenant admins now manage their own
  // exact-origin rows; wildcard/SYSTEM rows stay SUPER_ADMIN-only, enforced
  // in the service, not the nav gate.
  {
    route: '/allowed-origins',
    label: 'Allowed origins',
    tier: '30-49',
    icon: IconWorld,
    required: [
      ['read', 'TenantAllowedOrigin'],
      ['manage', 'TenantAllowedOrigin'],
    ],
    implemented: true,
  },
  {
    route: '/storage',
    label: 'Storage browser',
    tier: '30-49',
    icon: IconFolders,
    required: [
      ['read', 'Storage'],
      ['manage', 'Storage'],
    ],
    implemented: true,
  },
  { route: '/agents', label: 'Agents', tier: '30-49', icon: IconRobot, required: [['manage', 'PromptTemplate']], implemented: true },
  // Prompt instruction templates got their own route: the
  // pre-summary/summary resolution map, template CRUD + versions, and clinical
  // approval, previously buried as tabs 2 and 3 of the Agent Catalog.
  {
    route: '/prompt-templates',
    label: 'Prompt templates',
    tier: '30-49',
    icon: IconFileText,
    required: [['manage', 'PromptTemplate']],
    implemented: true,
  },
  {
    // tenant-defined consultation context vocabulary.
    route: '/context-schemas',
    label: 'Context Schemas',
    tier: '30-49',
    icon: IconSchema,
    required: [['manage', 'ConsultationContextSchema']],
    implemented: true,
  },
  // TASK-728: institutional-RAG knowledge documents — the only real
  // clinical "memory" concept the platform has today (admin-uploaded
  // guidelines/protocols, chunked+embedded, retrieved to ground summary
  // generation with citations). `manage` mirrors `KnowledgeController`'s
  // class-level `@CanManage('KnowledgeDocument')` gate.
  {
    route: '/knowledge',
    label: 'Knowledge Base',
    tier: '30-49',
    icon: IconBook2,
    required: [['manage', 'KnowledgeDocument']],
    implemented: true,
  },
  {
    route: '/dna-writing-styles',
    label: 'DNA writing styles',
    tier: '30-49',
    icon: IconDna,
    required: [['manage', 'DnaWritingStyleReport']],
    implemented: true,
  },
  {
    route: '/audio/pipelines',
    label: 'Audio pipelines',
    tier: '30-49',
    icon: IconWaveSine,
    required: [['manage', 'AsrPipeline']],
    implemented: true,
  },
  {
    route: '/audio/transcription-jobs',
    label: 'Transcription jobs',
    tier: '30-49',
    icon: IconMicrophone,
    required: [
      ['read', 'AsrPipeline'],
      ['manage', 'Tenant'],
    ],
    implemented: true,
  },
  {
    route: '/harness/policy',
    label: 'Harness policy',
    tier: '30-49',
    icon: IconShieldCog,
    required: [
      ['read', 'HarnessPolicy'],
      ['manage', 'HarnessPolicy'],
    ],
    implemented: true,
  },
  {
    route: '/harness/observability',
    label: 'Harness observability',
    tier: '30-49',
    icon: IconTelescope,
    required: [
      ['read', 'HarnessAudit'],
      ['read', 'HarnessEval'],
      ['read', 'HarnessWorkflow'],
    ],
    implemented: true,
  },
  {
    route: '/harness/workflows',
    label: 'Harness workflows',
    tier: '30-49',
    icon: IconRoute,
    required: [
      ['read', 'HarnessWorkflow'],
      ['manage', 'HarnessWorkflow'],
    ],
    implemented: true,
  },
  {
    route: '/harness/pipeline-policy',
    label: 'Pipeline policy',
    tier: '30-49',
    icon: IconAdjustmentsAlt,
    required: [
      ['read', 'PipelinePolicy'],
      ['manage', 'PipelinePolicy'],
    ],
    implemented: true,
  },
  // TASK-723: the DEFINITION-scoped runs/observability view — distinct from
  // `/ai-operations/runs` (tier 10-19, cross-tenant platform ops over every
  // agentic session, §2.4). This one reads `WorkflowRun`, the workflow-
  // substrate read model, and links to its cross-tenant sibling rather than
  // duplicating it (rule 13 "one authoritative editor" + cross-link posture).
  {
    route: '/workflow-runs',
    label: 'Workflow Runs',
    tier: '30-49',
    icon: IconListTree,
    required: [['read', 'WorkflowRun']],
    implemented: true,
  },
  // TASK-719: Workflow Studio v1 — the graph-authoring surface over `WorkflowDefinition`
  // (TASK-734's `admin/workflow-definitions` + read-only `admin/workflow-nodes` registry
  // controllers). `manage` mirrors `WorkflowDefinitionController`'s class-level
  // `@CanManage('WorkflowDefinition')` gate — the console never widens past what the gateway
  // itself requires.
  {
    route: '/workflow-studio',
    label: 'Workflow Studio',
    tier: '30-49',
    icon: IconBinaryTree2,
    required: [['manage', 'WorkflowDefinition']],
    implemented: true,
  },
  // TASK-733 half (a) Task 6 — the assignment matrix. A sub-route of the Studio
  // (rule 13 "one authoritative editor per backend resource": the Studio owns
  // `WorkflowDefinition`, so it owns which definition governs which
  // tenant/department too), given its own nav entry rather than a tab so it
  // shows up alongside the sibling `/workflow-runs` entry for the same domain.
  // Design gate waived for this screen (owner decision, TASK-733 Task 6).
  {
    route: '/workflow-studio/assignments',
    label: 'Workflow Assignments',
    tier: '30-49',
    icon: IconLayoutGrid,
    required: [['manage', 'WorkflowDefinition']],
    implemented: true,
  },
  // the single tenant AI hub. The former standalone screens
  // `/stt-config`, `/tts-config` and `/ai-providers` were merged into four tabs
  // here (Models · Speech · Voice · Providers), closing the credential-editor
  // duplication (rule 13, "one authoritative editor"). Each tab spans a
  // DIFFERENT backend resource, so `required` is the OR (canAny) of the four
  // reads — the entry shows if the caller can read ANY one, and each tab is
  // `<RequirePermission>`-gated in the screen. SMR selection stays tenant-owned;
  // guardrail/nlp/harness model selection stays SUPER_ADMIN-only (read-only here).
  {
    route: '/ai-configuration',
    label: 'AI Configuration',
    tier: '30-49',
    icon: IconTargetArrow,
    required: [
      ['read', 'AiTaskDefault'],
      ['read', 'TenantSttConfig'],
      ['read', 'TenantTtsConfig'],
      ['read', 'GlobalSetting'],
    ],
    implemented: true,
  },
  {
    route: '/consultations',
    label: 'Consultations',
    tier: '30-49',
    icon: IconStethoscope,
    required: [['manage', 'Consultation']],
    implemented: true,
  },

  // Tier 50-59 — Playground (approved 2026-07-06; moved into the
  // console shell under (console)/(tenant)). End-user demo
  // planes run under the admin's OWN account, so the backend guards are
  // plain @Authorize() — visibility is role-gated (SUPER_ADMIN or
  // TENANT_ADMIN) via visibleNavEntries, mirroring the (tenant) tier guard.
  // Labels reconciled to the page titles: nav = breadcrumb = title.
  { route: '/playground/consultation', label: 'Consultation Demo', tier: '50-59', icon: IconHeartbeat, required: [], implemented: true },
  { route: '/playground/live-transcription', label: 'Live Transcription', tier: '50-59', icon: IconBroadcast, required: [], implemented: true },
  {
    route: '/playground/voice-profiles',
    label: 'My Voice Enrollment & Profiles',
    tier: '50-59',
    icon: IconUserScan,
    required: [],
    implemented: true,
  },
  { route: '/playground/dna-writing-style', label: 'My DNA Writing Style', tier: '50-59', icon: IconDna2, required: [], implemented: true },
  { route: '/playground/llm', label: 'Agent Playground', tier: '50-59', icon: IconSparkles, required: [], implemented: true },
  // TASK-721: deliberate divergence from the `required: []` convention above.
  // The five entries before this one are own-account end-user demo planes
  // whose backend guards are plain @Authorize() (comment above). The
  // Workbench instead READS and EXECUTES tenant WorkflowDefinition rows — a
  // resource ability the gateway enforces — so declaring `required: []`
  // would hide a real gate from the nav. RECONCILED against the real,
  // now-landed decorators (Phase C): the definition picker needs
  // `manage:WorkflowDefinition` (`WorkflowDefinitionController`'s class-level
  // `@CanManage('WorkflowDefinition')` — TASK-734), and starting/reading/
  // canceling a sandbox run needs `manage:WorkflowRun`
  // (`WorkflowSandboxRunController`'s `@CanCreate`/`@CanRead`/`@CanUpdate('WorkflowRun')`,
  // all subsumed by the seeded `manage:WorkflowRun` tenant-admin grant —
  // `packages/database/src/prisma/db_main/seed/01-policy.ts`). `canAny`
  // (OR) means either alone shows the entry; both are seeded together for
  // every tenant admin, so this is not a practical gap.
  {
    route: '/playground/workbench',
    label: 'Workbench',
    tier: '50-59',
    icon: IconFlask,
    required: [
      ['manage', 'WorkflowDefinition'],
      ['manage', 'WorkflowRun'],
    ],
    implemented: true,
  },
];

/** The playground audience — mirrors the (console)/(tenant) tier guard. */
function isAdminTier(roles: readonly string[] | null | undefined): boolean {
  return isElevated(roles) || !!roles?.includes('TENANT_ADMIN');
}

/**
 * Implemented entries the caller's ability grants, in declaration order.
 * Tier 50-59 additionally requires an admin role (`roles`), mirroring the
 * (console)/(tenant) tier guard — ability rules alone cannot express it.
 */
/** Longest-prefix nav match — `/tenants/storage` beats `/tenants`. */
export function matchNavEntry(pathname: string, entries: readonly NavEntry[] = NAV_ENTRIES): NavEntry | undefined {
  return entries.filter((e) => pathname === e.route || pathname.startsWith(`${e.route}/`)).sort((a, b) => b.route.length - a.route.length)[0];
}

export function visibleNavEntries(rules: readonly PermissionRule[] | null | undefined, roles?: readonly string[] | null): NavEntry[] {
  return NAV_ENTRIES.filter((entry) => {
    if (!entry.implemented) return false;
    if (entry.tier === '50-59' && !isAdminTier(roles)) return false;
    return entry.required.length === 0 ? !!rules : canAny(rules, entry.required);
  });
}
