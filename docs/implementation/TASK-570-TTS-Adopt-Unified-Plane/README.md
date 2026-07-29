# TASK-570 — TTS: Adopt the Unified Provider-Connection Plane

- **Status**: Pending
- **Type**: refactor
- **Program**: [Unified Provider-Connection Plane](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) — Wave 1 adoption lane
- **Branch of record**: `thuynh/2607`
- **Size**: M · **Wave**: 1
- **Depends on**: **TASK-569** (contracts C2/C4). Develop day-1 against a mocked `IProviderConnectionService`; rebase + integrate after 569 merges.
- **Blocks**: TASK-576 (rows must resolve from the unified plane before the legacy table is dropped)

> Read the [program doc](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) §4 (contracts) + §5 (invariants) first.

## Agent execution

| Phase | Tier | Goal |
|---|---|---|
| Discovery | **claude-sonnet-5-low** | Map every place `TenantTtsConfigService` credential methods and `resolveProviderOverrides` are used; confirm the two gateway injection call-sites (`speech-proxy.controller.ts:70`, `tts-ws.gateway.ts:135`) and the console credential-card wiring. Produce a call-graph note. **No edits.** |
| Implementation | **claude-sonnet-5-xhigh** | Repoint TTS credential storage/resolution to the unified service without changing TTS runtime behavior or the wire shape. |
| Review/close | **claude-sonnet-5-xhigh** | Confirm all TTS BYOK tests + the TTS credential e2e stay green; confirm no behavioral change; verify no key ever appears in a read/log. |

**Ownership (exclusive):** `packages/applications/src/services/tenant-tts-config/**`, `apps/api/src/modules/tenant-tts-config/**`, `apps/api/src/modules/speech/**`, `apps/admin-console/src/features/tenant-tts-config/**`. **Do NOT** edit the prisma schema, migrations, `ai-provider-connection/**`, or any other lane's tree.

## 1. Requirement Analysis
Move TTS BYO credentials off `TenantTtsProviderCredential` onto the unified `AiProviderConnection` (`service='tts'`), so credential set/rotate/disable/remove and request-time injection all flow through `IProviderConnectionService`, while `TenantTtsConfig` keeps its non-credential spec (voices, `routingEn/Ml`, `allowedProviders`). Zero change to the injected wire shape (C4) → `apps/tts` untouched.

Verifiable outcomes:
1. `TenantTtsConfigService.setCredential/maskCredential/resolveProviderOverrides` delegate to `IProviderConnectionService` with `service='tts'` (or the admin controller calls the unified service directly and TTS-config retains only spec).
2. `speech-proxy.controller.ts` + `tts-ws.gateway.ts` obtain `provider_overrides` via `resolveTenantCloudOverrides('tts', tenantId)` — identical body shape as today.
3. All existing TTS BYOK tests pass unchanged; the admin credential endpoints keep their external contract (or the console is repointed in the same lane if the endpoint moves to `admin/providers/tts/*`).

## 2. Current State Evaluation (2026-07-28)
- Credentials: `TenantTtsProviderCredential` (`tenant-tts-config.prisma:62`, `provider ∈ azure|sarvam`, `endpoint`, `encryptedApiKey`, `keyVersion`, `enabled`).
- Service methods: `tenant-tts-config.service.ts:344 setCredential`, `:430 maskCredential`, `:405 resolveProviderOverrides` (fail-open per credential). Interface `ITenantTtsConfigService.ts:38,48`.
- Admin controller: `apps/api/src/modules/tenant-tts-config/tenant-tts-config-admin.controller.ts:133 setCredential` (routes `GET/PUT/DELETE admin/tts-config/credentials[/:provider]`, non-OCC per its client comment).
- Injection: `speech-proxy.controller.ts:70` + `tts-ws.gateway.ts:135` call `resolveProviderOverrides(tenantId)`.
- Console: `apps/admin-console/src/features/tenant-tts-config/` (api + components; `CredentialCard`).
- After TASK-569, the TTS rows already exist in `AiProviderConnection(service='tts')` (copied by the 569 migration) and the legacy table still exists (dropped by 576).

## 3. Implementation Plan (TDD)
1. **Delegate credential storage.** Rewrite `setCredential`/`maskCredential`/`resolveProviderOverrides` to call `IProviderConnectionService` with `service='tts'` (inject the token). Preserve `TenantTtsConfigService`'s public method signatures so its callers don't change, OR (cleaner) move the credential methods out of `TenantTtsConfigService` entirely and have the admin controller + gateway call `IProviderConnectionService` directly; keep `TenantTtsConfigService` for spec only. Pick one and document it — do not leave both paths writing credentials.
2. **Repoint injection.** `speech-proxy.controller.ts` + `tts-ws.gateway.ts` call `resolveTenantCloudOverrides('tts', tenantId)`. Body shape unchanged (C4).
3. **Admin API.** Either keep `admin/tts-config/credentials/*` as a thin facade over the unified service, or move to `admin/providers/tts/*` (C3) and repoint the console in this lane. Recommendation: **facade now** (smaller blast radius); the console consolidation to `admin/providers/*` is TASK-575.
4. **TDD tests (write first):** setCredential('tts','azure') writes an `AiProviderConnection(tts,azure)` (via the unified service mock) and the legacy table is no longer written; `resolveProviderOverrides` returns `{azure:{api_key,...}}` from the unified plane; a disabled/broken cred fails open; masked read has no key; the two gateway paths inject the same body as before (snapshot test).
5. **Regression:** the full existing `tenant-tts-config` unit suite + `speech-proxy`/`tts-ws.gateway` tests pass; TTS credential e2e (if present) green.

## 4. Verification
- `pnpm --filter @arcaai/applications build test lint typecheck` (tts-config subset green).
- `pnpm --filter @arcaai/api-... ` build + `pnpm test:unit` for the speech + tenant-tts-config modules.
- `pnpm --filter @arcaai/admin-console build lint test` if the console is touched.
- Evidence: a body-snapshot diff proving the injected `provider_overrides` is byte-identical pre/post.

## 5. Implementation Summary
_(fill on completion.)_

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (Wave 1 TTS adoption). |
