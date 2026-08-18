/**
 * A CASL permission a scope implies — structurally identical to
 * `RequiredPermission` (`../../authorization/authorization.guard`), restated
 * here so the registry stays importable from the gateway's decorator layer
 * without pulling in guard runtime code.
 */
export interface ImpliedPermission {
  action: string;
  subject: string;
}

export interface ScopeDefinition {
  description: string;
  category: string;
  /**
   * TASK-756 — the privilege CEILING on minting: the CASL ability a holder of
   * this scope may exercise. `ApiKeyService.assertScopeCeiling` refuses to mint
   * (or widen) a key carrying a scope whose implications the CALLER does not
   * itself hold, so a credential can never out-rank the human who created it.
   *
   * How the values were derived — one rule, applied per scope:
   *   1. Take the CASL permission the scope's own controller declares
   *      (`@CanXxx`/`@Authorize`); the controller→scope half of this mapping is
   *      `apps/api/src/bootstrap/admin-scope-audit.ts`.
   *   2. Where the class-level decorator is only `@Authorize()` (authenticated,
   *      no subject) — or exists solely to satisfy the deny-by-default boot
   *      audit, as `AdminTranscriptionJobController` documents — use the
   *      method-level declarations instead.
   *   3. Where a controller declares an OR set (`@CanAny`), take the
   *      least-privileged branch: holding it already makes the surface reachable.
   *   4. Where one scope gates several controllers, union them (checked with
   *      AND) — the scope unlocks all of them.
   *
   * Surfaces gated only by authentication (the consultation/STT/TTS runtime
   * plane) carry the corresponding `Consultation` ability: that is the resource
   * the plane operates on, and it is what every principal permitted to use it
   * already holds. This is deliberately conservative, never fail-open — an
   * empty `implies` would let a scope pass the ceiling unchecked, which is why
   * `apikey-scopes.registry.test.ts` requires every entry to declare one.
   *
   * Wildcards are the exception: they carry `[]` and are resolved by EXPANSION
   * in `resolveImpliedPermissions`, never by a literal of their own.
   */
  implies: ImpliedPermission[];
}

export const API_KEY_SCOPE_REGISTRY: Record<string, ScopeDefinition> = {
  // STT Service
  'stt:transcription:read': { description: 'Read transcription results', category: 'STT', implies: [{ action: 'read', subject: 'Consultation' }] },
  'stt:transcription:write': {
    description: 'Create and stream transcriptions',
    category: 'STT',
    implies: [{ action: 'create', subject: 'Consultation' }],
  },
  'stt:stream:write': {
    description: 'Stream audio for real-time transcription',
    category: 'STT',
    implies: [{ action: 'create', subject: 'Consultation' }],
  },
  'stt:model:read': { description: 'View available STT models', category: 'STT', implies: [{ action: 'read', subject: 'Consultation' }] },

  // TTS Service (TASK-742). The `/speech/*` proxy was one of the surfaces the
  // gateway conformance review named as reachable with NO authorization check
  // at all, because the API-key path permitted any route declaring no scopes.
  // Follows the same `<area>:<resource>:<action>` grammar as the `stt:*` family
  // above rather than borrowing an `stt:` scope: a key issued to transcribe
  // audio has no business synthesising speech, and reusing `stt:*` here would
  // have silently granted exactly that.
  'tts:speech:write': { description: 'Synthesize speech from text', category: 'TTS', implies: [{ action: 'create', subject: 'Consultation' }] },
  'tts:voice:read': { description: 'List available TTS voices', category: 'TTS', implies: [{ action: 'read', subject: 'Consultation' }] },

  // Consultation
  'consultation:session:read': {
    description: 'Read consultation sessions',
    category: 'Consultation',
    implies: [{ action: 'read', subject: 'Consultation' }],
  },
  'consultation:session:write': {
    description: 'Create and manage consultation sessions',
    category: 'Consultation',
    implies: [{ action: 'create', subject: 'Consultation' }],
  },
  'consultation:report:read': {
    description: 'Read consultation reports/summaries',
    category: 'Consultation',
    implies: [{ action: 'read', subject: 'Consultation' }],
  },
  'consultation:report:write': {
    description: 'Generate consultation reports',
    category: 'Consultation',
    implies: [{ action: 'create', subject: 'Consultation' }],
  },

  // User (Self)
  'user:profile:read': { description: 'Read own user profile', category: 'User', implies: [{ action: 'read', subject: 'UserProfile' }] },
  'user:preferences:read': { description: 'Read own preferences', category: 'User', implies: [{ action: 'read', subject: 'UserSettings' }] },
  'user:preferences:write': { description: 'Update own preferences', category: 'User', implies: [{ action: 'update', subject: 'UserSettings' }] },

  // Media
  'media:file:read': { description: 'Read/download media files', category: 'Media', implies: [{ action: 'read', subject: 'Storage' }] },
  'media:file:write': { description: 'Upload media files', category: 'Media', implies: [{ action: 'create', subject: 'Storage' }] },

  // Admin
  'admin:user:read': { description: 'Read user information', category: 'Admin', implies: [{ action: 'read', subject: 'User' }] },
  'admin:user:write': { description: 'Manage users', category: 'Admin', implies: [{ action: 'manage', subject: 'User' }] },
  'admin:apikey:read': { description: 'Read API keys', category: 'Admin', implies: [{ action: 'read', subject: 'ApiKey' }] },
  'admin:apikey:write': { description: 'Manage API keys', category: 'Admin', implies: [{ action: 'manage', subject: 'ApiKey' }] },
  'admin:tenant:read': { description: 'Read tenant configuration', category: 'Admin', implies: [{ action: 'read', subject: 'Tenant' }] },
  'admin:tenant:write': { description: 'Manage tenant settings', category: 'Admin', implies: [{ action: 'manage', subject: 'Tenant' }] },
  'admin:audit:read': { description: 'Read audit logs', category: 'Admin', implies: [{ action: 'read', subject: 'AuditLog' }] },
  'admin:role:read': { description: 'Read roles and policies', category: 'Admin', implies: [{ action: 'read', subject: 'Role' }] },
  'admin:role:write': { description: 'Manage roles and policies', category: 'Admin', implies: [{ action: 'manage', subject: 'Role' }] },

  // Webhooks
  'webhook:event:read': { description: 'Read webhook events', category: 'Webhook', implies: [{ action: 'read', subject: 'Webhook' }] },
  'webhook:event:write': { description: 'Manage webhook subscriptions', category: 'Webhook', implies: [{ action: 'manage', subject: 'Webhook' }] },

  // Internal (platform-only). Reserved for service-to-service credentials —
  // never issued to a tenant SDK/WEBHOOK/INTEGRATION key. Gates
  // `SttInternalController` (`/internal/stt/*`), which the STT worker calls
  // with the platform SERVICE_ACCOUNT credential (scopes: `['*']`, which
  // satisfies this via `hasScope`'s wildcard grant — no seed/provisioning
  // change needed). See `apps/api/src/modules/internal/stt-internal.controller.ts`.
  //
  // Why a reserved scope rather than pulling `/internal/*` fully off the
  // API-key surface: the STT worker authenticates with `X-Internal-Service-Key`
  // carrying `api_gateway_key`, which BUG-013 requires to be the RAW value of a
  // registered ACTIVE SERVICE_ACCOUNT ApiKey row (`apps/stt/src/stt/worker.py`,
  // `core/effective_config.py`). It presents an API KEY, not a service token, so
  // a `@Public()` + service-token-guard rework would break the worker unless
  // `apps/stt` changed in lockstep. The owner's "`/admin/*` and `/internal/*`
  // are different purposes" rule is honoured by the SEPARATE `internal:` root —
  // prefix matching cannot cross it — not by a different auth mechanism.
  'internal:stt:worker': {
    description: 'STT worker service-to-service callbacks (never issued to a tenant key)',
    category: 'Internal',
    implies: [{ action: 'manage', subject: 'all' }],
  },

  // Admin (platform/tenant-admin surface, `/admin/*`). One scope per admin
  // controller area — TASK-708 Task 4 gap closure. Coarse-grained by design
  // (one scope per controller, not per read/write method) so the sweep is
  // mechanically verifiable across every `/admin/*` controller in one pass
  // without risking a missed-method gap; `admin:tenant:*`, `admin:user:*`,
  // `admin:apikey:*`, `admin:audit:read`, `admin:role:*` above predate this
  // pass and are reused where a controller's whole surface maps cleanly onto
  // one of them. See the ticket README's Task 3/4 tables for the full
  // controller → scope mapping and the sensitivity notes per area.
  'admin:rate-limit:manage': {
    description: 'Manage platform rate-limit configuration',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'all' }],
  },
  'admin:usage:manage': {
    description: 'Read/reconcile usage analytics',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'UsageAnalytics' }],
  },
  'admin:agent-promotion:manage': {
    description: 'Manage department-agent promotions',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'DepartmentAgent' }],
  },
  'admin:agent-trajectory:read': {
    description: 'Read agent trajectory steps',
    category: 'Admin',
    implies: [{ action: 'read', subject: 'AgentTrajectory' }],
  },
  'admin:agentic:manage': {
    description: 'Manage agentic policy administration',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'HarnessPolicy' }],
  },
  'admin:ai-model:manage': {
    description: 'Manage AI model registrations and discovery',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'all' }],
  },
  'admin:ai-provider:manage': {
    description: 'Manage AI/model provider connections (HIGH sensitivity — provider credentials)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'GlobalSetting' }],
  },
  'admin:ai-runtime-profile:manage': {
    description: 'Manage AI runtime profiles',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'all' }],
  },
  'admin:ai-service:manage': { description: 'Manage AI service configuration', category: 'Admin', implies: [{ action: 'manage', subject: 'all' }] },
  'admin:ai-task-default:manage': {
    description: 'Manage AI task defaults (some sub-routes are additionally SUPER_ADMIN-only via SUPER_ADMIN_ONLY_TASK_PREFIXES)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'AiTaskDefault' }],
  },
  'admin:billing:manage': {
    description: 'Manage billing invoices and rate cards',
    category: 'Admin',
    implies: [
      { action: 'manage', subject: 'BillingInvoice' },
      { action: 'manage', subject: 'AiPriceBook' },
    ],
  },
  'admin:changelog:manage': {
    description: 'Manage changelog entries',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'ChangelogEntry' }],
  },
  'admin:consultation-context-schema:manage': {
    description: 'Manage consultation context schemas',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'ConsultationContextSchema' }],
  },
  'admin:consultation-admin:manage': {
    description: 'Manage consultations from the admin surface',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Consultation' }],
  },
  'admin:department-agent:manage': {
    description: 'Manage department agents and their resync',
    category: 'Admin',
    implies: [
      { action: 'manage', subject: 'DepartmentAgent' },
      { action: 'manage', subject: 'Tenant' },
    ],
  },
  'admin:department:manage': { description: 'Manage departments', category: 'Admin', implies: [{ action: 'manage', subject: 'Department' }] },
  'admin:dna-writing-style:manage': {
    description: 'Manage DNA writing style reports',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'DnaWritingStyleReport' }],
  },
  'admin:entitlement:manage': { description: 'Manage tenant entitlements', category: 'Admin', implies: [{ action: 'manage', subject: 'all' }] },
  'admin:settings:manage': {
    description: 'Read/manage platform global settings (HIGH sensitivity — platform-wide knobs)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'GlobalSetting' }],
  },
  'admin:harness:manage': {
    description: 'Manage the Clinical Documentation Harness admin surface',
    category: 'Admin',
    implies: [
      { action: 'manage', subject: 'HarnessPolicy' },
      { action: 'manage', subject: 'HarnessEval' },
      { action: 'manage', subject: 'HarnessWorkflow' },
      { action: 'read', subject: 'HarnessAudit' },
    ],
  },
  'admin:knowledge:manage': {
    description: 'Manage the institutional-RAG knowledge corpus (inspect, archive, delete — governance, not ingestion)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'KnowledgeDocument' }],
  },
  'admin:mcp-server:manage': {
    description: 'Manage MCP server registrations',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'McpServer' }],
  },
  'admin:nlp-task-instructions:manage': {
    description: 'Manage tenant NLP task instructions',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'TenantNlpTaskInstructions' }],
  },
  'admin:notification:manage': {
    description: 'Manage platform notifications',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Notification' }],
  },
  'admin:pipeline-policy:manage': {
    description: 'Manage harness pipeline policy (carries the globalOnly descriptor lock on some fields)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'PipelinePolicy' }],
  },
  'admin:audio-pipeline:manage': {
    description: 'Manage audio pipeline configuration',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'AsrPipeline' }],
  },
  'admin:platform-metrics:read': {
    description: 'Read platform-wide metrics',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'PlatformMetrics' }],
  },
  'admin:prompt-template:manage': {
    description: 'Manage prompt templates from the admin surface',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'PromptTemplate' }],
  },
  'admin:pstudio:manage': { description: 'Manage Prisma Studio access', category: 'Admin', implies: [{ action: 'manage', subject: 'PrismaStudio' }] },
  'admin:queue:manage': { description: 'Manage background job queues', category: 'Admin', implies: [{ action: 'manage', subject: 'all' }] },
  'admin:scheduler:manage': { description: 'Manage scheduled jobs', category: 'Admin', implies: [{ action: 'manage', subject: 'all' }] },
  'admin:rbac-policy:write': {
    description: 'Manage RBAC policies (HIGH sensitivity — defines the RBAC model itself)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Policy' }],
  },
  'admin:resource-subscription:manage': {
    description: 'Manage resource subscriptions',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'ResourceSubscription' }],
  },
  'admin:service-release:manage': {
    description: 'Manage service release registrations',
    category: 'Admin',
    implies: [{ action: 'read', subject: 'TenantTelemetry' }],
  },
  'admin:storage-key:manage': {
    description: 'Manage tenant storage access keys (HIGH sensitivity — storage credentials)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Tenant' }],
  },
  'admin:transcription-job:read': {
    description: 'Read admin transcription job status',
    category: 'Admin',
    implies: [{ action: 'read', subject: 'AsrPipeline' }],
  },
  'admin:allowed-origin:manage': {
    description: 'Manage tenant CORS allow-list',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'TenantAllowedOrigin' }],
  },
  'admin:tenant-storage:manage': {
    description: 'Manage tenant storage buckets and config',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Tenant' }],
  },
  'admin:tenant-frontend-config:manage': {
    description: 'Manage tenant frontend configuration',
    category: 'Admin',
    implies: [{ action: 'update', subject: 'Tenant' }],
  },
  'admin:tenant-idp-config:manage': {
    description: 'Manage tenant identity-provider config (HIGH sensitivity — SSO)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'TenantIdentityProvider' }],
  },
  'admin:tenant-stt-config:manage': {
    description: 'Manage tenant STT configuration',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'TenantSttConfig' }],
  },
  'admin:tenant-tts-config:manage': {
    description: 'Manage tenant TTS configuration',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'TenantTtsConfig' }],
  },
  'admin:workflow-run:read': { description: 'Read admin workflow runs', category: 'Admin', implies: [{ action: 'read', subject: 'WorkflowRun' }] },
  'admin:workflow-test-fixture:manage': {
    description: 'Manage workflow test fixtures',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'WorkflowTestFixture' }],
  },
  'admin:workflow-definition:manage': {
    description: 'Author, validate and publish workflow definitions',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'WorkflowDefinition' }],
  },
  'admin:workflow-node:read': {
    description: 'Read the code-owned workflow node-type registry',
    category: 'Admin',
    implies: [{ action: 'read', subject: 'WorkflowDefinition' }],
  },

  // Workflow exposure plane (TASK-722). Prefix-matching (apikey.service.ts's
  // hasScope) means a key holding the bare `"workflow"` scope would grant all
  // three below — that is the existing prefix semantics, not new behavior.
  // NOTE: these scopes exist so `@RequiredScopes(...)` can be declared once
  // the gateway controller lands; the surface itself ships OFF (kill-switch)
  // per TASK-722 R-1 until TASK-708's scope-narrowing exit criterion is met.
  'workflow:definition:read': {
    description: 'List published workflows and their input schemas',
    category: 'Workflow',
    implies: [{ action: 'list', subject: 'WorkflowDefinition' }],
  },
  'workflow:run:write': {
    description: 'Invoke and cancel workflow runs',
    category: 'Workflow',
    implies: [
      { action: 'create', subject: 'WorkflowRun' },
      { action: 'update', subject: 'WorkflowRun' },
    ],
  },
  'workflow:run:read': {
    description: 'Read workflow run status and stream progress',
    category: 'Workflow',
    implies: [{ action: 'read', subject: 'WorkflowRun' }],
  },

  // Wildcards
  'stt:*': { description: 'Full STT service access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'tts:*': { description: 'Full TTS service access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'consultation:*': { description: 'Full consultation access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'user:*': { description: 'Full user self-service access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'media:*': { description: 'Full media access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'admin:*': { description: 'Full admin access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'webhook:*': { description: 'Full webhook access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'workflow:*': { description: 'Full workflow exposure access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  '*': { description: 'Unrestricted access (superadmin only)', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
};

export function isValidScope(scope: string): boolean {
  return scope in API_KEY_SCOPE_REGISTRY;
}

/**
 * TASK-756 — resolve the full set of CASL permissions a scope implies.
 *
 * Wildcards resolve by EXPANSION, not by a literal permission of their own,
 * because that is exactly what they buy at request time (`ApiKeyService.hasScope`:
 * `'*'` grants everything, `'<ns>:*'` grants the whole namespace):
 *
 * - `'<ns>:*'` → the union across every registry key starting `'<ns>:'`
 * - `'*'`      → the union across the whole registry (so only `manage:all`
 *                satisfies it)
 *
 * Enumeration is by KEY, never by position: `'admin:*'` does not sit inside the
 * contiguous `admin:` block in this file, so anything walking a line range or a
 * block would miss the single most dangerous string in the registry.
 *
 * Throws on an unknown scope — fail closed. Resolving an unrecognized string to
 * "no requirement" would turn a typo into a ceiling bypass.
 */
export function resolveImpliedPermissions(scope: string): ImpliedPermission[] {
  const collected: ImpliedPermission[] = [];

  if (scope === '*') {
    for (const [key, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
      if (key !== '*') collected.push(...def.implies);
    }
  } else if (scope.endsWith(':*')) {
    if (!(scope in API_KEY_SCOPE_REGISTRY)) {
      throw new Error(`Unknown API key scope: ${scope}`);
    }
    const prefix = `${scope.slice(0, -1)}`; // 'admin:*' -> 'admin:'
    for (const [key, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
      if (key !== scope && key.startsWith(prefix)) collected.push(...def.implies);
    }
  } else {
    const def = API_KEY_SCOPE_REGISTRY[scope];
    if (!def) {
      throw new Error(`Unknown API key scope: ${scope}`);
    }
    collected.push(...def.implies);
  }

  const seen = new Set<string>();
  return collected.filter((permission) => {
    const key = `${permission.action}:${permission.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getAvailableScopes(): Array<{ scope: string } & ScopeDefinition> {
  return Object.entries(API_KEY_SCOPE_REGISTRY).map(([scope, def]) => ({
    scope,
    ...def,
  }));
}

export function getScopesByCategory(): Record<string, Array<{ scope: string; description: string }>> {
  const result: Record<string, Array<{ scope: string; description: string }>> = {};
  for (const [scope, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
    if (!result[def.category]) result[def.category] = [];
    result[def.category].push({ scope, description: def.description });
  }
  return result;
}
