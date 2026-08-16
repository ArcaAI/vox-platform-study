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
families. All opt-in via `HARNESS_JUDGE_*`; defaults are safe everywhere.

| Env                                                | Default            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HARNESS_JUDGE_REASONING_MODE`                     | `auto`             | How the system prompt treats reasoning. `auto` = neutral prompt — **neither forces nor forbids** a reasoning pass (safe across families). `think` = elicit an explicit reasoning pass before the JSON (helps Qwen-style judges). `none` = forbid reasoning; answer with the JSON object **only**.                                                                                                                                    |
| `HARNESS_JUDGE_SUPPRESS_REASONING`                 | `false`            | Append a hard `/no_think` + "output ONLY the JSON object" directive to the system prompt. Needed for small local judges (e.g. gemma-4-e4b) that otherwise emit a long thinking pass and may end the turn _before_ the JSON (premature stop). Note: gemma-4 still emits reasoning into `reasoning_content` even with this on — the win is that the final JSON is reliably present.                                                    |
| `HARNESS_JUDGE_OUTPUT_MODE`                        | `with_explanation` | `score` = compact score-only JSON; `with_explanation` = per-dimension rationale. `score` is markedly more reliable for ≤~7B judges (a long prose preamble can exhaust the token/context budget before any JSON appears).                                                                                                                                                                                                             |
| `HARNESS_JUDGE_MAX_TOKENS`                         | `8192`             | Completion budget. Large on purpose for reasoning models — BUT must stay **≤ the judge's loaded context window**. A value larger than the loaded context (e.g. 8192 against a model loaded at 4096 ctx) makes LM Studio reject/terminate the request (`400 {'error':'terminated'}`). For gemma-4-e4b @ 4096 ctx use `3072`.                                                                                                          |
| `HARNESS_JUDGE_TRANSIENT_RETRIES` / `_BACKOFF_S`   | `3` / `12.0`       | Bounded app-level retry (linear backoff) for **transient** backend failures — a local model engine terminated/unloaded under sustained load (`'terminated'`), a dropped connection, a momentary 5xx. Lets a long run survive a mid-run crash (the server JIT-reloads on the next call). A genuinely-down backend still aborts once retries are exhausted — never a silent green gate.                                                |
| `HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT` | `json_object`      | `response_format.type` sent on json_mode calls (faithfulness claim-extract/verify). LM Studio rejects `json_object` (HTTP 400) and small models choke under a strict `json_schema` grammar, so set **`text`** for LM Studio — the prompt asks for JSON and parsing is tolerant.                                                                                                                                                      |
| `HARNESS_JUDGE_EXTRA_BODY`                         | `none`             | JSON-**string** passthrough forwarded verbatim into the OpenAI-compatible / Azure `create(...)` call (ignored by Bedrock). For server-specific reasoning controls on vLLM/Azure, e.g. `HARNESS_JUDGE_EXTRA_BODY='{"reasoning_effort":"low"}'` or `'{"chat_template_kwargs":{"enable_thinking":false}}'`. Empirically a no-op on LM Studio (there the large `max_tokens` + reading the reasoning channel is the only reliable lever). |

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

## Live gate results — LM Studio `google/gemma-4-e4b` on `curated_v1` (18 cases)

This is also the exact backend/config `harness-eval-gate` (`.gitlab/ci/test.yml`, TASK-713)
targets in CI — the job is gated behind `RUN_INFRA_TESTS=true` rather than unconditionally
on, because no CI-runnable LM Studio image exists for a shared GitLab runner; see
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
HARNESS_JUDGE_OUTPUT_MODE=score HARNESS_JUDGE_SUPPRESS_REASONING=true \
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
| `no JSON object found` / truncated JSON                                                | 4096 ctx: long prompt + verbose reasoning leaves no room for the JSON                                              | `output_mode=score`, `suppress_reasoning=true`, `anchored=false`; reload judge at ≥ 8192 ctx to re-enable `anchored` |
| Complete JSON stranded in `reasoning_content` while `content` is a truncated duplicate | gemma splits answer across channels                                                                                | provider prefers whichever channel carries a **balanced** JSON object                                                |

## Label provenance & the OPEN PREREQUISITE — real golden set

**Provenance (read this before quoting any ICC number).** Both shipped fixtures
carry `clinician_pdsqi` _reference_ labels that are **CURATED / SYNTHETIC,
rubric-derived** — they were authored from the Epic PDSQI-9 grade descriptors,
**not** collected from real clinicians. Therefore the ICC reported by a live run
is **judge ↔ curated-reference** agreement, NOT **judge ↔ real-clinician**
agreement. Likewise the quality-lane notes in `curated_v1.json` are hand-authored
exemplars, not real system (SMR) output. A green gate here proves the harness +
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
  shape** + live **NLP** (NER) + live **SMR** generation (same OPEN prerequisite as the Phase-0 gate above).
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
Granite calls). No NLP / SMR / apps-api / Temporal needed — the inferential pass needs only the judge + Granite.

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
  hand-authored exemplars (not real SMR output) and every `clinician_pdsqi` label is **curated/rubric-derived, not a
  real clinician rating**. The "agreement" rows are judge-vs-rubric over **n=6** — illustrative, not a reliability claim.
- **Model verdicts inherit gemma-4-e4b behaviour.** Groundedness carries the small-judge entailment noise seen on c02
  (a grounded claim false-flagged) and the residual lenience characterised in the Phase-0 section. Treat per-claim
  flags as a live signal to be clinician-reviewed, not ground truth.
- **No SMR/NLP/apps-api/Temporal in the loop.** This is the standalone inferential pass over a static fixture, not an
  end-to-end durable-loop run. A full clinical corpus delta still needs the **SME-authored golden set in the loop's
  JSON-SOAP shape** + live NER + live SMR generation + persistence (the same OPEN prerequisite as the Phase-0 gate).
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
