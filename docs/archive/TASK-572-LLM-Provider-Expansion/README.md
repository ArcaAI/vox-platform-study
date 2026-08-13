# TASK-572 — LLM Provider Expansion (OpenAI / Anthropic / Vertex) + Adopt the Unified Plane

- **Status**: Review (572b adoption/wiring complete; see §5 seams)
- **Type**: feature
- **Program**: [Unified Provider-Connection Plane](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) — Wave 0 (SMR adapters) + Wave 1 (adoption/wiring)
- **Branch of record**: `thuynh/2607`
- **Size**: L · **Wave**: 0/1 (split: 572a adapters start day-1; 572b wiring after 569)
- **Depends on**: **TASK-569** for the gateway repoint (C2/C5). The SMR Python adapters (572a) depend on **nothing** — they build against the frozen C4 wire shape and start day 1.
- **Blocks**: TASK-575 (console cards for the new providers), TASK-576

> Read the [program doc](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) §4 (C4/C5) + §5 first. **`CLOUD_BYO_PROVIDERS` already lists `openai/anthropic/vertex` under `llm` (C5) — this ticket does NOT edit `constants.ts`; it makes those entries functional.**

## Agent execution

| Phase | Tier | Goal |
|---|---|---|
| Discovery | **claude-sonnet-5-low** | Map the SMR provider-adapter contract (`apps/smr/src/smr/providers/base.py`, how `azure_openai.py`/`bedrock.py` do `_resolve_override`/`_client_for`/request-scoped clients), the provider→adapter registry/dispatch, `GenerateRequest.provider_overrides` (`models/requests.py`), and how the seed/`AI_MODEL_PROVIDERS` gates a provider. Produce an adapter-authoring spec. **No edits.** |
| Implementation | **claude-opus-4-8-high** | Author three net-new cloud SMR adapters with correct auth + request-scoped isolation + override precedence + streaming; wire the gateway repoint. High-stakes external-API integration. |
| Review/close | **claude-sonnet-5-xhigh** | Adversarial review: no key in logs, no client shared across tenants, override-wins precedence, fail-open on broken key; run SMR provider-override tests. |

**Ownership (exclusive):** `apps/smr/src/smr/providers/{openai,anthropic,vertex}.py` (new) + their registration in the SMR provider registry, `apps/smr/src/smr/models/requests.py`, `apps/api/src/modules/ai-provider-connection/**` (rename controller `admin/ai-providers`→`admin/providers` + keep legacy alias, per C3) and `apps/api/src/modules/streaming/smr-proxy.controller.ts`, `apps/admin-console/src/features/ai-task-defaults/providers-*.ts` + `byo-credential-card.tsx`. New env keys via env descriptors (never hand-edit `turbo.json#globalEnv`). **Do NOT** edit `constants.ts` (TASK-569 owns C5), the prisma schema/migrations (569), or other lanes' gateway controllers.

## 1. Requirement Analysis
Let tenant admins BYOK three additional LLM providers — **OpenAI**, **Anthropic**, **Google Vertex** — end to end: credential CRUD (already generic via the unified plane), gateway injection, SMR consumption with a request-scoped client, and console cards. Plus repoint the LLM gateway + admin controller onto the unified plane (C2/C3) and remove the deprecated 1-arg resolver shim TASK-569 left.

Verifiable outcomes:
1. A tenant admin can set/rotate/disable/remove an OpenAI / Anthropic / Vertex credential; key Vault-encrypted, masked reads, no reveal.
2. An SMR generation whose resolved provider is one of the three carries the tenant's key as a request-time override; a broken/disabled key degrades to platform/env creds without failing the request.
3. Each adapter builds a **fresh request-scoped client** (no cross-tenant client reuse), honors override-wins precedence, and never logs the key.
4. `smr-proxy.controller.ts` resolves via `resolveTenantCloudOverrides('llm', tenantId)` (C2); the 569 shim is removed.
5. Admin routes served at `admin/providers/llm/*` with `admin/ai-providers/*` kept as a one-release alias; console cards render for all five LLM providers.

Out of scope: Realtime/streaming-token nuances beyond SMR's existing SSE contract (match the current provider adapters' behavior); non-LLM services.

## 2. Current State Evaluation (2026-07-28)
- SMR adapters present: `apps/smr/src/smr/providers/` = `base.py`, `azure_openai.py`, `bedrock.py`, `ollama.py`, `vllm.py`, `llama_cpp.py`, `openai_compat.py`. **No `openai.py`/`anthropic.py`/`vertex.py` as first-class BYO providers.** `openai_compat.py` exists (OpenAI-compatible `/v1` wire) and can be the basis for `openai` but the tenant-BYO provider id + governance is new.
- Override plumbing: `GenerateRequest.provider_overrides: dict[str, ProviderOverride]` (`models/requests.py`); `azure_openai.py`/`bedrock.py` implement `_resolve_override`/`_client_for`/`_resolve_model` (request-scoped clients). This is the template.
- Gateway: `smr-proxy.controller.ts:237` calls `resolveTenantCloudOverrides(tenantId)` (1-arg; TASK-569 shim). Admin controller `admin/ai-providers` (`apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts`).
- `AI_MODEL_PROVIDERS` (`seed/ai-models/shared.ts`) lacks `openai/anthropic/vertex` — extend it (validated via `@IsIn(AI_MODEL_PROVIDERS)` in DTOs). SYSTEM catalog rows for the three are seeded by TASK-569 §3.1; this ticket only ensures `AI_MODEL_PROVIDERS` includes them.

## 3. Implementation Plan (TDD)
### 572a — SMR adapters (day 1, no dep on 569)
1. `ProviderOverride` (`models/requests.py`) already carries `api_key/base_url/region/api_version/deployment_name/model`; add any provider-specific fields the three need (e.g. Vertex `project`, `location`; Anthropic `base_url`). Keep additive.
2. `openai.py` — reuse the OpenAI SDK / `openai_compat` core; `_client_for(override)` builds a request-scoped `AsyncOpenAI(api_key=override.api_key, base_url=override.base_url or default)`; model precedence override→settings; SSE mapping identical to the existing adapters.
3. `anthropic.py` — request-scoped `AsyncAnthropic(api_key=…)`; map SMR's generate/stream contract onto the Messages API; SSE.
4. `vertex.py` — request-scoped client from the tenant SA key / ADC (`project`, `location`); map onto SMR's contract.
5. Register the three in the SMR provider dispatch/registry; `SecretStr` for keys; **never log the key** (log `{provider, model}` only).
6. **TDD (write first, mock the SDKs):** override-wins model+key; a fresh client is built per request (assert no module-level singleton reused across two tenants); fail-open when override decrypt/build fails (fall back to env client); no key in captured logs. Extend `apps/smr/src/smr/tests/unit/test_provider_overrides.py`.
7. `uv lock` if new deps (openai/anthropic/google-cloud-aiplatform) are added; register new env keys (`ANTHROPIC_API_KEY`, `VERTEX_PROJECT/LOCATION`, platform fallbacks) via env descriptors + regenerate.

### 572b — adoption/wiring (after 569)
8. `smr-proxy.controller.ts`: call `resolveTenantCloudOverrides('llm', tenantId)`; the resolved `provider_overrides` now legitimately includes the three new providers (governance via C5); remove the 569 1-arg shim.
9. Rename the admin controller to `@Controller('admin/providers')` with routes `:service/:provider` (C3); keep `admin/ai-providers/*` as a one-release alias mapping to `llm/*`.
10. Console: `providers-types.ts` `CLOUD_BYO_PROVIDERS` mirror gains `openai/anthropic/vertex`; `byo-credential-card.tsx` `CLOUD_PROVIDERS` gains their card metadata (fields: OpenAI = base URL optional + model; Anthropic = base URL optional; Vertex = project + location); `providers-client.ts` targets `admin/providers/llm` (alias-safe).
11. Extend `AI_MODEL_PROVIDERS` with the three.

### TDD test list (gateway/console)
- `smr-proxy` injects `{openai:{api_key,...}}` when the resolved provider is `openai` and a tenant cred exists; injects nothing when disabled; body-shape snapshot.
- Admin PUT `admin/providers/llm/anthropic` stores a masked cred; GET returns `hasKey:true`, no key; legacy `admin/ai-providers/anthropic` alias still works.
- Console renders 5 LLM cards; axe 0 violations; both themes.

## 4. Verification
- `pnpm py:smr:test` (incl. extended `test_provider_overrides`), `pnpm py:smr:lint`, `pnpm py:smr:typecheck`; `uv lock` clean if deps changed.
- `pnpm test:unit` for `streaming` (smr-proxy) + `ai-provider-connection` API modules.
- `pnpm --filter @arcaai/admin-console build lint test` (a11y for the new cards).
- Evidence: per-provider override injection snapshot; a log capture proving no key; the 5-provider console screenshot (both themes).

## 5. Implementation Summary

### 572b — adoption/wiring (this pass, opus-4-8)

**Gateway / admin API**
- `apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts` — new `ProviderConnectionController` at `@Controller('admin/providers')` with `GET :service`, `GET :service/:provider`, `PUT :service/:provider`, `DELETE :service/:provider` (C3), `:service` validated against `PROVIDER_SERVICES` (unknown → 400). The former `AiProviderConnectionController` is kept as a thin **legacy alias** at `@Controller('admin/ai-providers')` hard-pinning `service='llm'` — so the frozen `ai-provider-connections.spec.ts` stays green untouched. Both delegate to the unified `IProviderConnectionService`.
- `…/ai-provider-connection.module.ts` — registers both controllers.
- `apps/api/src/modules/streaming/smr-proxy.controller.ts` — repointed to `resolveTenantCloudOverrides('llm', tenantId)` + `isCloudByoProvider('llm', provider)`; injection token switched to `IProviderConnectionService`. This was the **last production caller** of the deprecated 1-arg shims.

**Seed**
- `packages/database/src/prisma/db_main/seed/ai-models/shared.ts` — `AI_MODEL_PROVIDERS` gains `anthropic`, `vertex` (`openai` was already present). The `_llmProviderCoverage` guard in `17-ai-provider-connection.ts` (569-owned) already seeds their llm rows, so coverage holds. Companion test fix in `seed/__tests__/config-plane-seed.test.ts` (dropped the now-redundant manual `+ anthropic/vertex` append).

**Env descriptors + turbo.json**
- Secrets (`vault-kv`) in `platform-secrets.descriptors.ts`: `smrOpenai.apiKey` → `SMR_OPENAI_API_KEY`, `smrAnthropic.apiKey` → `SMR_ANTHROPIC_API_KEY` (mirrors `smrAzure.apiKey`). Vertex authenticates by service-account JSON / ADC, so it has no API-key env secret.
- New `env`-tier file `smr-provider-connections.descriptors.ts` (registered in `registry.ts`): `SMR_OPENAI_BASE_URL`, `SMR_OPENAI_ORGANIZATION`, `SMR_OPENAI_DEFAULT_MODEL`, `SMR_ANTHROPIC_BASE_URL`, `SMR_ANTHROPIC_DEFAULT_MODEL`, `SMR_VERTEX_PROJECT`, `SMR_VERTEX_LOCATION`, `SMR_VERTEX_DEFAULT_MODEL` — defaults transcribed verbatim from `apps/smr/src/smr/core/config.py`. Companion parity-map additions in `fail-mode.governance.test.ts`.
- `turbo.json#globalEnv` regenerated via `pnpm env:sync` (never hand-edited); `env:sync --check` is clean.

**Console**
- `providers-types.ts` — `CLOUD_BYO_PROVIDERS` gains openai/anthropic/vertex; `UpsertProviderConnectionRequest` gains `extraJson` (Vertex `project`).
- `byo-credential-card.tsx` — `CLOUD_PROVIDERS` gains three cards: **OpenAI** (key + Base URL?), **Anthropic** (key + Base URL?), **Vertex** (service-account-JSON key + Project + Location). Vertex `location` → `region` column; `project` → `extraJson` (new `store: 'extra'` field support).
- `providers-client.ts` — `BASE` cut over to `admin/providers/llm` (alias-safe).

### Deviations / cross-boundary seams (owner attention)
1. **Vertex runtime injection is BLOCKED on a 569-owned change.** `vertex.py` reads `override.project`/`override.location` (and OpenAI/Anthropic optionally read `override.model`), but the gateway resolver `resolveTenantCloudOverrides` (569-owned `ai-provider-connection.service.ts`) + the TS `ProviderOverrideEntry` type emit only `base_url/region/api_version/deployment_name` — **not** `project/location/model`. OpenAI + Anthropic work end-to-end today (their `base_url` flows). Vertex credential CRUD + console capture work, but its project/location will not reach SMR until that emitter is extended. Out of my file boundary (569 owns the service + interface + constants).
2. **The deprecated 1-arg overloads remain** on `IProviderConnectionService.resolveTenantCloudOverrides` / `isCloudByoProvider` (569-owned interface/constants/service) and are still exercised by 569-owned tests; I removed the last production *usage* (smr-proxy) but dropping the signatures is 569/cleanup's.
3. ~~**`turbo.json#globalEnv` budget cap.**~~ RATIFIED 2026-07-28 (see Change History): bumped `scripts/__tests__/env-sync.test.ts` 134→144 after re-confirming `env:sync --check` is clean.
4. ~~**Not run (needs live stack):**~~ the frozen `ai-provider-connections.spec.ts` count fixed 2026-07-28 (9→11; the doc's `toHaveLength(8)` reference above was itself stale — the code had `toHaveLength(9)`). `admin-providers.spec.ts` still needs a live-stack run.
5. **NEW 2026-07-28 — DTO/seed provider-list drift.** `packages/applications/src/services/stt/model/dto/create-model.request.ts`'s `AI_MODEL_PROVIDERS` (a same-named but independent list, pinned to the seed's by `tests/contracts/ai-model-providers.contract.test.ts`) was not updated alongside the seed's — outside this ticket's ownership list (§ "Ownership (exclusive)" above doesn't include this file), so 572b correctly didn't touch it, but the drift still broke the contract test. Fixed by adding `anthropic`/`vertex` to that list too.

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (Wave 0/1 LLM expansion + adoption). |
| 2026-07-28 | opus-4-8 (572b) | Adoption/wiring: unified `admin/providers` controller + legacy alias; smr-proxy repoint; `AI_MODEL_PROVIDERS` += anthropic/vertex; env descriptors + turbo regen; console openai/anthropic/vertex cards. Gates: applications build/test(7131)/lint/typecheck green; database test(873) green; api unit(2213)+typecheck green; console ai-task-defaults tests + axe green. Seams reported in §5. |
| 2026-07-28 | sonnet-5 (test-failure review) | Closed §5 deviations #3/#4 + a newly-found #5: bumped `env-sync.test.ts` cap 134→144 (ratified, `env:sync --check` clean); fixed frozen `ai-provider-connections.spec.ts` 9→11; added `anthropic`/`vertex` to the separate DTO `AI_MODEL_PROVIDERS` in `create-model.request.ts` (contract test now green). `pnpm --filter @arcaai/applications build` clean; both previously-failing unit test files pass (25/25). Also found the failed `pnpm test:e2e:managed` run's other 6 failures (stt-fallback 500, super-admin-backend-backlog ECONNRESET, 4× task-562-smr-compat 401s) correlate with a test-Redis (port 6380) outage starting mid-run (`ECONNREFUSED` from ~14:28:31Z through EOF in `~/.local/state/hope-dev/logs/test-run/api.log`) — likely infra flakiness, not a code regression; recommend re-running `test:e2e` once test infra is confirmed healthy before investigating further. |
