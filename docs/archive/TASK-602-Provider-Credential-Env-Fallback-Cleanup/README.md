# TASK-602 — BYOK Provider Credentials: Remove Env-Secret Fallback (STT/TTS/SMR)

- **Status**: Review
- **Type**: refactor / bugfix (config hardening)
- **Branch**: dev-2.1
- **Owner**: Tap Huynh
- **Created**: 2026-08-02
- **Program**: follow-up to [Unified Provider-Connection Plane](../SOTA-Track/2026-07-28-unified-provider-plane-program.md); closes the gap self-flagged in [TASK-600](../TASK-600-Compat-Translate-To-English/README.md) line 78.

## Requirement Analysis

The unified provider-connection plane (`AiProviderConnection`, TASK-569–576) is the one governed, Vault-Transit-encrypted store for BYOK credentials, keyed by `(tenantId, service, provider)`. The gateway resolves **tenant row → SYSTEM-tenant row** and forwards the result to the Python services as `provider_overrides`. This is correct and unchanged.

The defect: STT, TTS, and SMR each *also* keep their own environment-variable copy of the same platform credential and silently substitute it whenever the gateway sends no override — a third, undocumented resolution tier that violates the Configuration-Tiers doctrine (`09-infrastructure-devops.md`: a tenant-BYO-capable credential is `db-secret` tier and must fail closed, never substitute from env) and is inconsistent with the just-shipped SMR Sarvam `translate` capability (`apps/smr/src/smr/translation/sarvam.py` — BYOK-only, fails closed 503).

**Owner decisions (2026-08-02):**
- Resolution becomes strictly **tenant BYOK → SYSTEM row → fail closed (503)**. No env fallback for these credentials.
- No data migration (dev-only; no production yet). Removing the env fallback means "no key until an admin configures the SYSTEM `AiProviderConnection` row" — acceptable.
- Scope: STT + TTS + SMR's Azure / Sarvam / OpenAI / Anthropic credentials.

**Out of scope (verified already-correct or unrelated):** the gateway/TS cascade; SMR Bedrock + Vertex (no static `api_key` field — ambient AWS IAM / GCP ADC + explicit override, already compliant); `AZURE_FOUNDRY_API_KEY` (disabled preview engine); any DB schema/migration.

## Current State Evaluation (code-verified 2026-08-02, dev-2.1)

- **STT** — `models/sarvam_loader.py:68-69`, `models/openai_loader.py:70-71`, `models/azure_speech_loader.py:122` each fall back to a `settings.*` env-sourced key after the override check; the fail-closed `raise CloudASRAuthError(...)` already follows. `core/config/settings.py:248/281/293` define `azure_speech_key` / `sarvam_api_key` / `openai_api_key`. `azure_speech_loader.py:117-121` has an EXTRA path: `model_config.compute_type` repurposed as `"key:<secret>"` (unencrypted secret in pipeline config; only its own test exercises it — no real caller found). Bare `SARVAM_API_KEY`/`OPENAI_API_KEY` are NOT in `turbo.json#globalEnv` nor the settings-registry; only `AZURE_SPEECH_KEY` is registered (`azure.speechKey` descriptor + turbo).
- **TTS** — `core/config.py` `AzureSpeechConfig` (`TTS_AZURE_`, `api_key` aliased to also read bare `AZURE_SPEECH_KEY`) and `SarvamConfig` (`TTS_SARVAM_`). `main.py:49/61` register the platform provider only when `settings.<p>.enabled`. `routing/router.py` `_build_override_engine`/`_engine_for` correctly build a per-tenant engine from an override; `candidates()` (~line 209) treats a registered-but-keyless provider as available (would 401 live).
- **SMR** — `core/config.py` `AzureOpenAIConfig`/`OpenAIConfig`/`AnthropicConfig` carry `api_key: SecretStr`. `providers/{azure_openai,openai,anthropic}.py` build the shared SDK client eagerly in `__init__` from the env key; `_client_for` returns the shared client when no override. `main.py:74` gates Azure OpenAI *registration* on `settings.azure.api_key` being non-empty → once env-unreachable, Azure never registers even for a valid BYOK override (404, not 503). OpenAI/Anthropic/Vertex already register unconditionally (BYO-first).

## Implementation Plan

See the approved plan (`.claude/plans/magical-tickling-lagoon.md`). Phases: STT → TTS → SMR → config/descriptor/vault hygiene → doc. TDD RED→GREEN per phase; a new `ProviderCredentialsError(SmrError)` (503) for SMR.

## Implementation Summary

All three services now resolve these cloud credentials strictly **tenant BYOK → SYSTEM row → fail closed**, with no env fallback. Approach per the plan, with one deviation recorded below.

### STT (`apps/stt`)
- **Deleted** the `azure_speech_key` / `sarvam_api_key` / `openai_api_key` settings fields entirely (cleaner than the alias approach — STT had no override-cloning dependency on them). Only the non-secret `azure_speech_region` / base-URL fields remain.
- `models/{azure_speech_loader,openai_loader,sarvam_loader}.py`: removed the env-fallback line in each; the credential now comes solely from the per-request override, and the existing `raise CloudASRAuthError(...)` is the fail-closed path (messages reworded to stop citing env vars).
- Removed the undocumented `compute_type` `"key:<secret>"` inline-key path from `azure_speech_loader.py` (unencrypted-secret-in-config; no real caller).

### TTS (`apps/tts`)
- `core/config.py`: `AzureSpeechConfig`/`SarvamConfig` `api_key` given a **dead `validation_alias`** (`*__ENV_REMOVED_TASK_602`) with `populate_by_name` **OFF**, so neither the prefixed env var nor the field name repopulates it. The router applies overrides via `model_copy(update=...)` (bypasses validation), so nothing breaks.
- Added an `is_configured: bool` attribute to the engine Protocol (`providers/base.py`) and every provider; `routing/router.py` `candidates()` now requires `is_configured` for a *registered* provider — a keyless platform provider is excluded (would 401 live) but still reachable via a per-tenant override. Fail-closed uses the existing `AllProvidersUnavailableError`.

### SMR (`apps/smr`)
- `core/config.py`: `AzureOpenAIConfig`/`OpenAIConfig`/`AnthropicConfig` `api_key` given the same **dead-alias / `populate_by_name`-off** treatment as TTS. **Plan deviation (verified empirically):** the plan suggested `populate_by_name=True` for SMR; testing showed that leaves the prefixed env var (`SMR_AZURE_API_KEY`) still populating the field, so the strict TTS approach was used instead. Tests construct keyed configs via a new `keyed()` conftest helper (`model_copy`).
- `providers/{azure_openai,openai,anthropic}.py`: the shared platform client is now built **lazily** — only when a non-empty key is present (empty in production). `_client_for()` raises the new `ProviderCredentialsError` when neither an override nor a platform client exists (never hands an empty key to the SDK). `health_check`/`get_info` report unavailable when there is no client.
- `main.py`: **bug fix** — Azure OpenAI registration no longer requires `api_key` (dropped the `and settings.azure.api_key...` half of the gate). It now registers on `endpoint` alone, BYO-first like openai/anthropic/vertex, so a tenant with a valid BYOK override reaches the credential check instead of a 404.
- New `ProviderCredentialsError(SmrError)` (`core/exceptions.py`), mapped **503** in `core/exception_handlers.py`. `api/endpoints/generate.py`: added a dedicated `except ProviderCredentialsError` that marks the task failed, **does not** trip the circuit breaker (a config gap is not a provider health failure), and re-raises so the shared handler maps it to 503 (not the generic 502).
- New security suite `tests/unit/test_task602_byok_credentials.py` (env-not-read × 3, fail-closed generate/stream × 4, 503 handler mapping, BYO-first registration). Existing provider/config tests repaired to the `keyed()` helper (12 files).

### Config / descriptor / Vault hygiene
- Removed the 5 platform-secret descriptors (`azure.speechKey`, `smrAzure.apiKey`, `smrOpenai.apiKey`, `smrAnthropic.apiKey`, `ttsSarvam.apiKey`) from `platform-secrets.descriptors.ts`; **kept** `azure.foundryApiKey` (out of scope). Updated `smr-provider-connections.descriptors.ts` header (non-secret routing only). Updated the parity test `fail-mode.governance.test.ts` (`EXPECTED` map).
- Per-service `.env.sample` (stt/tts/smr) dead keys removed; `pnpm env:sync` regenerated root `.env.sample` + `turbo.json` (removed 5 creds, retained `AZURE_FOUNDRY_API_KEY`); `pnpm env:sync:check` reports no drift.
- Vault policies `hope-{stt,tts,smr}.hcl` and `deployment/vault-agent/README.md` secret table: dead credential paths removed.
- Comment-only fixes: `ai-provider-connection.prisma` resolution header (no more "service env fallback") and the `enabled` DTO description.

### Verification (evidence)
- **STT** — `stt:test:unit` exit 0; `stt:lint` 0; `stt:typecheck` 0.
- **TTS** — unit **187 passed** (`NODE_ENV=test`); `tts:lint` 0; typecheck: only pre-existing missing-stub / `aclosing` errors, none at TASK-602 lines.
- **SMR** — full unit **1022 passed** (`NODE_ENV=test`); new suite 10/10; `smr:lint` 0; typecheck: only the pre-existing `bedrock.py` boto3-stub error (file untouched).
- **`@arcaai/applications`** — **7183 passed** (incl. `fail-mode.governance` + `vault-kv-coverage`).
- **Grep sweep** — no live read sites for any removed credential name in `apps/{stt,tts,smr}` src.

> **Harness note:** `{stt,tts,smr}:test:unit` scripts don't set `NODE_ENV`, so run locally they load `.env.dev` (which carries service tokens) and auth-gate endpoint tests to 401 — a pre-existing harness artifact, not a TASK-602 regression. Verified under `NODE_ENV=test`.

## Remaining / out of scope
- Production Helm chart (external `hope-deployments` repo) — any equivalent `podAnnotations`/secret wiring for these five names is out of scope here; flag for that repo.
- Pre-existing typecheck debt (`bedrock.py` boto3 stub; TTS optional-ML stubs) — unrelated to this ticket.
- Not committed — changes are staged on `dev-2.1` for owner review.

## Change History

- 2026-08-02 — Ticket created from the owner-confirmed provider-credential cleanup; plan approved. Status In Progress.
- 2026-08-02 — Implemented all phases (STT/TTS/SMR + config/descriptor/Vault hygiene). STT deleted the key fields; TTS/SMR used the dead-alias technique (SMR deviated from the plan's `populate_by_name=True` after empirically confirming it still leaks env). Fixed the SMR `main.py` Azure-registration bug and the `/generate` 502-swallow (now 503, no false CB trip). All service unit suites + applications suite green under `NODE_ENV=test`; `env:sync:check` clean. Status **Review**.
