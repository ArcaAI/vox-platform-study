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
import { AI_READINESS_SETTINGS } from './descriptors/ai-readiness.descriptors';
import { BATCH_TRANSCRIPTION_SETTINGS } from './descriptors/batch-transcription.descriptors';
import { BOOTSTRAP_ENV_SETTINGS } from './descriptors/bootstrap-env.descriptors';
import { CONSULTATION_GATE_SETTINGS } from './descriptors/consultation-gates.descriptors';
import { CONSULTATION_REALTIME_SETTINGS } from './descriptors/consultation-realtime.descriptors';
import { ENTITLEMENT_SETTINGS } from './descriptors/entitlements.descriptors';
import { FEATURE_FLAG_SETTINGS } from './descriptors/feature-flags.descriptors';
import { GUARDRAIL_JUDGE_SETTINGS } from './descriptors/guardrail-judge.descriptors';
import { HARNESS_LOOP_SETTINGS } from './descriptors/harness-loop.descriptors';
import { HARNESS_CLAIM_CHECK_MIN_BYTES, HARNESS_SENSOR_SETTINGS } from './descriptors/harness-sensor.descriptors';
import { MCP_EGRESS_SETTINGS } from './descriptors/mcp-egress.descriptors';
import { METERING_SETTINGS } from './descriptors/metering.descriptors';
import { PHI_REDACTION_SETTINGS } from './descriptors/phi-redaction.descriptors';
import { PLATFORM_KNOB_SETTINGS, RATE_LIMIT_TIER_SETTINGS } from './descriptors/platform-knobs.descriptors';
import { PLATFORM_OPS_SETTINGS } from './descriptors/platform-ops.descriptors';
import { PLATFORM_SECRET_SETTINGS } from './descriptors/platform-secrets.descriptors';
import { SECURITY_POLICY_SETTINGS } from './descriptors/security-policy.descriptors';
import { SERVICE_RUNTIME_SETTINGS } from './descriptors/service-runtime.descriptors';
import { TEXT_PROVIDER_CONNECTION_SETTINGS } from './descriptors/text-provider-connections.descriptors';
import { TEXT_GENERATION_SETTINGS } from './descriptors/text-generation.descriptors';
import { TEXT_GUARDRAIL_POLICY_SETTINGS } from './descriptors/text-guardrail-policy.descriptors';
import { STORAGE_SETTINGS } from './descriptors/storage.descriptors';
import { STT_RUNTIME_SETTINGS } from './descriptors/stt-runtime.descriptors';
import { TTS_RUNTIME_SETTINGS } from './descriptors/tts-runtime.descriptors';
import { SettingsRegistry } from './settings-registry';

export const HOPE_SETTINGS_REGISTRY: SettingsRegistry = new SettingsRegistry().registerAll([
  // The five `pipeline.*` toggles were here. TASK-882 retired `PipelinePolicy`: three were dead,
  // `autoSummaryEnabled` is the workflow generation node's `enabled`, and `dnaStyleEnabled` split
  // into the `agent.dna_style` node (tenant) and a `UserSettings` preference (doctor).
  // Platform storage default: SYSTEM TenantStorageConfig row + Vault kv-v2.
  ...STORAGE_SETTINGS,
  // `TTS_SETTINGS` was spread here — one key, `tts.defaultVoiceEn`. TASK-879
  // deleted the file: a tenant's default voice is `Agent.parameters.voice` on the
  // TEXT_TO_SPEECH agent the assignment cascade selects, and the gateway pushes it
  // in the resolved spec on every synthesis request. There is no per-tenant tts
  // settings surface left; what a tenant owns is its agent and its BYO connection
  // row.
  //
  // tts PLATFORM knobs — four process-level settings on the pull route. The model
  // ids, mirrors, artifacts, voices, vendor endpoints, regions, timeouts and
  // engine enable-flags that used to be here moved to the AiModel /
  // AiProviderConnection / Agent rows that own them (TASK-879). The two cloud
  // credentials appear in NEITHER: they have no env path at all by construction.
  ...TTS_RUNTIME_SETTINGS,
  // `STT_FALLBACK_SETTINGS` was spread here — the per-tenant fallback pipeline
  // pointer plus three BYO provider credentials. TASK-872 deleted the file: the
  // credentials are owned end to end by `TenantSttConfigService` (its own DTOs,
  // its own Vault-Transit column) and the settings write lane refuses a
  // `db-secret` tier, while the three `stt.fallback.*` knobs are read from
  // `TenantSttConfig` by that same service and never through this registry.
  // Batch (pre-recorded file) upload ceilings — recordings per batch, minutes
  // per recording, size, in-flight jobs per user.
  ...BATCH_TRANSCRIPTION_SETTINGS,
  ...ENTITLEMENT_SETTINGS,
  // Outbox-drain schedule (handoff) + the
  // TenantUsageMeter reconcile-sweep kill-switch + its seed-time-only default.
  ...METERING_SETTINGS,
  // AI task-model defaults (guardrail/NLP/TEXT).
  // `GUARDRAIL_POLICY_SETTINGS` (13 `guardrail.policy.*` keys) was here. Every
  // one was UNREAD — nothing on any path resolved them — so they were removed
  // by TASK-872 rather than left as a control surface an admin could set with
  // no effect. Their CONCEPTS are not lost: the four thresholds and the four
  // label taxonomies belong to the MODEL that produces the scores, so they ride
  // `AiModel._metadata` (`policy` / `labelTaxonomy`) and are resolved by the
  // same cascade that chose the model — a threshold calibrated for one
  // checkpoint is meaningless against another. The two judge hyper-parameters
  // and the judge timeout got their homes in wave 2 (TASK-878): the two
  // hyper-parameters are MODEL-COUPLED and ride `AiModel._metadata.policy`
  // (fail-closed, resolved by the cascade that chose the model), and the timeout
  // is the platform-scope peer-call budget below.
  ...GUARDRAIL_JUDGE_SETTINGS,
  // `consultation.visitTypes` was here. TASK-882 retired it: there are no tenant-managed
  // conditions (owner #6); the two visit types are platform data derived from the parent link,
  // and the `(task, visitType) -> prompt` binding is replaced by `Agent.tags` (TASK-884).
  // agentic context-management strategy knobs.
  ...AGENTIC_CONTEXT_SETTINGS,
  // agentic eval promotion-gate mode (block | warn | off).
  ...AGENTIC_EVAL_SETTINGS,
  // `agentic.revisit.carryForwardEnabled` was here. TASK-882 moved the decision onto the
  // assigned graph (`carryForward` on the prompt-composition / agent node).
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
  // environment variables until lane C; every `default` is transcribed
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
  // SSRF egress allow-list for tenant-authored `McpServer.baseUrl`.
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
  // TASK-891 B1 — the realtime scribe's own runtime budget. `LIVE_DOC_TEXT_TIMEOUT_MS`
  // was a raw env read whose hard-coded 20 s default sat below the measured p50 of the
  // generation it bounded, so every realtime flush timed out.
  ...CONSULTATION_REALTIME_SETTINGS,
  // `consultation.endpoint.actions` was here. TASK-882 moved the stage onto the assigned graph
  // (endpoint nodes, presence + `enabled`, in edge order).

  // ── Consultation-loop lifecycle bounds ───────────────────────────────────
  // The loop's IDLE bound. A tuning knob rather than a kill-switch, and PINNED
  // at workflow start rather than re-read per signal — see the descriptor.
  ...HARNESS_LOOP_SETTINGS,

  // ── Clinical-assurance gate thresholds ────────────────────
  // The PLATFORM defaults for the harness sensor gates, served on the pull route.
  // The per-tenant lane is `HarnessPolicy` (PUSH), not an override here — see the
  // descriptor file for why the split falls that way (D-1).
  ...HARNESS_SENSOR_SETTINGS,
  HARNESS_CLAIM_CHECK_MIN_BYTES,

  // ── Inference readiness ──────────────────────────────────────────────────
  // The readiness sweep's three knobs plus the two `modelRegistry.inventory.*`
  // keys the inventory cron has read since TASK-860 with no descriptor behind
  // them. Registering them is what makes them reachable from an admin surface —
  // there is no per-key allow-list anywhere else.
  ...AI_READINESS_SETTINGS,
]);
