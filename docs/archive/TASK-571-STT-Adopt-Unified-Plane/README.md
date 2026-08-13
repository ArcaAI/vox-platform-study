# TASK-571 — STT: Adopt the Unified Provider-Connection Plane

- **Status**: Review
- **Type**: refactor
- **Program**: [Unified Provider-Connection Plane](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) — Wave 1 adoption lane
- **Branch of record**: `thuynh/2607`
- **Size**: M · **Wave**: 1
- **Depends on**: **TASK-569** (contracts C2/C4). Develop day-1 against a mocked `IProviderConnectionService`; integrate after 569 merges.
- **Related**: TASK-567 (delivered STT BYOK with the separate `TenantSttProviderCredential`; this ticket repoints its credential lane). Coordinate with **TASK-573** (STT owner tails) — different files, but same feature.
- **Blocks**: TASK-576 (legacy table drop)

> Read the [program doc](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) §4 + §5 first.

## Agent execution

| Phase | Tier | Goal |
|---|---|---|
| Discovery | **claude-sonnet-5-low** | Map `TenantSttConfigService` credential methods, the **streaming** injection point (`stt-ws.gateway.ts` / streaming session-create) AND the **batch** worker credential-pull internal route; note where decrypted keys enter the session runtime. Produce a call-graph note. **No edits.** |
| Implementation | **claude-sonnet-5-xhigh** | Repoint STT credential storage/resolution to the unified service, preserving the two injection paths (streaming session-create + batch pull) and the fallback feature exactly. |
| Review/close | **claude-sonnet-5-xhigh** | Confirm STT BYOK + fallback tests stay green; verify the batch path still pulls creds via the internal route (never Redis) and no key is logged. |

**Ownership (exclusive):** `packages/applications/src/services/tenant-stt-config/**`, `apps/api/src/modules/tenant-stt-config/**`, `apps/api/src/modules/streaming/stt-ws.gateway.ts` + the STT streaming credential-inject/pull code, `apps/admin-console/src/features/tenant-stt-config/**`. **Do NOT** touch the prisma schema/migrations, `ai-provider-connection/**`, `apps/stt/**` engine code, or another lane's tree. (The `TenantSttConfig` *spec* table — `fallbackPipelineId`, `autoSwitchEnabled` — stays; only the *credential* table is retired.)

## 1. Requirement Analysis
Move STT BYO credentials off `TenantSttProviderCredential` onto the unified `AiProviderConnection` (`service='stt'`, providers `azure-speech|sarvam|openai`), so credential CRUD and both injection paths (streaming + batch) flow through `IProviderConnectionService`, while `TenantSttConfig` retains its non-credential spec and the fallback machinery is untouched. Wire shape unchanged (C4) → `apps/stt` engine code untouched.

Verifiable outcomes:
1. STT credential set/mask/resolve delegate to `IProviderConnectionService` with `service='stt'`.
2. **Streaming**: gateway resolves `resolveTenantCloudOverrides('stt', tenantId)` at session-create and injects the same `provider_overrides` shape into the session-open body.
3. **Batch**: the worker's internal credential-pull route returns the decrypted cred from the unified plane; the Redis job payload still carries **no key**.
4. Fallback (`fallbackPipelineId`, `EngineSwitchController`, `switchToFallback`) behavior is identical — this ticket does not touch it.
5. All existing STT BYOK + fallback tests pass.

## 2. Current State Evaluation (2026-07-28)
- Credentials: `TenantSttProviderCredential` (`tenant-stt-config.prisma:62`, `provider ∈ azure-speech|sarvam|openai`, `encryptedApiKey`, `keyVersion`, `enabled`).
- Governance: `platform-limits.ts:15 BYO_STT_PROVIDERS=['azure-speech','sarvam','openai']`, `:40 CLOUD_STT_PROVIDERS`.
- Service: `packages/applications/src/services/tenant-stt-config/tenant-stt-config.service.ts` (credential set/mask/resolve mirroring TTS).
- Admin API: `apps/api/src/modules/tenant-stt-config/tenant-stt-config-admin.controller.ts`.
- Injection: streaming session-create body gains `provider_overrides` + `fallback_pipeline_id` (in-memory only, never persisted/logged); batch pulls creds via the internal streaming/sessions route.
- Console: `apps/admin-console/src/features/tenant-stt-config/`.
- After TASK-569: STT rows already copied into `AiProviderConnection(service='stt')`; legacy table intact until 576.

## 3. Implementation Plan (TDD)
1. **Delegate credential storage** to `IProviderConnectionService` (`service='stt'`); keep `TenantSttConfig` spec (default pipeline, `fallbackPipelineId`, `autoSwitchEnabled`) in `TenantSttConfigService`. As with TTS, pick ONE credential path — do not leave both the legacy table and the unified plane writable.
2. **Repoint streaming injection** to `resolveTenantCloudOverrides('stt', tenantId)`; body shape unchanged.
3. **Repoint batch pull** internal route to resolve from the unified plane; assert the Redis payload still has no key.
4. **Admin API**: facade `admin/stt-config/credentials/*` over the unified service now; move to `admin/providers/stt/*` in TASK-575.
5. **TDD tests (write first):** setCredential('stt','azure-speech') writes `AiProviderConnection(stt,azure-speech)`; streaming session-create injects `{azure-speech:{api_key,region,...}}`; batch internal route returns the decrypted cred; Redis payload snapshot has no key; masked read has no key; disabled/broken cred fails open; **fallback path unchanged** (existing EngineSwitch tests still green).
6. **Regression**: full `tenant-stt-config` unit suite + streaming injection/batch-pull tests green.

## 4. Verification
- `pnpm --filter @arcaai/applications build test lint typecheck` (stt-config subset green).
- `pnpm test:unit` for the streaming + tenant-stt-config API modules.
- Evidence: streaming session-create body snapshot + a batch Redis-payload snapshot proving no key; fallback tests green.

## 5. Implementation Summary

Repointed STT BYO credential storage to the unified `AiProviderConnection` plane (`service='stt'`). `TenantSttProviderCredential` is no longer written anywhere — `TenantSttConfigService`'s credential methods (`getCredentials`, `setCredential`, `removeCredential`, `resolveProviderOverrides`) now delegate entirely to `IProviderConnectionService`. `TenantSttConfig` (fallback pointer + auto-switch spec) and the fallback machinery (`EngineSwitchController`, `switchToFallback`) are untouched.

**Files changed (3, all within exclusive ownership):**
- `packages/applications/src/services/tenant-stt-config/tenant-stt-config.service.ts` — constructor now injects `IProviderConnectionService` instead of `TenantSttProviderCredentialRepository` + `SecretsService`; `getCredentials`→`list('stt',...)`, `setCredential`→`getRow`+`upsertRow('stt',...)`, `removeCredential`→`deleteRow('stt',...)`, `resolveProviderOverrides`→`resolveTenantCloudOverrides('stt',...)` folded with a `list()` call to recover the STT-only `model` field (missing from the unified `ProviderOverrideEntry` shape) out of `extraJson`. Encryption, masking, OCC, and the `ResourceCreated`/`Updated`/`Deleted` sys-event broadcasts for credential rows are now owned by `AiProviderConnectionService` (TASK-569) — this service only translates STT-shaped request/response and preserves the pre-unification `enabled` default asymmetry (create defaults `true`; rotate leaves the flag untouched) via a pre-read `getRow`.
- `packages/applications/src/services/tenant-stt-config/tenant-stt-config.service.module.ts` — imports `AiProviderConnectionServiceModule` so `IProviderConnectionService` resolves in this module's DI container.
- `packages/applications/src/services/tenant-stt-config/__tests__/tenant-stt-config.service.test.ts` — rewritten to mock `IProviderConnectionService` for the credential/override paths (asserting delegation + response mapping) instead of a credential repository + Vault mock; fallback-spec tests (`setFallbackPipeline`, `getEffective`, `getRow`) are unchanged.

**Not touched (interface-stable, so no downstream edit was needed):** `apps/api/src/modules/tenant-stt-config/tenant-stt-config-admin.controller.ts` (thin facade over `ITenantSttConfigService`, unchanged signature — admin routes stay `admin/stt-config/credentials/*`), `apps/api/src/modules/streaming/transcription-job.controller.ts` (the streaming session-create injection point — calls `sttConfig.getEffective`/`resolveProviderOverrides`, unchanged), `apps/api/src/modules/internal/stt-internal.controller.ts` (the batch-worker credential-pull route — calls `sttConfig.resolveProviderOverrides`, unchanged), `apps/admin-console/src/features/tenant-stt-config/**` (wire shape unchanged). `apps/api/src/modules/streaming/stt-ws.gateway.ts` carries no credential-inject/pull code (verified by grep) — the actual streaming injection point is `transcription-job.controller.ts`'s `resolveSttFallbackConfig`.

**Evidence:**
- Streaming session-create body: `transcription-job.stt-fallback.controller.test.ts` asserts `sessionService.createSession` receives `payload.providerOverrides === { sarvam: { api_key: 'secret-key' } }` and `payload.fallbackPipelineId === 'fallback-pipe'` — the exact pre-existing wire shape, forwarded unchanged through the (mocked) `ITenantSttConfigService` interface.
- Batch Redis-payload no-key proof: `TranscriptionRealtimeService.dispatchDramatiqJob`'s param type (`packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts:312`) carries `{jobId, tenantId, pipelineId, audioUri, consultationId?, mediaId?, language?, userId?, audioBucketName?, storage?}` — structurally no credential field. The worker instead pulls decrypted creds at execution time via `GET /internal/stt/provider-overrides` (`stt-internal.controller.ts`), proven by `stt-internal.controller.test.ts`'s `getProviderOverrides` suite (service-token gate, tenant-pinned CLS, delegates to `sttConfig.resolveProviderOverrides('t-1')`).
- Fallback unchanged: all 6 tests in `transcription-job.stt-fallback.controller.test.ts` (fail-open injection, fail-closed switch guard, happy-path switch, 409 mapping) pass unmodified.

**Off-limits confirmation:** neither `dto/set-stt-credential.request.ts` nor `dto/set-stt-fallback.request.ts` needed edits — the DTO shapes were sufficient as-is to build the unified plane's `UpsertAiProviderConnectionRequest` adapter object. No e2e spec, `.claude/rules/05-nestjs-api.md`, or `vitest.integration.config.ts` touched. No prisma schema/migration, `ai-provider-connection/**`, or `apps/stt/**` engine code touched. `apps/api/src/modules/streaming/smr-proxy.controller.ts` shows modified in `git status` but was NOT edited by this agent — it is a concurrent TASK-572 lane change in the same worktree.

**Gates run (worktree `hope-v2-wave1`, branch `wave1/provider-plane`):**
- `pnpm --filter @arcaai/applications build` → clean (`tsc`, no errors).
- `pnpm --filter @arcaai/applications typecheck` → clean (`tsc --noEmit`, no errors).
- `pnpm --filter @arcaai/applications lint` → `0 errors, 330 warnings` (pre-existing `only-warn` prettier-style nits repo-wide; none in the touched files are architecture-rule violations — verified no `no-restricted-syntax`/`no-restricted-imports` hits).
- `pnpm --filter @arcaai/applications exec vitest run src/services/tenant-stt-config src/services/ai-provider-connection` → `4 test files, 70 tests passed`.
- `pnpm --filter @arcaai/applications test` (full `test:unit`) → `366 passed | 1 skipped` files, `7130 passed | 4 skipped` tests, **1 unrelated failure**: `settings-registry/__tests__/fail-mode.governance.test.ts` — missing env-name mapping for `smrOpenai.baseUrl`, a TASK-572 (SMR OpenAI adapter) descriptor gap in files this agent never touched (`git status` shows them modified/untracked by a concurrent lane).
- `pnpm exec dotenv -e .env.test -- vitest run apps/api/src/modules/streaming apps/api/src/modules/tenant-stt-config apps/api/src/modules/internal --exclude '**/integration/**' --exclude '**/e2e/**'` → `12 test files, 273 tests passed` (streaming + tenant-stt-config + internal API modules, including the fallback suite and the batch-pull internal route).

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (Wave 1 STT adoption). |
| 2026-07-28 | claude-sonnet-5-xhigh (agent) | Implemented: credential storage repointed to the unified `AiProviderConnectionService` (`service='stt'`); `TenantSttProviderCredential` no longer written. All gates green except one unrelated concurrent-lane (TASK-572) test failure. Status → Review. |
