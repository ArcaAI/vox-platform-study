# TASK-356 — Phase 3 (SMR gateway refactor, D-7) — TDD Implementation Plan

| Field | Value |
|---|---|
| **Ticket** | TASK-356 — Admin-Managed Models & Workflows |
| **Phase** | Phase 3 — SMR gateway refactor (D-7): no in-gateway model default; API resolves + passes on every call |
| **Status** | **Plan — awaiting approval** |
| **Date** | 2026-06-15 |
| **Author** | Planner (subagent) |
| **Scope of this doc** | Plan only — **no code written**. Mirrors the structure of [`phase-2-defaults-wiring-plan.md`](./phase-2-defaults-wiring-plan.md). Grounds every current-state claim in `path:line`. Raises blocking questions (§12) rather than guessing. |

---

## 1. Purpose

Make **SMR a stateless text-generation gateway with NO default model** (Decision **D-7**, README §7;
artifact-plane design README §4.4). Concretely:

1. **Remove the in-gateway model default** from `apps/smr/**` — the per-provider `default_model` config
   values and the `request.model or self._default_model` fallbacks. After this, SMR **requires** a model
   on every `/api/v1/generate` call and fails closed (validation error) when one is absent.
2. **Resolve the effective model in the API** (the cascade `HarnessPolicy.smrModel → SYSTEM default`,
   already owned by `HarnessPolicyService`) and **pass `{provider, model}` on EVERY SMR call** — the
   **harness** path (already does this), the **legacy** summary paths (sync + BullMQ), the **DNA** path,
   and the remaining generate callers (prompt-test, live-doc, the SDK/playground proxy).
3. **Tests** for "no default / caller-supplied model": SMR rejects a missing model; every caller sends a
   concrete, cascade-resolved model.

This phase changes **WHO resolves and passes** the SMR model and **removes the silent fallback**. It does
**NOT** change the *value* (Phase 2 already set SYSTEM `HarnessPolicy.smrModel = gemma-4-e2b-it-sft-rlvr-medical`,
README §8B), and it does **NOT** touch gating/thresholds/PHI/sensors (TASK-357/358/359) or enable any
cloud provider.

---

## 2. Scope & decisions applied

### In scope
- **`apps/smr/**` refactor:** delete per-provider `default_model` + `_resolve_model` fallback; make
  `GenerateRequest.model` required (fail-closed); drop the endpoint's `model or "default"` last-resort.
- **API resolution seam (`@arcaai/applications`):** a single, reused resolver that returns a
  **guaranteed-non-null** `{ smrProvider, smrModel }` from the existing `HarnessPolicy` cascade, plus
  field-level fallthrough so a tenant row with null SMR fields still resolves to the SYSTEM default.
- **Caller wiring:** every TS `/api/v1/generate` caller passes the resolved `{provider, model}`.
- **Tests:** SMR (pytest) "missing model ⇒ error" + "caller model honored, no default"; TS (vitest) each
  caller resolves + passes; resolver unit tests for the null-fallthrough + fail-closed.

### Out of scope (hard boundaries — see §10)
- **Gating / thresholds / `maxRegen` / gate timing** (TASK-358/359). Untouched.
- **PHI egress / cloud provider activation** (TASK-357). Phase 3 is **provider-agnostic plumbing**; it
  passes whatever provider the cascade resolves (local `lm-studio` today) and **enables no cloud
  provider**. The `ensure_egress_safe(...)` guard in the harness `generate` activity
  (`apps/harness/src/harness/temporal/activities.py:257-284`) is TASK-357's — **not modified**.
- **Sensors / calibration** (TASK-358), e.g. `apps/harness/src/harness/sensors/**`. Untouched.
- **ConfigResolver generalization (Phase 5).** Phase 3 reuses the *existing* `HarnessPolicyService`
  cascade; it does **not** build or depend on the generalized resolver (seam decided in §10 / Q-7).
- **Hyperparameters.** SMR's `GENERATION_DEFAULTS` (temperature/max_tokens/top_p) in
  `apps/smr/src/smr_v2/core/defaults.py` are **not** a "model default" — D-7 is about the **model**.
  They stay (callers may still omit them).

### Decisions applied / to confirm
- **D-7** — "No SMR default; SMR is a stateless gateway; the API passes the cascade-resolved model on
  every call." This plan implements it; the *mechanism* choices (resolver shape, SMR fail mode, call-site
  scope) are surfaced as Q-1…Q-8.
- **G-13** (README §7) — the gap D-7 closes: "SMR silently defaults the model when the caller omits it,
  so the admin-managed default can be bypassed." Addressed by §4.E + §4.B.

### Gaps addressed
- **G-13** — in-gateway SMR model default → §4.E (remove) + §4.B/§4.C (resolve+pass on every call).

---

## 3. Current state (grounded — every claim cited `path:line`)

### 3.1 SMR carries an in-gateway model default today (the thing D-7 removes)

- **Per-provider `default_model` config values** — `apps/smr/src/smr_v2/core/config.py`:
  `OllamaConfig.default_model = "google/gemma-4-e4b"` (`:20`); `AzureOpenAIConfig.default_model = "gpt-5-mini"`
  (`:36`); `BedrockConfig.default_model = "anthropic.claude-3-5-haiku-…"` (`:52`);
  `OpenAICompatConfig.default_model = "google/gemma-4-e4b"` (`:71`).
- **Request model is optional** — `apps/smr/src/smr_v2/models/requests.py`: `provider: str = "lm-studio"`
  (`:24`), `model: str | None = None` (`:25`). So an omitted model arrives as `None`.
- **Providers apply the fallback** — `request.model or self._default_model`:
  `providers/openai_compat.py:41-42` (default stored `:33`), `providers/ollama.py:38-39` (`:35`),
  `providers/azure_openai.py:40-41` (`:33`), `providers/bedrock.py:45-46` (`:35`). The provider's
  `ProviderInfo.default_model` is also surfaced in the providers listing (`openai_compat.py:179`,
  `ollama.py:154`).
- **Endpoint last-resort** — `apps/smr/src/smr_v2/api/endpoints/generate.py:145`:
  `model = request_body.model or "default"` (used for task/metrics labels); streaming mirror
  `resolved_model = model or request_body.model or "default"` (`:430`).
- **Hyperparameters are separate** — `apps/smr/src/smr_v2/core/defaults.py` resolves only
  temperature/max_tokens/top_p; **no model defaulting here** (confirms the model fallback lives only in
  config + providers).

⇒ Today, **any caller that omits `model` silently gets the provider's hard-coded default** — bypassing the
admin-managed cascade. This is exactly G-13 / D-7.

### 3.2 The API already owns a model cascade — `HarnessPolicyService`

- **Resolver (row-level)** — `packages/applications/src/services/harness-policy/harness-policy.service.ts:127-138`:
  `getEffectivePolicy(tenantId)` returns the tenant's **own** row (`:131-132`), else the **SYSTEM default**
  (`findSystemDefault()`, `:134-135`), else **code defaults** (`codeDefaultResponse`, `:137`). Resolution
  is **row-level**, not field-level.
- **First-edit seeding** — `upsert(...)` creates a new tenant row seeded from `findSystemDefault()` via
  `mergeKnobs(base, dto)` (`harness-policy.service.ts:206-211`). ⇒ a tenant row created **after** Phase 2
  inherits `smrModel = medgemma`; only rows created **before** Phase 2 (when SYSTEM was null) carry a null
  `smrModel` (the narrow gap, R-2 / Q-8).
- **Code defaults are null** — `packages/domains/src/factories/generated/core/HarnessPolicyFactory.ts:29-30`:
  `smrProvider: null`, `smrModel: null` (D-7 keeps these null — the "default" is a **data** row, not code).
- **Columns nullable, no DB default** — `packages/database/src/prisma/db_main/harness.prisma:284-285`.
- **Phase 2 set the SYSTEM row** — `seed/13-harness-policy.ts` upserts SYSTEM `smrProvider='lm-studio'`,
  `smrModel='gemma-4-e2b-it-sft-rlvr-medical'`; `GlobalSetting smr/default-smr-model` flipped to medgemma
  (README §8B). ⇒ **post-Phase-2, the cascade yields medgemma for every tenant without its own (null) row.**
- **Two consumers of `getEffectivePolicy`:** the worker-facing endpoint
  `apps/api/src/modules/consultation/harness-internal.controller.ts:62-73` (the harness `fetch_policy`
  reads this) and the admin view `apps/api/src/modules/harness-admin/harness-admin.controller.ts:65`.

### 3.3 The harness path already resolves + passes the model (minimal Phase-3 work)

- `fetch_policy` activity reads the effective policy via the API client
  (`apps/harness/src/harness/services/api_client.py:157`; activity
  `apps/harness/src/harness/temporal/activities.py:200`).
- Workflow resolves `smr_provider = inp.smr_provider or policy.smr_provider` and
  `smr_model = inp.smr_model or policy.smr_model` (`apps/harness/src/harness/temporal/workflows.py:293-294`)
  and threads them into `GenerateInput` (`:415-416`, `:594-595`).
- The `generate` activity passes them to the client (`activities.py:286-295`, `model=payload.model` `:290`).
- The client **omits** `provider`/`model` from the body when `None` —
  `apps/harness/src/harness/services/smr_client.py:69-70` (`if model: body["model"] = model`). So a null
  resolved model ⇒ omitted ⇒ **SMR default** today.
- `start` does **not** send SMR fields: `HarnessGatewayService.start()` posts only
  tenant/user/job/correlation/context/transcript (so `inp.smr_model` is `None`; the model comes entirely
  from `policy.smr_model`). The internal endpoint maps the (None) fields
  (`apps/harness/src/harness/api/endpoints/internal.py:94-95,157-158`); models default them None
  (`apps/harness/src/harness/temporal/models.py:70,160-161,197-198`); harness `Settings.smr_*` default
  None "let SMR choose" (`apps/harness/src/harness/core/config.py:222-224`).

⇒ **Post-Phase-2 the harness already sends medgemma** for any tenant resolving to the SYSTEM default. The
only residual gap is a tenant **own** row with null `smrModel` (3.2) → fixed in the API resolver (§4.B),
needing **zero `apps/harness/**` change** (key overlap win, §10).

### 3.4 Complete SMR `/api/v1/generate` caller inventory (production, non-test)

Grounded via repo-wide grep of `/api/v1/generate`. Ten production call sites; the shared TS payload
builder is `buildSmrGeneratePayload` / `mapSmrGenerateResponse`
(`packages/applications/src/services/consultation/summary/smr-v2-generate.ts`), which reads the model from
`pickString(options, 'model','smrModel','defaultSmrModel')` — **`undefined` when options omit it**.

| # | Caller (method) | `path:line` | Path class | Model source **today** | After D-7 |
|---|---|---|---|---|---|
| 1 | `SummaryService.callSmrService` | `summary.service.ts:717` | Legacy **sync** (pre-summary + summary) | `request.options` via `buildSmrGeneratePayload` (often `undefined` ⇒ SMR default) | resolve + pass |
| 2 | `ChainSummaryService.callSmrService` | `chain-summary.service.ts:504` | **Sync** comprehensive | `request.options` (often `undefined`) | resolve + pass |
| 3 | `SummaryProcessor.callSmrService` | `summary.processor.ts:253` | **BullMQ** summary | `request.options` | resolve + pass |
| 4 | `PreSummaryProcessor.callSmrService` | `pre-summary.processor.ts:210` | **BullMQ** pre-summary | `request.options` | resolve + pass |
| 5 | `ComprehensiveSummaryProcessor.callSmrService` | `comprehensive-summary.processor.ts:303` | **BullMQ** comprehensive | `request.options` | resolve + pass |
| 6 | `DnaWritingStyleProcessor.callSmrV2` | `dna-writing-style.processor.ts:259` | **BullMQ DNA** | **none** — body is `{prompt, system_prompt, stream}` only (`:260-264`) ⇒ SMR default | resolve + pass |
| 7 | `LiveDocumentationService.callSmr` | `live-documentation.service.ts:799` | **Live** running-SOAP | `LIVE_DOC_SMR_PROVIDER`/`LIVE_DOC_SMR_MODEL` env (`:174-175`, payload `:793-794`), often `undefined` | resolve + pass (Q-3b) |
| 8 | `PromptManagementService.callSmrGenerate` | `prompt-management.service.ts:617` | **Admin** prompt-template test | **none** — body is `{prompt, stream}` only (`:618`) ⇒ SMR default | resolve + pass (Q-3a) |
| 9 | `SmrProxyController.generate` | `smr-proxy.controller.ts:361` | **SDK/playground** direct proxy (`POST /text/generate`) | **pass-through** of client `body.model` (client-supplied) | pass-through; 422 if omitted (Q-3c) |
| 9b | `SmrProxyController.generateAssembled` | `smr-proxy.controller.ts:542` | **SDK/playground** debug assembled | client `body.model` (`:531`) | pass-through; 422 if omitted (Q-3c) |
| 10 | Harness `generate` → `SmrClient.generate` | `activities.py:286` / `smr_client.py:63` | **Durable harness** loop | `policy.smr_model` (cascade) — **already resolved** (3.3) | ensure non-null via §4.B; no harness change |

> The harness path (10) is the **only** caller already wired to the cascade. The SDK/playground proxy
> (9/9b) is a debug surface where the **client** picks the model (the playground has a model selector). All
> others (1-8) currently rely — directly or via `undefined` options — on SMR's in-gateway default.

---

## 4. File-by-file change plan (layer order: DB → Domain → App → API → Python)

> **Sequencing invariant (R-1):** land the API resolver + all caller wiring (§4.B-§4.D) **before** removing
> the SMR default (§4.E), so no live caller can hit a missing-model error mid-rollout. SMR's RED tests
> (§8) are written first but the gateway change ships last in the cut.

### 4.A — DB / Domain — **no change**
- No schema change: `HarnessPolicy.smrProvider/smrModel` already exist (`harness.prisma:284-285`).
- `HARNESS_POLICY_DEFAULTS.smrProvider/smrModel` stay **null** (`HarnessPolicyFactory.ts:29-30`) — D-7
  forbids a code-baked model default; the default is the SYSTEM **data** row (Phase 2). **No domain change.**

### 4.B — Applications: the single resolution seam (the "API resolves" half of D-7)

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| B1 | `harness-policy.service.ts` `getEffectivePolicy` | **M** | Add **field-level fallthrough for the two SMR fields only**: when the tenant's own row has `smrModel`/`smrProvider` null, fill from `findSystemDefault()` (then code-default null). Keeps the cascade authority in one place; **the harness benefits with zero `apps/harness/**` change** (it reads this via `harness-internal.controller.ts:62`). Other knobs unchanged. *(Admin "effective" view at `harness-admin.controller.ts:65` then shows the truly-effective model — see Q-1.)* | `harness-policy.service.test.ts` (T-B1) |
| B2 | `harness-policy.service.ts` (or a small co-located helper exported from `@arcaai/applications`) | **N** | `resolveSmrSelection(tenantId?): { provider: string; model: string }` — calls `getEffectivePolicy`, then **fail-closed**: throw a clear `BadRequest/Internal` error if `smrModel` is still null (no hidden last-resort model). This is the one function every TS caller uses. | `harness-policy.service.test.ts` (T-B2) |

> **Why reuse `getEffectivePolicy` (not a new resolver):** it is already the gold-standard cascade for
> `smrModel/smrProvider` (README §4.2). Reusing it keeps Phase 3 **decoupled from Phase 5** (which
> generalizes a `ConfigResolver` for summary/NER) — Phase 3 can ship first; Phase 5 may later swap B2's
> internals to the generalized resolver without touching callers (Q-7).

### 4.C — Applications: wire the legacy + DNA callers to pass the resolved model

Each caller injects `HarnessPolicyService` (exported from `@arcaai/applications` via
`services/harness-policy`) and resolves `{provider, model}` for its tenant, then passes them. The shared
`buildSmrGeneratePayload` already accepts `provider`/`model` (and `smrProvider`/`smrModel`) in `options`,
so callers 1-5 need only **merge the resolved values into `options`**; callers 6/8 build the body manually
and add the two fields explicitly.

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| C1 | `summary.service.ts` | **M** | In `callSmrService` (build at `:715`, post `:717`), resolve via B2 using the request tenant and merge `{smrProvider, smrModel}` into the options before `buildSmrGeneratePayload`. **Edit only the SMR-payload assembly** (avoid the TASK-355 edit-signal/latency code in this file — §10). | `summary.service.test.ts` (T-C1) |
| C2 | `chain-summary.service.ts` | **M** | Same pattern in `callSmrService` (`:502-504`). | `chain-summary.service.test.ts` (T-C2) |
| C3 | `summary.processor.ts` | **M** | Resolve in `callSmrService` (`:246-253`) using `job.data` tenant. | `summary.processor.test.ts` (T-C3) |
| C4 | `pre-summary.processor.ts` | **M** | Same (`:205-210`). | `pre-summary.processor.test.ts` (T-C4) |
| C5 | `comprehensive-summary.processor.ts` | **M** | Same (`:291-303`). | `comprehensive-summary.processor.test.ts` (T-C5) |
| C6 | `dna-writing-style.processor.ts` | **M** | In `callSmrV2` (`:249-264`) add `provider`/`model` from B2 (tenant from `job.data`) to the currently model-less body. | `dna-writing-style.processor.test.ts` (T-C6) |
| C7 | `live-documentation.service.ts` | **M / decision** | `callSmr` (`:784-805`) today uses `LIVE_DOC_SMR_*` env (`:174-175`). **Q-3b:** either resolve via B2 (needs the session tenantId — the service is a Redis-subscribing singleton, not request-CLS) or keep env but **require non-null** (no SMR fallback). | `live-documentation.service.test.ts` (T-C7) |
| C8 | `prompt-management.service.ts` | **M / decision** | `callSmrGenerate` (`:610-625`) is an admin prompt-template **test**. It has `this.tenantId` (BaseService/CLS). **Q-3a:** resolve via B2 with `this.tenantId` and pass `{provider, model}`. | prompt-management test suite (T-C8) |

### 4.D — API: the SDK/playground proxy (decision)

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| D1 | `apps/api/src/modules/streaming/smr-proxy.controller.ts` | **M / decision** | `generate` (`:355-379`) and `generateAssembled` (`:521-573`) are **pass-through** of the client's `model` (the playground UI selects it). **Q-3c:** (a) keep pass-through — after §4.E a missing model returns SMR's 422 verbatim (acceptable for a debug tool); or (b) inject the tenant's resolved default when the client omits `model`. Recommended: **(a)** + a clear error mapping. | `smr-proxy.controller.test.ts` (T-D1) |
| D2 | `apps/api/src/modules/consultation/harness-internal.controller.ts` | — | **No change** — benefits from B1 (the harness reads the now field-resolved policy). Listed for traceability. | existing |

### 4.E — Python: remove the SMR in-gateway model default (the "no default" half of D-7)

> Ships **last** in the cut (R-1). `apps/smr/**` is **Phase-3-exclusive** (no other in-flight ticket edits
> it — §10).

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| E1 | `apps/smr/src/smr_v2/models/requests.py` | **M** | Make `model` **required** (`model: str` with `min_length`), `:25`. A missing model ⇒ FastAPI **422** (fail-closed; Q-2). Keep `provider` default behavior per Q-4. | `test_request_models_e1.py` / `test_models.py` (T-E1) |
| E2 | `apps/smr/src/smr_v2/core/config.py` | **M** | Remove the per-provider `default_model` fields (`:20,:36,:52,:71`) — or, if the providers listing still needs an informational value, keep them out of generation entirely (E3). | `test_config.py` (T-E2) |
| E3 | `apps/smr/src/smr_v2/providers/{openai_compat,ollama,azure_openai,bedrock}.py` | **M** | Delete `_resolve_model`'s `or self._default_model` fallback; use `request.model` directly (`openai_compat:41-42`, `ollama:38-39`, `azure_openai:40-41`, `bedrock:45-46`). Decide `ProviderInfo.default_model` (`openai_compat:179`, `ollama:154`) → informational only (e.g. empty) or removed (Q-5). | provider tests (T-E3) |
| E4 | `apps/smr/src/smr_v2/api/endpoints/generate.py` | **M** | Drop the `or "default"` last-resort (`:145`, streaming `:430`) — `model` is now guaranteed present. | `test_generate_endpoint_e1.py` (T-E4) |
| E5 | `apps/harness/**` | — | **No change** (3.3 + B1). Listed to make the boundary explicit (Q-6). | existing harness suite |

---

## 5. Schema / migration assessment — **none required**

No table, column, enum, or index change. `HarnessPolicy.smrProvider/smrModel` already exist
(`harness.prisma:284-285`); the SMR request shape change (E1) is a Python/Pydantic contract, not a DB
change. Per the Prisma migration best-practices rule, an additive/contract-only phase that needs no
column/enum change writes **no migration**. (Run `prisma migrate diff` at verify time to confirm in-sync.)

---

## 6. Resolution & propagation design

The "default" lives in **one** place — the SYSTEM `HarnessPolicy` row (Phase 2). Phase 3 ensures it reaches
**every** call:

- **Single resolver seam (B1+B2).** `resolveSmrSelection(tenantId)` = `getEffectivePolicy` (tenant own →
  SYSTEM default → code-default) with **field-level** fallthrough for the SMR fields + **fail-closed** on
  null. Every TS caller funnels through it; the harness funnels through `getEffectivePolicy` (B1) via its
  existing `fetch_policy`.
- **Tenant context per caller:** sync services use request CLS (`this.tenantId`); BullMQ processors use
  `job.data` tenant; the DNA processor uses its job tenant; prompt-test uses `this.tenantId`; live-doc must
  supply the **session** tenantId (Q-3b); the proxy uses the request CLS (or pass-through, Q-3c).
- **No clone-per-tenant needed** (unlike Phase 2's catalog rows): resolution is dynamic at call time, so a
  new SYSTEM-default value is picked up by all tenants on the next call with no backfill — **except**
  pre-Phase-2 tenant rows with a null `smrModel`, which B1's field-level fallthrough covers (or a one-time
  backfill, Q-8).

---

## 7. Authorization / safety posture

Unchanged. Phase 3 changes **model plumbing** only.
- **No weakening of any guard.** `safetyEnabled`/`phiEnabled`/`phiFailClosed`, thresholds, gate SLA,
  `maxRegen`, and the safety/gating cascade are untouched. The harness PHI-egress guard
  (`activities.py:257-284`, TASK-357) is **not** modified — Phase 3 passes the same provider it does today.
- **Provider-agnostic, no cloud activation.** The cascade resolves `lm-studio` (local) today; Phase 3
  enables **no** cloud provider (TASK-357 owns that gate). Removing the SMR *model* default does **not**
  remove provider validation in SMR.
- **Fail-closed is stricter, not looser:** after §4.E, a missing model is a hard error (422) instead of a
  silent fallback that could bypass the admin-managed default (closes G-13).
- `default-smr-model`/`default-guardrail-model` remain `locked: true` (SUPER-only), unchanged.

---

## 8. TDD test list (RED-first), per layer

> Write each test first, watch it fail for the right reason, then implement. SMR RED tests (T-E*) are
> authored first but the gateway change ships last (R-1).

### Applications (TS) — `pnpm --filter @arcaai/applications test:unit`
- **T-B1** `harness-policy.service.test.ts` — a tenant row with `smrModel=null` + a SYSTEM default of
  medgemma ⇒ `getEffectivePolicy` returns `smrModel='…medgemma…'` (field-level fallthrough); a tenant row
  with its own non-null `smrModel` is unchanged.
- **T-B2** — `resolveSmrSelection` returns `{provider, model}` from the cascade; **throws** (fail-closed)
  when the cascade yields a null model; never returns a hard-coded model.
- **T-C1…T-C5** — `summary.service` / `chain-summary.service` / the three processors call SMR with the
  **resolved** `model` (assert the posted body's `model` equals the cascade value) and **no longer** send
  `undefined`/omit it. Add a "caller-supplied model wins over the resolved default" case where `options`
  already carries a model.
- **T-C6** — `dna-writing-style.processor` posts a body that now **includes** `provider` + `model` (was
  model-less) equal to the resolved values.
- **T-C7** — `live-documentation.service` sends a non-null `model` (per Q-3b: resolved-from-policy or
  required-env) and **fails/throws** rather than relying on an SMR default when none is configured.
- **T-C8** — `prompt-management` prompt-test posts `model` resolved from `this.tenantId`.

### API (TS) — `pnpm --filter @arcaai/api test`
- **T-D1** `smr-proxy.controller.test.ts` — (per Q-3c) pass-through preserves the client `model`; a missing
  model surfaces SMR's 422 verbatim (or, if Q-3c=b, the injected tenant default is posted).

### SMR (Python) — `pnpm py:smr:test` (conda env per repo convention; confirm name, Q-9)
- **T-E1** `test_request_models_e1.py` / `test_models.py` — `GenerateRequest` **rejects** a missing/empty
  `model` (validation error); accepts a supplied model.
- **T-E2** `test_config.py` — provider configs no longer expose a generation `default_model` (or it is
  informational only).
- **T-E3** provider unit tests (`test_openai_compat_provider.py`, `test_ollama_provider.py`,
  `test_azure_provider.py`, `test_bedrock_provider.py`) — `_resolve_model`/request building uses
  `request.model` verbatim and **does not** substitute a default when model is absent (these tests
  currently assert the default — they must be **updated**, R-3).
- **T-E4** `test_generate_endpoint_e1.py` — `POST /api/v1/generate` **without** `model` ⇒ 422 (fail-closed);
  **with** `model` ⇒ that exact model is used (no `"default"` label).

### Harness (Python) — **no test added/changed**
The harness already passes `policy.smr_model` (covered by `apps/harness/.../tests/.../test_policy_injection.py`,
`test_doc_workflow.py`, `test_smr_client.py`). B1 makes that value non-null; assert at the API layer (T-B1),
not in `apps/harness` (keeps Phase 3 out of the contended harness suite — §10).

---

## 9. Verification criteria (layer gates)

Per `.cursor/rules/01-development-workflow.mdc`:

| Layer | Build / apply gate | Test gate |
|---|---|---|
| DB / migration | **N/A** — no schema change; `prisma migrate diff` in-sync | — |
| Domain | unchanged — `pnpm build --filter @arcaai/domains` green | unaffected |
| Applications | `pnpm build --filter @arcaai/applications` green | `test:unit` green incl. T-B1/B2 + T-C1…C8 |
| API | `pnpm build:api` green | `smr-proxy.controller.test.ts` green (T-D1) |
| Python (SMR) | service imports/boots | `pnpm py:smr:test` green incl. T-E1…E4 + **updated** provider/default tests |
| Python (harness) | unchanged | existing harness suite still green (no Phase-3 edit) |

Completion also requires (workflow checklist): `ReadLints` clean on every touched TS file; barrel exports
for any new helper (B2); ticket README §6/§8 updated with a Phase-3 Implementation Summary + Change History
entry (post-approval). Capture actual test/build output as evidence.

---

## 10. Overlap boundaries (CRITICAL — most overlap-prone phase)

**Working-tree note (grounded):** a fresh `git status` shows the only live modifications are TASK-356
Phase 2 (`tenant.service.ts`, `seed/**`, its tests) + docs. The TASK-355/357 changes are **already
committed** into the tree (e.g. `summary.service.ts` carries TASK-355 edit-signal code;
`activities.py:257-284` carries the TASK-357 PHI guard) — so Phase 3 builds **on top of** them, and the
risk is **future concurrent edits** to the same files, not a dirty merge today.

**Phase 3's deliberate lever choice to minimize overlap:** resolve + pass in **`apps/api`/`@arcaai/applications`**
and refactor **`apps/smr`**, while **touching no `apps/harness/**`** (3.3 + B1 make that possible).

| File Phase 3 touches | Also edited by | Conflict risk | Coordination / sequencing boundary |
|---|---|---|---|
| `apps/smr/**` (E1-E4) | **none** in-flight (357 = harness PHI, not SMR) | **None** | Phase-3-exclusive. Ship last in the cut (R-1). |
| `harness-policy.service.ts` (B1/B2) | none in-flight | Low | Single resolver seam; coordinate only with Phase 5 (Q-7). |
| `summary.service.ts` (C1) | **TASK-355** (edit-signal/latency, already merged here) | **Med — same file** | Edit **only** `callSmrService`'s payload assembly; do not touch 355's edit-signal/latency methods. Rebase on 355 if it reopens. |
| `summary.processor.ts` / `pre-summary.processor.ts` / `comprehensive-summary.processor.ts` (C3-C5) | TASK-355 (latency may touch processors) | Med | Edit only the SMR-payload block in each `callSmrService`. |
| `live-documentation.service.ts` (C7) | TASK-355 (live-pipeline-reuse review references it) | Med | Touch only `callSmr` payload; gate on Q-3b. |
| `chain-summary.service.ts` / `dna-writing-style.processor.ts` / `prompt-management.service.ts` / `smr-proxy.controller.ts` (C2/C6/C8/D1) | none in-flight | Low | — |
| `apps/harness/**` (workflows/activities/models/sensors) | **TASK-357** (PHI egress in `activities.py generate`), **TASK-358** (sensors), **TASK-359** (gating) | **Highest — avoided** | **Phase 3 makes NO `apps/harness` change** (Q-6). This sidesteps the most contended files (e.g. the `generate` activity 357 is editing at `:257-295`). |

**Explicit non-goals (stay out of):** gating/thresholds/`maxRegen`/gate timing (358/359); PHI-egress &
cloud activation (357) — Phase 3 passes the same local provider and enables no cloud; sensors/calibration
(358).

**Seam with Phase 5 (decided, confirm Q-7):** Phase 3 **reuses** `HarnessPolicyService.getEffectivePolicy()`
and ships **before** Phase 5. Phase 5 generalizes the `ConfigResolver` for summary/NER; when it lands, B2's
internals may migrate to it **without** changing any caller. Phase 3 must **not** block on Phase 5.

**Coordination order vs TASK-355:** land Phase 3's `apps/api`/`applications` + `apps/smr` changes;
because Phase 3 edits only the SMR-payload assembly inside shared summary files (different methods than
355's latency work) and touches no `apps/harness`, it can proceed in parallel with a rebase discipline on
the shared summary files.

**Files Phase 3 modifies (complete list):** `harness-policy.service.ts`; `summary.service.ts`;
`chain-summary.service.ts`; `summary.processor.ts`; `pre-summary.processor.ts`;
`comprehensive-summary.processor.ts`; `dna-writing-style.processor.ts`; `live-documentation.service.ts`
(Q-3b); `prompt-management.service.ts` (Q-3a); `smr-proxy.controller.ts` (Q-3c);
`apps/smr/src/smr_v2/models/requests.py`; `apps/smr/src/smr_v2/core/config.py`;
`apps/smr/src/smr_v2/providers/{openai_compat,ollama,azure_openai,bedrock}.py`;
`apps/smr/src/smr_v2/api/endpoints/generate.py`; plus the matching test files. **No `apps/harness/**`, no
seed, no schema, no other file.**

---

## 11. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | **Rollout ordering** — removing the SMR default (§4.E) before every caller passes a model would break live calls. | Cut order: API resolver + all callers first; SMR fail-closed last. SMR RED tests authored first but shipped last. Optional transition flag (Q-2). |
| R-2 | **Pre-Phase-2 tenant rows with null `smrModel`** resolve to null → after §4.E that's a hard 422. | B1 field-level fallthrough to the SYSTEM default covers them at resolve time (defense-in-depth for future nulls too); or a one-time backfill (Q-8). |
| R-3 | **Existing SMR provider/default tests assert the in-gateway default** and will fail after §4.E. | They are in-scope to **update** (T-E2/E3): assert "uses request.model; rejects missing model" instead. Listed explicitly so the change is intentional, not a surprise. |
| R-4 | **Live-doc lacks request CLS** (Redis-subscribing singleton) — resolving per-policy needs the session tenantId. | Q-3b: thread the session tenantId into `callSmr`, or keep `LIVE_DOC_SMR_*` env but require non-null (no SMR fallback). |
| R-5 | **SDK/playground proxy** clients that omit `model` will start getting 422. | Q-3c: recommended pass-through + clear error mapping (the playground already has a model selector); optional inject-default fallback. |
| R-6 | **Provider also nullable** — resolving model but omitting provider would let SMR pick `lm-studio` implicitly. | Q-4: resolve + pass **both** `provider` and `model` (D-7 says both are caller-supplied); SMR keeps provider validation. |
| R-7 | **Shared-file churn** with TASK-355 in the summary services/processors. | §10 coordination: edit only the SMR-payload block; rebase discipline; no `apps/harness` edit. |
| R-8 | **Admin "effective policy" view semantics change** — B1 makes the effective view show the inherited model where a tenant row's field is null (previously null = "inherit"). | Arguably more correct (shows what actually runs). Confirm acceptable (Q-1); if not, scope B1 to a worker-only resolve path instead. |

---

## 12. Blocking questions (raise, don't guess)

1. **Resolver shape & location (Q-1).** Confirm the recommended seam: field-level fallthrough for the SMR
   fields **inside `getEffectivePolicy`** (B1) + a `resolveSmrSelection` fail-closed wrapper (B2), reused by
   all callers. Is the resulting **admin "effective" view** change (R-8) acceptable, or should the
   fallthrough be confined to a worker/caller-only path (leaving the admin view row-level)?
2. **SMR fail mode when no model (Q-2).** Recommended: make `model` **required** ⇒ **422** (fail-closed).
   Acceptable, or do you want a **400** with a custom error code, or a transition-period feature flag
   (`SMR_REQUIRE_MODEL`) that warns-then-enforces?
3. **Call-site scope (Q-3).** Confirm in/out for the three non-obvious callers:
   - **(a) Prompt-template test** (`prompt-management.callSmrGenerate`) — resolve via the admin's
     `this.tenantId` and pass the tenant's effective model? (recommended yes)
   - **(b) Live-doc** (`live-documentation.callSmr`) — switch from `LIVE_DOC_SMR_*` env to the policy
     cascade (needs session tenantId), or keep env but require non-null? Which?
   - **(c) SDK/playground proxy** (`/text/generate`, `/text/generate/assembled`) — keep **pass-through**
     (422 if the client omits model) or **inject** the tenant default when omitted?
4. **Provider as well as model (Q-4).** Resolve + pass **both** `{provider, model}` on every call
   (recommended, per D-7 "provider + model always supplied"), or model only (leaving provider to SMR's
   `lm-studio` default)?
5. **`ProviderInfo.default_model` (Q-5).** After removing generation defaults, should the providers
   listing keep an **informational** `default_model` (e.g. empty/derived) or drop the field? (affects
   `SmrProxyController.getProviders` fallback shaping.)
6. **Harness untouched (Q-6).** Confirm Phase 3 makes **no `apps/harness/**` change** and relies on B1 for
   the non-null guarantee — vs adding a defensive assertion in the harness `generate` activity (which would
   collide with TASK-357's edits there).
7. **Phase 5 seam / ordering (Q-7).** Confirm Phase 3 **reuses `getEffectivePolicy` and precedes Phase 5**
   (no dependency on the generalized `ConfigResolver`), with B2 as the later migration point.
8. **Pre-Phase-2 null tenant rows (Q-8).** Field-level fallthrough (B1, recommended, no data change) vs a
   one-time **backfill** of tenant `HarnessPolicy` rows with null `smrModel` to the SYSTEM default? (A
   backfill would overlap Phase 2's seed surface.)
9. **SMR conda env name (Q-9).** Which conda env runs `apps/smr` pytest (`pnpm py:smr:test`)? (Repo rule:
   always use the conda env; confirm the name before running.)

---

*Plan only — no code, no migration, no git commit. Awaiting approval before any implementation.*
