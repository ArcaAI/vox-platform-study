# TASK-337: Local LLM Engine Standardization (LM Studio default across SMR, Harness, Guardrail)

- **Ticket Number**: TASK-337
- **Created Date**: 2026-06-07
- **Last Updated**: 2026-06-07
- **Status**: Pending (Plan — awaiting approval)
- **Classification**: refactor / infrastructure
- **Related**: TASK-238 (SMR seed defaults), TASK-330 (Clinical Documentation Harness), prior chat (SMR LM Studio default flip)

---

## 1. Requirement Analysis

### Objective

Standardize the **local LLM engine** to **LM Studio (OpenAI-compatible)** across the three
LLM-consuming Python services, and make **Ollama / Azure OpenAI / AWS Bedrock** optional,
lower-priority providers behind a uniform provider abstraction — mirroring the SMR service's
existing multi-provider design.

### Desired end-state (provided by product)

**SMR (`apps/smr`, 8862)** — provider fallback `default_model` values:

| Provider (registry key) | Default model | Role |
|---|---|---|
| **lm-studio** (default) | `google/gemma-4-e4b` | Primary local engine for pre-summary + summary |
| ollama (optional) | `google/gemma-4-e4b` | Optional/lower-priority local engine |
| azure-openai (managed) | `gpt-5-mini` | Cloud egress (PHI-redacted) |
| bedrock (managed) | `anthropic.claude-3-5-haiku-20241022-v1:0` | Cloud egress |

Hyperparameters unchanged: `temperature=0.1`, `max_tokens=16384`, `top_p=0.95`.

**Harness (`apps/harness`, 8866)**:

| Role | Default model | Engine |
|---|---|---|
| LLM-as-judge (eval gate + Phase-2 groundedness/reasoning) | `google/gemma-4-e4b` | LM Studio (`openai_compat`, `:1234/v1`) |
| Safety classifier (Phase-2 safety sensor) | `granite-guardian-4.1-8b` | LM Studio (`openai_compat`, `:1234/v1`) |

Optional providers (same as SMR): Ollama, Azure OpenAI, Bedrock. Variable names reviewed/renamed.

**Guardrail (`apps/guardrail`, 8863)** — all guardrail LLM tasks default to `granite-guardian-4.1-8b` over LM Studio:

| Task | Default model | Purpose |
|---|---|---|
| `guardrail_model` | `granite-guardian-4.1-8b` | Generic guardrail analysis (fallback) |
| `content_safety_model` | `granite-guardian-4.1-8b` | Content safety screening |
| `pii_detection_model` | `granite-guardian-4.1-8b` | PII detection |
| `prompt_injection_model` | `granite-guardian-4.1-8b` | Prompt-injection detection |
| `comprehensive_model` | `granite-guardian-4.1-8b` | Combined guardrail pass |
| `guardian_model` | `granite-guardian-4.1-8b` | Medical-context validation (temp 0.05, conf ≥0.75) |

Optional providers (same as SMR): Ollama, Azure OpenAI, Bedrock. Variable names reviewed/renamed.

### Acceptance criteria

1. Default local engine for SMR, Harness (judge + safety), and Guardrail is **LM Studio** (OpenAI-compatible, `http://localhost:1234/v1`).
2. Ollama / Azure OpenAI / Bedrock remain selectable via a `provider` switch per service.
3. Default model strings match the tables above.
4. Granite-Guardian-based screens (harness safety, guardrail) work over the OpenAI-compatible endpoint and still parse correctly (`<score>yes/no</score>`).
5. Env var names are consistent and engine-agnostic; `.env.example`, `.env.dev`, and the k3s configmap are updated.
6. All affected unit tests pass; new tests cover the OpenAI-compatible code paths.

---

## 2. Research Findings (Granite Guardian over OpenAI-compatible serving)

Sources: IBM Granite Guardian docs, `ibm-granite/granite-guardian` repo (4.1 cookbooks), HF model card `ibm-granite/granite-guardian-4.1-8b`, Traefik Hub AI-Gateway Granite Guardian integration.

1. **Output format is unchanged across backends.** Granite Guardian emits a binary verdict inside `<score>yes</score>` / `<score>no</score>` tags (no-think mode). The existing `_SCORE_RE = <score>\s*(yes|no)\s*</score>` parser remains valid over LM Studio/vLLM.
2. **Transport change only.** Over Ollama native we POST `{base_url}/api/chat` and read `data["message"]["content"]`. Over OpenAI-compatible we POST `{base_url}/v1/chat/completions` and read `data["choices"][0]["message"]["content"]`.
3. **Criteria are passed in-message (BYOC), not via API params.** `guardian_config={"criteria_id": ...}` / `risk_name` is a **Python `apply_chat_template` kwarg** and cannot be sent over the OpenAI HTTP API. The supported path for OpenAI-compatible serving is to append the `<guardian>` block as the final message — which is exactly what the current client already does. The Traefik integration confirms Granite Guardian runs behind `/v1/chat/completions` with a single-word/system-prompt criterion and a `yes`/`no` body.
4. **Canonical IBM 4.1 BYOC block** (recommended, replaces the current ad-hoc block):
   ```
   <guardian><no-think>As a judge agent, assess whether the provided text meets the given
   judging criteria using all available information, including conversations, documents, and
   tools. Provide your score immediately without explanation. Output empty <think>\n</think>
   tags followed by your score in <score></score> tags.

   ### Criteria: {criteria_text}

   ### Scoring Schema: If the last assistant's text meets the criteria, return 'yes'; otherwise, return 'no'.
   ```
   The block is appended as the **final user message**, after the text-to-judge (the generated note as an `assistant` message). One call per harm dimension.
5. **Model slug.** Canonical HF repo: `ibm-granite/granite-guardian-4.1-8b`. The configured `model` string sent to LM Studio must match the identifier LM Studio exposes for the loaded model. **Proposed config value: `granite-guardian-4.1-8b`** (matches the product tables); operators load the corresponding community GGUF (e.g. `lmstudio-community/granite-guardian-4.1-8b-GGUF`) and ensure LM Studio's model id resolves to `granite-guardian-4.1-8b`, or override via env.
6. **`google/gemma-4-e4b`** is already the established judge slug in `harness.eval.config` — we reuse it verbatim for SMR's lm-studio fallback and the SMR seed default for consistency.

### ✅ Resolved decisions (approval round 1)

- **D1 — Guardrail adopts the Granite `<guardian>`/`<score>` protocol.** The guardrail providers will be refactored to use the Granite protocol (shared client) for content_safety / pii / prompt_injection / comprehensive, so `granite-guardian-4.1-8b` actually works (replaces the generic SAFE/UNSAFE prompts).
- **D2 — Wire all four engines into the provider switch.** `lm-studio` (default) | `ollama` | `azure` | `bedrock`. Azure/Bedrock are marked **"requires guardian-capable model"**; when selected for a Granite task they fall back to the generic-prompt strategy (since Granite Guardian isn't hosted on Azure/Bedrock).
- **D3 — `guardian_model` → `granite-guardian-4.1-8b`** (follow the product table; medgemma medical-context specialization is dropped).
- **D4 — Clean break on env var renames** (no back-compat aliases) — **AND** the guardrail engine/provider/model must be **admin-console configurable** (new requirement, see §2b).
- **D5 — Azure OpenAI deployment + API key must be admin-configurable** (not a hardcoded `gpt-5-mini`). See §2b for the secrets constraint.

### ⚠ New requirements from D4/D5 → expanded scope

Admin-configurability follows the existing **SMR provider/model GlobalSetting pattern** (seed `namespace='smr'` rows + `ux-constants` catalog + `tenant.service.ts` validation + `GET /api/v1/text/providers`). Two hard constraints discovered:

1. **The `apps/admin` console UI source is NOT in this workspace** (separate repo / not checked out). This ticket can deliver the **backend contract** (GlobalSetting seed rows, applications-layer validation, and an API catalog endpoint) so the console can wire to it, but **the admin console UI changes are out-of-scope for this workspace** and tracked as a follow-up.
2. **Admin-set Azure API key is blocked on TASK-302 Phase 4D** (GlobalSetting `encryptedValue`/Vault-Transit not fully wired). For now: the Azure **deployment/model name** is admin-configurable via a (non-secret) GlobalSetting; the Azure **API key** stays env/Vault-only (`SMR_V2_AZURE_API_KEY` / `GUARDRAIL_AZURE_API_KEY`). A non-secret GlobalSetting MUST NOT hold the raw key.

### ⚠ Open questions for approval round 2

- **Q1 — Admin UI scope.** Confirm the admin console UI work is handled in the separate `apps/admin` repo and this ticket delivers backend contract only (seed + validation + API). If `apps/admin` should be in this workspace, point me to it.
- **Q2 — Azure key handling.** Accept "deployment-name configurable via console, API key via env/Vault only" for now, or block this ticket until TASK-302 Phase 4D secret-encryption lands?
- **Q3 — Guardrail runtime config application.** The guardrail service reads its own env and is only (loosely) called by SMR's `ExternalGuardrailClient` (which isn't wired into the generate pipeline yet). How should admin-chosen guardrail provider/model reach the running guardrail service?
  - (a) **Service-default + catalog** — guardrail keeps env-configured engine/model defaults; the console only manages the GlobalSetting catalog/defaults and the API surfaces them; no per-request override yet (simplest; admin choice is advisory until wired).
  - (b) **Per-request forwarding** — wire `ExternalGuardrailClient` into SMR generate and forward admin-chosen guardrail provider/model per request (larger; SMR generate request gains guardrail fields).
  - (c) **Guardrail reads DB** — give guardrail tenant-config access (largest; new DB dependency for that service).
- **Q4 — Scope split.** This is now a multi-ticket-sized effort. Split into TASK-337 (Python engine standardization: SMR/harness/guardrail LM-Studio default + provider switch) and TASK-338 (admin-configurability backend: GlobalSettings + validation + API), or keep as one ticket with phased delivery?

---

## 3. Current State Evaluation

### SMR (`apps/smr`)
- `core/config.py`: `OllamaConfig.default_model="qwen3.5:2b"`, `AzureOpenAIConfig.default_model="gpt-4"`, `BedrockConfig.default_model="anthropic.claude-3-haiku-20240307-v1:0"`, `OpenAICompatConfig.default_model="local-model"` (base_url already `:1234/v1`).
- Already done (prior chat): API default `provider="lm-studio"`, LM Studio registered first in `main.py`, `.env.dev` LM Studio enabled, seed `default-smr-provider=lm-studio`, `default-smr-model=lmstudio-community/gemma-4-E4B-it-QAT-GGUF`, catalog reordered.
- **Conflict to fix:** seed default-model must become `google/gemma-4-e4b` to match the table.

### Harness (`apps/harness`)
- Judge: **already LM Studio default** (`openai_compat`, `google/gemma-4-e4b`, `:1234/v1`). No engine change; optional-Ollama provider to add for parity.
- Safety: `GraniteGuardConfig` + `GraniteGuardianClient` use **Ollama native `/api/chat`**, model `ibm/granite3.3-guardian:8b`, base_url `:11434`. Consumers: `temporal/activities.py` (builds the client), `sensors/inferential/safety.py`, `sensors/inferential/__init__.py`. Tests: `tests/unit/sensors/test_granite_client.py`, `test_safety.py`, `tests/unit/test_guardrail_config.py`, `tests/unit/temporal/test_activities.py`.

### Guardrail (`apps/guardrail`)
- `OllamaConfig` (`GUARDRAIL_OLLAMA_*`) drives `OllamaProvider` (content analysis) and `GuardianProvider` (medical validation), both via Ollama native `/api/generate` + `/api/tags`. No provider abstraction. Wiring in `main.py` lifespan + `core/dependencies.py`. Tests: `tests/test_job_processor.py`, `tests/test_job_endpoints_integration.py`. Endpoints: `api/endpoints/health.py`, `api/endpoints/medical.py`.

### Deployment
- `deployment/k3s/base/configmap.yaml`: SMR + guardrail Ollama vars present; SMR openai_compat present but `ENABLED=false`. Needs LM-Studio-default + renamed guardrail keys.

---

## 4. Implementation Plan

### Phase A — SMR default-model alignment (low risk)

A1. `apps/smr/src/smr_v2/core/config.py`:
- `OllamaConfig.default_model` → `google/gemma-4-e4b`
- `AzureOpenAIConfig.default_model` → `gpt-5-mini`
- `BedrockConfig.default_model` → `anthropic.claude-3-5-haiku-20241022-v1:0`
- `OpenAICompatConfig.default_model` → `google/gemma-4-e4b`

A2. Seed `packages/database/src/prisma/db_main/seed/11-global-setting.ts`:
- `default-smr-model` value/defaultValue → `google/gemma-4-e4b`
- Add `google/gemma-4-e4b` to the `lm-studio` catalog block (first entry).

A3. `.env.dev` + `deployment/k3s/base/configmap.yaml`: set `SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL=google/gemma-4-e4b`; flip configmap to LM-Studio-default (`SMR_V2_OPENAI_COMPAT_ENABLED=true`, `SMR_V2_OLLAMA_ENABLED=false`).

A4. **Tests (RED→GREEN):**
- `apps/smr/.../tests/unit/test_config.py`: update `default_model` assertions (currently `qwen3.5:2b`, `gpt-4`).
- `packages/database/src/__tests__/seed-smr-provider-models.test.ts`: assert `google/gemma-4-e4b` present + default; bump LM Studio model count (15→16).

### Phase B — Harness safety: Ollama-native → OpenAI-compatible engine abstraction

B1. New shared transport: `apps/harness/src/harness/sensors/inferential/guardian_engine.py` (or extend `granite_client.py`):
- `provider` selector: `openai_compat` (default) | `ollama` | `azure` | `bedrock`.
- OpenAI-compatible path: POST `{base_url}/v1/chat/completions`, parse `choices[0].message.content`.
- Ollama path: retain `/api/chat` for backward-compat (optional engine).
- Replace ad-hoc guardian block with canonical IBM 4.1 BYOC no-think block; keep `<score>` parser; keep degrade-don't-guess error semantics.

B2. `apps/harness/src/harness/core/config.py` — rename `GraniteGuardConfig` → `SafetyGuardConfig` (env prefix `HARNESS_SAFETY_`), add `provider`, `base_url` default `http://localhost:1234/v1`, `model` default `granite-guardian-4.1-8b`, keep `harm_criteria`, `no_think`, `timeout_s`. Keep a back-compat alias for `HARNESS_GRANITE_*` (optional) or document the rename as breaking.

B3. Wire optional `ollama` provider into judge config (`apps/harness/src/harness/eval/config.py`) for parity (Ollama reachable via its `/v1`); documentation note that azure/bedrock already exist.

B4. Update consumers: `temporal/activities.py`, `sensors/inferential/safety.py`, `sensors/inferential/__init__.py`, `eval/inferential_corpus_eval.py`.

B5. **Tests:** rewrite `tests/unit/sensors/test_granite_client.py` for the OpenAI-compatible request/response shape + canonical block; update `test_safety.py`, `test_guardrail_config.py`, `tests/unit/temporal/test_activities.py`. Add an Ollama-path regression test.

### Phase C — Guardrail: provider abstraction + Granite protocol (largest)

C1. `apps/guardrail/src/guardrail/core/config.py`:
- Introduce `LLMEngineConfig` with `provider` (`lm-studio` default | `ollama` | `azure` | `bedrock`) and an OpenAI-compatible sub-config (`GUARDRAIL_OPENAI_COMPAT_*`, base_url `:1234/v1`).
- Repoint the six task model fields to `granite-guardian-4.1-8b` (default).
- Keep `GUARDRAIL_OLLAMA_*` for the optional Ollama engine.

C2. New provider(s) under `apps/guardrail/src/guardrail/providers/`:
- `openai_compat.py` — OpenAI-compatible client implementing the Granite `<guardian>`/`<score>` protocol for content_safety/pii/prompt_injection + a JSON path for comprehensive/medical-context.
- Optional `azure.py` / `bedrock.py` (engine switch) — flagged "requires guardian-capable model" per D2.
- Refactor `ollama.py`/`guardian.py` to share the protocol/parsers; keep them as the optional Ollama engine.

C3. Wiring: `main.py` lifespan + `core/dependencies.py` select provider by `settings.<engine>.provider`; default LM Studio.

C4. `.env.example` + configmap: rename `GUARDRAIL_OLLAMA_*` per D4; add `GUARDRAIL_OPENAI_COMPAT_*`; default models `granite-guardian-4.1-8b`.

C5. **Tests:** `tests/test_job_processor.py`, `tests/test_job_endpoints_integration.py`, health/medical endpoint tests; add OpenAI-compatible provider unit tests (protocol + parsing + fail-open semantics).

### Phase D — Docs

D1. `docs/marketing/V2_BRIEF_TECHNICAL.md` (model table), `apps/harness/eval/README.md`, `apps/guardrail/README.md`, `apps/guardrail/GUARDIAN_INTEGRATION.md`, `knowledge/02_TECHNICAL_ARCHITECTURE.md` as needed.
D2. This README → Implementation Summary + Change History on completion.

### Phase E — Admin-configurability backend (D4/D5) — *pending Q1–Q4*

> Scope assumes Q1 = backend-only (admin UI lives in external `apps/admin`), Q2 = deployment-name-configurable / key via env+Vault, Q3 = option (a) catalog+defaults unless told otherwise.

E1. **DB seed** `packages/database/src/prisma/db_main/seed/11-global-setting.ts` (+ IDs in `00-constants.ts`):
- New `namespace='guardrail'` rows: `default-guardrail-provider` (default `lm-studio`), `default-guardrail-model` (default `granite-guardian-4.1-8b`), `locked: true`.
- New `ux-constants` catalog: `guardrail-provider-models` (JSON, mirrors `SMR_PROVIDER_MODELS` shape) + exported `GUARDRAIL_PROVIDER_NAMES`/`GUARDRAIL_PROVIDER_MODELS`.
- New non-secret Azure settings: `smr-azure-deployment` (and optionally `guardrail-azure-deployment`) — **deployment name only, never the key**.

E2. **Applications validation** `packages/applications/src/services/tenant/tenant.service.ts`:
- Generalize `validateSmrConfigValue()` → also validate `default-guardrail-provider`/`default-guardrail-model` against the guardrail catalog (extract a shared `validateProviderModel(namespacePrefix, ...)` helper).
- Add `getCurrentGuardrailProvider()` parallel to `getCurrentSmrProvider()`.

E3. **API catalog endpoint** `apps/api/src/modules/streaming/smr-proxy.controller.ts` (or new controller): add `GET /api/v1/text/guardrail-providers` mirroring `GET /text/providers` (reads `default-guardrail-*` + `guardrail-provider-models`).

E4. **Runtime application** (per Q3): default = (a) guardrail keeps env defaults; catalog/defaults are advisory. If (b): add `guardrail_provider`/`guardrail_model` to SMR generate request + wire `ExternalGuardrailClient` into the pipeline and forward.

E5. **Out-of-workspace follow-up:** admin console UI section under `configurations` (tracked separately; not editable here).

E6. **Tests:** extend `seed.test.ts`/`seed-smr-provider-models.test.ts` for guardrail catalog; extend `tenant.service.test.ts` for guardrail validation + reject-invalid cases.

### Layer/verification order

`config → providers/clients → wiring (main/dependencies/activities) → env/configmap → DB seed/applications/api → tests → docs`. After each service: run that service's unit suite (conda `arcaenv`, `pytest -o addopts=""`), TS tests for SMR seed + tenant service, `ReadLints` on edited files. Capture output as evidence.

### File touch inventory (estimate)

- SMR: `core/config.py`, seed `11-global-setting.ts`, `.env.dev`, configmap, `test_config.py`, `seed-smr-provider-models.test.ts` (+ docs).
- Harness: `core/config.py`, `eval/config.py`, `sensors/inferential/granite_client.py` (+ new engine), `safety.py`, `inferential/__init__.py`, `temporal/activities.py`, `eval/inferential_corpus_eval.py`, `.env.example`, 4 test files (+ docs).
- Guardrail: `core/config.py`, `providers/*` (new + refactor), `main.py`, `core/dependencies.py`, endpoints, `.env.example`, configmap, 2+ test files (+ README/GUARDIAN_INTEGRATION).

---

## 5. Implementation Summary

_(to be completed after approval + implementation)_

## 6. Change History

_(to be completed)_
