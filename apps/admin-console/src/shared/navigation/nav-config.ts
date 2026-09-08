import {
  IconActivity,
  IconApi,
  IconAtom,
  IconBinaryTree,
  IconBinaryTree2,
  IconBook2,
  IconBrain,
  IconBroadcast,
  IconBuilding,
  IconBuildings,
  IconBuildingSkyscraper,
  IconBulb,
  IconCalendarTime,
  IconChartHistogram,
  IconCpu,
  IconCpu2,
  IconDatabase,
  IconDatabaseSearch,
  IconDna,
  IconDna2,
  IconFileCheck,
  IconFileDescription,
  IconFileText,
  IconFingerprint,
  IconFlask2,
  IconFolders,
  IconGauge,
  IconHeartbeat,
  IconHistory,
  IconHome,
  IconKey,
  IconLayoutDashboard,
  IconLayoutGrid,
  IconLicense,
  IconListDetails,
  IconListTree,
  IconLockAccess,
  IconLockCog,
  IconMicrophone,
  IconPlugConnected,
  IconReceipt,
  IconReportMedical,
  IconReportMoney,
  IconRobot,
  IconRocket,
  IconRoute,
  IconSchema,
  IconServerBolt,
  IconServerCog,
  IconSettings,
  IconShieldBolt,
  IconShieldCog,
  IconShieldLock,
  IconSitemap,
  IconSparkles,
  IconStack2,
  IconStethoscope,
  IconTelescope,
  IconTimeline,
  IconToggleRight,
  IconTopologyStar3,
  IconUserCircle,
  IconUsers,
  IconUserScan,
  IconUserShield,
  IconVersions,
  IconWorld,
  type TablerIcon,
} from '@tabler/icons-react';
import { canAny, isElevated, type PermissionRule } from '@/shared/auth/ability';
import type { FeatureGateKey, FeatureGateMap } from '@/shared/feature-gates/keys';

/**
 * Full route map from the capabilities matrix (section 3, frames 10-40, as
 * reviewed 2026-07-04) plus the TASK-932 §3.1 rail reorder. All design gates
 * cleared (B0/B1/B2 approved 2026-07-05; Playground 50-59 approved
 * 2026-07-06). The sidebar only renders implemented entries the caller's
 * ability grants AND, for a `gate`-carrying entry, whose platform-wide
 * feature-availability key resolves `true` (§3.2; see `visibleNavEntries`).
 *
 * TASK-932: the rail domain order became Overview · Tenancy · Platform Ops ·
 * AI Platform · Knowledge & Agents · Clinical · Workflow & Harness ·
 * Identity & Access · Playground (Platform Ops moved ahead of AI Platform per
 * owner request R-2). `/tools-mcp`, `/ai-services/mlflow` and
 * `/agentic-policy` moved into Platform Ops; `/ai-configuration` ("Speech &
 * Voice") was removed from the rail entirely (the route itself becomes a
 * redirect, see its page); `/features` (the feature-availability matrix,
 * Lane S) is new, first in Platform Ops. Every entry now carries an explicit
 * `order` — its position within its own domain+tier — and `NAV_ENTRIES` is
 * declared in that order, so a future reorder touches both the field and the
 * array position in the same diff (see `nav-config.test.ts`'s inventory
 * tests).
 */
export type NavTier = '10-19' | '20-29' | '30-49' | '50-59';

/**
 * Capability domain — the axis the navigation rail groups by.
 *
 * ORTHOGONAL to `NavTier`, and deliberately so: tier answers *who may
 * open a screen* and keeps governing the `(global)`/`(shared)`/`(tenant)` route
 * groups and their guards; domain answers *where a user looks for it*.
 */
export type NavDomainId =
  'overview' | 'tenancy' | 'platform-ops' | 'ai-platform' | 'knowledge-agents' | 'clinical' | 'workflow-harness' | 'identity-access' | 'playground';

export interface NavDomain {
  id: NavDomainId;
  label: string;
  /** Rail icon; shown with the label as its accessible name, never alone. */
  icon: TablerIcon;
  /** Rail order, ascending. Declaration order matches it. */
  order: number;
}

export const NAV_DOMAINS: readonly NavDomain[] = [
  { id: 'overview', label: 'Overview', icon: IconHome, order: 1 },
  { id: 'tenancy', label: 'Tenancy', icon: IconBuildingSkyscraper, order: 2 },
  { id: 'platform-ops', label: 'Platform Ops', icon: IconServerBolt, order: 3 },
  { id: 'ai-platform', label: 'AI Platform', icon: IconCpu, order: 4 },
  { id: 'knowledge-agents', label: 'Knowledge & Agents', icon: IconBulb, order: 5 },
  { id: 'clinical', label: 'Clinical', icon: IconReportMedical, order: 6 },
  { id: 'workflow-harness', label: 'Workflow & Harness', icon: IconTopologyStar3, order: 7 },
  { id: 'identity-access', label: 'Identity & Access', icon: IconLockAccess, order: 8 },
  { id: 'playground', label: 'Playground', icon: IconFlask2, order: 9 },
];

/** Fields every addressable console route carries — rail entries and user-menu entries alike. */
export interface NavRouteEntry {
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

export interface NavEntry extends NavRouteEntry {
  /** Rail bucket. Purely additive — it changes no guard, tier or route (AC-1/AC-2). */
  domain: NavDomainId;
  /** Position within this entry's domain+tier; declaration order in `NAV_ENTRIES` matches it. */
  order: number;
  /**
   * Platform-wide feature-availability key (TASK-932 §3.2). When set, the
   * entry is visible only while `gates[gate] === true` — absent, `false`,
   * loading and error all hide it. Omit for an entry no gate governs.
   */
  gate?: FeatureGateKey;
}

/**
 * Personal chrome rather than domain work — the API documentation portal and
 * the signed-in user's own profile. moves these two out of the rail
 * (they fit no capability domain) and into the topbar user menu; their tier and
 * ability gate are carried over verbatim.
 */
export type UserMenuEntry = NavRouteEntry;

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
  // ---------------------------------------------------------------------
  // Overview — tier 10-19 only.
  // ---------------------------------------------------------------------
  {
    route: '/dashboard',
    domain: 'overview',
    label: 'Dashboard',
    tier: '10-19',
    icon: IconLayoutDashboard,
    required: [['manage', 'PlatformMetrics']],
    implemented: true,
    order: 1,
  },
  {
    route: '/monitoring',
    domain: 'overview',
    label: 'Monitoring',
    tier: '10-19',
    icon: IconActivity,
    required: [
      ['manage', 'all'],
      ['read', 'TenantTelemetry'],
    ],
    implemented: true,
    order: 2,
  },
  {
    // service version & release registry. Same gate as
    // `/admin/monitoring` and `/admin/health/services` (frozen contract): grouped
    // together in the sidebar.
    route: '/releases',
    domain: 'overview',
    label: 'Releases',
    tier: '10-19',
    icon: IconVersions,
    required: [
      ['manage', 'all'],
      ['read', 'TenantTelemetry'],
    ],
    implemented: true,
    order: 3,
  },

  // ---------------------------------------------------------------------
  // Tenancy — tiers 10-19, 20-29, 30-49.
  // ---------------------------------------------------------------------
  {
    route: '/tenants',
    domain: 'tenancy',
    label: 'Tenants',
    tier: '10-19',
    icon: IconBuildings,
    required: [
      ['manage', 'Tenant'],
      ['update', 'Tenant'],
    ],
    implemented: true,
    order: 1,
  },
  {
    route: '/entitlements',
    domain: 'tenancy',
    label: 'Entitlements & plans',
    tier: '10-19',
    icon: IconLicense,
    required: [['manage', 'all']],
    implemented: true,
    order: 2,
  },
  {
    route: '/tenants/storage',
    domain: 'tenancy',
    label: 'Tenant storage',
    tier: '10-19',
    icon: IconDatabase,
    required: [
      ['manage', 'Tenant'],
      ['read', 'Storage'],
    ],
    implemented: true,
    order: 3,
  },
  {
    route: '/billing',
    domain: 'tenancy',
    label: 'Billing & invoices',
    tier: '10-19',
    icon: IconReceipt,
    required: [['manage', 'all']],
    implemented: true,
    order: 4,
  },
  {
    route: '/tenant-profile',
    domain: 'tenancy',
    label: 'Tenant profile',
    tier: '20-29',
    icon: IconBuilding,
    required: [
      ['read', 'Tenant'],
      ['update', 'Tenant'],
    ],
    implemented: true,
    order: 1,
  },
  {
    route: '/departments',
    domain: 'tenancy',
    label: 'Departments',
    tier: '30-49',
    icon: IconSitemap,
    required: [['manage', 'Department']],
    implemented: true,
    order: 1,
  },

  // ---------------------------------------------------------------------
  // Platform Ops — tiers 10-19, 20-29, 30-49. TASK-932 R-2/R-4: moved ahead
  // of AI Platform in the rail, and gained the four platform-wide-gated
  // entries plus the new feature-availability matrix screen.
  // ---------------------------------------------------------------------
  {
    // The feature-availability matrix (§3.3, Lane S owns the route — this
    // worktree carries only the nav entry). Deliberately UNGATED: the screen
    // that controls the other three platform-wide gates cannot gate itself.
    route: '/features',
    domain: 'platform-ops',
    label: 'Feature availability',
    tier: '10-19',
    icon: IconToggleRight,
    required: [['manage', 'all']],
    implemented: true,
    order: 1,
  },
  {
    route: '/rate-limits',
    domain: 'platform-ops',
    label: 'Rate limits',
    tier: '10-19',
    icon: IconGauge,
    required: [['manage', 'all']],
    implemented: true,
    order: 2,
  },
  // TASK-862 (README §3.4): the three `/ai-operations/*` dashboards are
  // OBSERVABILITY over runs, latency and spend — Platform Ops work, filed
  // under AI only because of a shared URL prefix. Domain and route are
  // independent (OD-2/OD-3): URLs are unchanged.
  {
    route: '/ai-operations/runs',
    domain: 'platform-ops',
    label: 'AI operations — runs',
    tier: '10-19',
    icon: IconTimeline,
    required: [['manage', 'all']],
    implemented: true,
    order: 3,
  },
  {
    route: '/ai-operations/metrics',
    domain: 'platform-ops',
    label: 'AI operations — metrics',
    tier: '10-19',
    icon: IconChartHistogram,
    required: [['manage', 'all']],
    implemented: true,
    order: 4,
  },
  {
    route: '/ai-operations/consumption',
    domain: 'platform-ops',
    label: 'Consumption & cost',
    tier: '10-19',
    icon: IconReportMoney,
    required: [['manage', 'all']],
    implemented: true,
    order: 5,
  },
  {
    route: '/queues',
    domain: 'platform-ops',
    label: 'Queues & jobs',
    tier: '10-19',
    icon: IconStack2,
    required: [['manage', 'all']],
    implemented: true,
    order: 6,
  },
  {
    route: '/schedulers',
    domain: 'platform-ops',
    label: 'Schedulers',
    tier: '10-19',
    icon: IconCalendarTime,
    required: [['manage', 'all']],
    implemented: true,
    order: 7,
  },
  {
    route: '/audit-logs',
    domain: 'platform-ops',
    label: 'Audit logs',
    tier: '10-19',
    icon: IconHistory,
    required: [['read', 'AuditLog']],
    implemented: true,
    order: 8,
  },
  // Renamed from `/pstudio` (read as a typo'd "prompt studio"). Console-only
  // rename — the gateway path stays `/admin/pstudio/*`.
  {
    route: '/db-studio',
    domain: 'platform-ops',
    label: 'Database Studio',
    tier: '10-19',
    icon: IconDatabaseSearch,
    required: [['manage', 'all']],
    implemented: true,
    order: 9,
  },
  {
    // Phase 3B agentic super-admin console (all SUPER_ADMIN-only). TASK-932
    // R-4: moved from `ai-platform` into `platform-ops`, and hidden behind
    // `console.agenticPolicy.enabled` (default off — D-1) until a platform
    // admin turns it on for the whole platform or a working tenant.
    route: '/agentic-policy',
    domain: 'platform-ops',
    label: 'Agentic policy',
    tier: '10-19',
    icon: IconShieldBolt,
    required: [['manage', 'all']],
    implemented: true,
    order: 10,
    gate: 'console.agenticPolicy.enabled',
  },
  {
    // MLflow is rendered NATIVELY through the gateway rather than framed: it
    // frame-denies by default, authenticates nobody of its own, and has no
    // browser-reachable URL. See `features/mlflow/components/mlflow-screen.tsx`.
    // TASK-932 R-4: moved from `ai-platform` into `platform-ops`, gated on
    // `console.mlflow.enabled` (default off — D-1).
    route: '/ai-services/mlflow',
    domain: 'platform-ops',
    label: 'MLflow',
    tier: '10-19',
    icon: IconAtom,
    required: [['manage', 'all']],
    implemented: true,
    order: 11,
    gate: 'console.mlflow.enabled',
  },
  //  — the descriptor-driven registry lane. 210
  // descriptors existed with exactly ONE console consumer (the Agentic Context
  // tab, a single hardcoded category), so `GET admin/settings/catalog` +
  // `PUT admin/settings/registry/:key` were fully functional and unreachable.
  //
  // Distinct from `/settings` below, which is the LEGACY raw-row CRUD over the
  // same table keyed by a key-name regex. That screen keeps row + secret
  // administration; this one owns the descriptor-governed keys, where tier /
  // maxScope / failMode / killSwitch / floorDirection / sourceScope apply.
  {
    route: '/settings-registry',
    domain: 'platform-ops',
    label: 'Settings registry',
    tier: '20-29',
    icon: IconListDetails,
    required: [
      ['read', 'GlobalSetting'],
      ['manage', 'GlobalSetting'],
    ],
    implemented: true,
    order: 1,
  },
  {
    route: '/settings',
    domain: 'platform-ops',
    label: 'Settings rows & secrets',
    tier: '20-29',
    icon: IconSettings,
    required: [['manage', 'GlobalSetting']],
    implemented: true,
    order: 2,
  },
  // / OD-7 (2026-09-01): `/tools-mcp` moved from tier 10-19 to 20-29 —
  // tenant admins may configure MCP connectors, gated by the resource's own
  // `manage:McpServer` rather than the `manage:all` super-admin proxy.
  // TASK-932 R-4: moved DOMAIN from `knowledge-agents` into `platform-ops`
  // (this table exists to make exactly this kind of move visible in a diff)
  // and gated on `console.tools.mcp.enabled` (default off — D-1).
  {
    route: '/tools-mcp',
    domain: 'platform-ops',
    label: 'Tools & MCP',
    tier: '20-29',
    icon: IconPlugConnected,
    required: [['manage', 'McpServer']],
    implemented: true,
    order: 3,
    gate: 'console.tools.mcp.enabled',
  },
  {
    route: '/storage',
    domain: 'platform-ops',
    label: 'Storage browser',
    tier: '30-49',
    icon: IconFolders,
    required: [
      ['read', 'Storage'],
      ['manage', 'Storage'],
    ],
    implemented: true,
    order: 1,
  },

  // ---------------------------------------------------------------------
  // AI Platform — tiers 10-19, 20-29.
  // ---------------------------------------------------------------------
  // Super-admin only per the 2026-07-04 review. The screen is the AI-models
  // HUB (registry grid + live LM Studio/Ollama discovery + register).
  {
    route: '/ai-models',
    domain: 'ai-platform',
    label: 'AI models',
    tier: '10-19',
    icon: IconBrain,
    required: [['manage', 'all']],
    implemented: true,
    order: 1,
  },
  // `/prompt-studio` retired — prompt governance folded into the elevated-only
  // Governance tab of the prompt-template surface (one authoritative surface
  // per resource). `/ai-services` took its freed slot, surfacing the
  // guardrail/NLP status + config backends that had no screen.
  {
    route: '/ai-services',
    domain: 'ai-platform',
    label: 'AI services',
    tier: '10-19',
    icon: IconServerCog,
    required: [['manage', 'all']],
    implemented: true,
    order: 2,
  },
  // The four PLATFORM AI BACKENDS as separate rail entries rather than tabs of
  // `/ai-services`, because the rail IS the inventory — an operator should be
  // able to see WHICH engines this platform has without opening a screen and
  // hunting a tab.
  {
    route: '/ai-services/lm-studio',
    domain: 'ai-platform',
    label: 'LM Studio',
    tier: '10-19',
    icon: IconCpu2,
    required: [['manage', 'all']],
    implemented: true,
    order: 3,
  },
  {
    route: '/ai-services/vllm',
    domain: 'ai-platform',
    label: 'vLLM',
    tier: '10-19',
    icon: IconRocket,
    required: [['manage', 'all']],
    implemented: true,
    order: 4,
  },
  {
    route: '/ai-services/ollama',
    domain: 'ai-platform',
    label: 'Ollama',
    tier: '10-19',
    icon: IconServerBolt,
    required: [['manage', 'all']],
    implemented: true,
    order: 5,
  },
  {
    route: '/ai-services/llama-cpp',
    domain: 'ai-platform',
    label: 'llama.cpp',
    tier: '10-19',
    icon: IconBinaryTree,
    required: [['manage', 'all']],
    implemented: true,
    order: 6,
  },
  // TASK-862 (README §3.4): the ONE AI provider screen. Tier 20-29 because it
  // renders cross-tenant for a super admin and tenant-scoped for a tenant
  // admin, and because tenancy is a CONTROL on the screen rather than a
  // route: the SYSTEM (platform-default) tier and the working tenant are the
  // two tiers of ONE cascade. Mirrors `ProviderConnectionController`'s
  // `CanRead`/`CanManage('GlobalSetting')`.
  {
    route: '/ai-providers',
    domain: 'ai-platform',
    label: 'AI providers',
    tier: '20-29',
    icon: IconCpu,
    required: [
      ['read', 'GlobalSetting'],
      ['manage', 'GlobalSetting'],
    ],
    implemented: true,
    order: 1,
  },

  // ---------------------------------------------------------------------
  // Knowledge & Agents — tier 30-49 only. TASK-862 (README §3.4): Agents ·
  // Prompt templates · Context schemas · Document templates · Knowledge base ·
  // DNA writing styles · Workflow Studio · Assignments — authoring surfaces.
  // `/tools-mcp` (the tools agents call) left this domain for Platform Ops in
  // TASK-932 R-4.
  // ---------------------------------------------------------------------
  // TASK-863: the first-class, task-typed, publishable Agent (ASR · text
  // generation · TTS) — one task, one registry model, task-typed
  // instruction/parameters/I-O schemas, versioned and published like a
  // workflow definition. Its own resource (`manage:Agent`).
  {
    route: '/agents',
    domain: 'knowledge-agents',
    label: 'Agents',
    tier: '30-49',
    icon: IconRobot,
    required: [['manage', 'Agent']],
    implemented: true,
    order: 1,
  },
  // Prompt instruction templates have their own route: the
  // pre-summary/summary resolution map, template CRUD + versions, and clinical
  // approval. The instruction library an agent binds to.
  {
    route: '/prompt-templates',
    domain: 'knowledge-agents',
    label: 'Prompt templates',
    tier: '30-49',
    icon: IconFileText,
    required: [['manage', 'PromptTemplate']],
    implemented: true,
    order: 2,
  },
  {
    // tenant-defined consultation context vocabulary.
    route: '/context-schemas',
    domain: 'knowledge-agents',
    label: 'Context Schemas',
    tier: '30-49',
    icon: IconSchema,
    required: [['manage', 'ConsultationContextSchema']],
    implemented: true,
    order: 3,
  },
  {
    // tenant-defined clinical document SHAPES. The deliberate sibling of
    // Context Schemas: that screen governs what context may be SUBMITTED,
    // this one governs what document comes BACK. `manage` mirrors
    // `DocumentTemplateAdminController`'s class-level
    // `@CanManage('DocumentTemplate')` gate, which is the whole gate.
    route: '/document-templates',
    domain: 'knowledge-agents',
    label: 'Document Templates',
    tier: '30-49',
    icon: IconFileDescription,
    required: [['manage', 'DocumentTemplate']],
    implemented: true,
    order: 4,
  },
  // institutional-RAG knowledge documents — the only real clinical "memory"
  // concept the platform has today. `manage` mirrors `KnowledgeController`'s
  // class-level `@CanManage('KnowledgeDocument')` gate.
  {
    route: '/knowledge',
    domain: 'knowledge-agents',
    label: 'Knowledge Base',
    tier: '30-49',
    icon: IconBook2,
    required: [['manage', 'KnowledgeDocument']],
    implemented: true,
    order: 5,
  },
  {
    route: '/dna-writing-styles',
    domain: 'knowledge-agents',
    label: 'DNA writing styles',
    tier: '30-49',
    icon: IconDna,
    required: [['manage', 'DnaWritingStyleReport']],
    implemented: true,
    order: 6,
  },
  // Workflow Studio v1 — the graph-authoring surface over `WorkflowDefinition`
  // (`admin/workflow-definitions` + read-only `admin/workflow-nodes` registry
  // controllers). `manage` mirrors `WorkflowDefinitionController`'s
  // class-level `@CanManage('WorkflowDefinition')` gate.
  {
    route: '/workflow-studio',
    domain: 'knowledge-agents',
    label: 'Workflow Studio',
    tier: '30-49',
    icon: IconBinaryTree2,
    required: [['manage', 'WorkflowDefinition']],
    implemented: true,
    order: 7,
  },
  // The assignment matrix. A sub-route of the Studio (rule 13 "one
  // authoritative editor per backend resource": the Studio owns
  // `WorkflowDefinition`, so it owns which definition governs which
  // tenant/department too), given its own nav entry rather than a tab so it
  // shows up alongside the sibling `/workflow-runs` entry for the same domain.
  {
    route: '/workflow-studio/assignments',
    domain: 'knowledge-agents',
    label: 'Workflow Assignments',
    tier: '30-49',
    icon: IconLayoutGrid,
    required: [['manage', 'WorkflowDefinition']],
    implemented: true,
    order: 8,
  },

  // ---------------------------------------------------------------------
  // Clinical — tier 30-49 only.
  // ---------------------------------------------------------------------
  {
    // the consent register. Tier 30-49 because grants key on
    // (tenantId, externalPatientId, purpose): a super admin reads them through
    // the working tenant, never cross-tenant. `manage:ConsentGrant` mirrors
    // `ConsentGrantController`'s class-level `@CanManage('ConsentGrant')`.
    route: '/consent',
    domain: 'clinical',
    label: 'Patient consent',
    tier: '30-49',
    icon: IconFileCheck,
    required: [['manage', 'ConsentGrant']],
    implemented: true,
    order: 1,
  },
  {
    route: '/audio/transcription-jobs',
    domain: 'clinical',
    label: 'Transcription jobs',
    tier: '30-49',
    icon: IconMicrophone,
    required: [
      ['read', 'AsrPipeline'],
      ['manage', 'Tenant'],
    ],
    implemented: true,
    order: 2,
  },
  {
    route: '/consultations',
    domain: 'clinical',
    label: 'Consultations',
    tier: '30-49',
    icon: IconStethoscope,
    required: [['manage', 'Consultation']],
    implemented: true,
    order: 3,
  },

  // ---------------------------------------------------------------------
  // Workflow & Harness — tier 30-49 only. TASK-932 R-4: the WHOLE domain is
  // gated on `console.workflowHarness.enabled` (default off — D-1).
  // ---------------------------------------------------------------------
  {
    route: '/harness/policy',
    domain: 'workflow-harness',
    label: 'Harness policy',
    tier: '30-49',
    icon: IconShieldCog,
    required: [
      ['read', 'HarnessPolicy'],
      ['manage', 'HarnessPolicy'],
    ],
    implemented: true,
    order: 1,
    gate: 'console.workflowHarness.enabled',
  },
  {
    route: '/harness/observability',
    domain: 'workflow-harness',
    label: 'Harness observability',
    tier: '30-49',
    icon: IconTelescope,
    required: [
      ['read', 'HarnessAudit'],
      ['read', 'HarnessEval'],
      ['read', 'HarnessWorkflow'],
    ],
    implemented: true,
    order: 2,
    gate: 'console.workflowHarness.enabled',
  },
  {
    route: '/harness/workflows',
    domain: 'workflow-harness',
    label: 'Harness workflows',
    tier: '30-49',
    icon: IconRoute,
    required: [
      ['read', 'HarnessWorkflow'],
      ['manage', 'HarnessWorkflow'],
    ],
    implemented: true,
    order: 3,
    gate: 'console.workflowHarness.enabled',
  },
  // the DEFINITION-scoped runs/observability view — distinct from
  // `/ai-operations/runs` (tier 10-19, cross-tenant platform ops over every
  // agentic session). This one reads `WorkflowRun`, the workflow-substrate
  // read model, and links to its cross-tenant sibling rather than duplicating
  // it (rule 13 "one authoritative editor" + cross-link posture).
  {
    route: '/workflow-runs',
    domain: 'workflow-harness',
    label: 'Workflow Runs',
    tier: '30-49',
    icon: IconListTree,
    required: [['read', 'WorkflowRun']],
    implemented: true,
    order: 4,
    gate: 'console.workflowHarness.enabled',
  },

  // ---------------------------------------------------------------------
  // Identity & Access — tiers 10-19, 20-29, 30-49.
  // ---------------------------------------------------------------------
  // Platform credential policy — password complexity/rotation and the entropy
  // behind every machine credential the platform issues. SUPER_ADMIN-only:
  // every backing key is a `globalOnly` descriptor, so the gateway 403s a
  // tenant admin regardless of what the nav shows.
  {
    route: '/security-policy',
    domain: 'identity-access',
    label: 'Security policy',
    tier: '10-19',
    icon: IconLockCog,
    required: [['manage', 'all']],
    implemented: true,
    order: 1,
  },
  { route: '/users', domain: 'identity-access', label: 'Users', tier: '20-29', icon: IconUsers, required: [['manage', 'User']], implemented: true, order: 1 },
  {
    route: '/rbac/roles',
    domain: 'identity-access',
    label: 'Roles',
    tier: '20-29',
    icon: IconUserShield,
    required: [
      ['read', 'Role'],
      ['manage', 'Role'],
    ],
    implemented: true,
    order: 2,
  },
  {
    route: '/rbac/policies',
    domain: 'identity-access',
    label: 'Policies',
    tier: '20-29',
    icon: IconShieldLock,
    required: [
      ['read', 'Policy'],
      ['manage', 'Policy'],
    ],
    implemented: true,
    order: 3,
  },
  {
    route: '/api-keys',
    domain: 'identity-access',
    label: 'API keys',
    tier: '20-29',
    icon: IconKey,
    required: [
      ['read', 'ApiKey'],
      ['manage', 'ApiKey'],
    ],
    implemented: true,
    order: 4,
  },
  {
    route: '/identity-providers',
    domain: 'identity-access',
    label: 'Identity providers',
    tier: '30-49',
    icon: IconFingerprint,
    required: [
      ['read', 'TenantIdentityProvider'],
      ['manage', 'TenantIdentityProvider'],
    ],
    implemented: true,
    order: 1,
  },
  // Retiered from 10-19: tenant admins now manage their own exact-origin
  // rows; wildcard/SYSTEM rows stay SUPER_ADMIN-only, enforced in the
  // service, not the nav gate.
  {
    route: '/allowed-origins',
    domain: 'identity-access',
    label: 'Allowed origins',
    tier: '30-49',
    icon: IconWorld,
    required: [
      ['read', 'TenantAllowedOrigin'],
      ['manage', 'TenantAllowedOrigin'],
    ],
    implemented: true,
    order: 2,
  },

  // ---------------------------------------------------------------------
  // Playground — tier 50-59 only (approved 2026-07-06; moved into the console
  // shell under (console)/(tenant)). End-user demo planes run under the
  // admin's OWN account, so the backend guards are plain @Authorize() —
  // visibility is role-gated (SUPER_ADMIN or TENANT_ADMIN) via
  // visibleNavEntries, mirroring the (tenant) tier guard. Labels reconciled
  // to the page titles: nav = breadcrumb = title.
  // ---------------------------------------------------------------------
  {
    route: '/playground/consultation',
    domain: 'playground',
    label: 'Consultation Scribe',
    tier: '50-59',
    icon: IconHeartbeat,
    required: [],
    implemented: true,
    order: 1,
  },
  {
    route: '/playground/live-transcription',
    domain: 'playground',
    label: 'Live Transcription',
    tier: '50-59',
    icon: IconBroadcast,
    required: [],
    implemented: true,
    order: 2,
  },
  {
    route: '/playground/voice-profiles',
    domain: 'playground',
    label: 'My Voice Enrollment & Profiles',
    tier: '50-59',
    icon: IconUserScan,
    required: [],
    implemented: true,
    order: 3,
  },
  {
    route: '/playground/dna-writing-style',
    domain: 'playground',
    label: 'My DNA Writing Style',
    tier: '50-59',
    icon: IconDna2,
    required: [],
    implemented: true,
    order: 4,
  },
  {
    route: '/playground/llm',
    domain: 'playground',
    label: 'LLM Playground',
    tier: '50-59',
    icon: IconSparkles,
    required: [],
    implemented: true,
    order: 5,
  },
];

/**
 * Personal chrome, reached from the topbar user menu rather than the rail.
 * Both entries carry the tier and ability gate they had as nav entries — the
 * move is a placement change only.
 */
export const USER_MENU_ENTRIES: readonly UserMenuEntry[] = [
  {
    // the developer API documentation portal. Tier 20-29: the
    // audience is both super admins and tenant admins/developers, and the
    // screens are not tenant-scoped (the API contract belongs to the platform).
    //
    // `read:ApiDocumentation` is a DEDICATED subject (seed policy
    // `api-documentation-read`), so access can be delegated to tenant
    // developers without granting `manage:all`. The admin-plane projection
    // additionally needs `manage` on the same subject; that split is enforced
    // server-side in `@/server/api-docs`, not here — this list only decides
    // whether the menu item renders.
    route: '/developer',
    label: 'Developer',
    tier: '20-29',
    icon: IconApi,
    required: [['read', 'ApiDocumentation']],
    implemented: true,
  },
  { route: '/account', label: 'Account', tier: '20-29', icon: IconUserCircle, required: [], implemented: true },
];

/**
 * Every addressable console route — rail plus user menu. Breadcrumbs resolve
 * against this, so moving an entry out of the rail never costs it its trail.
 */
const ALL_ROUTE_ENTRIES: readonly NavRouteEntry[] = [...NAV_ENTRIES, ...USER_MENU_ENTRIES];

/** The playground audience — mirrors the (console)/(tenant) tier guard. */
function isAdminTier(roles: readonly string[] | null | undefined): boolean {
  return isElevated(roles) || !!roles?.includes('TENANT_ADMIN');
}

/** The one ability gate every nav surface shares: ANY granted pair, or any authenticated caller. */
function isGranted(rules: readonly PermissionRule[] | null | undefined, entry: NavRouteEntry): boolean {
  return entry.required.length === 0 ? !!rules : canAny(rules, entry.required);
}

/**
 * Platform-wide feature-availability gate (TASK-932 §3.2). An entry with no
 * `gate` is unaffected; a gated entry needs `gates[gate] === true` exactly —
 * absent (loading/error/not-yet-returned) and `false` both hide it. This is
 * the SAME fail-closed rule `FeatureGateBoundary` applies to the route
 * itself, so a nav entry and its route can never disagree.
 */
function isGateOpen(entry: NavEntry, gates: FeatureGateMap | undefined): boolean {
  return entry.gate === undefined || gates?.[entry.gate] === true;
}

/**
 * Implemented entries the caller's ability grants, in declaration order.
 * Tier 50-59 additionally requires an admin role (`roles`), mirroring the
 * (console)/(tenant) tier guard — ability rules alone cannot express it.
 */
/** Longest-prefix nav match — `/tenants/storage` beats `/tenants`. */
export function matchNavEntry(pathname: string, entries: readonly NavRouteEntry[] = ALL_ROUTE_ENTRIES): NavRouteEntry | undefined {
  return entries.filter((e) => pathname === e.route || pathname.startsWith(`${e.route}/`)).sort((a, b) => b.route.length - a.route.length)[0];
}

export function visibleNavEntries(
  rules: readonly PermissionRule[] | null | undefined,
  roles?: readonly string[] | null,
  gates?: FeatureGateMap,
): NavEntry[] {
  return NAV_ENTRIES.filter((entry) => {
    if (!entry.implemented) return false;
    if (entry.tier === '50-59' && !isAdminTier(roles)) return false;
    if (!isGateOpen(entry, gates)) return false;
    return isGranted(rules, entry);
  });
}

/** The user-menu counterpart of `visibleNavEntries` — same gate, no tier role check to apply. */
export function visibleUserMenuEntries(rules: readonly PermissionRule[] | null | undefined): UserMenuEntry[] {
  return USER_MENU_ENTRIES.filter((entry) => entry.implemented && isGranted(rules, entry));
}

/**
 * Rail domains the caller can actually reach: a domain shows
 * when at least one of its entries is visible. Derived from `visibleNavEntries`
 * so there is exactly ONE ability mechanism — including the playground's
 * role check and the feature-gate check, neither of which any ability rule
 * can express.
 */
export function visibleNavDomains(
  rules: readonly PermissionRule[] | null | undefined,
  roles?: readonly string[] | null,
  gates?: FeatureGateMap,
): NavDomain[] {
  const reachable = new Set(visibleNavEntries(rules, roles, gates).map((entry) => entry.domain));
  return NAV_DOMAINS.filter((domain) => reachable.has(domain.id));
}

/**
 * The rail domain the CURRENT ROUTE belongs to.
 *
 * Selection is derived, never stored: there is no domain state, no
 * localStorage key and no click handler that "remembers" a choice — the URL is
 * the only input. Longest-prefix matching means a detail route
 * (`/tenants/t-123`) resolves to its parent's domain, and `/tenants/storage`
 * resolves to its own entry rather than `/tenants`.
 *
 * Returns `undefined` for a route no visible entry owns (`/account`,
 * `/developer`, a 404) — the caller decides the fallback frame.
 */
export function activeNavDomainId(pathname: string, entries: readonly NavEntry[]): NavDomainId | undefined {
  const matched = matchNavEntry(pathname, entries);
  return matched && entries.find((entry) => entry.route === matched.route)?.domain;
}

/**
 * Where a rail click goes: the domain's FIRST visible entry.
 *
 * This is the Phase B answer to the ticket's Open Question. A domain with
 * exactly one visible route — routine for a narrowly-permissioned tenant admin
 * — needs no special case, because the general rule already lands on that one
 * route. Every rail item therefore navigates (no dead click), and the sidebar
 * renders the same frame at every domain size, with the landed entry selected.
 */
export function domainLandingRoute(domainId: NavDomainId, entries: readonly NavEntry[]): string | undefined {
  return entries.find((entry) => entry.domain === domainId)?.route;
}
