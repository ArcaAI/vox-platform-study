# TASK-736 — Remove Ollama entirely; purge the gemma3 / llama3.2 / qwen catalog; standardise on `gemma-4-e2b-it-qat`

| Field | Value |
|---|---|
| Status | In Progress (Phase D — `apps/harness` — completed 2026-08-16; Phases A/B/C/E/F owned by concurrent agents) |
| Type | refactor + infrastructure |
| Owner decision date | 2026-08-16 |
| Depends on | TASK-735 (overlapping files — see §6 Sequencing) |
| Affects | `apps/text`, `apps/guardrail`, `apps/harness`, `apps/api`, `apps/admin-console`, `packages/database` seeds, `turbo.json`, every `.env*`, docs |

---

## 1. Requirement Analysis

Owner directive, 2026-08-16:

- **R1 — Ollama is removed completely**, including its model catalog rows. Not deprecated, not
  disabled-by-default: removed.
- **R2 — One LM Studio model is the dev + deployment default everywhere**, and every
  `gemma3` / `llama3.2` / `qwen` model-catalog row and configuration default goes with Ollama.
  Owner-resolved 2026-08-16: the model is **`gemma-4-e2b-it-qat`** (slug `lms-gemma-4-e2b-it-qat`),
  applied to the agentic loop AND `smr.live` / `smr.finalize` / `smr.test` / `harness.judge`.
  A separate production model set will be decided later and is out of scope here.

Both follow from the standing configuration rules (`.claude/rules/00-project-context.md`
§Configuration Principles): a model catalog nobody serves is dead config, and an engine kept
"just in case" is an ungoverned surface.

## 2. Current State — measured footprint (2026-08-16)

`ollama`, case-insensitive, excluding `node_modules` / `dist` / `__pycache__`: **282 files**.

| Area | Files | What lives there |
|---|---|---|
| `apps/text` | 59 | `providers/ollama.py` adapter, config, registry wiring, ~20 unit/e2e test modules |
| `packages/**` | 49 | seed catalog, descriptors, domain enums, provider-connection constants |
| `apps/harness` | 23 | `_SAFETY_PROVIDERS` validator, `PhiConfig.local_providers`, judge providers, eval config |
| `apps/guardrail` | 20 | `providers/ollama.py`, `OllamaConfig`, `_PROVIDER_TO_ATTR`, health, tests |
| `apps/api` | 11 | model-discovery controller, text-proxy tests, compat schemas |
| `apps/admin-console` | 7 | model-meta labels, discovery drawer, AI-models screen |
| `docs` (non-archive) | 21 | operations/inference, development-guide, service READMEs |
| `docs/archive` | 84 | historical tickets — **out of scope, do not edit** |
| `infrastructure`, `scripts` | 4 | compose, `dev-service.sh` |

`gemma3` / `llama3.2` / `qwen`: **92 files**.

Env files carrying `OLLAMA`: `.env.sample`, `.env.dev` (untracked, local), `.env.test`,
`apps/guardrail/.env.sample`, `apps/text/.env.sample`.

### 2.1 Catalog rows to remove

`packages/database/src/prisma/db_main/seed/ai-models/llm.ts` — live Ollama rows:
`ollama-gemma4-12b-mlx`, `ollama-gemma4-e2b-it-qat`, `ollama-qwen3.5-2b` (verify the full set at
implementation time; the file is the authority).

There is already a correct mechanism for this: `ai-models/retired.ts` holds a retired-slug ledger
that `retireLegacyAiModels` (`06-stt.ts`) sweeps across **every tenant's copy** of each slug,
guarded by `shouldRetireAiModelSlug` so a slug still referenced by a pipeline is not yanked out
from under it. Several `ollama-*` and `lms-qwen3.5-*` slugs are already in that ledger.

> **Deleting the seed rows is not enough.** Seeds are create-only; a row already materialised in a
> tenant's catalog survives a seed edit. Every removed slug MUST be added to the retired ledger,
> or tenants keep a catalog entry pointing at an engine that no longer exists.

### 2.2 The harness loop default today

`packages/database/src/prisma/db_main/seed/13-harness-policy.ts` seeds the SYSTEM policy with
`smrProvider: 'lm-studio'`, `smrModel: 'gemma-4-e2b-it-qat'` — the **e2b** model. `16-ai-task-default.ts`
likewise binds `smr.live`, `smr.finalize`, `smr.test` and `harness.judge` to
`lms-gemma-4-e2b-it-qat` — which is **already** the owner-chosen model (§2.5).

### 2.3 Model-id drift — resolved against the LIVE LM Studio catalog (2026-08-16)

`GET http://localhost:1234/v1/models` on the running dev instance returns, among 24 models:

```
gemma-4-e2b-it-qat          ✅ served
gemma-4-e4b-it-qat          ✅ served
google/gemma-4-e2b          ✅ served
google/gemma-4-e4b          ✅ served
google/gemma-4-12b-qat      ✅ served
granite-guardian-4.1-8b     ✅ served
google/gemma-4-e4b-qat      ❌ NOT SERVED
```

**This overturns two claims the repo makes about itself:**

1. `seed/ai-models/llm.ts:20-21` states the instance serves `google/gemma-4-e4b-qat` and that
   `google/gemma-4-e4b` is a typo. **Both halves are wrong.** `google/gemma-4-e4b` is served;
   `google/gemma-4-e4b-qat` is not. The comment must be deleted, not merely edited — it is the
   source of the drift it claims to document.
2. `seed/ai-models/llm.ts:160-167` annotates the `lms-gemma-4-e4b-it-qat` row *"Not loaded on the
   dev LM Studio instance (verified 2026-08-10)"*. **Stale** — `gemma-4-e4b-it-qat` is served today.

### 2.4 Live defect found while verifying (fix in this ticket)

`.env.sample:1277-1280` sets `HARNESS_JUDGE_MODEL=google/gemma-4-e4b-qat`, with a comment saying it
"read `google/gemma-4-e4b` until corrected". That "correction" repointed the judge at an id **no
backend serves** — so the harness eval judge is misconfigured wherever this sample was copied
(check the untracked local `.env.dev` too). Under R2 it becomes `gemma-4-e2b-it-qat`.

Related stale defaults carrying the unservable or wrong id, all to be converged onto
`gemma-4-e2b-it-qat`: `apps/text/src/text/core/config.py:54` (comment), `scripts/dev-service.sh:185`,
`packages/applications/src/services/harness-policy/__tests__/harness-policy.service.test.ts:207,214`,
`apps/harness/eval/README.md`, `docs/development-guide.md:128`.

### 2.5 What R2 does NOT need to change

The seed is **already** on the chosen model: `13-harness-policy.ts` seeds
`smrModel: 'gemma-4-e2b-it-qat'`, and `16-ai-task-default.ts` already binds `smr.live`,
`smr.finalize`, `smr.test` and `harness.judge` to `lms-gemma-4-e2b-it-qat`, whose `sourceUri` is
`gemma-4-e2b-it-qat` (`llm.ts:139-155`) — a served id. So R2's "make it the default" is largely
**already true in seed data**; the work is removing the wrong ids from env/config/docs/tests
(§2.3, §2.4) and purging Ollama, not repointing the catalog.

## 3. Explicit non-goals — do NOT purge these

1. **STT's Cadence punctuation backbone is Gemma-3 and must stay.**
   `apps/stt/pyproject.toml:81`, `apps/stt/src/stt/punctuation/service.py:91` and
   `tests/unit/test_huggingface_loader.py` (`Gemma3ForMultimodalLM`) reference Gemma-3 as a
   **transformers architecture compatibility path** (bidirectional vs causal masking), not as a
   catalog row or a configurable model. A blind `gemma3` sweep breaks STT punctuation.
2. **`docs/archive/**`** — 84 of the 282 hits. Archived tickets are a historical record; editing
   them rewrites history and is off-limits this sprint.
3. **Retired-ledger entries already listing ollama/qwen slugs** — they must remain in the ledger
   to keep sweeping existing tenant rows. Removing a slug from `retired.ts` un-retires it.

## 4. Implementation Plan

### Phase A — Catalog & seed (packages/database)

1. Delete live `ollama-*` rows from `seed/ai-models/llm.ts`; add every deleted slug to the
   `retired.ts` ledger. Same for any remaining `gemma3` / `llama3.2` / `qwen` rows.
2. Harness loop + task defaults: **no repointing needed.** `13-harness-policy.ts` already seeds
   `smrModel: 'gemma-4-e2b-it-qat'` and `16-ai-task-default.ts` already binds `smr.live`,
   `smr.finalize`, `smr.test` and `harness.judge` to `lms-gemma-4-e2b-it-qat`. Assert this with a
   test rather than editing it, so a future drift is caught.
3. Delete the false provenance comment at `llm.ts:20-21` and the stale "not loaded on the dev
   instance" note at `llm.ts:160-167` (§2.3). Replace with the verified 2026-08-16 catalog fact, or
   with nothing — a comment that asserts an unverifiable runtime fact is what caused this.
4. Tests: `seed/__tests__/ai-model-consolidation-seed.test.ts` and `config-plane-seed.test.ts`
   must assert no `provider: 'ollama'` row survives and that every removed slug is in the ledger.

### Phase B — `apps/text`

Remove `providers/ollama.py`, its registry registration, `TEXT_OLLAMA_*` config, and the ~20
test modules that exercise it (`test_ollama_provider.py`, `test_ollama_e2e.py`, and the ollama
arms of the cross-provider suites — do not delete a whole shared suite to remove one arm).
`TEXT_OLLAMA_DEFAULT_MODEL=llama3.2:latest` disappears with it.

### Phase C — `apps/guardrail`

Largely **already inside TASK-735 Phase 2**, which deletes `providers/ollama.py`, `OllamaConfig`
and the `_PROVIDER_TO_ATTR` dispatch map. This ticket only adds: the six
`GUARDRAIL_OLLAMA_*_MODEL=gemma3:latest` entries in `.env.sample`, and any ollama mention left in
`README.md` / `GUARDIAN_INTEGRATION.md` / `docker-compose.yml`.

### Phase D — `apps/harness` (safety-sensitive, read the risks first)

1. `_SAFETY_PROVIDERS = ("lm-studio", "ollama", "azure", "bedrock")` → drop `"ollama"`.
   **Breaking**: a deployment whose env sets an ollama provider now fails startup validation
   instead of running. That is the correct direction (fail fast, not silently), but it needs a
   release note and a check of `.env.dev` on every developer machine.
2. `PhiConfig.local_providers` default `["lm-studio", "openai_compat", "ollama", "vllm", "llama-cpp"]`
   → drop `"ollama"`. This list is an **allowlist of non-egress providers**; the guard is
   fail-closed, so removing an entry makes any lingering ollama-routed call get PHI-redacted rather
   than passed through. Safe direction — but the docstring's example
   `['lm-studio', 'ollama']` must be updated too, or it teaches the removed value.
3. `HARNESS_PHI_LOCAL_PROVIDERS` in `.env.sample` (line ~1426) carries the same list — update.
4. Judge/eval config: drop ollama branches from `eval/judge/providers.py`, `eval/config.py`;
   converge the judge default onto the canonical model id (§2.3).

### Phase E — gateway, console, infra, scripts

`apps/api` model-discovery (ollama discovery branch + its tests), `apps/admin-console`
`model-meta.ts` labels / discovery drawer / AI-models screen, `infrastructure/docker/*` compose
service if one exists, `scripts/dev-service.sh` (`LM_STUDIO_MODEL` default → canonical id).

### Phase F — config surface & docs

1. Remove every `*_OLLAMA_*` var from `turbo.json#globalEnv`, `.env.sample`,
   `apps/text/.env.sample`, `apps/guardrail/.env.sample`, `apps/text/.env.prod`, `.env.test`, and
   the local untracked `.env.dev`.
2. Update non-archive docs (21 files): `docs/operations/inference/README.md`,
   `docs/development-guide.md`, service READMEs, `apps/harness/eval/README.md`.
3. Regenerate samples with `pnpm env:sync` where that is the generator.

### Verification

- `rg -i ollama` over the repo excluding `docs/archive/**` returns **zero** hits.
- `rg -i "gemma3|llama3\.2|qwen"` returns only the three sanctioned STT Cadence hits from §3.1.
- `pnpm text:test`, `guardrail:test`, `harness:test`, `stt:test`, `pnpm --filter @arcaai/database test`,
  `pnpm test:unit` green — output pasted into §Implementation Summary.
- A fresh `pnpm db:all` produces a catalog with no ollama row, and the harness loop resolving to
  `gemma-4-e2b-it-qat`.
- **Every `sourceUri` on an ENABLED `lm-studio` catalog row appears in
  `GET http://localhost:1234/v1/models`.** This is the check that would have caught the §2.4 defect;
  make it a script, not a manual step.
- STT punctuation still loads its Gemma-3 backbone (the regression this ticket is most likely to cause).

## 5. Risks

| Risk | Mitigation |
|---|---|
| A blind `gemma3` sweep breaks STT punctuation | §3.1 non-goal, and an explicit STT test run in the gate |
| Tenant catalogs keep orphan `ollama-*` rows | Retired-ledger entries, not just seed deletions (§2.1) |
| `_SAFETY_PROVIDERS` change breaks running deployments | Release note; fail-fast is intended, but must be announced |
| Removing a `local_providers` entry changes PHI-redaction behaviour | Direction is fail-closed (more redaction, never less); assert it in a test |
| Model id drift means a default 404s at LM Studio — **already happened**, see §2.4 | Converge on `gemma-4-e2b-it-qat`; add the served-catalog assertion to the verification gate so a comment can never again be the authority on what an engine serves |
| Deleting shared cross-provider test suites to remove one arm | Remove the arm, keep the suite (§Phase B) |

## 6. Sequencing against TASK-735

TASK-735 lanes are in flight and own files this ticket touches. **Do not start the overlapping
phases until those lanes land**:

| This ticket | Blocked by | Reason |
|---|---|---|
| Phase C (guardrail) | TASK-735 Phase 2 | Deletes the same adapters; TASK-735 does most of it |
| Phase B (`apps/text`) | TASK-735 lane C (judge route) | Both edit `text` config/registry wiring |
| Phase A (seeds) | — | No overlap; **can start now** |
| Phase D (harness) | — | No overlap with TASK-735; **can start now** |
| Phases E/F (console, docs, env) | Phases A–D | Env/doc cleanup must reflect the final code state |

## 7. Open Questions (owner)

| # | Question | Recommendation |
|---|---|---|
**Resolved 2026-08-16:**

| # | Question | Owner answer |
|---|---|---|
| **Q1** | Which model, and does it apply beyond the agentic loop? | **`gemma-4-e2b-it-qat` (the smaller e2b), applied to everything** — agentic loop, `smr.live`, `smr.finalize`, `smr.test`, `harness.judge`. One model resident in LM Studio. A production model set is a later, separate discussion. |
| **Q2** | Keep or retire `lms-gemma-4-e2b-it-qat`? | Keep — it is the chosen default. |
| **Q3** | Which spelling does LM Studio actually serve? | Settled empirically against the live instance, not by choosing: `gemma-4-e2b-it-qat` is served, `google/gemma-4-e4b-qat` is not (§2.3). |

**Still open:**

| # | Question | Recommendation |
|---|---|---|
| **Q4** | ~~Is any deployment currently running an ollama provider?~~ | **Resolved 2026-08-16: no — there is no Ollama anywhere.** Phase D's fail-fast validator change ships with the rest; no coordinated release needed. |
| **Q5** | The dev LM Studio serves qwen, medgemma, bonsai and other models the HOPE catalog does not list. Should the catalog track the instance, or stay a curated subset? | Curated subset. The catalog is what HOPE *offers*; the instance is what happens to be *installed*. Q3's defect came from assuming the two agree — the new verification check asserts catalog ⊆ instance, deliberately not equality. |

## 8. Implementation Summary

**Phase D (`apps/harness`) — Completed 2026-08-16.** Phases A/B/C/E/F are owned by
concurrent agents (packages/database, apps/text, apps/guardrail) and are out of
this phase's scope; see their own tickets/sessions for status.

### Lists/validators changed, and the direction of the behaviour change

| File | Change | Direction |
|---|---|---|
| `apps/harness/src/harness/core/config.py` | `_SAFETY_PROVIDERS` drops `"ollama"` (`("lm-studio", "azure", "bedrock")`) | **Breaking, fail-fast (intended).** `HARNESS_SAFETY_PROVIDER=ollama` now raises `ValidationError` at startup instead of selecting an engine. |
| `apps/harness/src/harness/core/config.py` | `PhiConfig.local_providers` default drops `"ollama"` (`["lm-studio", "openai_compat", "vllm", "llama-cpp"]`); docstring example `['lm-studio', 'ollama']` → `['lm-studio', 'vllm']` | **More conservative (fail-closed guard).** An ollama-routed call is no longer in the local allowlist, so it now falls into the default-deny redact-and-confirm branch instead of the local pass-through — strictly more PHI protection, never less. |
| `apps/harness/src/harness/eval/config.py` | `JudgeProvider.OLLAMA` enum member removed; `JudgeConfig.model` default changed `"google/gemma-4-e4b"` → `"gemma-4-e2b-it-qat"` | Ollama selection now fails at `JudgeProvider("ollama")` / Pydantic validation (fail-fast). Judge default now resolves to the owner-standardized, LM-Studio-served id. |
| `apps/harness/src/harness/eval/judge/providers.py` | `_OLLAMA_STOP` stop-reason table removed, `"ollama"` dropped from `_STOP_TABLES`; `JudgeProvider.OLLAMA` dropped from `build_judge_client`'s accepted-provider tuple | Dead code removed; unreachable once the enum member is gone. |
| `apps/harness/src/harness/sensors/inferential/granite_client.py` | Removed the `if self._provider == "ollama"` branches (native `/api/chat` transport + response parsing) from `GraniteGuardianClient._classify`/`_extract_content` and `GraniteGroundednessJudge._screen`/`_content`; `_native_stats_fields` dropped its now-unused `provider` parameter | **Extension beyond the literal Phase D bullet list, required by consequence:** once `_SAFETY_PROVIDERS` rejects `"ollama"`, `SafetyGuardConfig.provider` can never be `"ollama"` again, so these branches were unreachable dead code (and their tests would otherwise fail to even construct a config). Removed for consistency with R1 ("removed, not deprecated"). |

### Judge model id

`JudgeConfig.model` default is now `gemma-4-e2b-it-qat` (owner-standardized 2026-08-16,
verified served by the live LM Studio dev instance). `apps/harness/.env.sample`
(`HARNESS_JUDGE_MODEL`), `apps/harness/eval/README.md` ("Run it" recipe + "Model
configuration" default description), and `apps/harness/scripts/task_330_phase3_cite_verify_check.py`
(converted from Ollama's native `/api/chat` to LM Studio's OpenAI-compatible
`/v1/chat/completions`, model `gemma3:latest` → `gemma-4-e2b-it-qat`) are all
converged onto this id. No harness code path resolves a model id the live LM
Studio does not serve as far as this phase's scope reaches — the `eval/README.md`
historical "Live gate results" run logs (§ dated 2026-06-07) are left with their
original `google/gemma-4-e4b` ids **on purpose**, since they are a verbatim record
of a specific past run — rewriting the model id there would misrepresent which
model produced those numbers. A correction note was added instead, and its
adjacent "Ollama remains a selectable engine via `HARNESS_SAFETY_PROVIDER=ollama`"
claim (now false) was corrected to state Ollama has been removed entirely.

### Tests

New/updated tests (all green, see `pnpm harness:test` output below):
`test_guardrail_config.py` (`test_ollama_provider_rejected`, `test_env_override_selects_azure_engine`
replacing the old ollama-selection test, `local_providers` membership flipped),
`test_judge_config.py` (`test_ollama_provider_no_longer_exists`,
`test_default_model_is_the_canonical_lm_studio_id`), `test_phi_redactor.py` /
`test_phi_egress.py` (`"ollama"` added to the "unknown provider defaults to
redact" parametrized/dedicated cases, asserting the fail-closed direction
explicitly), `test_granite_client.py` / `test_granite_groundedness_judge.py`
(ollama-transport tests removed as they tested now-unreachable code).
`test_replay_compat.py` (19 cases) still passes unchanged.

### `HARNESS_*` env vars to remove from `turbo.json#globalEnv` / root `.env.sample` (report only, not edited)

None. Every `HARNESS_*` var touched in this phase (`HARNESS_SAFETY_PROVIDER`,
`HARNESS_SAFETY_BASE_URL`, `HARNESS_PHI_LOCAL_PROVIDERS`, `HARNESS_JUDGE_MODEL`,
`HARNESS_JUDGE_PROVIDER`, `HARNESS_SMR_PROVIDER`) keeps its name and stays a
valid, still-meaningful setting — only the *set of accepted/default values*
changed, not the variable surface. Nothing needs to be removed from
`turbo.json#globalEnv` or the root `.env.sample` as a result of Phase D.

### Verification

```
pnpm harness:lint    -> All checks passed! (ruff)
pnpm harness:typecheck -> Success: no issues found in 108 source files (mypy)
pnpm harness:test    -> 4 failed, 1260 passed (apps/harness/src/harness/tests/)
```

The 4 failures (`test_otel_tracing_task636.py` x3, `test_qdrant_api_key.py` x1)
are **pre-existing, unrelated to this phase** — confirmed by reproducing them on
a clean pre-Phase-D tree. They stem from ambient host env vars (`NODE_ENV`/
`HARNESS_ENVIRONMENT`/a `QDRANT_API_KEY`-shaped var) leaking from this developer
machine's shell into `pydantic-settings`, not from any code or test this phase
touched.

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-16 | Ticket created from owner directive. Footprint measured (282 ollama files / 92 model-name files); STT Cadence Gemma-3 backbone identified as an explicit non-goal; retired-slug ledger identified as the correct removal mechanism; model-id naming drift documented. |
| 2026-08-16 | Q1–Q3 resolved: `gemma-4-e2b-it-qat` for all bindings. Model id verified against the LIVE LM Studio catalog, which **overturned** the ticket's own §2.3 analysis and the seed's provenance comment: `google/gemma-4-e4b-qat` is not served by the instance. Live defect recorded (§2.4 — `HARNESS_JUDGE_MODEL` points at an unservable id). Seed already carries the chosen model, so R2's catalog work collapses to assertions + comment deletion. |
| 2026-08-16 | **Phase D implemented** (`apps/harness`, this ticket's only phase with no TASK-735 dependency): `_SAFETY_PROVIDERS` and `PhiConfig.local_providers` drop `"ollama"` (fail-fast / more-conservative directions respectively); `JudgeProvider.OLLAMA` removed and the judge default converged on `gemma-4-e2b-it-qat`; dead ollama-transport branches removed from `GraniteGuardianClient`/`GraniteGroundednessJudge` (a required consequence of the `_SAFETY_PROVIDERS` change, not originally itemized); `.env.sample`, `README.md`, `eval/README.md`, and `scripts/task_330_phase3_cite_verify_check.py` swept. `pnpm harness:lint`/`:typecheck` clean; `pnpm harness:test` green modulo 4 pre-existing, unrelated env-leak failures. |
