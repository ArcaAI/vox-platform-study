// The assembled HOPE settings catalog.
//
// Feature modules contribute descriptor arrays; this is the single queryable
// registry, seeded with the verified, admin-controllable settings across the
// tiers (pipeline config, TTS BYO secrets, entitlements). Consumers include
// the catalog endpoint, server-side categories, and the generalized
// effective-config resolver.

import { AGENTIC_CONTEXT_SETTINGS } from './descriptors/agentic-context.descriptors';
import { AGENTIC_EVAL_SETTINGS } from './descriptors/agentic-eval.descriptors';
import { AGENTIC_FEWSHOT_SETTINGS } from './descriptors/agentic-fewshot.descriptors';
import { AGENTIC_REVISIT_SETTINGS } from './descriptors/agentic-revisit.descriptors';
import { BATCH_TRANSCRIPTION_SETTINGS } from './descriptors/batch-transcription.descriptors';
import { BOOTSTRAP_ENV_SETTINGS } from './descriptors/bootstrap-env.descriptors';
import { CONSULTATION_ENDPOINT_SETTINGS } from './descriptors/consultation-endpoint.descriptors';
import { CONSULTATION_GATE_SETTINGS } from './descriptors/consultation-gates.descriptors';
import { ENTITLEMENT_SETTINGS } from './descriptors/entitlements.descriptors';
import { FEATURE_FLAG_SETTINGS } from './descriptors/feature-flags.descriptors';
import { GUARDRAIL_POLICY_SETTINGS } from './descriptors/guardrail-policy.descriptors';
import { HARNESS_LOOP_SETTINGS } from './descriptors/harness-loop.descriptors';
import { HARNESS_CLAIM_CHECK_MIN_BYTES, HARNESS_SENSOR_SETTINGS } from './descriptors/harness-sensor.descriptors';
import { MCP_EGRESS_SETTINGS } from './descriptors/mcp-egress.descriptors';
import { METERING_SETTINGS } from './descriptors/metering.descriptors';
import { MODEL_DEFAULT_SETTINGS } from './descriptors/model-defaults.descriptors';
import { PHI_REDACTION_SETTINGS } from './descriptors/phi-redaction.descriptors';
import { PIPELINE_SETTINGS } from './descriptors/pipeline.descriptors';
import { PLATFORM_KNOB_SETTINGS, RATE_LIMIT_TIER_SETTINGS } from './descriptors/platform-knobs.descriptors';
import { PLATFORM_OPS_SETTINGS } from './descriptors/platform-ops.descriptors';
import { PLATFORM_SECRET_SETTINGS } from './descriptors/platform-secrets.descriptors';
import { SECURITY_POLICY_SETTINGS } from './descriptors/security-policy.descriptors';
import { SERVICE_RUNTIME_SETTINGS } from './descriptors/service-runtime.descriptors';
import { TEXT_PROVIDER_CONNECTION_SETTINGS } from './descriptors/text-provider-connections.descriptors';
import { TEXT_GENERATION_SETTINGS } from './descriptors/text-generation.descriptors';
import { TEXT_GUARDRAIL_POLICY_SETTINGS } from './descriptors/text-guardrail-policy.descriptors';
import { STORAGE_SETTINGS } from './descriptors/storage.descriptors';
import { STT_FALLBACK_SETTINGS } from './descriptors/stt-fallback.descriptors';
import { STT_RUNTIME_SETTINGS } from './descriptors/stt-runtime.descriptors';
import { TTS_RUNTIME_SETTINGS } from './descriptors/tts-runtime.descriptors';
import { TTS_SETTINGS } from './descriptors/tts.descriptors';
import { VISIT_TYPE_SETTINGS } from './descriptors/visit-type.descriptors';
import { SettingsRegistry } from './settings-registry';

export const HOPE_SETTINGS_REGISTRY: SettingsRegistry = new SettingsRegistry().registerAll([
  ...PIPELINE_SETTINGS,
  // Platform storage default: SYSTEM TenantStorageConfig row + Vault kv-v2.
  ...STORAGE_SETTINGS,
  ...TTS_SETTINGS,
  // tts PLATFORM provider config — endpoints, local-engine model ids, timeouts,
  // concurrency and synthesis limits, all of which were environment variables
  // until TASK-799 lane C. The tenant-varying half stays in TTS_SETTINGS above
  // and travels the push channel; these ride the pull route (D-1). The two cloud
  // credentials appear in NEITHER: they have no env path at all by construction.
  ...TTS_RUNTIME_SETTINGS,
  // Per-tenant STT fallback pipeline pointer + BYO provider credentials.
  ...STT_FALLBACK_SETTINGS,
  // Batch (pre-recorded file) upload ceilings — recordings per batch, minutes
  // per recording, size, in-flight jobs per user.
  ...BATCH_TRANSCRIPTION_SETTINGS,
  ...ENTITLEMENT_SETTINGS,
  // Outbox-drain schedule (ws-b-contract.md handoff) + the
  // TenantUsageMeter reconcile-sweep kill-switch + its seed-time-only default.
  ...METERING_SETTINGS,
  // AI task-model defaults (guardrail/NLP/TEXT).
  ...MODEL_DEFAULT_SETTINGS,
  // Guardrail POLICY (thresholds, judge/groundedness tuning, label
  // taxonomies) — tenant → SYSTEM cascade, tighten-only floor on the
  // verdict-deciding keys. Companion to MODEL_DEFAULT_SETTINGS' `models.guardrail.*`
  // (which selects WHICH model runs; this selects HOW STRICT it is).
  ...GUARDRAIL_POLICY_SETTINGS,
  // The tenant's VISIT-TYPE catalogue (TASK-815 §11 row 3) — the label set that
  // used to be a derived literal in nine places. `maxScope: 'tenant'`, so a
  // tenant defines its own and one with no opinion inherits the two shipped
  // defaults through the SYSTEM lane.
  ...VISIT_TYPE_SETTINGS,
  // agentic context-management strategy knobs.
  ...AGENTIC_CONTEXT_SETTINGS,
  // agentic eval promotion-gate mode (block | warn | off).
  ...AGENTIC_EVAL_SETTINGS,
  // Re-visit carry-forward (default OFF).
  ...AGENTIC_REVISIT_SETTINGS,
  // Few-shot exemplar curation gate (default off).
  ...AGENTIC_FEWSHOT_SETTINGS,
  // The formerly orphaned platform-ops keys (rate limiting, audit
  // retention, agent-trajectory retention). Registered at their CURRENT runtime
  // defaults, so cataloging them changes no behaviour.
  ...PLATFORM_OPS_SETTINGS,
  // Stt-v2/nlp service-runtime knobs, consumed over the internal
  // effective-config route. Registered at their current Python defaults, so
  // cataloging them changes no behaviour.
  ...SERVICE_RUNTIME_SETTINGS,
  // The rest of stt's runtime tuning — VAD, streaming geometry and timeouts,
  // transcription chunking, punctuation, semantic endpointing, worker/threading
  // and the non-secret halves of the cloud engine connections. All were
  // environment variables until TASK-799 lane C; every `default` is transcribed
  // verbatim from the Python field it replaces, so registering them changes no
  // behaviour and needs no seeded rows.
  ...STT_RUNTIME_SETTINGS,
  // Gateway-side PHI-redaction call budget (companion to the guardrail-side
  // chunk budget in SERVICE_RUNTIME_SETTINGS). Registered at the redactor's own
  // code default, so cataloging it changes no behaviour.
  ...PHI_REDACTION_SETTINGS,
  // TEXT cloud-provider (openai/anthropic/vertex) platform CONNECTION config —
  // tier `env`, read by apps/text. Registered at their config.py defaults, so
  // cataloging them changes no behaviour.
  ...TEXT_PROVIDER_CONNECTION_SETTINGS,
  // TEXT's per-tenant moderation policy — the PUSH half of the guardrail
  // posture. Deliberately NOT `consumedBy`: it varies by tenant, so it travels
  // per-request injection, never the platform-scope pull snapshot (D-1).
  ...TEXT_GUARDRAIL_POLICY_SETTINGS,
  // TEXT's platform generation profile (temperature/maxTokens/topP), registered
  // verbatim at `GENERATION_FLOOR`, so cataloging them changes no behaviour.
  ...TEXT_GENERATION_SETTINGS,

  // ── Taxonomy coverage ────────────────────────────────────────────────────
  // Platform secrets (Vault kv-v2). Every one is `failMode: 'closed'`, enforced
  // by `SettingsRegistry.register`.
  ...PLATFORM_SECRET_SETTINGS,
  // The bootstrap floor: the variables required to REACH the database or
  // AUTHENTICATE to Vault. Not admin-editable (`editableBy: 'none'`) — declared
  // so the catalog is complete and the schema generator can emit the per-deployable schema.
  ...BOOTSTRAP_ENV_SETTINGS,
  // Operational knobs still read from env, carrying `targetTier: 'global-kv'`.
  ...PLATFORM_KNOB_SETTINGS,
  // Rate-limit TIER policy — genuinely `global-kv` today (RateLimitSettingsService
  // already resolves them from GlobalSetting); they were simply never cataloged.
  ...RATE_LIMIT_TIER_SETTINGS,
  // Feature gates still read from env, carrying `targetTier: 'redis-flag'`.
  ...FEATURE_FLAG_SETTINGS,
  // Credential policy — password complexity/rotation (readers already existed
  // and already preferred the stored row; they were simply never cataloged, so
  // no admin could reach them) and the issued-secret strength policy behind
  // service-account client secrets and API keys.
  ...SECURITY_POLICY_SETTINGS,
  // SSRF egress allow-list for tenant-authored `McpServer.baseUrl` (TASK-846 D-3).
  // Sits beside the credential policy for the same reason: it is a floor the
  // PLATFORM owes every tenant, against a party that is now the tenant itself.
  ...MCP_EGRESS_SETTINGS,

  // ── Configuration-tier compliance ────────────────────────────────────────
  // The two consultation-pipeline `@OnEvent(ContextAdded)` kill-switches,
  // MIGRATED off `process.env` in the same commit (so `tier` is already
  // `global-kv`, with no `targetTier` pending). NOTE: `consultation.ocr.enabled`
  // carries a deliberate BEHAVIOUR CHANGE — `OCR_ENABLED` defaulted ON, and a
  // kill-switch must default OFF.
  ...CONSULTATION_GATE_SETTINGS,
  // TASK-812 — the ordered endpoint stage that runs before a consultation closes.
  ...CONSULTATION_ENDPOINT_SETTINGS,

  // ── Consultation-loop lifecycle bounds ───────────────────────────────────
  // The loop's IDLE bound. A tuning knob rather than a kill-switch, and PINNED
  // at workflow start rather than re-read per signal — see the descriptor.
  ...HARNESS_LOOP_SETTINGS,

  // ── Clinical-assurance gate thresholds (TASK-799 A.2) ────────────────────
  // The PLATFORM defaults for the harness sensor gates, served on the pull route.
  // The per-tenant lane is `HarnessPolicy` (PUSH), not an override here — see the
  // descriptor file for why the split falls that way (D-1).
  ...HARNESS_SENSOR_SETTINGS,
  HARNESS_CLAIM_CHECK_MIN_BYTES,

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║ REGISTRATION POINT — storage config → DB + Vault                         ║
  // ║                                                                          ║
  // ║ Storage descriptors live in `descriptors/storage.descriptors.ts`.        ║
  // ║ To wire them in, add the import above and ONE line here:                 ║
  // ║                                                                          ║
  // ║     ...STORAGE_SETTINGS,                                                 ║
  // ║                                                                          ║
  // ║ CONTRACT ITS DESCRIPTORS MUST MEET:                                      ║
  // ║  • `failMode` is REQUIRED on every descriptor — the build fails without   ║
  // ║    it. Storage ENDPOINT/REGION/PATH-STYLE/PREFIX are tuning →             ║
  // ║    'open-to-default'; anything `sensitivity: 'secret'` (a credentialsRef  ║
  // ║    target, a BYO tenant key) MUST be 'closed' — `register()` throws       ║
  // ║    otherwise, at module load.                                            ║
  // ║  • If a value is still read from `MINIO_*` env, declare                   ║
  // ║    `tier: 'env'` + `targetTier: 'db-config'` rather than claiming the DB  ║
  // ║    tier early; flip `tier` and drop `targetTier` when the READER moves.   ║
  // ║  • env-tier descriptors use `editableBy: EDITABLE_BY_NONE`; a governance  ║
  // ║    test binds that both ways.                                            ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
]);
