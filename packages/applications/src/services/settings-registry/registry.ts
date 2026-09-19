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
import { CONSULTATION_PRE_SUMMARY_SETTINGS } from './descriptors/consultation-presummary.descriptors';
import { CONSULTATION_REALTIME_SETTINGS } from './descriptors/consultation-realtime.descriptors';
import { ENTITLEMENT_SETTINGS } from './descriptors/entitlements.descriptors';
import { FEATURE_AVAILABILITY_SETTINGS } from './descriptors/feature-availability.descriptors';
import { GUARDRAIL_JUDGE_SETTINGS } from './descriptors/guardrail-judge.descriptors';
import { HARNESS_LOOP_SETTINGS } from './descriptors/harness-loop.descriptors';
import { HARNESS_CLAIM_CHECK_MIN_BYTES, HARNESS_SENSOR_SETTINGS } from './descriptors/harness-sensor.descriptors';
import { HARNESS_JUDGE_SETTINGS } from './descriptors/harness-judge.descriptors';
import { TEXT_REASONING_SETTINGS } from './descriptors/text-reasoning.descriptors';
import { MCP_EGRESS_SETTINGS } from './descriptors/mcp-egress.descriptors';
import { METERING_COMPUTE_SETTINGS } from './descriptors/metering-compute.descriptors';
import { METERING_STORAGE_SETTINGS } from './descriptors/metering-storage.descriptors';
import { METERING_SETTINGS } from './descriptors/metering.descriptors';
import { PHI_REDACTION_SETTINGS } from './descriptors/phi-redaction.descriptors';
import { PLATFORM_KNOB_SETTINGS, RATE_LIMIT_PRINCIPAL_SETTINGS, RATE_LIMIT_TIER_SETTINGS } from './descriptors/platform-knobs.descriptors';
import { PLATFORM_OPS_SETTINGS } from './descriptors/platform-ops.descriptors';
import { PLATFORM_SECRET_SETTINGS } from './descriptors/platform-secrets.descriptors';
import { SECURITY_POLICY_SETTINGS } from './descriptors/security-policy.descriptors';
import { HARNESS_CLAIM_CHECK_ENABLED, SERVICE_RUNTIME_SETTINGS } from './descriptors/service-runtime.descriptors';
import { TEXT_PROVIDER_CONNECTION_SETTINGS } from './descriptors/text-provider-connections.descriptors';
import { TEXT_GENERATION_SETTINGS } from './descriptors/text-generation.descriptors';
import { TEXT_GUARDRAIL_POLICY_SETTINGS } from './descriptors/text-guardrail-policy.descriptors';
import { STORAGE_SETTINGS } from './descriptors/storage.descriptors';
import { STT_GATEWAY_SETTINGS } from './descriptors/stt-gateway.descriptors';
import { STT_RUNTIME_SETTINGS } from './descriptors/stt-runtime.descriptors';
import { TTS_RUNTIME_SETTINGS } from './descriptors/tts-runtime.descriptors';
import { TRAINING_CAPTURE_SETTINGS } from './descriptors/training-capture.descriptors';
import { USER_IDENTITY_SETTINGS } from './descriptors/user-identity.descriptors';
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
  // TASK-959 — which DEVICE each self-hosted LLM server runs on, which is what
  // decides whether a call's occupancy seconds are metered as GPU_SECOND or
  // CPU_SECOND. Its own file, and NOT part of the family above: every key there
  // is `globalOnly` platform plumbing at `maxScope: 'system'`, while this one is
  // tenant-overridable and deliberately tenant-visible — a tenant that brings
  // its own self-hosted server is the only party who knows its hardware.
  ...METERING_COMPUTE_SETTINGS,
  // TASK-959 §5.2 — the nightly storage snapshot's schedule and master switch.
  // Its own file, and NOT part of the family above, for one reason: those
  // sweeps persist figures a live aggregate can recompute and therefore
  // default OFF, while a storage LEVEL is observable only on the day it is
  // taken — so this one defaults ON. See the descriptor file's header.
  ...METERING_STORAGE_SETTINGS,
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
  // The harness worker's Temporal-history protection. Still `env` (its reader is
  // pydantic-settings inside the worker), re-categorised out of the dissolved
  // "Feature Flags" bucket — see the descriptor.
  HARNESS_CLAIM_CHECK_ENABLED,
  // The rest of stt's runtime tuning — VAD, streaming geometry and timeouts,
  // transcription chunking, punctuation, semantic endpointing, worker/threading
  // and the non-secret halves of the cloud engine connections. All were
  // environment variables until lane C; every `default` is transcribed
  // verbatim from the Python field it replaces, so registering them changes no
  // behaviour and needs no seeded rows.
  ...STT_RUNTIME_SETTINGS,
  // TASK-944 — the GATEWAY's own budget for opening an stt streaming session.
  // Deliberately not part of the family above: that one is `consumedBy: ['stt']`
  // and travels the pull route to the Python process, while this is read by the
  // gateway about its own outbound hop and `apps/stt` never sees it.
  ...STT_GATEWAY_SETTINGS,
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
  // The per-principal lane (TASK-993 OD-2) — level two of the two-level
  // bucketing model, resolved by the same service from the same cache.
  ...RATE_LIMIT_PRINCIPAL_SETTINGS,
  // Feature availability — the ONE surface a platform admin uses to decide
  // which features exist, per tenant (TASK-932 R-8). Replaces
  // `FEATURE_FLAG_SETTINGS`, whose file is deleted: the four console visibility
  // gates are new, three of its five keys migrated from `env` to `global-kv`
  // with their readers, and `harness.claimCheck.enabled` was never a feature at
  // all — it is a Python worker knob and now sits with the service runtime.
  ...FEATURE_AVAILABILITY_SETTINGS,
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
  // TASK-982 §3.4.5 — the warm-start pre-summary's bounded retry (not the realtime flush lane
  // above; `LivePreSummaryAdapter` runs once, at recording start).
  ...CONSULTATION_PRE_SUMMARY_SETTINGS,
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

  // ── Judge reasoning posture ──────────────────────────────────────────────
  // TASK-968 — the two levers that decide how hard the assurance judge thinks,
  // moved off `HARNESS_JUDGE_*` env and defaulted OFF. The wire lever is NOT
  // eval-only: it rides every judge call, the live inferential pass included.
  ...HARNESS_JUDGE_SETTINGS,

  // ── Default reasoning posture for the TEXT plane ─────────────────────────
  // TASK-968 — the SECOND tier of the reasoning cascade. An agent that authored
  // no posture used to resolve to the ENGINE's default; it now resolves here.
  // Fills absence only: an agent with an opinion still wins outright.
  ...TEXT_REASONING_SETTINGS,

  // ── Context-schema user identity ─────────────────────────────────────────
  // TASK-950 D-9 — whether HOPE may provision a tenant user for an unrecognised
  // staff id, and the role + department it is given. CONFIGURATION, not schema
  // content: a schema version is CLONED from SYSTEM into every tenant, so a
  // department id could never ride inside it. Tenant → SYSTEM, like every other
  // per-tenant knob.
  ...USER_IDENTITY_SETTINGS,

  // ── Inference readiness ──────────────────────────────────────────────────
  // The readiness sweep's three knobs plus the two `modelRegistry.inventory.*`
  // keys the inventory cron has read since TASK-860 with no descriptor behind
  // them. Registering them is what makes them reachable from an admin surface —
  // there is no per-key allow-list anywhere else.
  ...AI_READINESS_SETTINGS,

  // ── Training capture ─────────────────────────────────────────────────────
  // TASK-972 Lane 2 (OD-4) — the TENANT half of the gate-edit training-capture
  // gate; the clinician's own half is a `UserSettings` row. Appended LAST on
  // purpose: a sibling lane appending its own block conflicts here trivially
  // rather than by re-indenting the whole array.
  ...TRAINING_CAPTURE_SETTINGS,
]);

// TASK-969 WS-1 — the one CROSS-descriptor invariant, run once the whole catalog
// exists. `register()` sees a single descriptor at a time, so it cannot check
// that `text.guardrailPolicy.requireMedical`'s declared platform tier
// (`text.externalGuardrail.requireMedical`) exists and agrees with it on
// maxScope / dataType / globalOnly. Run HERE it throws at MODULE LOAD, so a
// mispaired declaration can never reach a request — it cannot even boot the
// gateway. A separate STATEMENT rather than a chained call deliberately: the
// registry is already exported as this const, and chaining would re-indent the
// whole two-hundred-line array for no gain.
// See `SettingsRegistry.assertPlatformTierPairs`.
HOPE_SETTINGS_REGISTRY.assertPlatformTierPairs();
