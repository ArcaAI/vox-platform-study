# TASK-580 — Provider-Config Hygiene (guardrail docstring, env template cleanup)

- **Status**: Review
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

All three hygiene items closed. No runtime behavior changed anywhere — confirmed by an unchanged, fully-green guardrail test/lint/typecheck run.

1. **Guardrail docstring (`apps/guardrail/src/guardrail/core/config.py`)** — rewrote the `DatabaseConfig.db_config_enabled` comment (was lines 277-279) to state the resolver (`get_resolved_guardian_provider` in `core/dependencies.py:63-104`) fails **CLOSED (HTTP 503)** when the SYSTEM `AiTaskDefault` selection for `guardrail.validate` is missing or a DB error occurs, with no silent env fallback — matching the verified behavior at `dependencies.py:94-99`. Also added a one-line "dev-only escape hatch" note above `Settings.provider` (`GUARDRAIL_V2_PROVIDER`, ~line 334) clarifying it is consumed only when `db_config_enabled=False`. `dependencies.py` was NOT touched — comment-only change, verified by diff.

2. **Env template hygiene — investigated, no tracked-file change needed.** Ran `git ls-files | grep -E '(^|/)\.env'` to enumerate every tracked env file, then `git grep` for `SUMMARY_SERVICE_PROVIDER`, `AZURE_OPENAI_MODEL=`, `AZURE_OPENAI_ENDPOINT=`, `SMR_V2_.*DEFAULT_MODEL` across `*.example` files: **zero matches**. The root `.env.example` carries no `SUMMARY_SERVICE_PROVIDER`/`AZURE_OPENAI_*`/`SMR_V2_*_DEFAULT_MODEL` keys at all (placeholder or otherwise) — confirmed by direct grep. There is also no tracked `.env.dev.example` anywhere in the repo. The stale values the ticket describes (`SUMMARY_SERVICE_PROVIDER=azure_openai`, `AZURE_OPENAI_ENDPOINT=https://alaas-openai.openai.azure.com/...`, `AZURE_OPENAI_MODEL=gpt-4o-mini`, `SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL`, `SMR_V2_OLLAMA_DEFAULT_MODEL`) live ONLY in the developer's local, gitignored `.env.dev` (verified present there at the lines the ticket cites) — which is per-developer and explicitly out of scope per the Implementation Plan ("edit that, not the local gitignored file, which each dev owns"). **No tracked file was edited for this item; nothing was in scope to remove.**

3. **`.env.production` comment** — added a 5-line comment directly above `HARNESS_JUDGE_PROVIDER`/`HARNESS_JUDGE_MODEL` marking them as LLM-as-eval infrastructure (the harness's own judge model), legitimately env-tier per `09-infrastructure-devops.md`, and explicitly exempt from the "no provider-selection default in env" invariant that governs tenant-facing generation (SMR/TTS/STT/guardrail). No value changed.

### Files changed

- `apps/guardrail/src/guardrail/core/config.py` (comment-only)
- `.env.production` (comment-only)

### Verification (actual output)

Note: the ticket's suggested commands (`pnpm py:guardrail:*`) don't exist under the current script taxonomy (TASK-557); the correct root scripts are `pnpm guardrail:test|lint|typecheck` (per `scripts/README.md` and `.claude/rules/01-development-workflow.md`).

**`pnpm guardrail:test`** — first run hit `ModuleNotFoundError: No module named 'guardrail'` (18 collection errors) because `guardrail` was not resolvable as an editable install in the shared `arcaenv` conda env at session start (`pip show guardrail` → not found, unlike `nlp`/`smr`/`stt` which were present) — a pre-existing local-environment gap, unrelated to this doc-only change. Ran `python -m pip install -e apps/guardrail --no-deps` (editable install only, no dependency/version changes, no tracked files touched) to restore the env, then re-ran:

```
======================== 174 passed, 1 warning in 4.64s ========================
```

Full suite green — the docstring rewrite doesn't change behavior. Coverage report shows `core/config.py` at 97%, `core/dependencies.py` at 90%, both untouched by this change.

**`pnpm guardrail:lint`**:
```
> conda run -n arcaenv --no-capture-output ruff check apps/guardrail/src/
All checks passed!
```

**`pnpm guardrail:typecheck`**:
```
> conda run -n arcaenv --no-capture-output mypy --config-file apps/guardrail/pyproject.toml apps/guardrail/src/
Success: no issues found in 31 source files
```

**gitleaks** (staged-scan, same invocation as `scripts/gitleaks-precommit.sh`):
```
$ gitleaks protect --staged --config .gitleaks.toml --no-banner --redact --verbose
INF 0 commits scanned.
INF scanned ~9586 bytes (9.59 KB) in 34.9ms
INF no leaks found
```

### Constraints honored

- `apps/guardrail/src/guardrail/core/dependencies.py` — untouched (verified: not in `git diff`/`git status`).
- No TS package, seed, TTS, or SMR file edited.
- Only `apps/guardrail/src/guardrail/core/config.py` and `.env.production` were staged by this session (`git add`); nothing committed, pushed, or reset. Concurrent in-flight changes from other agents (`apps/api/tests/e2e/mcp-admin.spec.ts` staged; `docs/implementation/SOTA-Track/...`, `TASK-577/578` READMEs modified) were left exactly as found.

## Change History

- 2026-07-28 — Ticket created from the Provider-Plane Day-1 Defaults audit (finding F4). Status Pending.
- 2026-07-28 — Implemented all three items (guardrail docstring rewrite + dev-escape-hatch note, env-template investigation with no tracked-file change required, `.env.production` eval-infra comment). Guardrail test/lint/typecheck green (174 passed), gitleaks clean on staged changes. Status Review.
