# TASK-572 — LLM Provider Expansion (OpenAI / Anthropic / Vertex) + Adopt the Unified Plane

- **Status**: Pending
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
_(fill on completion — list the three adapter files, their auth model, the deps added to `uv.lock`, and the env descriptors registered.)_

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (Wave 0/1 LLM expansion + adoption). |
