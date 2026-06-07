# Harness Eval (TASK-330, Phase 0)

Self-contained clinical-documentation **evaluation harness**: a PDSQI-9
LLM-as-judge, RAGAS-style faithfulness, DeepEval metric wrappers, a pluggable
golden-set runner, and a judge-calibration gate (ICC / Gwet AC2). It emits scores
to JSON/stdout and never writes to Postgres or imports `packages/*` — DB
persistence of eval runs is a later phase via `apps/api`.

## Layout

| Path | What |
|---|---|
| `../src/harness/eval/` | The Python package (`harness.eval.*`) |
| `../src/harness/eval/judge/` | PDSQI-9 judge: vendored Epic prompts, parsing, model-agnostic providers |
| `../src/harness/eval/metrics/` | RAGAS-style faithfulness + DeepEval metric wrappers |
| `../src/harness/eval/calibration/` | ICC(2,1) + Gwet AC2 + the `ICC >= 0.8` release gate |
| `../src/harness/eval/golden/` | Golden-set runner + pluggable sources + fixtures |
| `../src/harness/eval/golden/fixtures/synthetic_v0.json` | 5-case synthetic wiring fixture (pinned default) |
| `../src/harness/eval/golden/fixtures/curated_v1.json` | 18-case **curated** set: 12 quality-lane + 6 calibration-lane |
| `../src/harness/eval/ci.py` | Release-gate runner + JSON report (CI entrypoint) |
| `./promptfoo/` | promptfoo output-contract gate (run via `npx`) |

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
# (anchored rubric prompt + deterministic seed), judge = local LM Studio google/gemma-4-e4b:
HARNESS_JUDGE_PROVIDER=openai_compat \
HARNESS_JUDGE_MODEL=google/gemma-4-e4b \
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

| `role` | `generated_note` is… | Feeds |
|---|---|---|
| `quality` (default) | a high-quality reference exemplar (good production output) | PDSQI quality aggregates (accurate / thorough / mean) **and** faithfulness |
| `calibration` | a range-spanning / adversarial note (may have a deliberate flaw) | judge↔reference agreement (**ICC / Gwet AC2**) **only** — excluded from the quality mean |

Every case is still scored by the judge and appears in the per-case report;
`role` only controls which cases feed which *aggregate*. Faithfulness is a
quality-lane metric, so it is not run on calibration cases. This mirrors how a
real gate works: "are my representative notes good?" (quality lane) is a separate
question from "can I trust the automated judge?" (calibration lane).

## Judge calibration levers (Lever 2)

All opt-in via `HARNESS_JUDGE_*` env; defaults preserve the prior single-pass
behaviour, so CI prompts stay pristine.

| Env | Default | Effect |
|---|---|---|
| `HARNESS_JUDGE_ANCHORED` | `false` | Append rubric-faithful per-score guidance + 2 balanced exemplars to the prompt (the verbatim Epic rubric is unchanged). Reduces a small judge's two main biases: over-penalising a single omission, and letting an inaccurate assertion bleed into unrelated dimensions. |
| `HARNESS_JUDGE_SEED` | `none` | Base decoding seed. For a single pass (K=1) it is the deterministic seed. For self-consistency (K>1) sample *i* uses `seed + i`, so the K samples are **distinct but reproducible** — a single fixed seed would make every sample identical and silently defeat self-consistency. `none` lets each sample draw a fresh random seed. |
| `HARNESS_JUDGE_SELF_CONSISTENCY` | `1` | Sample the judge K times and take the per-dimension **median** (variance reduction). `1` = single deterministic pass. Note: median reduces *variance*, not *bias* — a judge that systematically under-rates a dimension will not be corrected by larger K. |
| `HARNESS_JUDGE_SC_TEMPERATURE` | `0.2` | Decoding temperature for the K>1 diversity samples (needs > 0 to produce diverse samples; kept low so samples stay near the greedy mode). |

## Model configuration (judge is model-agnostic)

Selected entirely via env (`HARNESS_JUDGE_*`); nothing is hardcoded.

| Provider | `HARNESS_JUDGE_PROVIDER` | Key env |
|---|---|---|
| LM Studio / vLLM / OpenAI-compatible (default, ≤20B) | `openai_compat` | `HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL`, `HARNESS_JUDGE_MODEL` |
| Azure OpenAI (large) | `azure` | `HARNESS_JUDGE_AZURE_ENDPOINT`, `HARNESS_JUDGE_AZURE_API_KEY`, `HARNESS_JUDGE_AZURE_DEPLOYMENT` |
| AWS Bedrock (large) | `bedrock` | `HARNESS_JUDGE_MODEL` (model id), `HARNESS_JUDGE_BEDROCK_REGION` |

The **default judge model** is `google/gemma-4-e4b` — a small (≤20B) Gemma-4
hybrid-reasoning model — served by a local **LM Studio** endpoint on
`http://localhost:1234/v1`. Override per env: `HARNESS_JUDGE_MODEL` (model id) and
`HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL` (endpoint).

### Reasoning-control levers (cross-family robustness)

Reasoning families spend hundreds–thousands of "thinking" tokens before they emit the
score JSON; these knobs keep a single judge robust across reasoning **and** non-reasoning
families. All opt-in via `HARNESS_JUDGE_*`; defaults are safe everywhere.

| Env | Default | Effect |
|---|---|---|
| `HARNESS_JUDGE_REASONING_MODE` | `auto` | How the system prompt treats reasoning. `auto` = neutral prompt — **neither forces nor forbids** a reasoning pass (safe across families). `think` = elicit an explicit reasoning pass before the JSON (helps Qwen-style judges). `none` = forbid reasoning; answer with the JSON object **only**. |
| `HARNESS_JUDGE_SUPPRESS_REASONING` | `false` | Append a hard `/no_think` + "output ONLY the JSON object" directive to the system prompt. Needed for small local judges (e.g. gemma-4-e4b) that otherwise emit a long thinking pass and may end the turn *before* the JSON (premature stop). Note: gemma-4 still emits reasoning into `reasoning_content` even with this on — the win is that the final JSON is reliably present. |
| `HARNESS_JUDGE_OUTPUT_MODE` | `with_explanation` | `score` = compact score-only JSON; `with_explanation` = per-dimension rationale. `score` is markedly more reliable for ≤~7B judges (a long prose preamble can exhaust the token/context budget before any JSON appears). |
| `HARNESS_JUDGE_MAX_TOKENS` | `8192` | Completion budget. Large on purpose for reasoning models — BUT must stay **≤ the judge's loaded context window**. A value larger than the loaded context (e.g. 8192 against a model loaded at 4096 ctx) makes LM Studio reject/terminate the request (`400 {'error':'terminated'}`). For gemma-4-e4b @ 4096 ctx use `3072`. |
| `HARNESS_JUDGE_TRANSIENT_RETRIES` / `_BACKOFF_S` | `3` / `12.0` | Bounded app-level retry (linear backoff) for **transient** backend failures — a local model engine terminated/unloaded under sustained load (`'terminated'`), a dropped connection, a momentary 5xx. Lets a long run survive a mid-run crash (the server JIT-reloads on the next call). A genuinely-down backend still aborts once retries are exhausted — never a silent green gate. |
| `HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT` | `json_object` | `response_format.type` sent on json_mode calls (faithfulness claim-extract/verify). LM Studio rejects `json_object` (HTTP 400) and small models choke under a strict `json_schema` grammar, so set **`text`** for LM Studio — the prompt asks for JSON and parsing is tolerant. |
| `HARNESS_JUDGE_EXTRA_BODY` | `none` | JSON-**string** passthrough forwarded verbatim into the OpenAI-compatible / Azure `create(...)` call (ignored by Bedrock). For server-specific reasoning controls on vLLM/Azure, e.g. `HARNESS_JUDGE_EXTRA_BODY='{"reasoning_effort":"low"}'` or `'{"chat_template_kwargs":{"enable_thinking":false}}'`. Empirically a no-op on LM Studio (there the large `max_tokens` + reading the reasoning channel is the only reliable lever). |

**Per-family reasoning serialization** (what the judge must survive):

| Family | How it reasons | What the server exposes |
|---|---|---|
| Qwen3.5 | `<think>…</think>` before the answer | split into a `reasoning_content` field |
| gpt-oss | harmony analysis / final channels | a separate `reasoning` field |
| Gemma 4 / some MedGemma builds | a thought block (e.g. `<unused94>thought`) or markdown-fenced JSON | `reasoning_content`, or leaked into `content` |
| Gemma 3 / Gemma-3-based MedGemma | non-reasoning | plain JSON in `content` |

The judge reads the server-split `reasoning_content` / `reasoning` field when `content` is
blank; otherwise it **strips** these forms (`<think>` blocks, harmony analysis/commentary
channels, Gemma `<unused94>thought` / `<|think|>` markers, markdown fences) and extracts the
**final** balanced JSON object — so a stray `{` inside leaked chain-of-thought never wins over
the real score object.

## Live gate results — LM Studio `google/gemma-4-e4b` on `curated_v1` (18 cases)

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

| Metric | Threshold | gemma-4-e4b (this run) | prior Ollama `gpt-oss:20b` | Δ | Gate |
|---|---|---|---|---|---|
| `pdsqi_accurate` | ≥ 4.0 | **5.00** | — | — | ✅ |
| `pdsqi_thorough` | ≥ 4.0 | **5.00** | 2.60 | **+2.40** | ✅ |
| `pdsqi_mean` | ≥ 4.0 | **4.86** | 3.96 | **+0.90** | ✅ |
| `icc` (judge ↔ curated ref) | ≥ 0.8 | **0.821** | 0.447 | **+0.374** | ✅ |
| `gwet_ac2` | (reported) | 0.963 | — | — | — |
| `faithfulness` | ≥ 0.85 | **0.990** | 0.863 | **+0.127** | ✅ |
| **Gate status (full)** | | **PASS** | FAIL | | ✅ |

Quality-lane (12) per-dimension means are **5.0 for every dimension except
`synthesized` (3.92)**; per-case `judge_mean` 4.75–5.00 vs reference 4.62–4.88.
Faithfulness scored all 12 quality cases (10 at 1.00, `q04` 0.944, `q05` 0.941) —
near-ceiling because the quality notes are hand-authored to be faithful, so this
confirms the RAGAS-style claim-extract/verify pipeline runs on gemma-4-e4b rather
than discriminating unfaithful output (the calibration lane does that).

### Honest reading of this PASS (do not over-claim)

- **Synthetic reference labels.** ICC here is **judge ↔ curated/rubric-derived
  reference**, not judge ↔ real clinician. See *Label provenance* below. Production
  calibration still needs real HITL clinician ratings.
- **Generous-judge ceiling effect.** gemma-4-e4b rates the (genuinely good)
  quality notes at the 5.0 ceiling. The quality-lane PASS therefore reflects a
  lenient judge meeting high reference labels — it would **not** reliably catch a
  *subtly* degraded note. The calibration lane is the real trust test, and there
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

| Symptom | Cause | Mitigation (in this harness) |
|---|---|---|
| `400 {'error':'terminated'}` mid-run | LM Studio terminates/unloads the model engine under sustained sequential load (and when `max_tokens` > loaded ctx) | `HARNESS_JUDGE_TRANSIENT_RETRIES` retry-with-backoff (JIT reload) + keep `max_tokens` ≤ loaded ctx (3072) |
| `no JSON object found` / truncated JSON | 4096 ctx: long prompt + verbose reasoning leaves no room for the JSON | `output_mode=score`, `suppress_reasoning=true`, `anchored=false`; reload judge at ≥ 8192 ctx to re-enable `anchored` |
| Complete JSON stranded in `reasoning_content` while `content` is a truncated duplicate | gemma splits answer across channels | provider prefers whichever channel carries a **balanced** JSON object |

## Label provenance & the OPEN PREREQUISITE — real golden set

**Provenance (read this before quoting any ICC number).** Both shipped fixtures
carry `clinician_pdsqi` *reference* labels that are **CURATED / SYNTHETIC,
rubric-derived** — they were authored from the Epic PDSQI-9 grade descriptors,
**not** collected from real clinicians. Therefore the ICC reported by a live run
is **judge ↔ curated-reference** agreement, NOT **judge ↔ real-clinician**
agreement. Likewise the quality-lane notes in `curated_v1.json` are hand-authored
exemplars, not real system (SMR) output. A green gate here proves the harness +
judge are wired and internally consistent against a defensible rubric; it does
**not** by itself constitute clinical validation.

**Still required for production calibration (HLD §7.5 #1/#3, Phase-0 exit).** The
ICC ≥ 0.8 *release* claim requires the **real clinician-authored golden set** —
≥50 transcript→note cases across specialties/tenants, each with **real
human-in-the-loop clinician PDSQI ratings**, owned + versioned by a clinical SME.
Drop it in by implementing a `GoldenSetSource` (or pointing `--golden-set` at it)
— no runner changes needed; mark its quality/calibration cases via `role`.
