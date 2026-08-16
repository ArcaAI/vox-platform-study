# TASK-713 — Make the Harness Clinical-Quality CI Gate Real

| | |
|---|---|
| **Status** | Blocked (Task 0 judge-backend decision is HUMAN-GATED and unmade; structural/harness work in this pass is done) |
| **Wave** | 1 · **Size** | M |
| **Epic slug** | `harness-eval-gate` |
| **Depends on** | — |
| **Design refs** | Not a D1–D8 fork directly, but a stated prerequisite for D1's staged-migration end-state: `docs/architecture/consultation-session-workflow/assessment/04-target-architecture.md` §"Wave 2 — Generator consolidation" lists `harness-eval-gate` as a `harness-sole-generator` prerequisite ("no working clinical-quality gate in CI" is named as the single biggest risk to migrating tenants onto the harness generator). |
| **Findings closed** | No `A-`/`F-` id — the audit names this as an infrastructure/CI gap in `03-compliance-posture.md` §"Executive summary" and `04-target-architecture.md` §"Executive summary" ("harness-eval-gate is allow_failure: true, failing closed for want of a judge backend — there is no working clinical-quality gate in CI"), not a numbered conformance finding. |

## 1. Requirement Analysis

The `harness-eval-gate` CI job exists, is well-built, and does not gate anything today for two independent reasons: (1) it is **entirely disabled** on ordinary pipelines (`rules: - if: $RUN_INFRA_TESTS != "true" \n when: never`), and (2) even when forced on, its first of two steps (`python -m harness.eval.ci`, a PDSQI-9/faithfulness/ICC judge-scored gate over an 18-case golden set) fails on a connection error because no LLM judge backend is reachable in the CI runner — and the job carries `allow_failure: true`, so that failure is silently swallowed. The second step (a promptfoo output-contract check against a deterministic offline mock provider) is hermetic and can pass today, but a two-step job where step 1 always fails and step 2 doesn't matter because the whole job is `allow_failure: true` provides **zero actual signal**.

This ticket makes the gate real: pick and provision a CI-reachable judge backend (HUMAN-GATED — see §6), wire it into the job, define the metric thresholds that make it blocking, and decide the hermetic-vs-non-hermetic staging so it doesn't break the rest of the harness suite's hermetic-CI discipline.

**Explicitly out of scope:**
- Building new eval metrics, judge prompts, or golden-set cases — `apps/harness/src/harness/eval/` already has a substantial, working eval framework (PDSQI judge, faithfulness/ICC/concept-F1 metrics, calibration/reliability tooling, a curated 18-case golden set). This ticket wires an existing, tested pipeline into CI with a real backend — it does not design new clinical-quality metrics.
- Migrating tenants to the harness generator, or any change to `pipeline.harnessEnabled` — this ticket is a CI-infrastructure prerequisite for that migration (TASK-732/Wave 4), not the migration itself.
- Expanding the golden set beyond `curated_v1.json`'s 18 cases — a separate, clinician-review-driven program per the job's own header comment (referenced there, not re-litigated here).

## 2. Current State Evaluation

Re-verified against the live tree on `feat/loop` (2026-08-16). No alternate job name exists (`eval-gate`, `clinical-quality-gate` were also searched — zero hits); `harness-eval-gate` is the only job.

**The job as it exists today**, `.gitlab/ci/test.yml:611-657`:

```yaml
harness-eval-gate:
  stage: test
  image: python:3.11-slim
  tags: [test]
  allow_failure: true
  needs:
    - job: lint-python
      optional: true
  variables:
    PIP_CACHE_DIR: "$CI_PROJECT_DIR/.pip-cache"
    PROMPTFOO_DISABLE_TELEMETRY: "1"
    PROMPTFOO_DISABLE_UPDATE: "1"
    PROMPTFOO_DISABLE_SHARING: "1"
  cache:
    - key: pip-harness-eval-gate
      paths: [.pip-cache/]
      policy: pull-push
      fallback_keys: [pip-harness, pip-$CI_DEFAULT_BRANCH]
  script:
    - pip install --quiet --retries 5 --timeout 120 packages/py-runtime-models
    - pip install --quiet --retries 5 --timeout 120 packages/py-env
    - cd apps/harness
    - pip install --quiet --retries 5 --timeout 120 ".[test,eval]"
    - python -m harness.eval.ci --golden-set src/harness/eval/golden/fixtures/curated_v1.json --output ../../eval-report.json
    - apt-get update -qq && apt-get install -y --no-install-recommends nodejs npm >/dev/null
    - cd eval/promptfoo
    - PROMPTFOO_PYTHON=python npx --yes promptfoo@0.121.15 eval -c promptfooconfig.yaml --no-cache --no-table
  artifacts:
    when: always
    paths: [eval-report.json]
    expire_in: 30 days
  rules:
    - if: $RUN_INFRA_TESTS != "true"
      when: never
    - if: $SKIP_TESTS == "true"
      when: never
    - if: $SKIP_TESTS_PY == "true"
      when: never
    - !reference [.rules-harness, rules]
```

The header comment block (`test.yml:588-609`) is explicit about both failure modes: step 1 needs `HARNESS_JUDGE_*` env (LM Studio/vLLM/Azure/Bedrock) which "none is wired into this runner yet, so this step currently fails closed (connection error) rather than producing a real PASS/FAIL verdict"; step 2 ("hermetic by default... CAN pass today") is the promptfoo output-contract check. `allow_failure: true` is called "deliberate... this gate only becomes hard-blocking once the clinician golden-set program delivers a real clinician-rated golden set AND a CI-reachable judge backend." **The `rules:` block additionally disables the job entirely** (`test.yml:649-652`) unless the pipeline sets `RUN_INFRA_TESTS=true` — so on an ordinary merge-request pipeline it does not run at all today, a stronger form of "not gating" than `allow_failure: true` alone.

**The eval framework already exists and is substantial** — this is not a from-scratch build:

```
apps/harness/eval/                                  # non-Python CI assets
  README.md, promptfoo/{README.md, assertions.py, prompt.py, promptfooconfig.yaml, provider.py, tests.py}

apps/harness/src/harness/eval/                       # harness.eval.* package
  ci.py, config.py, draft_eval.py, entity_code_population.py,
  entity_grounding_corpus.py, entity_grounding_parity.py,
  inferential_corpus_eval.py, inferential_judge_parity.py,
  jsonio.py, models.py, retrieval_eval.py
  judge/{base.py, pdsqi.py, prompts.py, providers.py}
  metrics/{concept_f1.py, deepeval_metrics.py, faithfulness.py, harm_weighted.py}
  calibration/{pairing.py, reliability.py}
  golden/{README.md, clinical_v1_spec.md, runner.py, sources.py,
    fixtures/{clinical_v1.schema.json, clinical_v1.template.json, concept_harm_v0.json,
              curated_v1.json, retrieval_synthetic_v0.json, synthetic_v0.json}}
```

`curated_v1.json` (the fixture the CI job points at) is 18 cases — 12 quality-lane + 6 calibration-lane, per `apps/harness/eval/README.md:19` and the job's own header comment (`test.yml:595-596`).

**The judge backend is already model-agnostic and configurable — the gap is CI provisioning, not application code.** `apps/harness/src/harness/eval/config.py:85-172`, class `JudgeConfig`, `env_prefix="HARNESS_JUDGE_"` (:91):

```python
class JudgeProvider(StrEnum):
    OPENAI_COMPAT = "openai_compat"  # LM Studio / any OpenAI-compatible server (default, priority)
    OLLAMA = "ollama"                # via its OpenAI-compatible /v1
    VLLM = "vllm"
    LLAMA_CPP = "llama-cpp"
    AZURE = "azure"
    BEDROCK = "bedrock"
```
`OpenAICompatJudgeConfig` (`env_prefix="HARNESS_JUDGE_OPENAI_COMPAT_"`, :47) defaults `base_url: str = "http://localhost:1234/v1"` (LM Studio, :49) — nothing listens on that port in a CI runner, which is the exact connection-error failure mode the job comment describes. `AzureJudgeConfig`/`BedrockJudgeConfig` (`env_prefix="HARNESS_JUDGE_AZURE_"`/`"HARNESS_JUDGE_BEDROCK_"`, :66/:80) are also available. `build_judge_client()` (`apps/harness/src/harness/eval/judge/providers.py:476-511`) dispatches on provider; azure/bedrock raise explicit `ValueError`s for missing config (:496,502,504,506,511), openai_compat has a non-empty default so it doesn't raise — it just can't connect. `apps/harness/eval/README.md:44-51` already documents the exact env recipe for a local LM Studio judge (`HARNESS_JUDGE_PROVIDER=openai_compat`, `HARNESS_JUDGE_MODEL=google/gemma-4-e4b`, `HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1`).

**Precedent for this exact config pattern elsewhere in the monorepo** (relevant to the judge-backend choice in §6): SMR (`apps/text/src/text/core/config.py`, `env_prefix="TEXT_"`) and guardrail (`apps/guardrail/src/guardrail/core/config.py`, `env_prefix="GUARDRAIL_"`, provider selector default `"lm-studio"` at :337, allowed set `{lm-studio, ollama, vllm, llama-cpp, azure, bedrock}` at :412) both already support the identical local-vs-cloud provider split, confirming `JudgeConfig`'s design deliberately mirrors an established platform pattern rather than inventing one.

**Release-gate thresholds already exist and are configurable**, `EvalConfig` (`config.py:201-233`, `env_prefix="HARNESS_EVAL_"`): `icc_threshold: float = 0.8`, `faithfulness_threshold: float = 0.85`, `pdsqi_accurate_threshold`/`pdsqi_thorough_threshold`/`pdsqi_mean_threshold: float = 4.0` (:220-224). `golden_set_version`/`golden_set_path` (:210-211) pin which fixture the gate scores against.

**`test-harness` (the ordinary hermetic suite) is a separate, already-blocking job** — `.gitlab/ci/test.yml:554` onward, `stage: test`, **no `allow_failure`**, runs `PYTHONPATH=src python -m pytest src/harness/tests/ -v --tb=short --junitxml=../../junit-harness.xml -x` (:575) against `.[test,eval,rag,guardrails]` extras (:574). Per `.claude/rules/06-python-services.md` §Pitfalls and confirmed in `.claude/rules/06-python-services.md:71`, this suite is deliberately hermetic (Temporal/LLM/reranker stubbed, Qdrant in-memory, no DB/Redis) — `harness-eval-gate` is intentionally a **separate** job precisely because a real judge call is not hermetic, and this ticket must not fold judge-scored eval into `test-harness` or it breaks that suite's hermeticity contract.

**DeepEval is already a pinned dependency**: `apps/harness/pyproject.toml:119`, `"deepeval>=4.1.8,<5"` inside the `eval` extras group (:114-123), wrapped by `apps/harness/src/harness/eval/metrics/deepeval_metrics.py`.

**Golden-set admin surface already exists** at the API layer (context for how a future clinician-rated golden set would be authored, not something this ticket builds): `packages/database/src/prisma/db_main/harness.prisma` — `model GoldenSet` (:43-80), `model GoldenCase` (:82-119, PHI fields as Vault-Transit ciphertext), `model EvalRun` (:121+); `apps/api/src/modules/harness-admin/harness-admin.controller.ts` exposes `GET/POST golden-sets[/:id[/cases|/run]]` (:216-330).

**Only one `retry:` exemplar exists in CI today**, `.gitlab/ci/templates.yml:113-128` (`.build-template`, stage build):
```yaml
retry:
  max: 1
  when: [runner_system_failure, stuck_or_timeout_failure, script_failure]
```
Its own justification (:119-122) is that image builds are idempotent/content-addressed, so retrying is safe. This is broader than a typical infra-only retry (it retries `script_failure` too) and is **not** a safe template to copy verbatim for a judge-scored quality gate — a genuinely-below-threshold note must never be retried into a pass; only judge-*backend* transport failures (timeout, connection reset) should retry.

## 3. Knowledge & Best Practices

- `.claude/rules/09-infrastructure-devops.md` §GitLab CI: stages are `install → validate → prepare → test → build → scan → publish → deploy → notify` (confirmed `.gitlab-ci.yml:106-115`); `harness-eval-gate` and `test-harness` both correctly sit in `test`.
- `.claude/rules/06-python-services.md` §Pitfalls: "The harness CI suite... is hermetic... Keep new harness tests hermetic or the job breaks; anything needing live infra belongs in local/e2e runs." This ticket's judge call is exactly "anything needing live infra" — it stays in its own non-hermetic job, never merged into `test-harness`.
- `.claude/rules/06-python-services.md` §Configuration: provider/model **selection** is fail-closed (an unresolved value raises, nothing substituted); tuning knobs fail open to a default. Apply the same split here: the *judge provider choice* must be an explicit, fail-closed CI variable (no silent fallback to the LM Studio default that produces the exact connection-error failure mode this ticket fixes) — but per-call tuning (temperature, batch size) can keep its defaults.
- `01-development-workflow.md` §TDD Requirements / Script Naming: any new root script must match the `<target>:<action>` taxonomy (e.g. `harness:eval` if a pnpm-level entry point is added) — note today there is **no** `harness:eval`/`harness:eval:gate` script; the gate is invoked directly via `python -m harness.eval.ci` inside the GitLab job, not through pnpm. Decide in Task 1 whether to add one for local reproducibility.
- Pitfall: `RUN_INFRA_TESTS != "true"` currently makes the job a no-op on ordinary pipelines — flipping `allow_failure` to `false` without also revisiting this `rules:` gate leaves the job just as silent as today, only with a misleading "blocking" label. Both must change together.
- Pitfall: the existing `retry: [..., script_failure]` template (`templates.yml:113-128`) is unsafe to copy verbatim for a quality gate — retrying a genuine below-threshold judge verdict as if it were a flake would defeat the gate's purpose. A flake policy here must distinguish "judge backend unreachable" (retry) from "judge scored the note below threshold" (never retry).

## 4. Implementation Plan

### Task 0 — Judge backend selection (HUMAN-GATED)
- **Agent:** T4 · opus-4-8 · medium
- **Files:** none (decision document — append to §7 before Task 1)
- **Approach:** Lay out the concrete options and costs for a person to decide:
  1. **Local judge in a CI service container** — spin up LM Studio (or a lighter OpenAI-compatible server, e.g. llama.cpp server) as a `services:` container in the `harness-eval-gate` job, serving `google/gemma-4-e4b` (`JudgeConfig`'s own default, :95) or a comparably small model, pointed at via `HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL=http://<service-alias>:1234/v1`. Cost: no per-call API spend, but CI runner needs enough RAM/CPU (or GPU) to host even a small model and cold-start latency adds to every pipeline run; `JudgeConfig.timeout_s` defaults to 300s per call (`config.py:106`) specifically because local reasoning judges are slow — with 18 golden-set cases this could add real minutes to every gated pipeline.
  2. **Cloud judge via Azure OpenAI or Bedrock** — `HARNESS_JUDGE_PROVIDER=azure` or `bedrock`, credentials from CI secrets/Vault. Cost: real per-call API spend on every pipeline run touching harness code (rate-limited by `.rules-harness`'s path filter, `.gitlab/ci/rules.yml:227-232`, so not every pipeline), but fast and does not burden the CI runner's compute budget.
  3. **Scheduled/nightly-only judge run, not per-MR** — keep the per-MR gate on the hermetic promptfoo step only, and run the judge-scored PDSQI/faithfulness/ICC gate on a separate scheduled pipeline (nightly or per-merge-to-`dev`) so judge cost/latency doesn't sit on every MR. Cost: weaker per-change signal (a regression could land and only be caught the next day), but far cheaper and simpler to provision.
  Recommend a decision and record it, but the actual choice (which model/provider CI may call, and per-MR vs. scheduled) is a cost/risk tradeoff for a human, not an engineering-only call — do not silently pick one and proceed.
- **Verify:** Decision recorded in §7 with the chosen option, before Task 1 begins.

### Task 1 — Failing test: gate produces a real verdict on a golden set
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/harness/src/harness/tests/unit/eval/test_ci_gate_wiring.py` (new, or extend the existing `unit/eval/` suite)
- **Approach:** Using Task 0's chosen backend (mocked/stubbed for this unit-level test — the CI-level wiring is proven in Task 3's real pipeline run, not here), assert `harness.eval.ci`'s entrypoint returns a genuine PASS when scores clear `EvalConfig`'s thresholds and a genuine FAIL when they don't, using a deliberately degraded note fixture (e.g. a hallucinated claim not present in the transcript) alongside the existing `curated_v1.json` cases.
- **Verify:** `pnpm harness:test -- unit/eval/test_ci_gate_wiring` — fails red until Task 2/3 wire a reachable backend.

### Task 2 — Provision the judge backend in CI
- **Agent:** T3 · sonnet-5 · medium
- **Files:** `.gitlab/ci/test.yml` (the `harness-eval-gate` job), possibly `.gitlab/ci/templates.yml` if a reusable judge-service block is warranted
- **Approach:** Wire Task 0's chosen backend into the job — either add a `services:` container block (local option) or add the `HARNESS_JUDGE_AZURE_*`/`HARNESS_JUDGE_BEDROCK_*` CI/CD variables sourced from the existing Vault-backed secrets pipeline (cloud option), following the pattern other jobs use for provider credentials. Remove the `RUN_INFRA_TESTS != "true"` `when: never` rule (or narrow it to a genuinely-optional local-dev escape hatch, not the default-off gate it is today) so the job runs on ordinary pipelines per `.rules-harness` path filtering.
- **Verify:** A pipeline run (or `gh`/GitLab CI dry-run equivalent) shows `harness-eval-gate` actually reaching the judge backend and producing `eval-report.json` with real (non-connection-error) scores.

### Task 3 — Flip to blocking with defined thresholds
- **Agent:** T2 · sonnet-5 · low
- **Files:** `.gitlab/ci/test.yml`
- **Approach:** Remove `allow_failure: true` from `harness-eval-gate`. Confirm `EvalConfig`'s existing thresholds (`icc_threshold=0.8`, `faithfulness_threshold=0.85`, `pdsqi_*_threshold=4.0`) are the intended release-gate bar — if Task 0's decision changed the golden-set scope or judge model, these may need recalibration (a different judge model can shift score distributions); do not assume the existing thresholds transfer unchanged to a new judge backend without at least one comparison run against the old configuration.
- **Verify:** A deliberately degraded note (Task 1's fixture) makes the job fail the pipeline; a passing note lets the pipeline proceed. `pnpm harness:test` (full hermetic suite) still green — confirms this change didn't leak a live-backend dependency into the hermetic suite.

### Task 4 — Flake policy
- **Agent:** T2 · sonnet-5 · low
- **Files:** `.gitlab/ci/test.yml`
- **Approach:** Add a narrow `retry:` block distinguishing transport failures from quality failures — the job script itself (not GitLab's job-level `retry:`) should catch judge-backend connection/timeout errors and retry the judge call a bounded number of times (`JudgeConfig.transient_retries`/`transient_retry_backoff_s`, already present at `config.py:116-117`, defaults `3`/`12.0s` — confirm these are actually threaded through `harness.eval.ci`'s call path, not just defined and unused), while a genuine below-threshold verdict must **never** retry — it is real signal, not a flake. If GitLab-level `retry:` is used at all, scope it to `runner_system_failure`/`stuck_or_timeout_failure` only (per `templates.yml:123-126`'s narrower half), explicitly excluding `script_failure` unlike the build-template exemplar, since a `script_failure` here can legitimately mean "the note failed quality review."
- **Verify:** A forced judge-backend connection error (mocked) triggers the app-level retry and eventually surfaces as a distinguishable CI failure (not silently green, not silently retried into a pass); a forced low-score verdict fails immediately with no retry.

### Task 5 — Wire to the layer-gate table
- **Agent:** T1 · haiku-4-5 · default
- **Files:** `.claude/rules/01-development-workflow.md` (§Layer Dependency Chain, Python row) — propose the addition, do not edit the rule file directly without confirming with a maintainer per the ticket's own scope (rule files are project-wide config)
- **Approach:** Draft the exact row addition connecting `harness-eval-gate` to the existing `| Python | apps/{stt,smr,guardrail,nlp,harness} | — | pnpm <svc>:test (e.g. ...) |` table row, or a new row naming `harness-eval-gate` explicitly as a build/quality gate distinct from `harness:test`. Present the diff for review rather than committing it as part of this ticket's execution, since editing `.claude/rules/*.md` is a repo-wide behavioral change outside this ticket's package boundary.
- **Verify:** Diff reviewed and applied by a maintainer (or explicitly deferred) before this ticket is marked Complete.

## 5. Acceptance Criteria

- [ ] Task 0's judge-backend decision recorded and approved (HUMAN-GATED) before implementation proceeds
- [ ] `harness-eval-gate` runs on ordinary pipelines (not gated behind `RUN_INFRA_TESTS=true`)
- [ ] `harness-eval-gate` reaches a real judge backend and produces genuine PASS/FAIL verdicts (not a connection error)
- [ ] `harness-eval-gate` has `allow_failure` removed (or narrowed to an explicit, reviewed exception) and blocks the pipeline on a below-threshold note
- [ ] A deliberately degraded golden-set case fails the job; the existing `curated_v1.json` cases pass it
- [ ] `pnpm harness:test` (the hermetic suite) remains green and unaffected — confirms no live-backend dependency leaked into hermetic tests
- [ ] Flake policy distinguishes judge-backend transport failures (bounded retry) from genuine below-threshold verdicts (never retried)
- [ ] `pnpm harness:lint`, `pnpm harness:typecheck` clean
- [ ] Paste actual CI job output (or a local reproduction via `python -m harness.eval.ci` against the chosen backend) before marking Complete

## 6. Risks & Open Questions

- **HUMAN-GATED (Task 0):** which judge backend CI is authorized to call — a self-hosted local model in a CI service container, or a cloud provider with real per-call spend — is a cost and infrastructure-ownership decision, not something this ticket should decide unilaterally. Options and costs are laid out in Task 0; a person must approve one.
- If a cloud judge backend is chosen, credential provisioning depends on the CI secrets pipeline (Vault AppRole per `09-infrastructure-devops.md` §Environment & Secrets Strategy) reaching this specific job — that wiring is not yet confirmed to exist for `apps/harness` eval specifically and may itself be nontrivial.
- If a local judge is chosen, CI runner resource sizing (RAM/CPU/GPU availability, cold-start latency against `JudgeConfig.timeout_s=300`) is unverified — 18 cases × up to 300s/call in the worst case is a meaningful per-pipeline time budget that needs measuring, not assuming.
- Recalibrating `EvalConfig`'s thresholds for whichever judge model is actually deployed (Task 3) may require at least one comparison run against a reference judge to avoid either a too-loose gate (false confidence) or a too-strict one (blocking legitimate changes) — this is empirical work that can't be fully scoped in advance.
- This ticket does not expand the golden set beyond `curated_v1.json`'s 18 cases; per the job's own header comment, a larger clinician-rated golden-set program is a separate, longer-running effort this ticket does not attempt to shortcut.

## 7. Implementation Summary

**Scope of this pass, per explicit execution instruction:** Task 0 (judge-backend
selection) is HUMAN-GATED and was NOT decided in this session. Task 2 (provision a
specific backend in CI) and Task 3 (flip `allow_failure`/`RUN_INFRA_TESTS` to make the
job actually blocking) both require Task 0's decision first — a live backend cannot be
wired without knowing which one — so neither was touched. No cloud spend was wired and
no backend was picked. This pass built/verified the structural pieces so that once a
human picks a backend, wiring it in is a **config change** (env vars / CI variables),
not an application rewrite:

- **Task 1 (TDD, RED→GREEN)** — added
  `apps/harness/src/harness/tests/unit/eval/test_ci_gate_wiring.py`, four tests proving
  `harness.eval.ci.main()` produces a genuine PASS/FAIL verdict against the *actual*
  CI-pinned golden set (`eval/golden/fixtures/curated_v1.json`, 18 cases: 12
  quality-lane + 6 calibration-lane), with a stub judge injected (hermetic, no
  network — the live-backend call stays out of this suite per
  `06-python-services.md` §Pitfalls):
  - fixture sanity check (18 cases, expected case id present) — confirms this test
    stays pinned to the same fixture the CI job's `--golden-set` argument points at.
  - all-cases-pass → `main()` exits 0, `passed: true`, no failures.
  - one case deliberately degraded (`accurate` scored 1, simulating a hallucinated/
    ungrounded note) → `main()` exits 1, `pdsqi_accurate` named in `failures`.
  - `JSONFileGoldenSetSource` round-trips the fixture's documented 12/6 quality/
    calibration lane split.
  - RED confirmed first: with a naive uniform-score stub judge, 2 of 4 tests failed —
    not because the wiring was broken, but because the fixture's 6 calibration-lane
    cases carry real `clinician_pdsqi` reference labels the judge<->clinician ICC gate
    compares against, and a uniform stub disagreed with those labels (ICC 0.18 < 0.8).
    Fixed by building the stub's calibration-lane responses from each case's own
    `clinician_pdsqi` label (perfect judge<->clinician agreement on that lane), leaving
    only the quality-lane PDSQI thresholds as the thing genuinely under test — GREEN
    after that. A second RED iteration surfaced a `MappingJudgeClient` substring
    collision (a case's 28-char note-prefix key matched another case's *transcript*
    text, not its own note) — fixed by keying on the full `generated_note` text
    instead of a short prefix.
  - Existing coverage (`test_ci_gate.py::TestApplyGate`/`TestRunAndGate`/`TestMainCLI`,
    `test_judge_transport.py`) already proved `apply_gate`/`run_and_gate`/`main` are
    pure/correct in the abstract and that the app-level transient-retry split (Task 4's
    "transport failure vs genuine low score never retries") is threaded through
    `harness.eval.judge.providers` and unit-tested — re-verified, not re-built.
- **Task 4 (flake policy)** — added a narrow GitLab-level `retry:` block to the
  `harness-eval-gate` job in `.gitlab/ci/test.yml`
  (`max: 2`, `when: [runner_system_failure, stuck_or_timeout_failure]`), deliberately
  narrower than the only prior exemplar (`.build-template`, `templates.yml:113-128`,
  which also retries `script_failure`). `script_failure` is excluded here on purpose —
  a below-threshold judge verdict, or a judge backend that never recovers
  (`harness.eval.judge.base.JudgeConnectionError`, raised once
  `JudgeConfig.transient_retries` is exhausted at the app level), both surface as
  `script_failure` and must never be silently retried into a pass. The app-level
  transient-retry/backoff split (the actual "is this a flake" decision) already
  existed and is already tested (`test_judge_transport.py::test_transient_terminated_is_retried_then_succeeds`,
  `::test_transient_failure_aborts_after_retries_exhausted`,
  `::test_non_transient_error_is_not_retried`) — this GitLab-level addition only
  covers the outer "the runner itself died" case, which the app-level retry cannot see.
- **Task 0 (decision options)** — not re-litigated here; the three options and their
  costs are already laid out in §4 Task 0 of this README as authored. No option was
  selected.
- **Task 2 / Task 3** — deliberately NOT done in this pass (gated on Task 0). The job
  in `.gitlab/ci/test.yml` is unchanged apart from the Task 4 `retry:` block: it still
  carries `allow_failure: true` and the `RUN_INFRA_TESTS != "true"` `when: never` rule,
  and step 1 (`python -m harness.eval.ci` against a live judge) will still fail closed
  with a connection error in an actual CI runner, exactly as described in §2 Current
  State Evaluation — this pass did not change that behavior.
- **Task 5 (layer-gate table)** — proposed, not applied (per the plan's own
  instruction not to edit `.claude/rules/*.md` as part of this ticket without
  maintainer confirmation). Proposed row for `01-development-workflow.md`
  §Layer Dependency Chain, Python row:

  ```markdown
  | Harness eval gate | `apps/harness` | `python -m harness.eval.ci` (`.gitlab/ci/test.yml:harness-eval-gate`) | Hermetic wiring: `pnpm harness:test -- unit/eval`; live-backend run needs `HARNESS_JUDGE_*` (gated — see TASK-713) |
  ```

**Verification actually run (local, no live infra):**

```
$ PYTHONPATH=src ~/miniconda3/envs/arcaenv/bin/python -m pytest \
    src/harness/tests/unit/eval/test_ci_gate_wiring.py -v --no-cov
... 4 passed in 0.32s

$ PYTHONPATH=src ~/miniconda3/envs/arcaenv/bin/python -m pytest \
    src/harness/tests/unit/eval/ -q --no-cov
198 passed in 11.87s

$ ~/miniconda3/envs/arcaenv/bin/ruff check apps/harness/src/
All checks passed!

$ ~/miniconda3/envs/arcaenv/bin/mypy --config-file apps/harness/pyproject.toml apps/harness/src/
Success: no issues found in 100 source files

$ PYTHONPATH=src ~/miniconda3/envs/arcaenv/bin/python -m pytest src/harness/tests/ -q --no-cov
6 failed, 1199 passed in 79.49s
```

The full-suite run above has 6 pre-existing failures
(`test_otel_tracing_task636.py` x3, `test_loop_config.py` x2, `test_qdrant_api_key.py`
x1) — all env-default assertions that fail locally because this machine's
`.env.dev`/`.env.test` sets values (`HARNESS_RETRIEVAL_QDRANT_API_KEY=`,
`HARNESS_SMR_BASE_URL=...`, etc.) the tests assert should be *unset*. Confirmed
unrelated to this ticket: `git status` shows only `.gitlab/ci/test.yml` and the new
`test_ci_gate_wiring.py` touched by this session; none of the 6 failing test files
were touched; reproduced identically under both `NODE_ENV=test` and the default env.
Reported here rather than silently omitted, per the honesty requirement — these are a
pre-existing local-environment condition, not a regression from this ticket's changes.

**`.gitlab/ci/test.yml` was NOT validated against a real GitLab pipeline** (no CI
access from this session) — only local YAML-parse validation (`python3 -c
"yaml.load(..., Loader=<custom loader stubbing !reference>)"`, confirmed the
`harness-eval-gate.retry` block parses as `{max: 2, when: [runner_system_failure,
stuck_or_timeout_failure]}`) and a read-through of the diff. GATED: a pipeline dry-run
proving the retry block behaves as intended requires the real CI runner.

**Remaining work, blocked on Decision #5 (Task 0):**
- Pick the judge backend (local CI service container vs. cloud Azure/Bedrock vs.
  scheduled-only) — human decision, not made here.
- Task 2: wire the chosen backend into `harness-eval-gate` (services: block or
  `HARNESS_JUDGE_AZURE_*`/`HARNESS_JUDGE_BEDROCK_*` CI variables) and remove/narrow the
  `RUN_INFRA_TESTS` gate.
- Task 3: remove `allow_failure: true`, confirm/recalibrate `EvalConfig` thresholds
  against the chosen judge model, prove a degraded note actually fails a real pipeline.
- Task 5: a maintainer applies (or explicitly declines) the proposed layer-gate table row.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (ticket-authoring session) |
| 2026-08-16 | Task 1 (TDD): added `test_ci_gate_wiring.py` proving `harness.eval.ci` gate wiring against the real `curated_v1.json` CI-pinned golden set (RED confirmed via a naive stub, then GREEN). Task 4: added a narrow GitLab `retry:` block (`runner_system_failure`/`stuck_or_timeout_failure` only, no `script_failure`) to `harness-eval-gate` in `.gitlab/ci/test.yml`. Task 0/2/3 explicitly left undone — HUMAN-GATED judge-backend decision not made, no backend picked, no cloud spend wired, per this session's execution instruction. Status set to Blocked pending Decision #5. | Claude (execution session) |
