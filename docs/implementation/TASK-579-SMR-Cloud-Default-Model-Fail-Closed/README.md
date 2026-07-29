# TASK-579 — SMR Cloud `default_model`: Align to `failMode=closed`

- **Status**: Review
- **Type**: bugfix (config hardening)
- **Tier**: sonnet-5-xhigh (scoped to `apps/smr` config + resolution)
- **Program**: [Provider-Plane Day-1 Defaults](../SOTA-Track/2026-07-28-provider-plane-day1-defaults-followups.md) — finding **F3** (borderline)

## Requirement Analysis

Each SMR cloud sub-config carries a per-provider `default_model` (`apps/smr/src/smr/core/config.py`): Azure `gpt-5-mini` (`:61`), Bedrock `anthropic.claude-3-5-haiku` (`:79-80`), OpenAI `gpt-4o-mini` (`:172`), Anthropic `claude-3-5-haiku-20241022` (`:197`), Vertex `gemini-2.0-flash` (`:222-223`). When the gateway omits `model`, the env value substitutes one. The Configuration-Tiers rule (`09-infrastructure-devops.md` §Configuration Tiers) says provider/model **SELECTION is `failMode=closed`** — an unresolved value must raise, "nothing is substituted." A per-provider `default_model` technically substitutes a model.

This is **borderline, not a clear breach** (it is per-provider, not a single global all-tenant default, and provider choice is always request-driven). This ticket resolves the tension deliberately rather than leaving it ambiguous.

## Current State Evaluation (code-verified 2026-07-28)

- Local built-in engines (`OllamaConfig`, `OpenAICompatConfig`/LM Studio, `VllmConfig`, `LlamaCppConfig`) carry base-URL + model defaults — **acceptable built-in topology**, out of scope.
- The five **cloud** sub-configs are the ones with a substitutable model default. The gateway resolves the intended model from `AiTaskDefault` (`smr.live`/`smr.finalize`) and passes it in `GenerateRequest.model` (`apps/smr/src/smr/models/requests.py:48-49`). So in the normal path the env default is never used.
- The risk is a **degenerate path**: a request reaches SMR with a cloud provider but no model → the env default silently picks a vendor model instead of failing. On a healthcare summarization path, silently substituting a model is worse than a clear 4xx/503.

## Decision (implement one; A recommended)

- **A (recommended) — fail-closed for cloud.** Remove the cloud `default_model` values (or set them to a sentinel like SMR/NLP's `__UNCONFIGURED__` pattern) so a cloud generate with no `model` raises a typed "model not selected" error surfaced as 4xx/503, never a substituted vendor model. Local built-in engines keep their model default (topology).
- **B — keep + document.** If the owner wants the cloud `default_model` retained as an intentional fail-open tuning knob, add an explicit docstring on each field stating it is a *tuning* default (fail-open) and confirm the gateway ALWAYS injects `model` for cloud providers so it is unreachable in production. Weaker; only if A is rejected.

## Implementation Plan (TDD — Decision A)

1. **RED** — in `apps/smr/**/tests/`, add a test: constructing/using a cloud provider client with a request that omits `model` **raises** the typed selection error (not a silent `gpt-4o-mini`). Cover Azure/OpenAI/Anthropic/Vertex/Bedrock. Run → fails (currently substitutes).
2. **GREEN** — in `core/config.py`, remove the `default_model` default from the five cloud sub-configs (make the field required-at-use or sentinel-guarded). Update each provider adapter (`providers/{azure_openai,bedrock,openai,anthropic,vertex}.py`) to raise when `model` is absent for a cloud request. Do not touch local-engine configs.
3. **REFACTOR** — factor the "cloud model required" guard into one helper if it repeats across adapters.
4. Confirm the gateway's normal path (model from `AiTaskDefault`) still works end-to-end via the existing SMR tests (regression).

## TDD Test List (RED first)

- Per cloud provider: generate with no `model` → raises typed selection error.
- Per cloud provider: generate WITH `model` → succeeds (uses injected model).
- Local engines unchanged (their model default still applies).
- Regression: shipped SMR generation/streaming tests green.

## Verification Criteria (Definition of Done)

- [ ] Decision recorded (A or B) with owner confirmation.
- [ ] `pnpm py:smr:test|lint|typecheck` green; `uv lock` unchanged (no deps).
- [ ] No cloud `default_model` silently substitutes a vendor model (grep + test).
- [ ] Local built-in engine defaults untouched; shipped SMR suite green.

## Implementation Summary

Decision A implemented. Code-verified before this ticket: of the five cloud providers only **`VertexProvider._resolve_model`** actually substituted a vendor model (`request.model or self._default_model`) — Azure/Bedrock/OpenAI/Anthropic already forwarded `request.model` verbatim into `generate()`/`generate_stream()` (the pre-existing D7 contract, `test_no_model_default_d7.py`), but relied on the *downstream SDK* to fail on `model=None` rather than a controlled, typed error. This ticket closes both: the one real substitution (Vertex) and the missing explicit guard (all five).

**Config (`apps/smr/src/smr/core/config.py`)**: the five cloud sub-configs' `default_model` field default changed from a compiled-in vendor string to `""` (informational-only, matching the existing `VllmConfig`/`LlamaCppConfig` convention):
- `AzureOpenAIConfig.default_model`: `"gpt-5-mini"` → `""`
- `BedrockConfig.default_model`: `"anthropic.claude-3-5-haiku-20241022-v1:0"` → `""`
- `OpenAIConfig.default_model`: `"gpt-4o-mini"` → `""`
- `AnthropicConfig.default_model`: `"claude-3-5-haiku-20241022"` → `""`
- `VertexConfig.default_model`: `"gemini-2.0-flash"` → `""`

Local built-in engines (`OllamaConfig`, `OpenAICompatConfig`, `VllmConfig`, `LlamaCppConfig`) are untouched.

**Shared guard (`apps/smr/src/smr/providers/base.py`)**: new `require_model(model, *, provider) -> str` — raises `ModelNotSelectedError` (new, in `core/exceptions.py`, subclasses `InputValidationError` → 422 via the existing `_STATUS_MAP` isinstance lookup in `core/exception_handlers.py`, no handler change needed) when the resolved model is `None`/blank/whitespace-only; otherwise returns it unchanged.

**Provider adapters** (`azure_openai.py`, `bedrock.py`, `openai.py`, `anthropic.py`, `vertex.py`): each `generate()`/`generate_stream()` now computes `resolved_model = require_model(self._resolve_model(request), provider="<name>")` as the first statement (before the OTel span / any client call), reusing that single guarded value everywhere the model was previously re-derived (removes several redundant `self._resolve_model(request)` re-calls and now-dead `or ""` fallbacks). `VertexProvider._resolve_model` no longer falls back to `self._default_model` — it now matches the other four (`override.model or request.model`, i.e. `None` when the caller omits a model). `get_info()` on azure/openai/anthropic/vertex now guards the informational `default_model` seed entry (`[ModelInfo(...)] if self._default_model else []`, matching the pre-existing `llama_cpp.py` pattern) so an unconfigured deployment never advertises an empty-named model on `/providers`. Bedrock's `get_info()` needed no change (already starts `models=[]`).

**Note on the endpoint-level guard**: `POST /generate` (`api/endpoints/generate.py`) already rejects a missing/blank `model` with 422 for EVERY provider (prior TASK, `test_no_model_default_d7.py`). This ticket adds the equivalent guard one layer down, in the provider adapters themselves — defense-in-depth for any caller that invokes a provider directly (tests, a future internal caller) rather than only through that endpoint.

**Tests**: new `apps/smr/src/smr/tests/unit/test_cloud_model_task579.py` — parametrized over all 5 cloud providers: `_resolve_model()` never falls back to the configured default (locks the Vertex fix); `generate()`/`generate_stream()` raise `ModelNotSelectedError` on a missing OR blank/whitespace model; a caller-supplied model still succeeds; local engines (Ollama, LM Studio) are confirmed unaffected; a grep-style assertion that every cloud config's `default_model` field default is `""`. Extended `test_config.py` (per-cloud-config default assertions) and `test_exception_hierarchy.py` (added `ModelNotSelectedError` to the parametrized exception-inheritance/error-code suite + a dedicated 422 handler-mapping test).

**Regression fixes** (pre-existing tests that constructed a `GenerateRequest` with no `model` against a cloud provider purely to exercise unrelated behavior — guardrail logging, async-stream bridging, OTel spans, token-usage mapping — now pass an explicit `model=` so they keep testing what they intended): `test_provider_guardrails.py` (1), `test_bedrock_async_stream.py` (8, single `replace_all`), `test_bedrock_provider.py` (4), `test_providers_e1.py` (2, Bedrock-only), `test_provider_edge_cases.py` (5, Bedrock-only), `test_telemetry.py` (3, Bedrock-only — the Azure telemetry tests were already safe because their fixture sets `deployment_name="gpt-4"`, which wins over `request.model` regardless of this change).

### Verification (actual output)

```
$ pnpm smr:test:unit
================= 989 passed, 8 warnings in 603.21s (0:10:03) ==================

$ pnpm smr:lint
All checks passed!

$ pnpm smr:typecheck
apps/smr/src/smr/providers/bedrock.py:98: error: "Session" has no attribute "_components"; maybe "get_component"?  [attr-defined]
Found 1 error in 1 file (checked 55 source files)
```

The one `smr:typecheck` finding is **pre-existing and out of scope**: `session._components.register_component(...)` in `BedrockProvider._client_for` (the tenant-BYO bearer-token override path, TASK-572a) is untouched by this ticket's diff and identical in the pre-ticket committed `HEAD` (`git show HEAD:apps/smr/src/smr/providers/bedrock.py`) — it calls a private/undocumented botocore attribute mypy's stubs don't know about. Confirmed zero NEW mypy errors from this ticket's changes.

`uv lock` not re-run — no dependency changes.

**Grep proof (no cloud `default_model` silently substitutes)**: `grep -n "default_model" apps/smr/src/smr/core/config.py apps/smr/src/smr/providers/*.py` shows `self._default_model` is read only in `__init__` (storage) and `get_info()` (informational `ProviderInfo`/`ModelInfo` display, now empty-guarded) across all five cloud adapters — never in `generate()`/`generate_stream()`/`_resolve_model()`.

## Change History

- 2026-07-28 — Ticket created from the Provider-Plane Day-1 Defaults audit (finding F3). Status Pending.
- 2026-07-28 — Implemented Decision A (fail-closed). `default_model` zeroed on the five cloud configs; `ModelNotSelectedError` + shared `require_model()` guard added; `VertexProvider._resolve_model`'s real substitution bug fixed; regression tests updated; new TDD suite added. `pnpm smr:test:unit` 989/989 green, `smr:lint` clean, `smr:typecheck` clean except one pre-existing, out-of-scope finding in `bedrock.py:98` (untouched by this diff). Status → Review. Staged, not committed.
