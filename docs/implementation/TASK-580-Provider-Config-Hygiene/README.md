# TASK-580 — Provider-Config Hygiene (guardrail docstring, env template cleanup)

- **Status**: Pending
- **Type**: docs + infrastructure (hygiene)
- **Tier**: sonnet-5-xhigh (doc/comment + local-template edits; no runtime behavior change)
- **Program**: [Provider-Plane Day-1 Defaults](../SOTA-Track/2026-07-28-provider-plane-day1-defaults-followups.md) — finding **F4**

## Requirement Analysis

Three low-risk hygiene items surfaced by the audit. None changes runtime behavior; all reduce the chance a future reader mistakes a stale artifact for a live provider default.

1. **Guardrail stale docstring (correctness of comment).** `apps/guardrail/src/guardrail/core/config.py:277-279` (`DatabaseConfig` docstring) claims the resolver *"fails open to the env-selected engine on ANY DB error or empty result."* The actual resolver `core/dependencies.py:94-99` (`get_resolved_guardian_provider`) fails **CLOSED (HTTP 503)** — correct behavior, wrong comment. A stale fail-open claim on a safety-critical path invites a wrong "fix."
2. **`.env.dev` legacy Azure block (developer template hygiene).** The gitignored `.env.dev` carries `SUMMARY_SERVICE_PROVIDER=azure_openai`, `AZURE_OPENAI_MODEL=gpt-4o-mini`, and `AZURE_OPENAI_ENDPOINT=https://alaas-openai.openai.azure.com/...` (a real, since-rotated endpoint host), plus `SMR_V2_*_DEFAULT_MODEL` values. Not committed (so not an all-tenant default), but stale legacy provider config sitting in the dev template.
3. **`.env.production` harness-judge note (informational).** `HARNESS_JUDGE_PROVIDER=openai_compat` + `HARNESS_JUDGE_MODEL=google/gemma-4-e4b` are committed. This is LLM-as-eval **infrastructure**, not tenant-facing generation, so it is legitimately env-tier — but it should carry a comment saying so, so the audit does not re-flag it.

## Current State Evaluation

- Guardrail behavior is already correct (fail-closed) — this is a **comment-only** change; do NOT alter `dependencies.py`.
- `GUARDRAIL_V2_PROVIDER=lm-studio` (`config.py:330-331`) is a documented dev escape (only used when `db_config_enabled=False`); leave it, optionally add a one-line "dev-only escape hatch" note.
- `.env.dev` is per-developer and gitignored; "cleanup" means correcting the tracked **template** the dev file is generated/copied from. Confirm during discovery whether `.env.example` (or a `.env.dev.example`) is the tracked source; edit that, not the local gitignored file (which each dev owns).

## Implementation Plan

1. **Guardrail docstring** — rewrite `config.py:277-279` to state the resolver fails **closed** (503) when SYSTEM selection is missing/errors, and that `GUARDRAIL_V2_PROVIDER` is a dev-only escape used only under `db_config_enabled=False`. No code change.
2. **Env template** — remove the stale Azure/`SUMMARY_SERVICE_PROVIDER`/`SMR_V2_*_DEFAULT_MODEL` lines from the tracked env template (`.env.example` and any `.env.dev.example`); ensure the committed template carries **placeholders only** (gitleaks rule `hope-committed-env-file` must stay green). Do not commit any real endpoint host.
3. **`.env.production` comment** — add a comment above `HARNESS_JUDGE_PROVIDER`/`_MODEL` marking it as eval infrastructure (env-tier by design), not a tenant-facing provider default.
4. **Verify** — `pnpm py:guardrail:lint|typecheck` green (docstring change compiles); gitleaks scan clean on the env template edits.

## TDD note

This ticket is documentation/hygiene — no behavior to test. The "test" is: (a) `pnpm py:guardrail:test` still green (unchanged behavior confirms the docstring now matches reality), and (b) a gitleaks run over the changed env template reports clean.

## Verification Criteria (Definition of Done)

- [ ] Guardrail docstring matches the fail-closed resolver; `dependencies.py` untouched; `py:guardrail:test` green.
- [ ] Tracked env template carries placeholders only; stale Azure/legacy provider lines gone; gitleaks clean.
- [ ] `.env.production` harness-judge lines carry the "eval infra" comment.
- [ ] No runtime behavior changed (confirmed by unchanged test results).

## Implementation Summary

_(fill on completion)_

## Change History

- 2026-07-28 — Ticket created from the Provider-Plane Day-1 Defaults audit (finding F4). Status Pending.
