# TASK-579 — SMR Cloud `default_model`: Align to `failMode=closed`

- **Status**: Pending
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

_(fill on completion)_

## Change History

- 2026-07-28 — Ticket created from the Provider-Plane Day-1 Defaults audit (finding F3). Status Pending.
