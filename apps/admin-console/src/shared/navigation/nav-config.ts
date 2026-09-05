import {
  IconActivity,
  IconApi,
  IconAtom,
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
  IconFlask,
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
  IconTargetArrow,
  IconTelescope,
  IconTimeline,
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

/**
 * Full route map from the capabilities matrix (section 3, frames 10-40, as
 * reviewed 2026-07-04: AI models re-tiered to 10-19, tenant frontend config
 * folded into the tenant-detail tab). All design gates cleared (B0/B1/B2
 * approved 2026-07-05; Playground 50-59 approved 2026-07-06). The
 * sidebar only renders implemented entries the caller's ability grants.
 *
 * (Corrected by: this comment claimed "AI models is hidden
 * (implemented: false)". It has not been hidden since the screen became the
 * AI-models HUB — the entry below is `implemented: true`, gated on
 * `manage:all`. The stale sentence read as a live rule and is gone.)
 */
export type NavTier = '10-19' | '20-29' | '30-49' | '50-59';

/**
 * Capability domain — the axis the navigation rail groups by.
 *
 * ORTHOGONAL to `NavTier`, and deliberately so: tier answers *who may
 * open a screen* and keeps governing the `(global)`/`(shared)`/`(tenant)` route
 * groups and their guards; domain answers *where a user looks for it*. Where
 * the two disagree — `/ai-configuration` is tier `30-49` but domain
 * `ai-platform` — the divergence is the point, not drift.
 */
export type NavDomainId =
  'overview' | 'tenancy' | 'ai-platform' | 'knowledge-agents' | 'clinical' | 'workflow-harness' | 'identity-access' | 'platform-ops' | 'playground';

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
  { id: 'ai-platform', label: 'AI Platform', icon: IconCpu, order: 3 },
  { id: 'knowledge-agents', label: 'Knowledge & Agents', icon: IconBulb, order: 4 },
  { id: 'clinical', label: 'Clinical', icon: IconReportMedical, order: 5 },
  { id: 'workflow-harness', label: 'Workflow & Harness', icon: IconTopologyStar3, order: 6 },
  { id: 'identity-access', label: 'Identity & Access', icon: IconLockAccess, order: 7 },
  { id: 'platform-ops', label: 'Platform Ops', icon: IconServerBolt, order: 8 },
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
  // Tier 10-19 — super admin (cross-tenant). Tenant frontend config is a
  // tenant-detail tab (matrix row 6), not a standalone nav entry.
  {
    route: '/dashboard',
    domain: 'overview',
    label: 'Dashboard',
    tier: '10-19',
    icon: IconLayoutDashboard,
    required: [['manage', 'PlatformMetrics']],
    implemented: true,
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
  },
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
  },
  {
    route: '/entitlements',
    domain: 'tenancy',
    label: 'Entitlements & plans',
    tier: '10-19',
    icon: IconLicense,
    required: [['manage', 'all']],
    implemented: true,
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
  },
  // Super-admin only per the 2026-07-04 review (backend guard re-pin:).
  // Unhidden: the screen is now the AI-models HUB (registry grid +
  // live LM Studio/Ollama discovery + register), i.e. the surface a super admin
  // uses to see what the serving engines actually host. It was hidden only while
  // it was registry-only. The manage:all gate is unchanged.
  {
    route: '/ai-models',
    domain: 'ai-platform',
    label: 'AI models',
    tier: '10-19',
    icon: IconBrain,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    route: '/rate-limits',
    domain: 'platform-ops',
    label: 'Rate limits',
    tier: '10-19',
    icon: IconGauge,
    required: [['manage', 'all']],
    implemented: true,
  },
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
  },
  // Phase 3B agentic super-admin console (all SUPER_ADMIN-only).
  {
    route: '/agentic-policy',
    domain: 'ai-platform',
    label: 'Agentic policy',
    tier: '10-19',
    icon: IconShieldBolt,
    required: [['manage', 'all']],
    implemented: true,
  },
  // `/prompt-studio` retired — prompt governance folded into the elevated-only
  // Governance tab of the prompt-template surface (one authoritative surface
  // per resource). `/prompt-studio` still resolves for one release via a
  // redirect page; `/ai-services` takes the freed slot, surfacing the
  // guardrail/NLP status + config backends that had no screen.
  //
  // The fold originally landed governance on `/agents`, and this comment still
  // said so after `/agents` itself retired — pointing the reader at
  // a redirect. The live target is `/prompt-templates?tab=governance`.
  {
    route: '/ai-services',
    domain: 'ai-platform',
    label: 'AI services',
    tier: '10-19',
    icon: IconServerCog,
    required: [['manage', 'all']],
    implemented: true,
  },
  // The three PLATFORM AI BACKENDS that had no screen of their own. All three
  // sit under `/ai-services/*` because they are the same kind of thing as the
  // guardrail/NLP surface above it: read-only operator views over a backend the
  // console does not own.
  //
  // Separate rail entries rather than tabs of `/ai-services`, because the rail
  // IS the inventory — an operator should be able to see WHICH engines and
  // registries this platform has without opening a screen and hunting a tab.
  {
    route: '/ai-services/lm-studio',
    domain: 'ai-platform',
    label: 'LM Studio',
    tier: '10-19',
    icon: IconCpu2,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    route: '/ai-services/vllm',
    domain: 'ai-platform',
    label: 'vLLM',
    tier: '10-19',
    icon: IconRocket,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    // MLflow is rendered NATIVELY through the gateway rather than framed: it
    // frame-denies by default, authenticates nobody of its own, and has no
    // browser-reachable URL. See `features/mlflow/components/mlflow-screen.tsx`.
    route: '/ai-services/mlflow',
    domain: 'ai-platform',
    label: 'MLflow',
    tier: '10-19',
    icon: IconAtom,
    required: [['manage', 'all']],
    implemented: true,
  },
  // TASK-862 (README §3.4): the AI Platform domain lists AI models · AI
  // providers · AI services · Agentic policy. The three `/ai-operations/*`
  // dashboards are OBSERVABILITY over runs, latency and spend — Platform Ops
  // work, filed under AI only because of a shared URL prefix — so they move
  // there. Domain and route are independent (OD-2/OD-3): URLs are unchanged.
  {
    route: '/ai-operations/runs',
    domain: 'platform-ops',
    label: 'AI operations — runs',
    tier: '10-19',
    icon: IconTimeline,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    route: '/ai-operations/metrics',
    domain: 'platform-ops',
    label: 'AI operations — metrics',
    tier: '10-19',
    icon: IconChartHistogram,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    route: '/ai-operations/consumption',
    domain: 'platform-ops',
    label: 'Consumption & cost',
    tier: '10-19',
    icon: IconReportMoney,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    route: '/billing',
    domain: 'tenancy',
    label: 'Billing & invoices',
    tier: '10-19',
    icon: IconReceipt,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    route: '/queues',
    domain: 'platform-ops',
    label: 'Queues & jobs',
    tier: '10-19',
    icon: IconStack2,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    route: '/schedulers',
    domain: 'platform-ops',
    label: 'Schedulers',
    tier: '10-19',
    icon: IconCalendarTime,
    required: [['manage', 'all']],
    implemented: true,
  },
  {
    route: '/audit-logs',
    domain: 'platform-ops',
    label: 'Audit logs',
    tier: '10-19',
    icon: IconHistory,
    required: [['read', 'AuditLog']],
    implemented: true,
  },
  // Renamed from `/pstudio` (read as a typo'd "prompt
  // studio"). Console-only rename — the gateway path stays `/admin/pstudio/*`.
  {
    route: '/db-studio',
    domain: 'platform-ops',
    label: 'Database Studio',
    tier: '10-19',
    icon: IconDatabaseSearch,
    required: [['manage', 'all']],
    implemented: true,
  },

  // Tier 20-29 — shared (cross-tenant or tenant-scoped)
  { route: '/users', domain: 'identity-access', label: 'Users', tier: '20-29', icon: IconUsers, required: [['manage', 'User']], implemented: true },
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
  //
  // `read:GlobalSetting` rather than `manage:` — the catalog is RBAC-filtered
  // and readable by any admin; which keys are WRITABLE, and at which scope, is
  // decided per descriptor in the drawer and enforced by the gateway.
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
  },
  {
    route: '/settings',
    domain: 'platform-ops',
    label: 'Settings rows & secrets',
    tier: '20-29',
    icon: IconSettings,
    required: [['manage', 'GlobalSetting']],
    implemented: true,
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
  },
  // `/developer` and `/account` used to sit here. moved them out of
  // the rail into USER_MENU_ENTRIES (below) — they are personal chrome, not
  // capability domains. Tier and ability gate are unchanged.

  // TASK-862 — THE one AI provider screen. Tier 20-29 because it renders
  // cross-tenant for a super admin and tenant-scoped for a tenant admin, and
  // because tenancy is a CONTROL on the screen rather than a route: the SYSTEM
  // (platform-default) tier and the working tenant are the two tiers of ONE
  // cascade. It replaced the five-tab `/ai-platform` hub (one-release redirect
  // here); the model catalogue is `/ai-models`, engine status `/ai-services/*`,
  // and task routing moves to the registry election (TASK-860) + the Agent
  // (TASK-863). The gate mirrors `ProviderConnectionController`'s
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
  },
  // / OD-7 (2026-09-01): `/tools-mcp` MOVED here from tier 10-19.
  // Tenant admins may configure MCP connectors, which makes this a
  // shared-audience screen — it renders cross-tenant for a super admin and
  // tenant-scoped for a tenant admin. Its ability gate narrows from the
  // `manage:all` super-admin proxy to the resource's own `manage:McpServer`,
  // the grant seeded tenant-admin roles have always held (`manage:all` still
  // matches it, so super admins are unaffected). Domain: `knowledge-agents`
  // since TASK-862 — MCP connectors are the TOOLS an agent calls, so they sit
  // beside Agents and Workflow Studio (README §3.4), not under provider
  // configuration. Domain and tier are orthogonal (OD-2/OD-3).
  {
    route: '/tools-mcp',
    domain: 'knowledge-agents',
    label: 'Tools & MCP',
    tier: '20-29',
    icon: IconPlugConnected,
    required: [['manage', 'McpServer']],
    implemented: true,
  },

  // Tier 30-49 — tenant-admin scope (a super admin needs a working tenant)
  {
    route: '/departments',
    domain: 'tenancy',
    label: 'Departments',
    tier: '30-49',
    icon: IconSitemap,
    required: [['manage', 'Department']],
    implemented: true,
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
  },
  // Retiered from 10-19: tenant admins now manage their own
  // exact-origin rows; wildcard/SYSTEM rows stay SUPER_ADMIN-only, enforced
  // in the service, not the nav gate.
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
  },
  // `/agents` — TASK-863: the first-class, task-typed, publishable Agent (ASR ·
  // text generation · TTS) — one task, one registry model, task-typed
  // instruction/parameters/I-O schemas, versioned and published like a workflow
  // definition. Its own resource (`manage:Agent`), no longer a prompt-template
  // screen in disguise; the retired Agent Catalog redirect is gone with it.
  {
    route: '/agents',
    domain: 'knowledge-agents',
    label: 'Agents',
    tier: '30-49',
    icon: IconRobot,
    required: [['manage', 'Agent']],
    implemented: true,
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
  },
  {
    // tenant-defined clinical document SHAPES. The deliberate
    // sibling of Context Schemas: that screen governs what context may be
    // SUBMITTED, this one governs what document comes BACK. `manage` mirrors
    // `DocumentTemplateAdminController`'s class-level
    // `@CanManage('DocumentTemplate')` gate, which is the whole gate — this
    // resource carries no imperative privilege check.
    route: '/document-templates',
    domain: 'knowledge-agents',
    label: 'Document Templates',
    tier: '30-49',
    icon: IconFileDescription,
    required: [['manage', 'DocumentTemplate']],
    implemented: true,
  },
  // institutional-RAG knowledge documents — the only real
  // clinical "memory" concept the platform has today (admin-uploaded
  // guidelines/protocols, chunked+embedded, retrieved to ground summary
  // generation with citations). `manage` mirrors `KnowledgeController`'s
  // class-level `@CanManage('KnowledgeDocument')` gate.
  {
    route: '/knowledge',
    domain: 'knowledge-agents',
    label: 'Knowledge Base',
    tier: '30-49',
    icon: IconBook2,
    required: [['manage', 'KnowledgeDocument']],
    implemented: true,
  },
  {
    route: '/dna-writing-styles',
    domain: 'knowledge-agents',
    label: 'DNA writing styles',
    tier: '30-49',
    icon: IconDna,
    required: [['manage', 'DnaWritingStyleReport']],
    implemented: true,
  },
  // the consent register. Tier 30-49 because grants key on
  // (tenantId, externalPatientId, purpose): a super admin reads them through
  // the working tenant, never cross-tenant. `manage:ConsentGrant` mirrors
  // `ConsentGrantController`'s class-level `@CanManage('ConsentGrant')`.
  {
    route: '/consent',
    domain: 'clinical',
    label: 'Patient consent',
    tier: '30-49',
    icon: IconFileCheck,
    required: [['manage', 'ConsentGrant']],
    implemented: true,
  },
  // TASK-861: `/audio/pipelines` RETIRED (redirect stub → `/agents?task=SPEECH_TO_TEXT`);
  // the ASR Agent replaces the pipeline. 59 -> 58, tier 30-49 22 -> 21.
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
  },
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
  },
  // TASK-861: `/harness/pipeline-policy` RETIRED (redirect stub → `/workflow-studio/assignments`);
  // its toggles become node `enabled` flags on the assigned workflow. 58 -> 57, tier 30-49 21 -> 20.
  // the DEFINITION-scoped runs/observability view — distinct from
  // `/ai-operations/runs` (tier 10-19, cross-tenant platform ops over every
  // agentic session, This one reads `WorkflowRun`, the workflow-
  // substrate read model, and links to its cross-tenant sibling rather than
  // duplicating it (rule 13 "one authoritative editor" + cross-link posture).
  {
    route: '/workflow-runs',
    domain: 'workflow-harness',
    label: 'Workflow Runs',
    tier: '30-49',
    icon: IconListTree,
    required: [['read', 'WorkflowRun']],
    implemented: true,
  },
  // Workflow Studio v1 — the graph-authoring surface over `WorkflowDefinition`
  // ( `admin/workflow-definitions` + read-only `admin/workflow-nodes` registry
  // controllers). `manage` mirrors `WorkflowDefinitionController`'s class-level
  // `@CanManage('WorkflowDefinition')` gate — the console never widens past what the gateway
  // itself requires.
  // TASK-862 (README §3.4): Knowledge & Agents lists Agents · Workflow Studio ·
  // Assignments · Prompt templates · Context schemas · Document templates ·
  // Knowledge base — authoring surfaces. The Studio and its assignment matrix
  // move here; `/workflow-runs` stays with the harness (observability).
  {
    route: '/workflow-studio',
    domain: 'knowledge-agents',
    label: 'Workflow Studio',
    tier: '30-49',
    icon: IconBinaryTree2,
    required: [['manage', 'WorkflowDefinition']],
    implemented: true,
  },
  // half (a) Task 6 — the assignment matrix. A sub-route of the Studio
  // (rule 13 "one authoritative editor per backend resource": the Studio owns
  // `WorkflowDefinition`, so it owns which definition governs which
  // tenant/department too), given its own nav entry rather than a tab so it
  // shows up alongside the sibling `/workflow-runs` entry for the same domain.
  // Design gate waived for this screen (owner decision).
  {
    route: '/workflow-studio/assignments',
    domain: 'knowledge-agents',
    label: 'Workflow Assignments',
    tier: '30-49',
    icon: IconLayoutGrid,
    required: [['manage', 'WorkflowDefinition']],
    implemented: true,
  },
  // Was the four-tab tenant AI hub (Models · Speech · Voice · Providers).
  // NARROWED it to two: the Models and Providers tabs were the TENANT
  // half of a two-tier cascade whose SYSTEM half lived on a different route,
  // and both moved to `/ai-platform`, where the tier is a control rather than a
  // route. The URL is unchanged, so this is a narrowing and takes no redirect.
  //
  // Speech stayed deliberately: `TenantSttConfig` is a pipeline BINDING resolved
  // on its own row, not provider configuration on the routing cascade. Folding
  // it into a provider console would recreate the by-which-table grouping
  // exists to remove. TASK-888 retired `TenantTtsConfig`, so the Voice tab reads
  // nothing any more and is gated on `Agent` instead; `required` is therefore
  // the ONE remaining read, and each tab is separately `<RequirePermission>`-gated
  // in the screen.
  //
  // DEPRECATED (TASK-862, removed in R4): the last binding retires with the ASR
  // Agent, when this route becomes a one-release `redirect('/agents')`. The
  // Models/Providers halves it used to link to now live on `/ai-providers`.
  {
    route: '/ai-configuration',
    domain: 'ai-platform',
    label: 'Speech & Voice',
    tier: '30-49',
    icon: IconTargetArrow,
    required: [['read', 'TenantSttConfig']],
    implemented: true,
  },
  {
    route: '/consultations',
    domain: 'clinical',
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
  {
    route: '/playground/consultation',
    domain: 'playground',
    label: 'Consultation Scribe',
    tier: '50-59',
    icon: IconHeartbeat,
    required: [],
    implemented: true,
  },
  {
    route: '/playground/live-transcription',
    domain: 'playground',
    label: 'Live Transcription',
    tier: '50-59',
    icon: IconBroadcast,
    required: [],
    implemented: true,
  },
  {
    route: '/playground/voice-profiles',
    domain: 'playground',
    label: 'My Voice Enrollment & Profiles',
    tier: '50-59',
    icon: IconUserScan,
    required: [],
    implemented: true,
  },
  {
    route: '/playground/dna-writing-style',
    domain: 'playground',
    label: 'My DNA Writing Style',
    tier: '50-59',
    icon: IconDna2,
    required: [],
    implemented: true,
  },
  { route: '/playground/llm', domain: 'playground', label: 'LLM Playground', tier: '50-59', icon: IconSparkles, required: [], implemented: true },
  // deliberate divergence from the `required: ` convention above.
  // The five entries before this one are own-account end-user demo planes
  // whose backend guards are plain @Authorize() (comment above). The
  // Workbench instead READS and EXECUTES tenant WorkflowDefinition rows — a
  // resource ability the gateway enforces — so declaring `required: []`
  // would hide a real gate from the nav. RECONCILED against the real,
  // now-landed decorators: the definition picker needs
  // `manage:WorkflowDefinition` (`WorkflowDefinitionController`'s class-level
  // `@CanManage('WorkflowDefinition')` —), and starting/reading/
  // canceling a sandbox run needs `manage:WorkflowRun`
  // (`WorkflowSandboxRunController`'s `@CanCreate`/`@CanRead`/`@CanUpdate('WorkflowRun')`,
  // all subsumed by the seeded `manage:WorkflowRun` tenant-admin grant —
  // `packages/database/src/prisma/db_main/seed/01-policy.ts`). `canAny`
  // (OR) means either alone shows the entry; both are seeded together for
  // every tenant admin, so this is not a practical gap.
  {
    route: '/playground/workbench',
    domain: 'playground',
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
 * Implemented entries the caller's ability grants, in declaration order.
 * Tier 50-59 additionally requires an admin role (`roles`), mirroring the
 * (console)/(tenant) tier guard — ability rules alone cannot express it.
 */
/** Longest-prefix nav match — `/tenants/storage` beats `/tenants`. */
export function matchNavEntry(pathname: string, entries: readonly NavRouteEntry[] = ALL_ROUTE_ENTRIES): NavRouteEntry | undefined {
  return entries.filter((e) => pathname === e.route || pathname.startsWith(`${e.route}/`)).sort((a, b) => b.route.length - a.route.length)[0];
}

export function visibleNavEntries(rules: readonly PermissionRule[] | null | undefined, roles?: readonly string[] | null): NavEntry[] {
  return NAV_ENTRIES.filter((entry) => {
    if (!entry.implemented) return false;
    if (entry.tier === '50-59' && !isAdminTier(roles)) return false;
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
 * role check, which no ability rule can express.
 */
export function visibleNavDomains(rules: readonly PermissionRule[] | null | undefined, roles?: readonly string[] | null): NavDomain[] {
  const reachable = new Set(visibleNavEntries(rules, roles).map((entry) => entry.domain));
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
