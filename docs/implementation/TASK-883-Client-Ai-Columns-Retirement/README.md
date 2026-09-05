# TASK-883 — Client-AI and display-only column retirement + service-runtime dead keys

| | |
|---|---|
| **Status** | Review |
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

Five commits off `4923cac40`, one per item plus this ticket.

| Commit | What |
|---|---|
| `0578ae685` | ticket opened: plan + intended migration SQL |
| `616630e91` | item 3 — the 11 `nlp.logging.*` keys and `apps/nlp`'s file/rotation sinks |
| `e467c90a5` | item 4 — the gateway's TEXT proxies present the shared `INTERNAL_ACCESS_TOKEN` |
| `4c77b0fd3` | item 2 — the three display-only entitlement feature flags |
| `c910c7e25` | item 1 — the five client-AI columns on `TenantFrontendConfig` |

### Per-item: what was removed, where it was read, what proves it

| Retired | Readers removed (`file:line` at the base commit) | Proof |
|---|---|---|
| `TenantFrontendConfig.{asrModel,noiseCancel,vad,voiceEnrollment,diarization}` | `tenant.prisma:55-59`; `TenantFrontendConfig{Model,Entity,Factory}.ts`; `tenant-frontend-config.service.ts:113-117,131-135,150-154`; `tenant-frontend-config.dto.mapper.ts:15-19`; `dto/tenant-frontend-config.response.ts:18-31`; `dto/upsert-tenant-frontend-config.request.ts:16-40`; `dto/frontend-pipeline-config.ts:11-18` (the four knobs that tuned them); `apps/api/.../tenant-frontend-config-admin.controller.ts:10-11` (doc) + its test `:34,42,45`; console `features/tenants/api/types.ts:88-116` + `tenant-frontend-config-tab.tsx:20-24` + `tenant-detail-screen.test.tsx:80-84`; SDK `types/frontend-pipeline-config.ts:16-23,47-51,83-87` + `useTenantFrontendConfig.test.ts:49,91-92,132`; `seed/05-tenant.ts:88-92,110-114`; `seed.test.ts:1691-1695` | `packages/applications/src/services/tenant-frontend-config/__tests__/client-ai-columns-retirement.test.ts` (4 cases, incl. "a stale caller cannot write one back"); `seed.test.ts` "should seed capture policy only" |
| `PlanEntitlement` + `TenantEntitlement.{featureDnaReports,featureVoiceEnrollment,featureMonitoringAccess}` | `entitlement.prisma:120-122,251-253`; `PlanEntitlement{Model,Entity,Factory}.ts` + the `TenantEntitlement` trio; `entitlements.constants.ts:188-190,270-272,314-316,346-348`; `resolve-entitlements.ts:58-60,142-144,184-186,245-247,326-328,362-364`; `entitlements.service.ts:563-565,639-641,682-684,755-757,804-806,835-837`; `dto/{plan-entitlement,tenant-entitlement,entitlement-capabilities}.*`; console `features/entitlements/{api/types.ts,components/{plan-meta.ts,plan-edit-dialog.tsx,entitlements-screen.tsx,tenant-override-panel.tsx}}`, `features/account/components/tenant-profile-screen.tsx:50-54`; SDK `hooks/useEntitlements.ts:43-45,77-79,97-99,119-121,140-142`; `seed/15-entitlements.ts:190-192,234-236,287-289,322-324` | `packages/applications/src/services/entitlements/__tests__/display-only-features-retirement.test.ts` (5 cases; the last pins the three ENFORCING siblings) |
| the 11 `nlp.logging.*` keys | `service-runtime.descriptors.ts:90-100` (defaults) + `:328-375` (meta); `nlp/core/logging.py:47-89` (`LOG_SINK_DEFAULTS`/`apply_log_sinks`/`log_sink`) + `:96-318` (the file/rotation handlers and their helpers); `nlp/core/effective_config.py:192-231` (`logging()`); `nlp/core/concurrency.py:160-163` (the apply site) | `packages/applications/src/services/settings-registry/__tests__/nlp-logging-retirement.test.ts` (4 cases); `apps/nlp/tests/test_task883_logging_retirement.py` (7 cases, incl. "exactly one StreamHandler, no FileHandler ever") |
| the gateway's `TEXT_SERVICE_TOKEN` readers | `apps/api/src/shared/base-proxy.controller.ts:68` (sole lookup); `src/modules/streaming/text-proxy.controller.ts:376`; `src/modules/text-compat/text-compat.controller.ts:915` (both as the fallback after `INTERNAL_ACCESS_TOKEN`) | `apps/api/src/__tests__/internal-access-token.text-proxies.test.ts` (9 cases over the three files; the old `text-service-token-migration.test.ts` was renamed into it) |

### Findings worth recording

- **The mapper and the repository needed no edit.** `TenantFrontendConfigEntityMapper` is
  `AutoClassMapper` over the model plus the `FIELDS_NOT_WRITABLE = ['version']` strip, and
  `TenantFrontendConfigRepository` adds only a `findByTenant` helper. Both are field-agnostic, so
  the column removal reached them for free. `gen:mapper` was NOT run (rule 03: it is destructive).
- **The `TenantEntitlement` override twins had to go with the plan columns.** The brief named only
  `PlanEntitlement`, but `resolve-entitlements.ts` reads `pick(override?.featureX, base.featureX)`:
  keeping the override of a base that no longer exists is not a smaller change, it is an incoherent
  one. Both models are in `entitlement.prisma`, which this lane owns exclusively.
- **Two console surfaces lost UI, deliberately.** The plan editor's feature-switch section and the
  plan grid's "Features" column had no field left to render — the console's `PlanEntitlement` type
  now carries no display boolean at all, so both could only ever render empty. An always-empty
  control is worse than no control.
- **Both capability renderers became payload-driven** (`Object.entries(features)` + a label map
  rather than a fixed field list). That also fixes a pre-existing under-declaration: the response
  DTO's own comment admits it omits `platformDefaultCredential` and `paletteStt`, which the runtime
  payload does carry — they were silently invisible in the console before.
- **The SDK's hard-off gate is untouched and was never fed by this row.** Verified three ways:
  `DEFAULT_AUDIO_CONFIG` (`types/config.ts:697-707`) still declares `noiseFilter.enabled: false`
  and `vad.enabled: false`; `audio.clientInference` and every `TranscriptionPipeline` /
  `PluginManager` reference to it are outside this lane's diff (the SDK diff is exactly
  `types/frontend-pipeline-config.ts` + one hook test); and the only SDK consumers of
  `TenantFrontendConfig` are the hook, its types and the two barrels — no path ever routed a tenant
  column into the audio config. The gate refuses to RUN a local stage; this lane removed the
  tenant-level switch that could ASK for one. The two are orthogonal, and neither weakens the other.
- **The four `configJson` knobs went with the toggles** (`noiseCancelLevel`, `vadThreshold`,
  `vadMinSilenceMs`, `diarizationMaxSpeakers`) — each documented as "…when `noiseCancel`/`vad`/
  `diarization` is on", and read by nothing (the SDK's `audio.vadThreshold` is an unrelated
  `ConfigSchema` field). `sampleRate` and `language` stay: they are capture parameters. **This is a
  small deviation from the brief**, which named only the five columns; the `configJson` COLUMN is
  untouched and no migration follows from it. Reversible in one commit if the orchestrator disagrees.
- **The TEXT-token swap is narrower than it looks (item 4).** The two proxies read
  `getSecretSync('INTERNAL_ACCESS_TOKEN') || getSecretSync('TEXT_SERVICE_TOKEN')`. `getSecretSync`
  does NOT pass through `realSecret()`, so an unfilled `INTERNAL_ACCESS_TOKEN=CHANGE_ME` is a
  non-empty string that already short-circuited the `||` — the legacy fallback could only ever fire
  where `INTERNAL_ACCESS_TOKEN` was truly absent or empty. The one environment this change is
  visible in is therefore: `TEXT_SERVICE_TOKEN` set, `INTERNAL_ACCESS_TOKEN` unset. Both are
  declared in the env surface (`turbo.json:378,598`; `.env.sample:830,837`) and the owner rule is
  that the shared token is set everywhere, so that combination is a misconfiguration this change
  makes visible rather than a regression it introduces. `base-proxy.controller.ts` was the only
  site with no shared-token path at all, so it is a strict improvement.
- **`apps/nlp`'s file logging was already inert.** `file_enabled` defaults `false` and no seed ever
  wrote a `GlobalSetting` row for any of the eleven keys, so a `FileHandler` was never constructed
  on any deployment. What ran was one `StreamHandler` with the plain formatter, which is exactly
  what remains — the retirement is behaviour-preserving, not merely behaviour-compatible.

### Gate evidence

All run in the worktree at `74059b895`.

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/database test` | `Test Files 2 failed \| 77 passed (79)` · `Tests 8 failed \| 1762 passed (1770)` — **exactly the stated baseline**: 4 in `ai-model-registry-seed.test.ts` + 4 in `task-863-agents.test.ts`, both pre-existing and untouched by this lane |
| `pnpm gen:model:check` | `check: no drift — 185 generated file(s) match the committed files.` |
| `pnpm gen:entity:check` | `check: no drift — 106 generated file(s) match the committed files.` · `Schema coverage OK: 104 entity artifact(s) cover every persisted column of 108 Prisma model(s)` |
| `pnpm gen:factory:check` | `check: no drift — 106 generated file(s) match the committed files.` · `Schema coverage OK: 104 factory artifact(s) cover every persisted column of 108 Prisma model(s)` |
| `pnpm --filter @arcaai/domains build` | clean (`tsc`) |
| `pnpm --filter @arcaai/domains test` | `Test Files 161 passed \| 2 skipped (163)` · `Tests 1919 passed \| 2 skipped \| 9 todo (1930)` |
| `pnpm --filter @arcaai/applications build` | clean |
| `pnpm --filter @arcaai/applications test` | `Test Files 664 passed \| 1 skipped (665)` · `Tests 11572 passed \| 4 skipped (11576)` |
| `pnpm --filter @arcaai/applications lint` | `✖ 213 problems (0 errors, 213 warnings)` — **0 errors**; no warning lands in a file this lane changed (checked file-by-file against the diff) |
| `pnpm --filter @arcaai/api typecheck` | clean (`tsc --noEmit`) |
| `pnpm --filter @arcaai/api test` | `Test Files 280 passed \| 2 skipped (282)` · `Tests 4219 passed \| 4 skipped (4223)`, 0 failures |
| `pnpm --filter @arcaai/admin-console build` | clean, after `74059b895` (the first run failed `next build`'s type check on `tenants-api.test.ts:141` — the one reader the greps missed) |
| `pnpm --filter @arcaai/admin-console lint` | clean |
| `pnpm --filter @arcaai/admin-console test` | `Test Files 258 passed (258)` · `Tests 2269 passed (2269)` |
| `pnpm --filter @arcaai/vox test` | `Test Files 281 passed \| 1 failed (282)` on the first run — all 7 failures in `bundle-externals.task364.test.ts`, whose own message is *"run `pnpm --filter @arcaai/vox build` first"*. After that build: `Tests 7 passed (7)` for that file, so the suite is 4373 passing / 0 failing |
| `pnpm --filter @arcaai/vox typecheck` | clean (`tsc --noEmit`) |
| `pnpm nlp:test` (via `arcaenv`'s python) | `2 failed, 586 passed, 1 skipped, 3 deselected` — the 2 are the stated baseline (`test_metrics_endpoint_task636.py`) |
| `pnpm nlp:lint` | 3 pre-existing `W291` in files byte-identical to the base commit; **ruff over this lane's five Python files: `All checks passed!`** |
| `pnpm nlp:typecheck` | `Success: no issues found in 59 source files` |

### Count reconciliation

The base counts are NOT restated from the program README: those figures were measured on the
merged primary at earlier commits, so subtracting them here would be arithmetic against a number
this worktree never produced. What is verifiable is the case delta this lane introduces, and that
every suite ends with **zero unexpected failures**.

| Suite | Final | Cases this lane adds / removes |
|---|---|---|
| applications | 11572 passed, 4 skipped, 0 failed | **+13**: 4 (`nlp-logging-retirement`) + 5 (`display-only-features-retirement`) + 4 (`client-ai-columns-retirement`). No case deleted — the entitlement and tenant-frontend-config specs were re-anchored onto surviving fields IN PLACE |
| api | 4219 passed, 4 skipped, 0 failed | **+5**: the renamed pin test runs 3 assertions over 3 files (9) where the old one ran 2 over 2 (4) |
| domains | 1919 passed, 0 failed | 0 — the trio edits removed fields, not cases |
| database | 1762 passed, 8 failed | 0 — `seed.test.ts` swapped one case's assertions rather than adding one. The 8 failures are the stated pre-existing baseline |
| admin-console | 2269 passed, 0 failed | 0 — fixtures re-anchored in place; the retired "feature badges" case was replaced 1:1 by "shows no plan-feature column" |
| vox | 4373 passed, 0 failed | 0 — the hook test's fixtures changed, its case count did not |
| nlp | 586 passed, 2 failed | **+3**: 7 new cases in `test_task883_logging_retirement.py`, 4 retired from `test_task799_lane_d_nlp.py` (they pinned the sink table this lane removed). The 2 failures are the stated pre-existing baseline |

### Two worktree conditions that were NOT this lane's doing

Both were unbuilt packages, and both are worth recording because a reader would otherwise
mis-attribute the first run's failures to the change:

1. `packages/ui/dist` did not exist, so every admin-console test file importing the `@arcaai/ui`
   root barrel failed to resolve. Fixed by `pnpm --filter @arcaai/ui build` (a build, not an
   install). Its own suite was not run — rule 01 excludes `packages/ui` from normal changes.
2. `@arcaai/{room,vad,stt,noise-filter,med-ner,pipeline}` and `@arcaai/vox` itself were unbuilt,
   which produced 41 failing vox test files (`Failed to resolve import "@arcaai/vad"`, …) and 52
   phantom `TS2307`s. After building them the vox suite is 4373 passing / 0 failing and typecheck
   is clean.

### Re-verification of the "no gate call site" claim (item 2)

```
$ grep -rnE "isFeatureEnabled\([^,)]+, *'(dnaReports|voiceEnrollment|monitoringAccess)'" \
    --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=dist \
    --exclude-dir=__tests__ packages apps
(exit 1 = no matches)

$ grep -rnE "\.isFeatureEnabled\(" --include="*.ts" --exclude-dir=node_modules \
    --exclude-dir=dist --exclude-dir=__tests__ packages/applications/src apps/api/src
packages/applications/src/services/workflow-definition/workflow-definition.service.ts:974:    const allowed = await this.entitlements.isFeatureEnabled(entity.tenantId, 'paletteStt');
packages/applications/src/services/consultation/loop/loop-context-signal.service.ts:230:      entitled = await this.entitlements.isFeatureEnabled(tenantId, 'agenticLoop');
packages/applications/src/services/ai-provider-connection/ai-provider-connection.service.ts:597:    return this.entitlementsService.isFeatureEnabled(tenantId, 'platformDefaultCredential');

$ grep -rnE "features\.(dnaReports|voiceEnrollment|monitoringAccess)" (production code)
apps/admin-console/src/features/entitlements/components/tenant-override-panel.tsx:130-135  (3 display badges)
```

Three `isFeatureEnabled` call sites exist and none names a retired flag; the only production reads
of the resolved capabilities were display badges. `resolve-entitlements.ts:74` said as much in its
own doc comment before this change.

## Handoffs

| To | What | Why it matters |
|---|---|---|
| **Orchestrator — migration** | The SQL in §Implementation Plan. Three `ALTER TABLE`s: 5 columns off `TenantFrontendConfig`, 3 off `PlanEntitlement`, 3 off `TenantEntitlement`. | Nothing was staged under `migrations/` (rule 02: Prisma applies every subdirectory regardless of name). `TenantEntitlement` is the one the brief did not name — see the finding above. |
| **Orchestrator — `text.serviceToken` descriptor** | **Do NOT delete it yet.** Retiring the three gateway readers does not make `TEXT_SERVICE_TOKEN` unreferenced: ~10 `packages/applications` call sites still pass it to `resolveInternalAccessToken` as the legacy fallback name (`summary.service.ts:1720`, `chain-summary.service.ts:675`, `pre-summary.processor.ts:342`, `comprehensive-summary.processor.ts:455`, `live-documentation.service.ts:3443,3508,3607`, `prompt-management.service.ts:1429`, `agent-invocation.service.ts:106`, `dna-writing-style.processor.ts:493`), plus `apps/api/src/modules/ai-model/ai-model-discovery.service.ts:359`, the `service-release` and `internal` guards' name maps, and the `common.service.module.ts` warm list. `vault-seed-secrets.sh` derives its key list from the descriptors, so deleting it now breaks a Vault deployment. | The wave-3 plan expects to delete `text.serviceToken` + `tts.serviceToken` together once "both gateway readers are gone". The TEXT gateway readers ARE gone; the descriptor is not yet retirable. |
| **Orchestrator — five-artifact regeneration** | `route-manifest`, `openapi`, `portal`, `gen:admin` all carry the removed DTO fields. `packages/vox-node/src/resources/admin/schemas.ts` still declares `featureDnaReports` / `featureVoiceEnrollment` / `featureMonitoringAccess` and the five `TenantFrontendConfig` fields — left untouched as instructed (generated). | Neither `openapi.json` nor the console's `api-docs/*.json` was edited by this lane. |
| **Orchestrator — env surface** | No env var changed. The 11 `nlp.logging.*` keys are `global-kv`, never env, and the `LOG_FILE_ENABLED` / `LOG_CONSOLE_JSON` entries in `turbo.json` / `.env.sample` belong to `apps/api`'s own logging service — untouched. | `env:sync` / `env:python-surface` need no run on this lane's account. |
| **Whoever owns `apps/nlp`'s container config** | `apps/nlp/Dockerfile:131` sets `LOG_CONSOLE_JSON_FORMAT=true` and `apps/nlp/.env.prod:22,27` set `LOG_FILE_ENABLED` / `LOG_CONSOLE_JSON_FORMAT`. All three were **already dead before this lane** (TASK-799 moved the sinks to the control plane and `logging.py` stopped reading env for them), so they are reported, not deleted. `apps/nlp/docs/05-configuration.md` WAS corrected — it documented the variables as live. | Pre-existing dead config, not created here. |
| **The R4 deprecation sweep** | `packages/agentic-sdk-v2/src/hooks/useVoiceEnrollmentStatus.ts` still gates on-device diarization on voice enrollment (`features.diarization`). That is the SDK's own audio config, not the retired DB column, and the hook is outside this lane's ownership. | It belongs to the client-AI deprecation set removed in R4, not to this column retirement. |
| **Reviewers** | Three ruff `W291` (trailing whitespace) errors fail `nlp:lint`, in `entailment_scorer.py:62`, `external_text_client.py:55` and `tests/load/test_guard_throughput_task778.py:62` — all three files are byte-identical to the base commit (`git diff --quiet 4923cac40..HEAD` per file). Ruff over only this lane's five Python files passes. | Pre-existing, and outside this lane's ownership to fix. |

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; exploration complete; plan recorded. |
| 2026-09-05 | Item 3 landed (`616630e91`): 11 `nlp.logging.*` descriptors, the `LOG_SINK_DEFAULTS` table, the file/rotation handlers, `EffectiveConfigSnapshot.logging()` and its apply site. |
| 2026-09-05 | Item 4 landed (`e467c90a5`): the three gateway TEXT-proxy readers now present `INTERNAL_ACCESS_TOKEN`; the pin test was rewritten and renamed. |
| 2026-09-05 | Item 2 landed (`4c77b0fd3`): the three display-only feature flags off both entitlement models, the domain trios, the applications surface, the seed and the console. |
| 2026-09-05 | Item 1 landed (`c910c7e25`): the five client-AI columns off `TenantFrontendConfig`, plus the four `configJson` knobs that tuned them. |
| 2026-09-05 | `74059b895`: `next build`'s type check caught one reader the greps missed (a bare `vad` in `tenants-api.test.ts:141`). All gates re-run and recorded above. Status → Review. |
