# TASK-571 — STT: Adopt the Unified Provider-Connection Plane

- **Status**: Pending
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
_(fill on completion.)_

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (Wave 1 STT adoption). |
