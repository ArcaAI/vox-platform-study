# TASK-337: Local LLM Engine Standardization (LM Studio default across SMR, Harness, Guardrail)

- **Ticket Number**: TASK-337
- **Created Date**: 2026-06-07
- **Last Updated**: 2026-06-07
- **Status**: Completed (2026-06-07)
- **Classification**: refactor / infrastructure
- **Scope**: **Python LLM engine standardization only** (SMR + Harness + Guardrail services). Admin-console configurability was split out to **TASK-338**.
- **Related**: TASK-238 (SMR seed defaults), TASK-330 (Clinical Documentation Harness), TASK-338 (admin-config backend + UI), prior chat (SMR LM Studio default flip)

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

### ✅ Resolved decisions (approval round 2)

- **Q1 — Admin console = `apps/ui-playground`** (in this workspace; has `features/admin/configurations` + `summarization/components/provider-model-select.tsx`). Admin-configurability work lives in **TASK-338**.
- **Q2 — Azure: deployment-name configurable via console now; API key stays env/Vault** (`SMR_AZURE_API_KEY` / `GUARDRAIL_AZURE_API_KEY`). A non-secret GlobalSetting MUST NOT hold the raw key (blocked on TASK-302 Phase 4D). → **TASK-338**.
- **Q3 — Guardrail reads tenant config directly from the DB (option c)** — guardrail service gains SQLAlchemy/asyncpg access to the `core.GlobalSetting` table (precedent: STT already uses SQLAlchemy+asyncpg). → **TASK-338**.
- **Q4 — Split into two tickets:**
  - **TASK-337 (this doc)** — Python engine standardization: LM-Studio default + `provider` switch across SMR/Harness/Guardrail; Granite-over-OpenAI; env renames; tests; docs.
  - **TASK-338** — Admin-configurability backend + UI: guardrail GlobalSettings + catalog, generalized `tenant.service.ts` validation, API catalog endpoint, `ui-playground` UI, Azure deployment-name setting, and guardrail-reads-DB runtime application.

> The env var renames in TASK-337 are designed so TASK-338 can layer DB-driven overrides on top without re-renaming.

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

A1. `apps/smr/src/smr/core/config.py`:
- `OllamaConfig.default_model` → `google/gemma-4-e4b`
- `AzureOpenAIConfig.default_model` → `gpt-5-mini`
- `BedrockConfig.default_model` → `anthropic.claude-3-5-haiku-20241022-v1:0`
- `OpenAICompatConfig.default_model` → `google/gemma-4-e4b`

A2. Seed `packages/database/src/prisma/db_main/seed/11-global-setting.ts`:
- `default-smr-model` value/defaultValue → `google/gemma-4-e4b`
- Add `google/gemma-4-e4b` to the `lm-studio` catalog block (first entry).

A3. `.env.dev` + `deployment/k3s/base/configmap.yaml`: set `SMR_OPENAI_COMPAT_DEFAULT_MODEL=google/gemma-4-e4b`; flip configmap to LM-Studio-default (`SMR_OPENAI_COMPAT_ENABLED=true`, `SMR_OLLAMA_ENABLED=false`).

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

> **Admin-configurability (DB GlobalSettings, generalized validation, API catalog endpoint, `ui-playground` UI, Azure deployment-name setting, guardrail-reads-DB) is TASK-338** — see that doc. TASK-337 stops at env-configured engines + the `provider` switch.

### Layer/verification order

`config → providers/clients → wiring (main/dependencies/activities) → env/configmap → tests → docs`. After each service: run that service's unit suite (conda `arcaenv`, `pytest -o addopts=""`), TS tests for SMR seed, `ReadLints` on edited files. Capture output as evidence.

### File touch inventory (estimate)

- SMR: `core/config.py`, seed `11-global-setting.ts`, `.env.dev`, configmap, `test_config.py`, `seed-smr-provider-models.test.ts` (+ docs).
- Harness: `core/config.py`, `eval/config.py`, `sensors/inferential/granite_client.py` (+ new engine), `safety.py`, `inferential/__init__.py`, `temporal/activities.py`, `eval/inferential_corpus_eval.py`, `.env.example`, 4 test files (+ docs).
- Guardrail: `core/config.py`, `providers/*` (new + refactor), `main.py`, `core/dependencies.py`, endpoints, `.env.example`, configmap, 2+ test files (+ README/GUARDIAN_INTEGRATION).

---

## 5. Implementation Summary

Implemented 2026-06-07 via three parallel workers (one per service). All scoped surgically.

### Phase A — SMR (config + seed + docs)
- `apps/smr/src/smr/core/config.py`: provider `default_model`s → Ollama/OpenAI-compat `google/gemma-4-e4b`, Azure `gpt-5-mini`, Bedrock `anthropic.claude-3-5-haiku-20241022-v1:0`.
- `packages/database/src/prisma/db_main/seed/11-global-setting.ts`: `default-smr-model` → `google/gemma-4-e4b`; added `google/gemma-4-e4b` as first `lm-studio` catalog entry (15→16).
- `.env.dev`: `SMR_OPENAI_COMPAT_DEFAULT_MODEL=google/gemma-4-e4b`.
- Tests updated: `test_config.py`, `test_openai_compat_provider.py`, `seed-smr-provider-models.test.ts`. **Python 39/39, TS 305/305.**
- Docs: `docs/marketing/V2_BRIEF_TECHNICAL.md` model table.

### Phase B — Harness safety (engine abstraction)
- `core/config.py`: `GraniteGuardConfig` → `SafetyGuardConfig`, env `HARNESS_GRANITE_*` → `HARNESS_SAFETY_*` (clean break), `Settings.granite` → `Settings.safety`; added `provider` (lm-studio default), `base_url=http://localhost:1234/v1`, `model=granite-guardian-4.1-8b`.
- `sensors/inferential/granite_client.py`: OpenAI-compatible `/v1/chat/completions` default (`choices[0].message.content`), legacy `/api/chat` for `provider=ollama`; canonical IBM 4.1 no-think BYOC block as final user message; `<score>` parser + degrade-don't-guess preserved; base_url `/v1` normalizer added.
- Consumers updated: `temporal/activities.py`, `eval/inferential_corpus_eval.py`, `sensors/inferential/__init__.py`. `eval/config.py` + `judge/providers.py`: added `JudgeProvider.OLLAMA` (parity; openai_compat stays default).
- `.env.example` renamed block. Tests rewritten/added. **Targeted 42/42, full harness unit suite 319/319.**
- Note: `apps/harness/eval/README.md` left as-is — its safety mentions are historical run records (would falsify the record to flip).

### Phase C — Guardrail (provider switch + Granite protocol)
- `core/config.py`: new `OpenAICompatConfig` (`GUARDRAIL_OPENAI_COMPAT_*`, base_url `:1234/v1`, six task models + guardian = `granite-guardian-4.1-8b`); minimal Azure/Bedrock stubs (“requires guardian-capable model”); top-level `provider="lm-studio"` selector + `engine` property; kept `OllamaConfig` as optional engine.
- New `providers/_granite.py` (BYOC block + `<score>` parser + criteria map) and `providers/openai_compat.py` (`OpenAICompatProvider` Granite protocol for safety/pii/injection/comprehensive + generic fallback; `OpenAICompatGuardianProvider` JSON medical-context path).
- `main.py` + `core/dependencies.py`: provider selection by `settings.provider` (default → openai_compat). `api/endpoints/medical.py`, `health.py` engine-aware.
- `.env.example` clean-break rename; `README.md` + `GUARDIAN_INTEGRATION.md` updated. **Tests 19/19** (7 pre-existing + 12 new), ruff clean. No DB access added (deferred to TASK-338).

### Coordination (applied by parent)
- `deployment/k3s/base/configmap.yaml`: SMR flipped to LM-Studio-default (`OPENAI_COMPAT_ENABLED=true`, `OLLAMA_ENABLED=false`, models → `google/gemma-4-e4b`); guardrail gained `GUARDRAIL_V2_PROVIDER=lm-studio` + full `GUARDRAIL_OPENAI_COMPAT_*` block (`granite-guardian-4.1-8b`), Ollama flipped to optional. Base URL `http://hope-lmstudio:1234/v1` — **requires an in-cluster OpenAI-compatible server serving the models (no `hope-lmstudio` service exists today)**.

### Aggregate verification
SMR Python 39/39 + TS 305/305; Harness 319/319; Guardrail 19/19. No lint errors across edited files.

## 6. Change History

- **2026-06-07** — Initial implementation (Phases A–D) via three parallel workers; configmap consolidated by coordinator. Status → Completed.

## 7. Follow-ups / Operational notes

- **k3s LM Studio service**: configmap now points SMR + Guardrail at `http://hope-lmstudio:1234/v1`; an operator must provide an in-cluster OpenAI-compatible endpoint serving `google/gemma-4-e4b` and `granite-guardian-4.1-8b` (none exists today).
- **`apps/harness/eval/README.md`**: still references the now-renamed `GraniteGuardConfig` in historical reproduction notes — optionally add a forward-looking note (left untouched to preserve the record).
- **Model availability**: `google/gemma-4-e4b` and `granite-guardian-4.1-8b` are the configured LM Studio identifiers; operators must load the corresponding models (canonical Granite HF repo: `ibm-granite/granite-guardian-4.1-8b`).
- **TASK-338** (admin-configurability) is unblocked and can now proceed.
