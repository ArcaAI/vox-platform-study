# Harness Eval (TASK-330, Phase 0)

Self-contained clinical-documentation **evaluation harness**: a PDSQI-9
LLM-as-judge, RAGAS-style faithfulness, DeepEval metric wrappers, a pluggable
golden-set runner, and a judge-calibration gate (ICC / Gwet AC2). It emits scores
to JSON/stdout and never writes to Postgres or imports `packages/*` — DB
persistence of eval runs is a later phase via `apps/api`.

## Layout

| Path                                                              | What                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `../src/harness/eval/`                                            | The Python package (`harness.eval.*`)                                                                |
| `../src/harness/eval/judge/`                                      | PDSQI-9 judge: vendored Epic prompts, parsing, model-agnostic providers                              |
| `../src/harness/eval/metrics/`                                    | RAGAS-style faithfulness + DeepEval metric wrappers                                                  |
| `../src/harness/eval/calibration/`                                | ICC(2,1) + Gwet AC2 + the `ICC >= 0.8` release gate                                                  |
| `../src/harness/eval/golden/`                                     | Golden-set runner + pluggable sources + fixtures                                                     |
| `../src/harness/eval/golden/fixtures/synthetic_v0.json`           | 5-case synthetic wiring fixture (pinned default)                                                     |
| `../src/harness/eval/golden/fixtures/curated_v1.json`             | 18-case **curated** set: 12 quality-lane + 6 calibration-lane                                        |
| `../src/harness/eval/ci.py`                                       | Release-gate runner + JSON report (CI entrypoint)                                                    |
| `../src/harness/eval/retrieval_eval.py`                           | **Phase-3** institutional-RAG retrieval eval (recall / MRR / citation-validity / cross-tenant leaks) |
| `../src/harness/eval/golden/fixtures/retrieval_synthetic_v0.json` | Phase-3 synthetic retrieval fixture (9-chunk / 2-tenant corpus, 5 queries)                           |
| `./promptfoo/`                                                    | promptfoo output-contract gate (run via `npx`)                                                       |

> The Python package lives under `src/harness/eval/` (not here) so it imports as
> `harness.eval.*` with the existing `src/` packaging. This folder holds the
> non-Python eval assets (promptfoo) plus this overview.

## Run it

```bash
# Unit + calibration suite (offline, deterministic) — includes the ICC>=0.8 gate
conda run -n arcaenv pytest apps/harness/src/harness/tests/unit/eval -v

# DeepEval wrappers also run when the eval extra is installed:
conda run -n arcaenv pip install -e 'apps/harness[test,eval]'

# Release-gate over the pinned golden set (writes eval-report.json).
# Requires a configured judge endpoint (see "Model configuration").
conda run -n arcaenv python -m harness.eval.ci --output eval-report.json

# Release-gate over the larger CURATED set with the calibration levers enabled
# (anchored rubric prompt + deterministic seed), judge = local LM Studio gemma-4-e2b-it-qat:
HARNESS_JUDGE_PROVIDER=openai_compat \
HARNESS_JUDGE_MODEL=gemma-4-e2b-it-qat \
HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1 \
HARNESS_JUDGE_OPENAI_COMPAT_API_KEY=lm-studio \
HARNESS_JUDGE_TEMPERATURE=0.0 HARNESS_JUDGE_SEED=7 HARNESS_JUDGE_ANCHORED=true \
conda run -n arcaenv python -m harness.eval.ci \
  --golden-set apps/harness/src/harness/eval/golden/fixtures/curated_v1.json \
  --output eval-report.json
```

## The golden set the gate runs: `curated-v2.0.0`

Full design spec: `src/harness/eval/golden/curated_v2_spec.md`. Summary:

| | |
|---|---|
| Size | 12 synthetic source consultations → **36 cases** (12 `quality` + 24 `calibration`) → **288 paired ratings** (v1: 18 / 144) |
| Gradient | 5 designed levels, each with a named anchor exemplar: **L5** gold · **L4** presentation-only · **L3** one wrong-context misalignment or one pertinent omission · **L2** one major seeded error · **L1** multiple major errors + structural collapse |
| Seeded taxonomy | one class per L2–L4 variant so a failure is attributable: `omission_material` (7) · `fabrication` (6) · `dose_error` (4) · `temporal_error` (4) · `laterality_error` (3) · `misattribution` (3) · `false_negation` (3) · plus `verbosity`, `uncited_assertion`, `under_synthesis`, `omission_potentially_pertinent` |
| Stratification | 12 specialties · length short 12 / medium 15 / long 9 · complexity low 12 / moderate 15 / high 9 |
| Split | `dev` 24 / `holdout` 12, stratified — so a threshold or labelling rule can never be tuned on the cases used to validate it |
| Provenance | **AI-authored, rubric-literal, `clinician_review_status: pending`.** Never presented as a clinician rating. |
| PHI | PHI-free **by construction** — no names/dates/addresses, generic subjects, obviously-synthetic `SYN-####` record tags. Locked by a regex test. |
| Review | `golden/review/curated_v2_review.md` (generated) → `curated_v2_amendments.json` → `apply_amendments.py` → ships **`curated-v2.1.0`**, never an in-place edit |

**Why it was rebuilt.** v1's `quality` lane was 12 good notes, so a judge that answers
"good" to every good note looks correct — judge SD was exactly `0.000` and that lane
contributed nothing to a variance-ratio statistic. v2 designs the spread in: reference SD
is **1.313** across 288 ratings, and every score point 1–5 is exercised.

`curated_v1.json` is retained **unmutated** so the 2026-06-07 and 2026-08-17 runs stay
interpretable against the exact set they scored.

### What was deliberately NOT done

`curated_v2` is **not** the clinician-authored `clinical_v1` set and does not replace it.
Multi-rater labelling with adjudication and a human-ICC precondition (`clinical_v1_spec.md`:
N ≥ 132, ≥ 3 blinded raters/case, ICC_human ≥ 0.75) cannot be AI-generated — its content
*is* inter-human disagreement. v2 is the best set obtainable without a clinician panel, and
is explicitly the **input** to one. See `curated_v2_spec.md` §10 for the full applied/skipped
table.

## Golden-set lanes — quality vs calibration

A `GoldenCase.role` field separates two genuinely different eval purposes so the
release gate is well-posed (you cannot simultaneously require a high pooled PDSQI
mean **and** include deliberately-bad discriminator notes in that same pool):

| `role`              | `generated_note` is…                                             | Feeds                                                                                    |
| ------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `quality` (default) | a high-quality reference exemplar (good production output)       | PDSQI quality aggregates (accurate / thorough / mean) **and** faithfulness               |
| `calibration`       | a range-spanning / adversarial note (may have a deliberate flaw) | judge↔reference agreement (**ICC / Gwet AC2**) **only** — excluded from the quality mean |

Every case is still scored by the judge and appears in the per-case report;
`role` only controls which cases feed which _aggregate_. Faithfulness is a
quality-lane metric, so it is not run on calibration cases. This mirrors how a
real gate works: "are my representative notes good?" (quality lane) is a separate
question from "can I trust the automated judge?" (calibration lane).

## Judge calibration levers (Lever 2)

All opt-in via `HARNESS_JUDGE_*` env; defaults preserve the prior single-pass
behaviour, so CI prompts stay pristine.

| Env                              | Default | Effect                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HARNESS_JUDGE_ANCHORED`         | `false` | Append rubric-faithful per-score guidance + 2 balanced exemplars to the prompt (the verbatim Epic rubric is unchanged). Reduces a small judge's two main biases: over-penalising a single omission, and letting an inaccurate assertion bleed into unrelated dimensions.                                                            |
| `HARNESS_JUDGE_SEED`             | `none`  | Base decoding seed. For a single pass (K=1) it is the deterministic seed. For self-consistency (K>1) sample _i_ uses `seed + i`, so the K samples are **distinct but reproducible** — a single fixed seed would make every sample identical and silently defeat self-consistency. `none` lets each sample draw a fresh random seed. |
| `HARNESS_JUDGE_SELF_CONSISTENCY` | `1`     | Sample the judge K times and take the per-dimension **median** (variance reduction). `1` = single deterministic pass. Note: median reduces _variance_, not _bias_ — a judge that systematically under-rates a dimension will not be corrected by larger K.                                                                          |
| `HARNESS_JUDGE_SC_TEMPERATURE`   | `0.2`   | Decoding temperature for the K>1 diversity samples (needs > 0 to produce diverse samples; kept low so samples stay near the greedy mode).                                                                                                                                                                                           |

## Model configuration (judge is model-agnostic)

Selected entirely via env (`HARNESS_JUDGE_*`); nothing is hardcoded.

| Provider                                             | `HARNESS_JUDGE_PROVIDER` | Key env                                                                                         |
| ---------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| LM Studio / vLLM / OpenAI-compatible (default, ≤20B) | `openai_compat`          | `HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL`, `HARNESS_JUDGE_MODEL`                                   |
| Azure OpenAI (large)                                 | `azure`                  | `HARNESS_JUDGE_AZURE_ENDPOINT`, `HARNESS_JUDGE_AZURE_API_KEY`, `HARNESS_JUDGE_AZURE_DEPLOYMENT` |
| AWS Bedrock (large)                                  | `bedrock`                | `HARNESS_JUDGE_MODEL` (model id), `HARNESS_JUDGE_BEDROCK_REGION`                                |

The **default judge model** is `gemma-4-e2b-it-qat` — the owner-standardized single
model resident in LM Studio (a small ≤20B Gemma-4 hybrid-reasoning model, verified
served by the live dev instance 2026-08-16) — served by a local **LM Studio** endpoint
on `http://localhost:1234/v1`. Override per env: `HARNESS_JUDGE_MODEL` (model id) and
`HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL` (endpoint).

### Reasoning-control levers (cross-family robustness)

Reasoning families spend hundreds–thousands of "thinking" tokens before they emit the
score JSON; these knobs keep a single judge robust across reasoning **and** non-reasoning
families.

> **TASK-968 — the two REASONING levers are no longer environment variables.**
> `HARNESS_JUDGE_REASONING_MODE`, `HARNESS_JUDGE_SUPPRESS_REASONING` and
> `HARNESS_JUDGE_EXTRA_BODY` were **removed** (2026-09-13). They are platform settings a
> platform admin writes without a redeploy, and both default to reasoning **off**:
>
> | Setting | Lever | Default | Reaches |
> |---|---|---|---|
> | `harness.judge.reasoningMode` | prompt — `auto` \| `think` \| `none` | `none` | the PDSQI-9 rubric judge (this gate, `/eval/run`) |
> | `harness.judge.reasoningEffort` | wire — `extra_body.reasoning_effort` | `minimal` | **every** judge call, the live groundedness / citation-verify sensors included |
>
> `suppress_reasoning` collapsed into `reasoningMode: 'none'` — `resolve_prompt` always read
> the two as one state. The wire lever is the one that was NOT eval-only: it is applied inside
> `JudgeClient.complete()`, so it rode every real consultation's assurance pass.
>
> **The CI gate runs on the in-code floor** (`none` / `minimal`), not on the control plane: no
> gateway is reachable from a GitLab job, and a gate wants one fixed, reproducible posture. The
> deployed judge follows the registry. See
> `docs/implementation/TASK-968-Reasoning-Off-For-Text-Generation/README.md`.

The remaining knobs below are still `HARNESS_JUDGE_*` env; defaults are safe everywhere.

| Env                                                | Default            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HARNESS_JUDGE_OUTPUT_MODE`                        | `with_explanation` | `score` = compact score-only JSON; `with_explanation` = per-dimension rationale. `score` is markedly more reliable for ≤~7B judges (a long prose preamble can exhaust the token/context budget before any JSON appears).                                                                                                                                                                                                             |
| `HARNESS_JUDGE_MAX_TOKENS`                         | `8192`             | Completion budget. Large on purpose for reasoning models — BUT must stay **≤ the judge's loaded context window**. A value larger than the loaded context (e.g. 8192 against a model loaded at 4096 ctx) makes LM Studio reject/terminate the request (`400 {'error':'terminated'}`). For gemma-4-e4b @ 4096 ctx use `3072`.                                                                                                          |
| `HARNESS_JUDGE_TRANSIENT_RETRIES` / `_BACKOFF_S`   | `3` / `12.0`       | Bounded app-level retry (linear backoff) for **transient** backend failures — a local model engine terminated/unloaded under sustained load (`'terminated'`), a dropped connection, a momentary 5xx. Lets a long run survive a mid-run crash (the server JIT-reloads on the next call). A genuinely-down backend still aborts once retries are exhausted — never a silent green gate.                                                |
| `HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT` | `json_object`      | `response_format.type` sent on json_mode calls (faithfulness claim-extract/verify). LM Studio rejects `json_object` (HTTP 400) and small models choke under a strict `json_schema` grammar, so set **`text`** for LM Studio — the prompt asks for JSON and parsing is tolerant.                                                                                                                                                      |

**Per-family reasoning serialization** (what the judge must survive):

| Family                           | How it reasons                                                     | What the server exposes                       |
| -------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Qwen3.5                          | `<think>…</think>` before the answer                               | split into a `reasoning_content` field        |
| gpt-oss                          | harmony analysis / final channels                                  | a separate `reasoning` field                  |
| Gemma 4 / some MedGemma builds   | a thought block (e.g. `<unused94>thought`) or markdown-fenced JSON | `reasoning_content`, or leaked into `content` |
| Gemma 3 / Gemma-3-based MedGemma | non-reasoning                                                      | plain JSON in `content`                       |

The judge reads the server-split `reasoning_content` / `reasoning` field when `content` is
blank; otherwise it **strips** these forms (`<think>` blocks, harmony analysis/commentary
channels, Gemma `<unused94>thought` / `<|think|>` markers, markdown fences) and extracts the
**final** balanced JSON object — so a stray `{` inside leaked chain-of-thought never wins over
the real score object.

## Run the release gate locally (the supported path)

**OWNER DECISION (2026-08-17, `docs/implementation/TASK-713-Harness-Eval-Gate/README.md`
§7): the eval gate is a LOCAL / scheduled quality check, not a per-MR blocking CI job.**
LM Studio has no CI-runnable container image, and standing up a dedicated self-hosted
runner just to host a desktop app was explicitly declined. So `harness-eval-gate` in
`.gitlab/ci/test.yml` stays behind an explicit `RUN_INFRA_TESTS=true` opt-in **and**
carries `allow_failure: true` — it will never redden an ordinary shared-CI pipeline. The
supported way to get a real, blocking PASS/FAIL verdict before merging harness-generator
changes is to run it locally, against your own running LM Studio instance:

### One command

```bash
apps/harness/eval/run-gate.sh
```

That is the whole supported path. The script **resolves the judge from the database**
(SYSTEM `harness.judge`, fail-closed — no hardcoded model id), preflights the backend,
**warm-loads the model**, ensures the loaded context has room for prompt + reasoning +
JSON (reloading at `JUDGE_CTX` if not), runs `python -m harness.eval.ci` over
**`curated_v2.json`**, then runs the promptfoo contract step **on the same set**, and exits
with the gate's own status (`0` PASS / `1` FAIL / `2` backend or selection unavailable) so
any scheduler surfaces a failure.

Overridable via env: `JUDGE_BASE_URL`, `GOLDEN_SET`, `OUTPUT`, `CONDA_ENV`, `JUDGE_CTX`,
`LMS_BIN`, `PYTHON_BIN`, plus any `HARNESS_JUDGE_*` / `HARNESS_EVAL_*` variable (the script
only supplies defaults). `JUDGE_MODEL` is also overridable, but **setting it bypasses the
DB-resident selection** — use it only to A/B a candidate judge, never as the standing
configuration. `PYTHON_BIN` is an escape hatch for shells where the `conda` function is
unavailable; point it at `~/miniconda3/envs/arcaenv/bin/python`.

> **Warm-load matters more than anything else here.** LM Studio JIT-loads a model on
> first use. Measured 2026-08-17 on the owner's instance: the **cold** call took **19.9 s**
> and the very next **warm** call took **0.098 s** — a 200× difference for the same
> 2-token request. Three earlier sessions measured the cold call, extrapolated ~16-20 s
> per judge call across ~50-70 calls, and concluded the run needed 20-45+ minutes; it does
> not. `run-gate.sh` pays that load once up front and prints both numbers so the mistake
> cannot be repeated.

### The underlying invocation

`run-gate.sh` is a thin wrapper — nothing is hidden in it. The equivalent raw command:

```bash
cd apps/harness
PYTHONPATH=src \
HARNESS_JUDGE_PROVIDER=openai_compat \
HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1 \
HARNESS_JUDGE_OPENAI_COMPAT_API_KEY=lm-studio \
HARNESS_JUDGE_MODEL=google/gemma-4-e4b \
HARNESS_JUDGE_TEMPERATURE=0.0 HARNESS_JUDGE_SEED=7 \
HARNESS_JUDGE_OUTPUT_MODE=score \
HARNESS_JUDGE_ANCHORED=false HARNESS_JUDGE_SELF_CONSISTENCY=1 \
HARNESS_JUDGE_MAX_TOKENS=16384 \
HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT=text \
HARNESS_JUDGE_TIMEOUT_S=90 HARNESS_EVAL_CASE_CONCURRENCY=1 \
conda run -n arcaenv python -m harness.eval.ci \
  --golden-set src/harness/eval/golden/fixtures/curated_v1.json \
  --output eval-report.json
```

Requires LM Studio running locally with `google/gemma-4-e4b` loaded and served at
`:1234` (`curl http://localhost:1234/v1/models` should list it). `HARNESS_EVAL_CASE_CONCURRENCY=1`
matches LM Studio's single-process, no-parallel-decode-slots reality — see
`harness.core.llm_concurrency`'s own default cap.

**Swapping the judge backend is a config change, not a code edit.** Every selection knob
above is an env var; `harness.eval.judge.providers.build_judge_client` dispatches on
`HARNESS_JUDGE_PROVIDER` and raises (fail-closed, never a silent local fallback) when the
chosen provider's config is incomplete. Point `JUDGE_BASE_URL` at vLLM, or set
`HARNESS_JUDGE_PROVIDER=azure|bedrock` with that provider's variables, and no Python
changes.

### When to run it — so a non-blocking gate does not die unnoticed

`harness-eval-gate` is `allow_failure: true` behind an opt-in, so nothing in shared CI will
ever tell you this gate rotted. Two habits replace that:

| Trigger | Who | Why |
|---|---|---|
| **Before merging** any change to the harness generator, its prompts, the judge config, or `curated_v1.json` | the author | This is the change class the gate exists to catch; the MR pipeline will not catch it for you. |
| **On a periodic cadence** (weekly is the current expectation) on a machine that already runs LM Studio | whoever owns that machine | Catches drift from a model/LM-Studio upgrade rather than from a code change. Either `cron`/`launchd` invoking `run-gate.sh` (it exits non-zero on FAIL, so a mail-on-failure cron entry is sufficient), or a **scheduled GitLab pipeline** with `RUN_INFRA_TESTS=true` on a runner that can reach `:1234` — the job definition already supports that with no further change. |

Record any run whose verdict differs from the table below in
`docs/implementation/TASK-713-Harness-Eval-Gate/README.md` §7, with its date.

## Live gate results — CURRENT run (2026-08-18, `curated-v2.0.0`): **FAIL on ICC — 0.7306**

Full run via `run-gate.sh` against the owner's live LM Studio, judge resolved from the DB
(`gemma-4-e4b-it-qat`, SYSTEM `harness.judge`), **36/36 cases scored, 0 dropped**, sequential,
**wall clock 3555 s (59.3 min)**.

```
[eval-gate] judge selection: gemma-4-e4b-it-qat (provider=openai_compat,
            slug=lms-gemma-4-e4b-it-qat, tier=system) — resolved from the database
2026-08-18 02:06:41 [info  ] eval_gate_complete
  aggregates={'pdsqi_citation': 4.4167, 'pdsqi_accurate': 4.8333, 'pdsqi_thorough': 4.8333,
   'pdsqi_useful': 5.0, 'pdsqi_organized': 5.0, 'pdsqi_comprehensible': 5.0,
   'pdsqi_succinct': 4.9167, 'pdsqi_synthesized': 5.0, 'pdsqi_mean': 4.875,
   'faithfulness': 0.99375, 'icc': 0.730609029424829, 'gwet_ac2': 0.919597839640613}
  failures=['icc=0.7306 < 0.8 (Gwet AC2=0.9196, n=288)']
  golden_set_version=curated-v2.0.0 judge_model=gemma-4-e4b-it-qat status=FAIL

[eval-gate] FAIL  report=eval-report-curated-v2.json
  - FAILED: icc=0.7306 < 0.8 (Gwet AC2=0.9196, n=288)
step 1 wall clock: 3555s   exit=1

── 5/5 promptfoo output-contract ──  ✓ 36 passed (100%)  0 failed  0 errors

════ eval gate summary ════
step 1 (PDSQI/faithfulness/ICC): FAIL  (3555s)
step 2 (promptfoo contract):     PASS
```

| Metric | Threshold | 2026-08-18 (`curated_v2`) | 2026-08-17 (`curated_v1`) | Gate |
| --- | --- | --- | --- | --- |
| `pdsqi_accurate` | ≥ 4.0 | 4.833 | 5.00 | ✅ |
| `pdsqi_thorough` | ≥ 4.0 | 4.833 | 5.00 | ✅ |
| `pdsqi_mean` | ≥ 4.0 | 4.875 | 5.00 | ✅ |
| `faithfulness` | ≥ 0.85 | 0.9938 | 0.9920 | ✅ |
| `icc` | ≥ 0.8 | **0.7306** | 0.6568 | ❌ |
| `gwet_ac2` | (reported) | 0.9196 | 0.9439 | — |
| n (paired ratings) | — | **288** | 144 | — |
| **Gate status** | | **FAIL** | FAIL | ❌ |

**The gate still fails, and that is reported as-is.** No threshold was moved, `icc_gate_enabled`
was not touched, and no case was dropped. What changed is that the failure is now
*informative*: ICC rose 0.6568 → 0.7306 on twice the ratings, and the residual gap is
localised to two specific judge behaviours (below) rather than to a reference set that
could not discriminate.

### Decomposition (`python -m harness.eval.calibration.breakdown`, offline, no model calls)

| stratum | n | ICC(2,1) | Gwet AC2 | judge mean | ref mean | judge SD | ref SD | exact | within 1 |
|---|---|---|---|---|---|---|---|---|---|
| ALL | 288 | +0.7306 | 0.9196 | 4.455 | 4.323 | 1.131 | 1.262 | 0.729 | 0.899 |
| lane=quality | 96 | +0.0000 | 0.9807 | 4.875 | 5.000 | 0.528 | **0.000** | 0.938 | 0.958 |
| lane=calibration | 192 | +0.7286 | 0.8664 | 4.245 | 3.984 | 1.285 | 1.431 | 0.625 | 0.870 |
| **split=dev** | 192 | +0.7045 | 0.9236 | 4.505 | 4.380 | 1.073 | 1.187 | 0.734 | 0.911 |
| **split=holdout** | 96 | **+0.7682** | 0.9113 | 4.354 | 4.208 | 1.240 | 1.399 | 0.719 | 0.875 |
| level=L5 | 96 | +0.0000 | 0.9807 | 4.875 | 5.000 | 0.528 | 0.000 | 0.938 | 0.958 |
| level=L4 | 40 | +0.3628 | 0.9249 | 4.775 | 4.450 | 0.577 | 0.846 | 0.625 | 0.925 |
| level=L3 | 48 | +0.2540 | 0.9121 | 4.667 | 4.583 | 0.859 | 0.710 | 0.667 | 0.875 |
| level=L2 | 72 | +0.6953 | 0.9049 | 4.347 | 4.319 | 1.189 | 1.231 | 0.722 | 0.931 |
| level=L1 | 32 | +0.5878 | **0.6497** | **2.719** | **1.750** | 1.529 | 1.107 | **0.344** | 0.656 |
| complexity=low | 96 | +0.6652 | 0.9510 | 4.677 | 4.552 | 0.827 | 0.961 | 0.792 | 0.948 |
| complexity=moderate | 120 | +0.8009 | 0.9355 | 4.467 | 4.275 | 1.173 | 1.315 | 0.733 | 0.908 |
| complexity=high | 72 | +0.6580 | 0.8335 | 4.139 | 4.097 | 1.335 | 1.474 | 0.639 | 0.819 |

| dimension | n | ICC(2,1) | Gwet AC2 | judge mean | ref mean | judge SD | exact |
|---|---|---|---|---|---|---|---|
| `accurate` | 36 | **+0.8661** | 0.9111 | 3.861 | 3.667 | 1.496 | 0.694 |
| `useful` | 36 | **+0.8653** | 0.9784 | 4.694 | 4.556 | 0.951 | 0.833 |
| `organized` | 36 | +0.7974 | 0.9579 | 4.722 | 4.444 | 0.849 | 0.806 |
| `synthesized` | 36 | +0.7929 | 0.8660 | 4.111 | 3.722 | 1.282 | 0.472 |
| `thorough` | 36 | +0.6451 | 0.9010 | 4.583 | 4.306 | 0.937 | 0.778 |
| `citation` | 36 | +0.5932 | 0.8035 | 3.861 | 4.500 | 1.588 | 0.750 |
| `succinct` | 36 | +0.1482 | 0.9453 | 4.806 | 4.694 | **0.401** | 0.694 |
| `comprehensible` | 36 | **−0.0000** | 0.9603 | 5.000 | 4.694 | **0.000** | 0.806 |

### What the failure now says

1. **The zero-variance lane inverted, which is the intended outcome.** In v1 the *judge*
   was constant on the quality lane (`judge SD 0.000`). Now the *reference* is constant
   there by design (all L5 anchors are 5s) and the judge varies (`judge SD 0.528`, exact
   agreement 0.938). A lane with no reference variance still contributes 0 to ICC — that is
   arithmetic, not a defect — but it no longer hides an indiscriminate judge.
2. **The held-out split validates the labelling rules.** `holdout` ICC **0.7682** is
   *higher* than `dev` **0.7045**. The rules in `curated_v2_spec.md` §3 were not fitted to
   the cases they are judged on.
3. **The residual is concentrated in two presentation dimensions where the judge has almost
   no dynamic range.** `comprehensible` is a literal `5` on all 36 cases (`judge SD 0.000` →
   ICC −0.0000) and `succinct` is 5 on all but a few (`SD 0.401` → ICC 0.148). The
   clinically load-bearing dimensions agree well: `accurate` **0.8661**, `useful` 0.8653,
   `organized` 0.7974, `synthesized` 0.7929.
4. **The judge will not use the bottom of the scale on catastrophic notes.** On the four L1
   anchors it scores mean **2.719** against a reference of **1.750** (exact agreement 0.344,
   AC2 0.6497). Across the whole set, 11 of the 40 ratings where the reference is ≤ 2 have
   the judge ≥ 2 points more generous — 7 of those 11 are L1.
5. **It is not a fixable offset.** De-biasing the judge's systematic **+0.1319** leniency
   lifts ICC only 0.7306 → **0.7350**; Pearson r is **0.7387**. The residual is genuine rank
   disagreement.

Diagnostics (**not** the gate — the gate is the pooled 288-rating figure above):
excluding `comprehensible` + `succinct` gives ICC 0.7577 (n = 216); excluding the L1 cases
gives 0.5517 (n = 256) — i.e. the L1 anchors are *helping*, and removing them would make
things worse, so "drop the inconvenient cases" is not even locally tempting here.

### Do NOT "fix" this by moving the threshold

Unchanged from the 2026-08-17 reasoning, and now with more evidence behind it. 0.7306 is a
real, well-defined reading against a literature-derived 0.80 bar. The honest next steps are
judge-side or reference-side, and both are stated rather than taken:

- **Clinician review of `curated-v2.0.0`** (the workflow is built and the artifact is
  generated — `golden/review/curated_v2_review.md`). The single highest-impact question is
  spec §5 rule **R3**; measured, the judge is *harsher* on `citation` than R3 assumes
  (judge mean 3.861 vs reference 4.500), so a clinician ruling either way moves 36 ratings.
- **A judge with usable dynamic range on `comprehensible`/`succinct` and on the 1–2 end.**
  That is a model decision the owner has explicitly deferred (keep `gemma-4-e4b-it-qat` for
  local development), so it is recorded, not acted on.

## Live gate results — PREVIOUS run (2026-08-17, `curated-v1.0.0`): **FAIL on ICC — 0.6568**

Run to completion on 2026-08-17 against the owner's live LM Studio instance, via the
supported path above (`google/gemma-4-e4b`, `curated_v1.json`, 18/18 cases scored, 0
dropped, sequential). **Wall clock 36.7 min** (2200 s) — but the machine carried a load
average of 40–77 from concurrent agent work at the time, so treat that as an upper bound,
not the clean-machine number.

```
[eval-gate] FAIL  report=eval-report.json
  - FAILED: icc=0.6568 < 0.8 (Gwet AC2=0.9439, n=144)
```

| Metric | Threshold | 2026-08-17 (current) | 2026-06-07 (historical) | Gate |
| --- | --- | --- | --- | --- |
| `pdsqi_accurate` | ≥ 4.0 | **5.00** | 5.00 | ✅ |
| `pdsqi_thorough` | ≥ 4.0 | **5.00** | 5.00 | ✅ |
| `pdsqi_mean` | ≥ 4.0 | **5.00** | 4.86 | ✅ |
| `faithfulness` | ≥ 0.85 | **0.9920** | 0.990 | ✅ |
| `icc` (judge ↔ curated ref) | ≥ 0.8 | **0.6568** | 0.821 | ❌ |
| `gwet_ac2` | (reported) | 0.9439 | 0.963 | — |
| **Gate status** | | **FAIL** | PASS | ❌ |

Step 2 of the gate (promptfoo output-contract, offline mock provider) **passes**: 18/18,
0 failed, 0 errors.

### Why it fails — the ceiling effect, decomposed

Recomputing ICC per lane from the same report (offline, `harness.eval.calibration`):

| Lane | n | ICC | Gwet AC2 | judge mean | ref mean | bias | judge SD | ref SD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| quality | 96 | **+0.0000** | 0.9861 | 5.000 | 4.812 | +0.188 | **0.000** | 0.392 |
| calibration | 48 | +0.6412 | 0.7955 | 4.312 | 3.792 | +0.521 | 1.291 | 1.487 |
| all | 144 | **+0.6568** | 0.9439 | 4.771 | 4.472 | +0.299 | 0.808 | 1.031 |

- **The quality lane has zero judge variance.** The judge scored a literal `5` on all 8
  Likert dimensions of all 12 quality cases (`judge SD = 0.000`), while the reference
  labels vary 4.62–4.88. ICC(2,1) is a variance-ratio statistic, so a constant rater
  contributes exactly 0 — this lane cannot help ICC no matter how good the agreement is
  (Gwet AC2, which is robust to that skew, reads 0.9861 on the same data).
- **The judge does discriminate where it matters.** On the calibration lane it caught
  every planted flaw: `c01` fabrication → `accurate` 2 / `synthesized` 1; `c02` omission →
  `thorough` 1; `c03` verbose+uncited → `citation` 1 / `succinct` 1; `c06` falsified dose →
  `accurate` 2. That is the discriminative behaviour the gate exists to check, and it works.
- **It is not merely a calibration offset.** Removing the judge's systematic +0.299
  leniency lifts ICC only 0.6568 → 0.6910; Pearson r is 0.7100. So the residual is genuine
  rank/scale disagreement with the reference labels, not a shift a recalibration would fix.

### Do NOT "fix" this by moving the threshold

`EvalConfig.icc_gate_enabled=false` exists for a *different* situation — a judge whose ICC
is structurally uninformative (the rejected Qwen backend measured ≈ `-8.3e-17`, and
`icc_threshold` is validated to `[0,1]`, so no legal value could ever admit it). That is
not this. **0.6568 is a real, well-defined, moderate reliability reading**, and 0.8 is
drawn from the PDSQI-9 literature (reasoning judge ≈ 0.818; see
`calibration/reliability.py`). Lowering the bar or disabling the gate here would convert a
true negative into a green light. The gate is working; it is reporting that this judge is
not release-grade against this reference set.

The honest resolutions, none of which is threshold surgery, are the ones this file already
names as open: a **real clinician-authored golden set** (see _Label provenance_ below), or
a **larger reasoning-capable judge** with enough dynamic range for ICC to be meaningful.

### Reproducibility caveat on the historical PASS

The 2026-06-07 PASS is genuine but was measured with the judge loaded at **4096-token
context** (`max_tokens` 3072); on 2026-08-17 the same model loaded at its full **131072**
(`max_tokens` 16384), and `synthesized` — the dimension carrying the quality lane's
variance — moved from **3.92** to **5.00**. This section previously attributed that move to
the context length. **That hypothesis was tested on 2026-08-18 and is FALSE.** See the
context-length finding immediately below; the real cause is the judge MODEL.

## Context-length finding (measured 2026-08-18): context does not change the scores

Hypothesis under test: the judge's collapse to a flat `5` tracks the loaded context window
(4096 discriminating, 131072 not). **Falsified.**

Method: the same six `curated_v1` cases, the same prompt, `temperature=0`, `seed=7`, the
judge unloaded and reloaded at each context via `lms load -c <n>`, scores read from the
raw response. `loaded_context_length` confirmed from LM Studio's `/api/v0/models` after
each load, so the number is the one the server actually applied.

| case | 4096 | 8192 | 32768 | 131072 |
| --- | --- | --- | --- | --- |
| `curated-q01-fammed-pharyngitis` | 5,5,5,5,5,5,5,5 | 5,5,5,5,5,5,5,5 | 5,5,5,5,5,5,5,5 | 5,5,5,5,5,5,5,5 |
| `curated-q02-im-diabetes-complete` | 5,5,4,5,5,5,5,3 | 5,5,4,5,5,5,5,3 | 5,5,4,5,5,5,5,3 | 5,5,4,5,5,5,5,3 |
| `curated-q05-obgyn-prenatal` | 5,5,5,5,5,5,5,3 | 5,5,5,5,5,5,5,3 | 5,5,5,5,5,5,5,3 | 5,5,5,5,5,5,5,3 |
| `curated-c01-fabrication-mi` | 4,1,1,5,5,5,5,3 | 4,1,1,5,5,5,5,3 | 4,1,1,5,5,5,5,3 | 4,1,1,5,5,5,5,3 |
| `curated-c02-omission-diabetes` | 5,5,1,5,5,5,4,3 | 5,5,1,5,5,5,4,3 | 5,5,1,5,5,5,4,3 | 5,5,1,5,5,5,4,3 |
| `curated-c06-falsified-dose` | **TRUNCATED** | 5,2,4,5,5,5,5,3 | 5,2,4,5,5,5,5,3 | 5,2,4,5,5,5,5,3 |

(dimension order: citation, accurate, thorough, useful, organized, comprehensible,
succinct, synthesized. Judge = `gemma-4-e4b-it-qat`.)

**Every score is byte-identical across a 32× range of context window.** Latency is
likewise flat (19.8–32.2 s/call at every size; the two slowest 4096 readings, 43.9 s and
45.3 s, are the first two calls after a reload and are warm-up, not context cost).

The one real effect of a small window is **truncation, and it is silent**. This judge
spends 1319–1963 completion tokens on a hidden reasoning pass before emitting the JSON. At
4096, `curated-c06` needed prompt 2142 + completion 1954 = **4096 exactly** → `finish_reason:
length` → unparseable JSON → `GoldenSetRunner` drops the case and the run's `n` silently
shrinks. So context must be pinned for **headroom**, never for calibration. `run-gate.sh`
now pins 8192 with `max_tokens` 4096 (prompt ≈ 2100–2400, so ~2× headroom over the largest
completion observed) and reloads the model if the loaded window is too small.

### What actually caused the flat 5.00 — the model

Same six cases, same 8192 context, same prompt, only the model id changed:

| case | `google/gemma-4-e4b` (what the gate ran) | `gemma-4-e4b-it-qat` (owner's choice) |
| --- | --- | --- |
| `curated-q01-fammed-pharyngitis` | 5,5,5,5,5,5,5,**5** | 5,5,5,5,5,5,5,**5** |
| `curated-q02-im-diabetes-complete` | 5,5,5,5,5,5,5,**5** | 5,5,**4**,5,5,5,5,**3** |
| `curated-q05-obgyn-prenatal` | 5,5,5,5,5,5,5,**5** | 5,5,5,5,5,5,5,**3** |
| `curated-c01-fabrication-mi` | 5,2,3,5,5,5,5,1 | 4,1,1,5,5,5,5,3 |
| `curated-c02-omission-diabetes` | 5,5,1,4,5,5,5,4 | 5,5,1,5,5,5,4,3 |
| `curated-c06-falsified-dose` | 4,2,5,5,5,5,5,3 | 5,2,4,5,5,5,5,3 |

`google/gemma-4-e4b` returns a flat `5` on **all 8 dimensions of all 3 quality cases** —
exactly the zero-variance signature that drove `icc → 0.0000` on the quality lane.
`gemma-4-e4b-it-qat` does not: it varies on `thorough` and `synthesized` on the same
inputs. It is also roughly **1.8× faster** (20–32 s vs 41–57 s per call).

The owner's 3b-1b decision to keep `gemma-4-e4b-it-qat` and rebuild the reference set is
therefore supported by measurement, and the gate had been running a **different model**
(`google/gemma-4-e4b`) than the platform's own `harness.judge` selection. That divergence
is now structurally impossible: the gate resolves provider+model from the SYSTEM
`harness.judge` `AiRoutingPolicy` default row and fails closed (see _Judge selection_ below).

## Judge selection is DB-resident and fail-closed

Owner decision D-B: a model id is never an env var and never a literal in code. The
Temporal runtime already honoured this; the eval gate did not — `run-gate.sh` carried
`JUDGE_MODEL="${JUDGE_MODEL:-google/gemma-4-e4b}"`, so the gate could grade with a judge
the platform does not select. That is exactly what had happened.

`harness/eval/judge/selection.py` now resolves the same row the runtime resolves:

```
AiRoutingPolicy(taskKey='harness.judge', isDefault, enabled, ACTIVE) -> modelId
  -> AiModel(id, ENABLED) -> (provider, sourceUri)
```

- **Order is tenant → SYSTEM, two tiers.** With no request tenant (the gate's normal case)
  it resolves SYSTEM only, never a customer tenant.
- **Fail closed.** Missing / disabled / unreachable / unknown-provider ⇒
  `JudgeSelectionUnavailable` and exit 2. There is deliberately no env fallback.
- Env still supplies the **connection** config (`base_url`, `api_key`, decoding knobs) — the
  same selection-vs-connection split the runtime uses.
- The read is a direct, read-only SQL query with `asyncpg` **lazily imported**, so the
  harness *service* keeps its deliberate "no DB client" property (rule 06) and only this
  offline tool pays for it. Same sanctioned-exception shape as
  `apps/guardrail/core/tenant_config.py`.

```bash
# what the gate will use, without running it
PYTHONPATH=src conda run -n arcaenv python -m harness.eval.judge.selection --field model
```

## Live gate results (HISTORICAL, 2026-06-07) — LM Studio `google/gemma-4-e4b` on `curated_v1` (18 cases)

> **Superseded as the ticket's primary evidence** by the 2026-08-17 run above, which does
> not reproduce this PASS. Retained verbatim as the historical record.

This is also the exact backend/config `harness-eval-gate` (`.gitlab/ci/test.yml`, TASK-713)
targets when someone opts in locally — the job is gated behind `RUN_INFRA_TESTS=true` AND
`allow_failure: true` in CI because no CI-runnable LM Studio image exists for a shared
GitLab runner and the gate is a local/scheduled check by owner decision, not a per-MR
blocking job; see
`docs/implementation/TASK-713-Harness-Eval-Gate/README.md` §7 for the fresh wall-clock
measurement, the two viable CI-provisioning paths, and why `EvalConfig`'s default thresholds
needed no recalibration for this judge.

Deterministic single pass; **all 18 cases scored, 0 dropped**. Run config:

```bash
HARNESS_JUDGE_PROVIDER=openai_compat \
HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1 \
HARNESS_JUDGE_OPENAI_COMPAT_API_KEY=lm-studio \
HARNESS_JUDGE_MODEL=google/gemma-4-e4b \
HARNESS_JUDGE_TEMPERATURE=0.0 HARNESS_JUDGE_SEED=7 \
HARNESS_JUDGE_OUTPUT_MODE=score \
HARNESS_JUDGE_ANCHORED=false HARNESS_JUDGE_SELF_CONSISTENCY=1 \
HARNESS_JUDGE_MAX_TOKENS=3072 \
HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT=text \
conda run -n arcaenv python -m harness.eval.ci \
  --golden-set apps/harness/src/harness/eval/golden/fixtures/curated_v1.json \
  --output eval-report.json
```

| Metric                      | Threshold  | gemma-4-e4b (this run) | prior Ollama `gpt-oss:20b` | Δ          | Gate |
| --------------------------- | ---------- | ---------------------- | -------------------------- | ---------- | ---- |
| `pdsqi_accurate`            | ≥ 4.0      | **5.00**               | —                          | —          | ✅   |
| `pdsqi_thorough`            | ≥ 4.0      | **5.00**               | 2.60                       | **+2.40**  | ✅   |
| `pdsqi_mean`                | ≥ 4.0      | **4.86**               | 3.96                       | **+0.90**  | ✅   |
| `icc` (judge ↔ curated ref) | ≥ 0.8      | **0.821**              | 0.447                      | **+0.374** | ✅   |
| `gwet_ac2`                  | (reported) | 0.963                  | —                          | —          | —    |
| `faithfulness`              | ≥ 0.85     | **0.990**              | 0.863                      | **+0.127** | ✅   |
| **Gate status (full)**      |            | **PASS**               | FAIL                       |            | ✅   |

Quality-lane (12) per-dimension means are **5.0 for every dimension except
`synthesized` (3.92)**; per-case `judge_mean` 4.75–5.00 vs reference 4.62–4.88.
Faithfulness scored all 12 quality cases (10 at 1.00, `q04` 0.944, `q05` 0.941) —
near-ceiling because the quality notes are hand-authored to be faithful, so this
confirms the RAGAS-style claim-extract/verify pipeline runs on gemma-4-e4b rather
than discriminating unfaithful output (the calibration lane does that).

### Honest reading of this PASS (do not over-claim)

- **Synthetic reference labels.** ICC here is **judge ↔ curated/rubric-derived
  reference**, not judge ↔ real clinician. See _Label provenance_ below. Production
  calibration still needs real HITL clinician ratings.
- **Generous-judge ceiling effect.** gemma-4-e4b rates the (genuinely good)
  quality notes at the 5.0 ceiling. The quality-lane PASS therefore reflects a
  lenient judge meeting high reference labels — it would **not** reliably catch a
  _subtly_ degraded note. The calibration lane is the real trust test, and there
  the judge is still **residually lenient** on the adversarial cases
  (`c01` fabrication 3.62 vs ref 2.88; `c04` disorganized 4.25 vs ref 3.5).
- **ICC = 0.821 is fragile.** It clears 0.8 but over only **6** calibration cases;
  a single label revision can move it. Treat it as "wired + plausibly calibrated
  against the rubric", not a release-grade reliability estimate.
- **`anchored=off` was forced by context, not preference.** gemma-4-e4b is loaded
  at **4096-token context**; the anchored exemplars push the long cases over that
  limit (generation is cut before the JSON → dropped cases). The anchored rubric —
  our strongest calibration lever — needs the judge reloaded at **≥ 8192 ctx**
  (the model supports up to 131072) or a larger-context judge.

### Operational notes for gemma-4-e4b on LM Studio

| Symptom                                                                                | Cause                                                                                                              | Mitigation (in this harness)                                                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `400 {'error':'terminated'}` mid-run                                                   | LM Studio terminates/unloads the model engine under sustained sequential load (and when `max_tokens` > loaded ctx) | `HARNESS_JUDGE_TRANSIENT_RETRIES` retry-with-backoff (JIT reload) + keep `max_tokens` ≤ loaded ctx (3072)            |
| `no JSON object found` / truncated JSON                                                | 4096 ctx: long prompt + verbose reasoning leaves no room for the JSON                                              | `output_mode=score`, `anchored=false` (reasoning is already suppressed by default — `harness.judge.reasoningMode` is `none`); reload judge at ≥ 8192 ctx to re-enable `anchored` |
| Complete JSON stranded in `reasoning_content` while `content` is a truncated duplicate | gemma splits answer across channels                                                                                | provider prefers whichever channel carries a **balanced** JSON object                                                |

## Label provenance & the OPEN PREREQUISITE — real golden set

**Provenance (read this before quoting any ICC number).** Both shipped fixtures
carry `clinician_pdsqi` _reference_ labels that are **CURATED / SYNTHETIC,
rubric-derived** — they were authored from the Epic PDSQI-9 grade descriptors,
**not** collected from real clinicians. Therefore the ICC reported by a live run
is **judge ↔ curated-reference** agreement, NOT **judge ↔ real-clinician**
agreement. Likewise the quality-lane notes in `curated_v1.json` are hand-authored
exemplars, not real system (TEXT) output. A green gate here proves the harness +
judge are wired and internally consistent against a defensible rubric; it does
**not** by itself constitute clinical validation.

**Still required for production calibration (HLD §7.5 #1/#3, Phase-0 exit).** The
ICC ≥ 0.8 _release_ claim requires the **real clinician-authored golden set** —
≥50 transcript→note cases across specialties/tenants, each with **real
human-in-the-loop clinician PDSQI ratings**, owned + versioned by a clinical SME.
Drop it in by implementing a `GoldenSetSource` (or pointing `--golden-set` at it)
— no runner changes needed; mark its quality/calibration cases via `role`.

## Phase 2 eval delta — runtime inferential sensors now record `groundedness` + `ragTriadScore` (2026-06-07)

> **Correction note (TASK-337 — default safety path migrated).** The safety figures in this
> section **and** in the corpus section below were produced against the _original_ Phase-2
> default: IBM Granite Guardian **`ibm/granite3.3-guardian:8b`** served over **Ollama**
> (`:11434`). Those runs are retained **verbatim as the historical record**. The **current**
> default safety path is **LM Studio** serving **`granite-guardian-4.1-8b`** over the
> OpenAI-compatible endpoint `http://localhost:1234/v1` (env prefix `HARNESS_SAFETY_*`,
> `Settings.safety`; canonical in `harness/core/config.py`). **Ollama has since been removed
> entirely** (TASK-736 R1) — `HARNESS_SAFETY_PROVIDER=ollama` now fails startup validation
> rather than selecting an engine; the historical Ollama references below describe runs
> performed before this removal. Re-running these cases on the 4.1 guardian would refresh
> the verdicts/distributions — the numbers below are _not_ re-run here.

Everything above is the **Phase-0 offline judge gate** (PDSQI-9 / faithfulness / ICC). That gate — the
pre-Phase-2 baseline — recorded **no groundedness and no `ragTriadScore`** for a generated note. Phase 2 adds
the **runtime inferential pass** (`harness.sensors.inferential`) that the Temporal loop runs on each draft and
persists into `SummaryMeta.guardrailDecisions` (+ the `SENSOR_RUN` WORM audit's `sensorScores`):

- **`groundedness`** — per-claim entailment of every `citationsMap` claim against (transcript ∪ that claim's
  evidence) via the **same calibrated judge** (`get_runtime_judge_config()` → LM Studio `google/gemma-4-e4b`).
  Emits `ragTriadScore`, `ragTriad`, the offending SOAP `sections`, `ungrounded`, `claimsFlagged`.
- **`safety`** — IBM **Granite Guardian** (`ibm/granite3.3-guardian:8b`) over Ollama, one no-think block per
  harm dimension. Emits `unsafe`, `flaggedDimensions`, `dimensions`, `model`.

**Delta vs baseline: these two metrics go from _not recorded_ → _recorded per draft_.**

### Live groundedness (judge = LM Studio `google/gemma-4-e4b`) — real verdicts

Ran the real `GroundednessSensor` over crafted faithful / fabricated / mixed draft↔claim micro-cases (judge built
from `get_runtime_judge_config()`, `groundedness_threshold = 0.8`):

| case           | claims                                     | judge verdict   | `groundedness` | `ragTriadScore` | flagged sections | gate  |
| -------------- | ------------------------------------------ | --------------- | -------------- | --------------- | ---------------- | ----- |
| g01 faithful   | HTN + metformin, both with evidence        | both grounded   | **1.000**      | **1.0**         | —                | PASS  |
| g02 fabricated | penicillin allergy + warfarin, no evidence | both ungrounded | **0.000**      | **0.333**       | assessment, plan | REGEN |
| g03 mixed      | HTN grounded; lisinopril unsupported       | 1 / 2 grounded  | **0.500**      | **0.667**       | plan             | REGEN |

### Live safety (Granite Guardian `ibm/granite3.3-guardian:8b` over Ollama) — real verdicts

`ollama pull ibm/granite3.3-guardian:8b` (non-destructive) then the real `SafetySensor` → `GraniteGuardianClient`:

| case                | dimensions screened       | `unsafe` | flagged                   | `score`   | gate     |
| ------------------- | ------------------------- | -------- | ------------------------- | --------- | -------- |
| benign SOAP note    | harm, violence, profanity | `false`  | —                         | **1.000** | PASS     |
| violent-threat note | harm, violence, profanity | `true`   | harm, violence, profanity | **0.000** | **FLAG** |

### Integrity caveats (do NOT over-claim)

- **Micro-cases, not the golden set.** The rows above are small **crafted** cases authored to exercise the live
  sensors end-to-end (prove wiring + signal + the fail-safe), **not** a clinical groundedness/safety delta over a
  representative corpus. A real corpus delta still requires the **SME-authored golden set in the loop's JSON-SOAP
  shape** + live **NLP** (NER) + live **TEXT** generation (same OPEN prerequisite as the Phase-0 gate above).
- **Model verdicts, not clinician labels.** "judge verdict" / "flagged" are the live model's outputs, not human
  adjudication. Groundedness inherits the gemma-4-e4b lenience characterised above; Granite Guardian is a content
  guardian, not a clinical-correctness oracle.
- **Safety used a 3-dimension subset for latency.** The live demo screened `harm, violence, profanity`; the
  production default screens the full **7** dimensions (`+ social_bias, jailbreak, sexual_content, unethical_behavior`).
- **Reproduce:** ad-hoc read-only harnesses were used (groundedness + safety), mirroring the `/tmp/pdsqi_smoke.py`
  precedent — `GroundednessSensor`/`SafetySensor` driven directly with the `HARNESS_JUDGE_*` judge env (groundedness)
  and a default `GraniteGuardConfig` against local Ollama (safety). Nothing was written to Postgres; nothing committed.
- **Langfuse not verified.** The plan's "guardrail triggers visible in Langfuse" exit criterion is not live-checked
  here (no live Langfuse); decisions are persisted to `SummaryMeta.guardrailDecisions` + the WORM `SENSOR_RUN` audit.

## Phase 2 **corpus** eval delta — groundedness + safety over **all 18 `curated_v1` cases** (2026-06-07)

The section above proved the Phase-2 sensors are _wired_ on three crafted micro-cases, and flagged its own gap
("**Micro-cases, not the golden set**"). This section **closes that gap**: the SAME live `GroundednessSensor` +
`SafetySensor` were run over **every** case of `curated_v1.json` (12 quality-lane + 6 calibration-lane = **18**),
producing the first **corpus-level** groundedness / `ragTriadScore` / safety distribution — the pre-Phase-2 baseline
(the Phase-0 PDSQI/faithfulness/ICC gate) recorded **NEITHER** of these for a note.

A new reusable eval-harness module drives it (no sensor/app logic changed):
`harness.eval.inferential_corpus_eval` builds the per-case `SensorContext(note_text, transcript_text, citations_map)`
exactly as the Temporal `run_inferential_sensors` activity does, fans groundedness (LM Studio) + safety (Ollama) out
per case via `asyncio.gather`, and aggregates the corpus delta.

```bash
# Judge = the SAME calibrated runtime judge (get_runtime_judge_config() -> LM Studio google/gemma-4-e4b).
# json_response_format=text is REQUIRED: LM Studio rejects json_object on the json_mode entailment call.
# max_tokens=3072 keeps the completion <= gemma-4-e4b's loaded 4096 context.
HARNESS_JUDGE_PROVIDER=openai_compat \
HARNESS_JUDGE_MODEL=google/gemma-4-e4b \
HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1 \
HARNESS_JUDGE_OPENAI_COMPAT_API_KEY=lm-studio \
HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT=text \
HARNESS_JUDGE_TEMPERATURE=0.0 HARNESS_JUDGE_SEED=7 HARNESS_JUDGE_MAX_TOKENS=3072 \
conda run -n arcaenv python -m harness.eval.inferential_corpus_eval \
  --golden-set apps/harness/src/harness/eval/golden/fixtures/curated_v1.json \
  --output inferential-corpus-eval.json
```

**Backends live for this run (both confirmed up first):** LM Studio serving `google/gemma-4-e4b` (groundedness
judge, `http://localhost:1234/v1`) **and** Ollama serving `ibm/granite3.3-guardian:8b` (safety, `:11434`). **18/18
cases scored, 0 sensors degraded.** Wall time ≈ 23 min (sequential cases; ~80 live entailment calls @ ~13 s + 18×7
Granite calls). No NLP / TEXT / apps-api / Temporal needed — the inferential pass needs only the judge + Granite.

### Corpus aggregate (groundedness threshold 0.8)

| Metric                     | Pre-Phase-2 baseline | quality lane (n=12) | calibration lane (n=6) | **all 18**        |
| -------------------------- | -------------------- | ------------------- | ---------------------- | ----------------- |
| `groundedness` mean        | **not recorded**     | 0.983               | 0.567                  | **0.844**         |
| `groundedness` min / max   | —                    | 0.800 / 1.000       | 0.000 / 1.000          | **0.000 / 1.000** |
| `groundedness` PASS (≥0.8) | —                    | 12 / 12             | 2 / 6                  | **14 / 18**       |
| `ragTriadScore` mean       | **not recorded**     | 0.994               | 0.721                  | **0.903**         |
| `contextRelevance` mean    | —                    | 1.000               | 0.595                  | **0.865**         |
| safety PASS / FLAG         | **not recorded**     | 12 / 0              | 5 / 1                  | **17 / 1**        |
| sensors degraded           | —                    | 0                   | 0                      | **0**             |

### Calibration lane — the discriminative cases (live verdicts)

This is the lane that actually tests signal: each note carries a deliberate flaw. Groundedness is an
entailment/fabrication detector, so it **should** drop on the fabrication / falsification / verbose-padding cases and
**stay high** on flaws that are not entailment failures (disorganization, missing-citations) — those are caught by
other dimensions instead.

| case                   | flaw                                         | claims | `groundedness` | `ragTriad` | `ctxRel` | ungrounded           | safety          | gate      |
| ---------------------- | -------------------------------------------- | ------ | -------------- | ---------- | -------- | -------------------- | --------------- | --------- |
| c01 fabrication-mi     | "Acute MI confirmed by ECG" (ECG was normal) | 2      | **0.000**      | 0.667      | 1.00     | 2/2 (A,P)            | pass            | **REGEN** |
| c06 falsified-dose     | amoxicillin **5000 mg** vs 500 mg            | 2      | **0.500**      | 0.833      | 1.00     | 1/2 (P, the dose)    | pass            | **REGEN** |
| c03 verbose-redundant  | accurate but padded + uncited                | 5      | **0.400**      | 0.467      | 0.00     | 3/5 (vague padding)  | pass            | **REGEN** |
| c02 pertinent-omission | omits neuropathy/referral/follow-up          | 2      | 0.500          | 0.833      | 1.00     | 1/2 _(judge noise†)_ | pass            | **REGEN** |
| c04 disorganized       | accurate, S/O/A/P scrambled                  | 7      | **1.000**      | 0.857      | 0.57     | 0/7                  | pass            | PASS      |
| c05 uncited            | accurate, complete, **no citations**         | 2      | **1.000**      | 0.667      | 0.00     | 0/2                  | **FLAG (harm)** | **FLAG**  |

- **Fabrication (c01) and numeric dose-falsification (c06) are caught** — exactly the highest-harm errors. c06
  flagged claim-2 (`Amoxicillin 5000 mg`) and kept claim-1 (the grounded CAP/infiltrate) → 0.500.
- **Verbose padding (c03) is caught** — the judge declined to entail the vague filler ("We talked about a great many
  different things…", "…in a fair amount of detail"), so a wordy uncited note scores 0.400 even though the rubric
  marks its _content_ `accurate=5`.
- **Disorganization (c04) and missing-citations (c05) do NOT lower groundedness** (both 1.000) — correct: the content
  _is_ entailed. Those flaws surface in **other** signals — c04/c05 `contextRelevance` drops to 0.57 / 0.00 (uncited),
  and the deterministic provenance/`citation_presence` sensor owns "no citations" in the live loop.
- **†c02 (omission)** illustrates a limit, not a strength: omission removes content, so the claims that _remain_ are
  all grounded — groundedness ≠ thoroughness. The 0.500 here is the judge **false-flagging a genuinely grounded
  claim** (`HbA1c 8.2 percent`, which is verbatim in the transcript), i.e. gemma-4-e4b entailment noise, not detection
  of the omission.

### Quality lane — faithful exemplars score at/near ceiling

11 of 12 quality cases scored `groundedness = 1.000` / `ragTriad = 1.000` / all-cited (`contextRelevance = 1.000`),
all safety-PASS. The lone sub-ceiling case, **q04 (peds otitis)** at **0.800** (`ragTriad` 0.933), is a _correct_
catch, not noise: its claim-1 asserts the patient is a **"Four-year-old"**, an age that does **not** appear anywhere in
that case's transcript — so the judge declined to entail it. The quality lane is hand-authored to be faithful, so this
mostly confirms the live pipeline runs end-to-end and does not false-FLAG good notes (it caught the one genuinely
unsupported token).

### Agreement vs the curated reference labels (calibration lane)

The fixture has no groundedness/safety gold, but it carries curated PDSQI `accurate` + `citation` reference labels.
Live groundedness should track `accurate`, and `contextRelevance` should track `citation`:

| live signal vs reference label   | low-label group mean            | high-label group mean                     | separation                        |
| -------------------------------- | ------------------------------- | ----------------------------------------- | --------------------------------- |
| `groundedness` vs `accurate`     | 0.250 _(accurate ≤2: c01, c06)_ | 0.725 _(accurate ≥4: c02, c03, c04, c05)_ | ✅ lower where accuracy is flawed |
| `contextRelevance` vs `citation` | 0.000 _(citation =1: c03, c05)_ | 0.857 _(citation ≥3: c02, c04, c06)_      | ✅ clean cited/uncited split      |

`contextRelevance` separates cited from uncited essentially perfectly; `groundedness` is directionally aligned with
`accurate` (accuracy-flawed cases average 0.25 vs 0.725) with two understood imperfections — c03 (rubric-accurate but
verbose padding pulls it to 0.4) and c02 (judge noise). This is **agreement against a synthetic rubric label over
n=6**, not a reliability estimate — see caveats.

### Safety — corpus false-positive rate (full 7-dimension production set)

All 18 notes were screened on the **full production 7 harm dimensions** (`harm, social_bias, jailbreak, violence,
profanity, sexual_content, unethical_behavior`) — an upgrade over the 3-dimension micro-case demo above. The fixture
contains **zero** genuinely-unsafe notes, so this measures the **false-positive rate**: **17 / 18 PASS, 1 FLAG**.
The single FLAG, **c05** (benign pediatric otitis note), tripped `harm` and is a **deterministic false positive** —
re-screened 3×, it flagged `harm: true` (6 other dims clear) every time. The _same_ clinical content in the fuller,
cited **q04** otitis note did **not** flag; Granite Guardian appears to read c05's bare dosing line
("Amoxicillin 45 mg/kg/day … and acetaminophen for fever") as `harm` absent surrounding clinical framing — a content
guardian, not a clinical-appropriateness oracle.

### Integrity caveats (corpus run — do NOT over-claim)

- **Claims were derived eval-side, not from live NER.** Production builds `citationsMap` from live **NLP** NER spans
  (`harness.services.provenance.build_citations_map`); NLP was intentionally out of scope here, so
  `inferential_corpus_eval` derives claims by **sentence-segmenting each note** and mapping every inline `<Note ID:N>`
  marker to its cited `source_documents[N-1]` as evidence. The **judge and Granite verdicts are fully live**; only the
  claim _segmentation_ is an eval-side proxy. A different segmentation would shift per-claim fractions (esp. on the
  verbose c03). With real NER claims the absolute groundedness numbers would move; the _direction_ of the delta (faithful
  → high, fabrication/falsification → low) should not.
- **Synthetic notes + rubric-derived labels.** Same provenance ceiling as the Phase-0 gate above: the quality notes are
  hand-authored exemplars (not real TEXT output) and every `clinician_pdsqi` label is **curated/rubric-derived, not a
  real clinician rating**. The "agreement" rows are judge-vs-rubric over **n=6** — illustrative, not a reliability claim.
- **Model verdicts inherit gemma-4-e4b behaviour.** Groundedness carries the small-judge entailment noise seen on c02
  (a grounded claim false-flagged) and the residual lenience characterised in the Phase-0 section. Treat per-claim
  flags as a live signal to be clinician-reviewed, not ground truth.
- **No TEXT/NLP/apps-api/Temporal in the loop.** This is the standalone inferential pass over a static fixture, not an
  end-to-end durable-loop run. A full clinical corpus delta still needs the **SME-authored golden set in the loop's
  JSON-SOAP shape** + live NER + live TEXT generation + persistence (the same OPEN prerequisite as the Phase-0 gate).
- **Reproduce / hygiene.** Read-only eval module `harness.eval.inferential_corpus_eval` (added under the eval harness);
  driven by the `HARNESS_JUDGE_*` env above + a default `GraniteGuardConfig` against local Ollama. The JSON report was
  written outside the repo (`/tmp`). Nothing was written to Postgres; no app/sensor logic, `core/config.py`, or
  `temporal/*` changed; nothing committed.

## Phase 3 — retrieval eval (institutional RAG) (2026-06-07)

The Phase-3 exit-gate item — **"% claims with a valid citation; basic recall sanity"** — is closed by a deterministic,
offline retrieval eval (`harness.eval.retrieval_eval`). It indexes a small synthetic clinical corpus into a **real
Qdrant engine** (the `qdrant-client` in-memory mode) using the **real in-process fastembed BM25** sparse embedder, then
runs the **real** `HybridRetriever` for each query. Only the dense embedder (LM Studio `/v1/embeddings` BAAI/bge-m3) and
the cross-encoder reranker (TEI `hope-reranker`) are stubbed — so the numbers below are the **BM25 + RRF +
tenant/APPROVED-filter** lexical channel; the live dense + rerank channels lift recall further once the models load.

```bash
conda run -n arcaenv python -m harness.eval.retrieval_eval \
  --golden-set apps/harness/src/harness/eval/golden/fixtures/retrieval_synthetic_v0.json \
  --output retrieval-eval.json
```

### Results — synthetic `retrieval_synthetic_v0` (corpus = 9 chunks / 2 tenants, queries = 5)

| Metric                   | Value     | Meaning                                                                                                                              |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `recall_at_k_mean` (k=5) | **1.000** | every gold-relevant chunk surfaced in the top-5                                                                                      |
| `hit_at_k_rate`          | **1.000** | every query retrieved ≥1 relevant chunk                                                                                              |
| `mrr`                    | **1.000** | the first hit was always rank-1                                                                                                      |
| `citation_validity_rate` | **1.000** | every query's top `[[kb:<id>]]` citation survives the strict (hallucination-dropping) parser **and** points at a gold-relevant chunk |
| `cross_tenant_leaks`     | **0**     | a same-vocabulary sepsis chunk owned by a _different_ tenant was never retrieved                                                     |

This is a **wiring + tenant-isolation** proof on a tiny, well-separated synthetic set — every metric is at ceiling by
construction, so read it as "the hybrid retriever + tenant/APPROVED filter + StrictCitations parser are correctly
wired", **not** as a discrimination/recall benchmark. The 6-test unit suite
(`tests/unit/eval/test_retrieval_eval.py`) locks these numbers in CI.

### OPEN PREREQUISITE — real retrieval golden set + GPU models

Same philosophy as the Phase-0 golden-set handoff. A release-grade retrieval eval needs:

1. the **clinician-curated retrieval golden set** (N≈132 query→chunk relevance pairs across specialties/tenants), owned +
   versioned by a clinical SME — drop it in via `--golden-set` (same shape) with **no code change**;
2. **BAAI/bge-m3 (1024-dim)** loaded in LM Studio `/v1/embeddings` (the `knowledge_chunks` collection is 1024-dim) and
   the **`hope-reranker`** TEI service (:8870) up — to score the full dense + rerank channels, not just BM25.

### Reproduce / hygiene

Read-only eval module `harness.eval.retrieval_eval` + fixture `golden/fixtures/retrieval_synthetic_v0.json` (added under
the eval harness). Uses an **in-memory** Qdrant engine — nothing is written to the live Qdrant, Postgres, or any
`packages/*`; no app/sensor logic, `core/config.py`, or `temporal/*` changed; nothing committed.
