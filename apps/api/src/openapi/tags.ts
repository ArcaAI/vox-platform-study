/**
 * TASK-783 — the gateway's canonical OpenAPI tag taxonomy.
 *
 * ## Why this file exists
 *
 * Tags are the ONLY grouping an OpenAPI renderer has. Before this file the
 * gateway had 87 distinct tags, declared ad hoc at each `@ApiTags(...)` call
 * site, in three competing spellings (`admin-ai-models`,
 * `Admin: AI Runtime Profiles`, `RBAC - Roles`) and with an EMPTY top-level
 * `tags` array — so every renderer fell back to alphabetical order over raw
 * slugs, and no tag carried a description.
 *
 * Declaring them here gives three things the call sites cannot:
 *
 * 1. **Order.** `DocumentBuilder.addTag()` order is the order a renderer
 *    shows in its sidebar. Grouped by plane, then alphabetically inside it.
 * 2. **Descriptions.** One line per tag, shown above the operation list.
 * 3. **A closed set.** `tags.test.ts` asserts every tag used by a controller
 *    is declared here, so a tag introduced at a call site fails CI instead of
 *    silently appearing at the bottom of the sidebar with no explanation.
 *
 * ## Plane
 *
 * `plane` mirrors the API-plane taxonomy of TASK-757/758/759 and is emitted
 * as the `x-hope-plane` vendor extension so the portal can render the two
 * audience views (`gen:api-portal`) without re-deriving it from paths:
 *
 * | Plane | Meaning |
 * |---|---|
 * | `admin` | `/api/v1/admin/**` — the administration plane. JWT or service-account only; every route carries `@ForbidApiKey()` |
 * | `business` | the tenant-facing business plane — API-key reachable |
 * | `platform` | health, metrics, and other operational surfaces that belong to neither |
 *
 * `plane` here describes the TAG's audience, which is a documentation
 * grouping. It is NOT an authorization statement: the authoritative,
 * per-route answer is `route-manifest.json` (`apiKeyForbidden`,
 * `apiKeyScopes`, `svcScopes`, `requiredPermissions`), and the portal
 * generator reads it from there — never from this file.
 */

export type ApiPlane = 'admin' | 'business' | 'platform';

export interface ApiTagDefinition {
  /** The exact string a controller passes to `@ApiTags(...)`. */
  readonly name: string;
  /** One line, shown above the tag's operations. */
  readonly description: string;
  /** Human-readable label for renderers that support `x-displayName` (Scalar, Redoc). */
  readonly displayName: string;
  readonly plane: ApiPlane;
}

/**
 * Every tag the gateway emits. Grouped by plane; alphabetical within a group.
 *
 * Adding a tag at a call site without adding it here fails
 * `tags.test.ts`. That is deliberate — an undocumented group is how a
 * developer-facing reference quietly grows a section nobody wrote.
 */
export const API_TAGS: readonly ApiTagDefinition[] = [
  // ── Business plane — the tenant-facing API developers integrate against ──
  { name: 'auth', displayName: 'Authentication', plane: 'business', description: 'Login, token refresh, logout, stream tickets, and impersonation.' },
  {
    name: 'service-account-auth',
    displayName: 'Service Account Auth',
    plane: 'business',
    description: 'Exchange service-account client credentials for a short-lived platform token. The only path to the administration plane.',
  },
  {
    name: 'user',
    displayName: 'User Self-Service',
    plane: 'business',
    description: "The authenticated user's own profile, preferences, and department membership.",
  },
  {
    name: 'tenant',
    displayName: 'Tenant Self-Service',
    plane: 'business',
    description: "The caller's own tenant: profile, configuration, and context schema.",
  },
  {
    name: 'consultations',
    displayName: 'Consultations',
    plane: 'business',
    description: 'The core clinical record: create and manage consultations, case notes, transcripts, and generated summaries.',
  },
  {
    name: 'consultation-jobs',
    displayName: 'Consultation Jobs',
    plane: 'business',
    description: 'Asynchronous consultation work: submit a job, poll its status, retrieve its result.',
  },
  {
    name: 'transcription-jobs',
    displayName: 'Transcription Jobs',
    plane: 'business',
    description: 'Speech-to-text job lifecycle — submit audio, track progress, fetch transcripts.',
  },
  { name: 'speech', displayName: 'Speech', plane: 'business', description: 'Speech synthesis and streaming speech surfaces.' },
  {
    name: 'text',
    displayName: 'Text Generation',
    plane: 'business',
    description: 'Multi-provider text generation and summarization, synchronous and SSE-streamed.',
  },
  {
    name: 'ai-inference',
    displayName: 'AI Inference',
    plane: 'business',
    description: 'Direct inference surfaces — medical NER, classification, diagnosis suggestion, and guardrail analysis.',
  },
  { name: 'workflows', displayName: 'Workflows', plane: 'business', description: 'Trigger and observe agentic workflow runs.' },
  {
    name: 'prompt-templates',
    displayName: 'Prompt Templates',
    plane: 'business',
    description: 'Read and manage the prompt templates available to the caller, including personal ones.',
  },
  {
    name: 'dna-writing-styles',
    displayName: 'DNA Writing Styles',
    plane: 'business',
    description: 'Per-clinician writing-style profiles used to shape generated documentation.',
  },
  {
    name: 'voice-profile',
    displayName: 'Voice Profiles',
    plane: 'business',
    description: 'Per-user voice profiles for speaker identification and synthesis.',
  },
  {
    name: 'audio-pipelines',
    displayName: 'Audio Pipelines',
    plane: 'business',
    description: 'The ASR pipeline configurations a caller may select when starting audio capture.',
  },
  { name: 'storage', displayName: 'Storage', plane: 'business', description: 'Upload, download, and manage tenant-scoped objects.' },
  { name: 'billing', displayName: 'Billing', plane: 'business', description: "The caller's own invoices and spend." },
  { name: 'usage', displayName: 'Usage', plane: 'business', description: "The caller's own consumption summary and quota burndown." },
  {
    name: 'entitlements',
    displayName: 'Entitlements',
    plane: 'business',
    description: "The plan limits and features in effect for the caller's tenant.",
  },
  { name: 'changelog', displayName: 'Changelog', plane: 'business', description: 'Platform changelog entries visible to the caller.' },
  {
    name: 'rbac-permission-check',
    displayName: 'Permission Check',
    plane: 'business',
    description: 'Ask whether the caller may perform an action — single, bulk, or "list everything I can do".',
  },
  {
    name: 'text-compat',
    displayName: 'Text (v1 compat)',
    plane: 'business',
    description: 'Legacy v1-compatible summarization paths. Exempt from the /api/v1 prefix; kept for existing integrations.',
  },
  {
    name: 'stt-compat',
    displayName: 'Speech-to-Text (v1 compat)',
    plane: 'business',
    description: 'Legacy v1-compatible STT session paths. Exempt from the /api/v1 prefix; kept for existing integrations.',
  },

  // ── Administration plane — /api/v1/admin/**, never reachable by an API key ──
  {
    name: 'admin-agent-promotions',
    displayName: 'Agent Promotions',
    plane: 'admin',
    description: 'Promote an agent configuration between environments.',
  },
  {
    name: 'admin-agent-trajectory',
    displayName: 'Agent Trajectory',
    plane: 'admin',
    description: 'Inspect the step-by-step trajectory of an agent run.',
  },
  {
    name: 'admin-agentic',
    displayName: 'Agentic Policy',
    plane: 'admin',
    description: 'Platform-wide agentic policy and live harness configuration.',
  },
  {
    name: 'admin-ai-models',
    displayName: 'AI Models',
    plane: 'admin',
    description: 'The model catalog: which models exist, their metadata, and their label taxonomies.',
  },
  {
    name: 'admin-ai-provider-connections-legacy',
    displayName: 'Provider Connections (legacy alias)',
    plane: 'admin',
    description: 'Deprecated alias of the provider-connection routes. Use admin-provider-connections.',
  },
  {
    name: 'admin-ai-runtime-profiles',
    displayName: 'AI Runtime Profiles',
    plane: 'admin',
    description: 'Runtime tuning profiles applied to inference requests.',
  },
  {
    name: 'admin-ai-services',
    displayName: 'AI Services',
    plane: 'admin',
    description: 'Registration and health of the downstream Python inference services.',
  },
  {
    name: 'admin-ai-task-defaults',
    displayName: 'AI Task Defaults',
    plane: 'admin',
    description: 'Which provider and model serve each AI task, resolved tenant-first with a SYSTEM fallback.',
  },
  { name: 'admin-allowed-origins', displayName: 'Allowed Origins', plane: 'admin', description: 'Per-tenant CORS origin allow-list.' },
  { name: 'admin-api-keys', displayName: 'API Keys', plane: 'admin', description: 'Mint, scope, rotate, and revoke tenant API keys.' },
  {
    name: 'admin-audio-pipelines',
    displayName: 'Audio Pipelines',
    plane: 'admin',
    description: 'Author and manage the ASR pipeline configurations tenants may select.',
  },
  { name: 'admin-audit-logs', displayName: 'Audit Logs', plane: 'admin', description: 'Query the immutable audit trail.' },
  {
    name: 'admin-billing-invoices',
    displayName: 'Billing — Invoices',
    plane: 'admin',
    description: 'Generate, inspect, and adjust tenant invoices.',
  },
  { name: 'admin-billing-rate-card', displayName: 'Billing — Rate Card', plane: 'admin', description: 'The price list metering is billed against.' },
  { name: 'admin-changelog', displayName: 'Changelog', plane: 'admin', description: 'Author the platform changelog entries tenants see.' },
  {
    name: 'admin-consent-grants',
    displayName: 'Consent Grants',
    plane: 'admin',
    description: 'Patient consent grants governing what may be processed.',
  },
  {
    name: 'admin-consultation-context-schemas',
    displayName: 'Context Schemas',
    plane: 'admin',
    description: 'The structured-context schemas consultations are validated against.',
  },
  { name: 'admin-consultations', displayName: 'Consultations', plane: 'admin', description: 'Cross-tenant consultation administration and review.' },
  { name: 'admin-departments', displayName: 'Departments', plane: 'admin', description: 'The tenant department tree.' },
  {
    name: 'admin-document-templates',
    displayName: 'Document Templates',
    plane: 'admin',
    description: 'The clinical-document shapes generation is constrained to.',
  },
  {
    name: 'admin-dna-writing-styles',
    displayName: 'DNA Writing Styles',
    plane: 'admin',
    description: 'Administer per-clinician writing-style profiles, including erasure.',
  },
  {
    name: 'admin-entitlements',
    displayName: 'Entitlements & Plans',
    plane: 'admin',
    description: 'Plan definitions and the per-tenant ceilings they impose.',
  },
  {
    name: 'admin-frontend-pipeline-config',
    displayName: 'Frontend Pipeline Config',
    plane: 'admin',
    description: 'Browser-side pipeline configuration served to the SDK.',
  },
  { name: 'admin-global-settings', displayName: 'Global Settings', plane: 'admin', description: 'Platform-wide non-secret knobs (global-kv tier).' },
  {
    name: 'admin-harness',
    displayName: 'Clinical Documentation Harness',
    plane: 'admin',
    description: 'Harness policy, evaluation, assurance, and live configuration.',
  },
  { name: 'admin-knowledge', displayName: 'Knowledge Base', plane: 'admin', description: 'Knowledge documents and their retrieval indexes.' },
  { name: 'admin-mcp-servers', displayName: 'Tools & MCP', plane: 'admin', description: 'Registered MCP servers and the tools they expose.' },
  {
    name: 'admin-nlp-task-instructions',
    displayName: 'NLP Task Instructions',
    plane: 'admin',
    description: 'Per-task instruction overrides for the medical NLP service.',
  },
  { name: 'admin-notifications', displayName: 'Notifications', plane: 'admin', description: 'Platform notification delivery and templates.' },
  { name: 'admin-platform-metrics', displayName: 'Platform Metrics', plane: 'admin', description: 'Aggregate cross-tenant platform metrics.' },
  {
    name: 'admin-prompt-templates',
    displayName: 'Prompt Templates',
    plane: 'admin',
    description: 'Author, version, and approve prompt templates. SYSTEM-owned templates are super-admin only.',
  },
  {
    name: 'admin-provider-connections',
    displayName: 'Provider Connections',
    plane: 'admin',
    description: 'Bring-your-own-key vendor connections, resolved tenant-first with a SYSTEM fallback.',
  },
  { name: 'admin-pstudio', displayName: 'Database Studio', plane: 'admin', description: 'Read-only database inspection surface.' },
  { name: 'admin-queues', displayName: 'Queues & Jobs', plane: 'admin', description: 'BullMQ queue depth, job inspection, retry, and drain.' },
  { name: 'admin-rate-limit', displayName: 'Rate Limits', plane: 'admin', description: 'Tiered rate-limit configuration.' },
  { name: 'admin-rbac-policies', displayName: 'RBAC — Policies', plane: 'admin', description: 'CASL policy documents and their bindings.' },
  { name: 'admin-rbac-roles', displayName: 'RBAC — Roles', plane: 'admin', description: 'Roles, their abilities, and their assignment to users.' },
  {
    name: 'admin-resource-subscriptions',
    displayName: 'Resource Subscriptions',
    plane: 'admin',
    description: 'Server-sent-event subscriptions to resource change streams.',
  },
  { name: 'admin-schedulers', displayName: 'Schedulers', plane: 'admin', description: 'Cron schedules and their run history.' },
  {
    name: 'admin-service-accounts',
    displayName: 'Service Accounts',
    plane: 'admin',
    description: 'Machine identities for the administration plane. Issuance is deliberately absent from the SDK.',
  },
  {
    name: 'admin-service-releases',
    displayName: 'Service Releases',
    plane: 'admin',
    description: 'Deployed service versions and their build identity.',
  },
  {
    name: 'admin-security-policy',
    displayName: 'Security Policy',
    plane: 'admin',
    description: 'Platform credential policy — password complexity/rotation and issued-secret entropy.',
  },
  {
    name: 'admin-settings-catalog',
    displayName: 'Settings Catalog',
    plane: 'admin',
    description: 'The declared settings catalog — every governed key and its tier.',
  },
  {
    name: 'admin-settings-registry',
    displayName: 'Settings Registry',
    plane: 'admin',
    description: 'Read and write governed settings through their descriptors.',
  },
  {
    name: 'admin-storage-config',
    displayName: 'Storage Config',
    plane: 'admin',
    description: 'Bucket and tenant storage configuration, cascading to a SYSTEM default.',
  },
  { name: 'admin-stt', displayName: 'Speech-to-Text', plane: 'admin', description: 'STT engine configuration and per-tenant overrides.' },
  {
    name: 'admin-tenant-idp-config',
    displayName: 'Identity Providers',
    plane: 'admin',
    description: 'Per-tenant OIDC identity-provider configuration.',
  },
  { name: 'admin-tenants', displayName: 'Tenants', plane: 'admin', description: 'Tenant lifecycle, profile, and configuration.' },
  {
    name: 'admin-transcription-jobs',
    displayName: 'Transcription Jobs',
    plane: 'admin',
    description: 'Cross-tenant transcription job administration.',
  },
  { name: 'admin-tts', displayName: 'Text-to-Speech', plane: 'admin', description: 'TTS provider configuration and per-tenant credentials.' },
  {
    name: 'admin-usage',
    displayName: 'Usage & Consumption',
    plane: 'admin',
    description: 'Metered consumption, cost attribution, and provider reconciliation.',
  },
  { name: 'admin-user-departments', displayName: 'User Departments', plane: 'admin', description: 'Assignment of users to departments.' },
  { name: 'admin-users', displayName: 'Users', plane: 'admin', description: 'User lifecycle, credentials, and role assignment.' },
  { name: 'admin-webhooks', displayName: 'Webhooks', plane: 'admin', description: 'Outbound webhook endpoints, secrets, and delivery history.' },
  {
    name: 'admin-workflow-assignments',
    displayName: 'Workflow Assignments',
    plane: 'admin',
    description: 'Which workflow definition serves which trigger.',
  },
  {
    name: 'admin-workflow-definitions',
    displayName: 'Workflow Definitions',
    plane: 'admin',
    description: 'Author, compile, and version agentic workflow definitions.',
  },
  {
    name: 'admin-workflow-invariant-rules',
    displayName: 'Workflow Invariant Rules',
    plane: 'admin',
    description: "The validator rule rows a graph is checked against — the SYSTEM platform register plus a tenant's own stricter additions.",
  },
  {
    name: 'admin-workflow-nodes',
    displayName: 'Workflow Nodes',
    plane: 'admin',
    description: 'The node palette available to the workflow compiler.',
  },
  { name: 'admin-workflow-runs', displayName: 'Workflow Runs', plane: 'admin', description: 'Inspect and replay workflow runs.' },
  {
    name: 'admin-workflow-sandbox-runs',
    displayName: 'Workflow Sandbox Runs',
    plane: 'admin',
    description: 'Trial runs of a workflow definition against fixtures, without touching real data.',
  },
  {
    name: 'admin-workflow-test-fixtures',
    displayName: 'Workflow Test Fixtures',
    plane: 'admin',
    description: 'The fixtures sandbox runs execute against.',
  },
  { name: 'monitoring', displayName: 'Monitoring', plane: 'admin', description: 'Service health roll-up and dependency probes.' },
  { name: 'tenant-storage', displayName: 'Tenant Storage', plane: 'admin', description: 'Per-tenant bucket administration.' },
  {
    name: 'tenant-storage-keys',
    displayName: 'Tenant Storage Keys',
    plane: 'admin',
    description: 'Storage credentials, held in Vault behind a credentials reference — never in a database column.',
  },

  // ── Platform — operational surfaces belonging to neither plane ──
  // `internal-stt` sits on an @ApiExcludeController controller, so it never
  // reaches openapi.json. It is declared anyway because the closed-set test
  // scans SOURCES: an excluded controller still names a group, and leaving it
  // undeclared would mean the test could not tell "deliberately excluded" from
  // "forgot to declare".
  {
    name: 'internal-stt',
    displayName: 'Internal — Speech-to-Text',
    plane: 'platform',
    description: 'Service-to-service STT callbacks. Excluded from the public reference; reachable only with the internal service token.',
  },
  { name: 'health', displayName: 'Health', plane: 'platform', description: 'Liveness, readiness, and dependency health probes.' },
  // Emitted by the VENDORED `@willsoto/nestjs-prometheus` controller, which we
  // do not own and therefore cannot re-tag at the source. Declared verbatim
  // (capital P, no kebab-case) so the closed-set test passes honestly rather
  // than by pretending the taxonomy is uniform where it is not.
  {
    name: 'Prometheus',
    displayName: 'Observability',
    plane: 'platform',
    description:
      'The Prometheus scrape endpoint (`/metrics`), served by the vendored @willsoto/nestjs-prometheus controller. Exempt from the /api/v1 prefix.',
  },
];

/** Fast membership/lookup index over {@link API_TAGS}. */
export const API_TAGS_BY_NAME: ReadonlyMap<string, ApiTagDefinition> = new Map(API_TAGS.map((tag) => [tag.name, tag]));

/** The plane a tag belongs to, or `undefined` when the tag is not declared. */
export function planeForTag(tagName: string): ApiPlane | undefined {
  return API_TAGS_BY_NAME.get(tagName)?.plane;
}
