# TASK-883 — Client-AI and display-only column retirement + service-runtime dead keys

| | |
|---|---|
| **Status** | In Progress |
| **Type** | refactor |
| **Program** | TASK-870 Configuration Governance — wave 3a, lane E |
| **Branch** | `task-883-client-ai-columns-retirement` (worktree `hope-v2-task-883`) |
| **Base** | `4923cac40` (= `dev-2.2` at wave-2 close) |
| **Merge target** | `dev-2.2` (orchestrator merges from the primary checkout) |

## Requirement Analysis

Four independent retirements, all of the same shape: a stored or declared setting that
nothing acts on any more.

1. **`TenantFrontendConfig.{asrModel,noiseCancel,vad,voiceEnrollment,diarization}`** — the
   client-AI toggles. Owner directive 2026-09-04 (TASK-865, `08-vox-sdk.md` §"The browser
   never runs a model"): VAD, denoise, diarization and ASR selection are SERVER-side agent
   decisions; the browser captures audio and renders results. A per-tenant column telling the
   browser to run a model is a control for a capability that no longer exists.
2. **`PlanEntitlement.{featureDnaReports,featureVoiceEnrollment,featureMonitoringAccess}`** —
   display-only. The resolver projects them to `capabilities.features.{dnaReports,
   voiceEnrollment,monitoringAccess}`; no gate call site consults the result. Their
   `TenantEntitlement` override twins go with them (an override of a base that no longer
   exists is not a smaller change, it is an incoherent one).
3. **The 11 `nlp.logging.*` registry keys** and `apps/nlp`'s file/rotation logging. The
   deployment ships stdout → Alloy → Loki and mounts no nlp log volume, so a rotating file
   sink writes to an ephemeral container filesystem nobody reads. structlog-to-stdout stays.
4. **The `TEXT_SERVICE_TOKEN` readers in the gateway's TEXT proxies.** Owner rule: ONE shared
   internal service token (`INTERNAL_ACCESS_TOKEN`). `base-proxy.controller.ts` read the
   per-service name exclusively; `text-proxy` and `text-compat` kept it as a fallback.

Registry after this lane: **277 − 11 = 266** (lanes A and B remove their own keys in
parallel; this lane asserts only that ITS 11 are absent).

## Current State Evaluation

### Item 1 — the five client-AI columns

`packages/database/src/prisma/db_main/tenant.prisma:55-59` declares them. Readers, verified
by grep at the base commit (generated Prisma client and `packages/vox-node/src/resources/admin/**`
excluded — both are regenerated artifacts):

| Layer | File |
|---|---|
| schema | `tenant.prisma:55-59` |
| domain | `TenantFrontendConfig{Model,Entity,Factory}.ts` (mapper/repository are field-agnostic) |
| service | `tenant-frontend-config.service.ts` (`upsert` sys-event payload, `createNew`, `applyUpdate`) |
| DTO | `dto/{tenant-frontend-config.response,upsert-tenant-frontend-config.request,frontend-pipeline-config}.ts`, `tenant-frontend-config.dto.mapper.ts` |
| entitlements | `resolve-entitlements.ts` (voice-enrollment capability), `dto/entitlement-capabilities.response.ts` |
| gateway | `apps/api/src/modules/tenant-frontend-config/__tests__/…controller.test.ts` fixtures |
| console | `features/tenants/{api/types.ts,components/tenant-frontend-config-tab.tsx,components/__tests__/tenant-detail-screen.test.tsx}` |
| SDK | `types/frontend-pipeline-config.ts`, `hooks/__tests__/useTenantFrontendConfig.test.ts` |
| seed | `seed/05-tenant.ts` (`TENANT_FRONTEND_CONFIGS`), `packages/database/src/__tests__/seed.test.ts:1691-1695` |

`configJson`'s typed shape (`FrontendPipelineConfigJson`, two copies) carries four knobs that
exist only to tune the removed stages — `noiseCancelLevel`, `vadThreshold`, `vadMinSilenceMs`,
`diarizationMaxSpeakers`, each documented as "…when `noiseCancel`/`vad`/`diarization` is on".
No consumer reads them (the SDK's `audio.vadThreshold` is an unrelated `ConfigSchema` field).
They go with the toggles; `sampleRate` and `language` (capture parameters, server-relevant)
stay, and the `configJson` COLUMN is untouched.

### Item 2 — the three display-only feature flags

`resolve-entitlements.ts:74` states it in the source: the three are *"display-only (read by
`getCapabilities`, the SDK and the console, and by nothing that decides anything)"*. Every
enforcing sibling (`platformDefaultCredential`, `agenticLoop`, `paletteStt`) has a named
call site; these three have none — re-verified below.

### Item 3 — `nlp.logging.*`

Declared in `service-runtime.descriptors.ts` (`SERVICE_RUNTIME_DEFAULTS` + `HAND_WRITTEN_META`),
served by `nlp/core/effective_config.py#logging()`, applied by `nlp/core/concurrency.py`
through `nlp/core/logging.py#apply_log_sinks`, consumed by `LoggingConfig.setup_logging`.
No GlobalSetting row seeds any of them, so the served value is the code default on every
deployment: `file_enabled=False` (no file handler is built today) and `console_enabled=True`
with the plain formatter. Retiring them is therefore behaviour-preserving.

### Item 4 — `TEXT_SERVICE_TOKEN` in the gateway

`base-proxy.controller.ts:68` (`getSecretSync('TEXT_SERVICE_TOKEN')`, sole lookup);
`text-proxy.controller.ts:376` and `text-compat.controller.ts:915`
(`getSecretSync('INTERNAL_ACCESS_TOKEN') || getSecretSync('TEXT_SERVICE_TOKEN')`).
All three are SYNC hot paths (`on.proxyReq` / `getForwardHeaders` cannot await), so the
async `resolveInternalAccessToken` helper is not usable — the change is a key swap plus a
dropped fallback.

## Implementation Plan

TDD per item: the assertion that the thing is gone goes in first (RED), then the removal.

1. Ticket README (this file).
2. **Item 3** — assert the 11 keys are absent from the registry and that `nlp.core.logging`
   exposes no sink table; then delete the descriptors, `LOG_SINK_DEFAULTS`/`apply_log_sinks`/
   `log_sink`, the file+rotation handler wiring, `EffectiveConfigSnapshot.logging()` and its
   `concurrency.py` call.
3. **Item 4** — pin the shared-token reads in `apps/api/src/__tests__/text-service-token-migration.test.ts`
   (rewritten as an `INTERNAL_ACCESS_TOKEN` pin), then swap the three readers.
4. **Item 2** — drop the three flags from `entitlement.prisma` (both models), the domain trio,
   constants/DTOs/service/resolver, the plan seed, the console screens; fix the stale comment
   at `entitlements.descriptors.ts:30-31`.
5. **Item 1** — drop the five columns from `tenant.prisma`; `pnpm db:generate` + `pnpm gen:model`;
   hand-edit entity/factory (mapper and repository are field-agnostic — no edit needed, stated
   as a finding); remove every reader; prove coverage with the `:check` variants.
6. Gates + Implementation Summary.

### Intended migration SQL (orchestrator-authored, after the wave merges)

Never staged under `migrations/` from this lane (rule 02: Prisma applies every subdirectory
regardless of name).

```sql
-- TASK-883 — retire the client-AI toggles and the three display-only feature flags.
ALTER TABLE "core"."TenantFrontendConfig"
  DROP COLUMN "asrModel",
  DROP COLUMN "noiseCancel",
  DROP COLUMN "vad",
  DROP COLUMN "voiceEnrollment",
  DROP COLUMN "diarization";

ALTER TABLE "core"."PlanEntitlement"
  DROP COLUMN "featureDnaReports",
  DROP COLUMN "featureVoiceEnrollment",
  DROP COLUMN "featureMonitoringAccess";

ALTER TABLE "core"."TenantEntitlement"
  DROP COLUMN "featureDnaReports",
  DROP COLUMN "featureVoiceEnrollment",
  DROP COLUMN "featureMonitoringAccess";
```

## Implementation Summary

_(filled in as the lane lands)_

## Handoffs

_(filled in as the lane lands)_

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; exploration complete; plan recorded. |
