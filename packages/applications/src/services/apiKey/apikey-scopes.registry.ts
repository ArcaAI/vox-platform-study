export interface ScopeDefinition {
  description: string;
  category: string;
}

export const API_KEY_SCOPE_REGISTRY: Record<string, ScopeDefinition> = {
  // STT Service
  'stt:transcription:read': { description: 'Read transcription results', category: 'STT' },
  'stt:transcription:write': { description: 'Create and stream transcriptions', category: 'STT' },
  'stt:stream:write': { description: 'Stream audio for real-time transcription', category: 'STT' },
  'stt:model:read': { description: 'View available STT models', category: 'STT' },

  // TTS Service (TASK-742). The `/speech/*` proxy was one of the surfaces the
  // gateway conformance review named as reachable with NO authorization check
  // at all, because the API-key path permitted any route declaring no scopes.
  // Follows the same `<area>:<resource>:<action>` grammar as the `stt:*` family
  // above rather than borrowing an `stt:` scope: a key issued to transcribe
  // audio has no business synthesising speech, and reusing `stt:*` here would
  // have silently granted exactly that.
  'tts:speech:write': { description: 'Synthesize speech from text', category: 'TTS' },
  'tts:voice:read': { description: 'List available TTS voices', category: 'TTS' },

  // Consultation
  'consultation:session:read': { description: 'Read consultation sessions', category: 'Consultation' },
  'consultation:session:write': { description: 'Create and manage consultation sessions', category: 'Consultation' },
  'consultation:report:read': { description: 'Read consultation reports/summaries', category: 'Consultation' },
  'consultation:report:write': { description: 'Generate consultation reports', category: 'Consultation' },

  // User (Self)
  'user:profile:read': { description: 'Read own user profile', category: 'User' },
  'user:preferences:read': { description: 'Read own preferences', category: 'User' },
  'user:preferences:write': { description: 'Update own preferences', category: 'User' },

  // Media
  'media:file:read': { description: 'Read/download media files', category: 'Media' },
  'media:file:write': { description: 'Upload media files', category: 'Media' },

  // Admin
  'admin:user:read': { description: 'Read user information', category: 'Admin' },
  'admin:user:write': { description: 'Manage users', category: 'Admin' },
  'admin:apikey:read': { description: 'Read API keys', category: 'Admin' },
  'admin:apikey:write': { description: 'Manage API keys', category: 'Admin' },
  'admin:tenant:read': { description: 'Read tenant configuration', category: 'Admin' },
  'admin:tenant:write': { description: 'Manage tenant settings', category: 'Admin' },
  'admin:audit:read': { description: 'Read audit logs', category: 'Admin' },
  'admin:role:read': { description: 'Read roles and policies', category: 'Admin' },
  'admin:role:write': { description: 'Manage roles and policies', category: 'Admin' },

  // Webhooks
  'webhook:event:read': { description: 'Read webhook events', category: 'Webhook' },
  'webhook:event:write': { description: 'Manage webhook subscriptions', category: 'Webhook' },

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
  'internal:stt:worker': { description: 'STT worker service-to-service callbacks (never issued to a tenant key)', category: 'Internal' },

  // Admin (platform/tenant-admin surface, `/admin/*`). One scope per admin
  // controller area — TASK-708 Task 4 gap closure. Coarse-grained by design
  // (one scope per controller, not per read/write method) so the sweep is
  // mechanically verifiable across every `/admin/*` controller in one pass
  // without risking a missed-method gap; `admin:tenant:*`, `admin:user:*`,
  // `admin:apikey:*`, `admin:audit:read`, `admin:role:*` above predate this
  // pass and are reused where a controller's whole surface maps cleanly onto
  // one of them. See the ticket README's Task 3/4 tables for the full
  // controller → scope mapping and the sensitivity notes per area.
  'admin:rate-limit:manage': { description: 'Manage platform rate-limit configuration', category: 'Admin' },
  'admin:usage:manage': { description: 'Read/reconcile usage analytics', category: 'Admin' },
  'admin:agent-promotion:manage': { description: 'Manage department-agent promotions', category: 'Admin' },
  'admin:agent-trajectory:read': { description: 'Read agent trajectory steps', category: 'Admin' },
  'admin:agentic:manage': { description: 'Manage agentic policy administration', category: 'Admin' },
  'admin:ai-model:manage': { description: 'Manage AI model registrations and discovery', category: 'Admin' },
  'admin:ai-provider:manage': { description: 'Manage AI/model provider connections (HIGH sensitivity — provider credentials)', category: 'Admin' },
  'admin:ai-runtime-profile:manage': { description: 'Manage AI runtime profiles', category: 'Admin' },
  'admin:ai-service:manage': { description: 'Manage AI service configuration', category: 'Admin' },
  'admin:ai-task-default:manage': {
    description: 'Manage AI task defaults (some sub-routes are additionally SUPER_ADMIN-only via SUPER_ADMIN_ONLY_TASK_PREFIXES)',
    category: 'Admin',
  },
  'admin:billing:manage': { description: 'Manage billing invoices and rate cards', category: 'Admin' },
  'admin:changelog:manage': { description: 'Manage changelog entries', category: 'Admin' },
  'admin:consultation-context-schema:manage': { description: 'Manage consultation context schemas', category: 'Admin' },
  'admin:consultation-admin:manage': { description: 'Manage consultations from the admin surface', category: 'Admin' },
  'admin:department-agent:manage': { description: 'Manage department agents and their resync', category: 'Admin' },
  'admin:department:manage': { description: 'Manage departments', category: 'Admin' },
  'admin:dna-writing-style:manage': { description: 'Manage DNA writing style reports', category: 'Admin' },
  'admin:entitlement:manage': { description: 'Manage tenant entitlements', category: 'Admin' },
  'admin:settings:manage': { description: 'Read/manage platform global settings (HIGH sensitivity — platform-wide knobs)', category: 'Admin' },
  'admin:harness:manage': { description: 'Manage the Clinical Documentation Harness admin surface', category: 'Admin' },
  'admin:knowledge:manage': {
    description: 'Manage the institutional-RAG knowledge corpus (inspect, archive, delete — governance, not ingestion)',
    category: 'Admin',
  },
  'admin:mcp-server:manage': { description: 'Manage MCP server registrations', category: 'Admin' },
  'admin:nlp-task-instructions:manage': { description: 'Manage tenant NLP task instructions', category: 'Admin' },
  'admin:notification:manage': { description: 'Manage platform notifications', category: 'Admin' },
  'admin:pipeline-policy:manage': {
    description: 'Manage harness pipeline policy (carries the globalOnly descriptor lock on some fields)',
    category: 'Admin',
  },
  'admin:audio-pipeline:manage': { description: 'Manage audio pipeline configuration', category: 'Admin' },
  'admin:platform-metrics:read': { description: 'Read platform-wide metrics', category: 'Admin' },
  'admin:prompt-template:manage': { description: 'Manage prompt templates from the admin surface', category: 'Admin' },
  'admin:pstudio:manage': { description: 'Manage Prisma Studio access', category: 'Admin' },
  'admin:queue:manage': { description: 'Manage background job queues', category: 'Admin' },
  'admin:scheduler:manage': { description: 'Manage scheduled jobs', category: 'Admin' },
  'admin:rbac-policy:write': { description: 'Manage RBAC policies (HIGH sensitivity — defines the RBAC model itself)', category: 'Admin' },
  'admin:resource-subscription:manage': { description: 'Manage resource subscriptions', category: 'Admin' },
  'admin:service-release:manage': { description: 'Manage service release registrations', category: 'Admin' },
  'admin:storage-key:manage': { description: 'Manage tenant storage access keys (HIGH sensitivity — storage credentials)', category: 'Admin' },
  'admin:transcription-job:read': { description: 'Read admin transcription job status', category: 'Admin' },
  'admin:allowed-origin:manage': { description: 'Manage tenant CORS allow-list', category: 'Admin' },
  'admin:tenant-storage:manage': { description: 'Manage tenant storage buckets and config', category: 'Admin' },
  'admin:tenant-frontend-config:manage': { description: 'Manage tenant frontend configuration', category: 'Admin' },
  'admin:tenant-idp-config:manage': { description: 'Manage tenant identity-provider config (HIGH sensitivity — SSO)', category: 'Admin' },
  'admin:tenant-stt-config:manage': { description: 'Manage tenant STT configuration', category: 'Admin' },
  'admin:tenant-tts-config:manage': { description: 'Manage tenant TTS configuration', category: 'Admin' },
  'admin:workflow-run:read': { description: 'Read admin workflow runs', category: 'Admin' },
  'admin:workflow-test-fixture:manage': { description: 'Manage workflow test fixtures', category: 'Admin' },
  'admin:workflow-definition:manage': { description: 'Author, validate and publish workflow definitions', category: 'Admin' },
  'admin:workflow-node:read': { description: 'Read the code-owned workflow node-type registry', category: 'Admin' },

  // Workflow exposure plane (TASK-722). Prefix-matching (apikey.service.ts's
  // hasScope) means a key holding the bare `"workflow"` scope would grant all
  // three below — that is the existing prefix semantics, not new behavior.
  // NOTE: these scopes exist so `@RequiredScopes(...)` can be declared once
  // the gateway controller lands; the surface itself ships OFF (kill-switch)
  // per TASK-722 R-1 until TASK-708's scope-narrowing exit criterion is met.
  'workflow:definition:read': { description: 'List published workflows and their input schemas', category: 'Workflow' },
  'workflow:run:write': { description: 'Invoke and cancel workflow runs', category: 'Workflow' },
  'workflow:run:read': { description: 'Read workflow run status and stream progress', category: 'Workflow' },

  // Wildcards
  'stt:*': { description: 'Full STT service access', category: 'Wildcard' },
  'tts:*': { description: 'Full TTS service access', category: 'Wildcard' },
  'consultation:*': { description: 'Full consultation access', category: 'Wildcard' },
  'user:*': { description: 'Full user self-service access', category: 'Wildcard' },
  'media:*': { description: 'Full media access', category: 'Wildcard' },
  'admin:*': { description: 'Full admin access', category: 'Wildcard' },
  'webhook:*': { description: 'Full webhook access', category: 'Wildcard' },
  'workflow:*': { description: 'Full workflow exposure access', category: 'Wildcard' },
  '*': { description: 'Unrestricted access (superadmin only)', category: 'Wildcard' },
};

export function isValidScope(scope: string): boolean {
  return scope in API_KEY_SCOPE_REGISTRY;
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
