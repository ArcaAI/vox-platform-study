# Harness Eval — the offline clinical-documentation quality gate

Self-contained clinical-documentation evaluation harness for `apps/harness`: a PDSQI-9
LLM-as-judge, RAGAS-style faithfulness, DeepEval metric wrappers, a pluggable golden-set
runner, and a judge-calibration gate (ICC / Gwet AC2). It emits scores to JSON/stdout and
never writes to Postgres or imports `packages/*` — it is not part of the live document loop.
The Python package lives under `../src/harness/eval/` (imports as `harness.eval.*`); this
folder holds the non-Python eval assets (promptfoo) plus this overview.

## Layout

| Path | What |
|---|---|
| `../src/harness/eval/` | The Python package (`harness.eval.*`) |
| `../src/harness/eval/judge/` | PDSQI-9 judge: vendored Epic prompts, parsing, model-agnostic providers, `selection.py` (DB-resident judge selection) |
| `../src/harness/eval/metrics/` | RAGAS-style faithfulness + DeepEval metric wrappers |
| `../src/harness/eval/calibration/` | ICC(2,1) + Gwet AC2 + the `ICC >= 0.8` release gate, `breakdown.py` |
| `../src/harness/eval/golden/` | Golden-set runner + pluggable sources + fixtures — see `../src/harness/eval/golden/README.md` |
| `../src/harness/eval/ci.py` | Release-gate runner + JSON report (CI entrypoint: `python -m harness.eval.ci`) |
| `../src/harness/eval/retrieval_eval.py` | Institutional-RAG retrieval eval (recall / MRR / citation-validity / cross-tenant leaks) |
| `../src/harness/eval/config.py` | `EvalConfig` — judge/eval env surface (`HARNESS_JUDGE_*`, `HARNESS_EVAL_*`) |
| `../src/harness/eval/reasoning.py` | Reasoning-stripping for the judge response (per-family serialization) |
| `./run-gate.sh` | The supported one-command local release-gate run |
| `./promptfoo/` | promptfoo output-contract gate (run via `npx`) — see `promptfoo/README.md` |

## Commands

```bash
# Unit + calibration suite (offline, deterministic) — includes the ICC>=0.8 gate
conda run -n arcaenv pytest apps/harness/src/harness/tests/unit/eval -v

# DeepEval wrappers also run when the eval extra is installed:
conda run -n arcaenv pip install -e 'apps/harness[test,eval]'

# The supported one-command release-gate run
apps/harness/eval/run-gate.sh

# Release-gate over the pinned golden set directly (writes eval-report.json).
# Requires a configured judge endpoint (see "Model configuration" below).
conda run -n arcaenv python -m harness.eval.ci --output eval-report.json
```

`run-gate.sh` overrides: `JUDGE_BASE_URL`, `GOLDEN_SET`, `OUTPUT`, `CONDA_ENV`, `JUDGE_CTX`,
`LMS_BIN`, `PYTHON_BIN`, plus any `HARNESS_JUDGE_*` / `HARNESS_EVAL_*` variable (the script
only supplies defaults). `JUDGE_MODEL` is also overridable, but setting it bypasses the
DB-resident selection — use it only to A/B a candidate judge, never as the standing
configuration. `PYTHON_BIN` is an escape hatch for shells where the `conda` function is
unavailable; point it at `~/miniconda3/envs/arcaenv/bin/python`.

## How it works

### The golden set the gate runs: `curated-v2.0.0`

Full design spec: `../src/harness/eval/golden/curated_v2_spec.md`. Summary:

| | |
|---|---|
| Size | 12 synthetic source consultations -> 36 cases (12 `quality` + 24 `calibration`) -> 288 paired ratings (v1: 18 / 144) |
| Gradient | 5 designed levels, each with a named anchor exemplar: L5 gold, L4 presentation-only, L3 one wrong-context misalignment or one pertinent omission, L2 one major seeded error, L1 multiple major errors + structural collapse |
| Seeded taxonomy | one class per L2-L4 variant so a failure is attributable: `omission_material` (7), `fabrication` (6), `dose_error` (4), `temporal_error` (4), `laterality_error` (3), `misattribution` (3), `false_negation` (3), plus `verbosity`, `uncited_assertion`, `under_synthesis`, `omission_potentially_pertinent` |
| Stratification | 12 specialties; length short 12 / medium 15 / long 9; complexity low 12 / moderate 15 / high 9 |
| Split | `dev` 24 / `holdout` 12, stratified — so a threshold or labelling rule can never be tuned on the cases used to validate it |
| Provenance | AI-authored, rubric-literal, `clinician_review_status: pending`. Never presented as a clinician rating |
| PHI | PHI-free by construction — no names/dates/addresses, generic subjects, obviously-synthetic `SYN-####` record tags. Locked by a regex test |
| Review | `golden/review/curated_v2_review.md` (generated) -> `curated_v2_amendments.json` -> `apply_amendments.py` -> ships `curated-v2.1.0`, never an in-place edit |

`curated_v1.json` (18 cases: 12 quality + 6 calibration) is retained unmutated so historical
runs stay interpretable against the exact set they scored. `curated_v2` does not replace the
clinician-authored `clinical_v1` set (see `golden/README.md`) — it is the best set obtainable
without a clinician panel, and is explicitly the input to one.

### Golden-set lanes — quality vs calibration

A `GoldenCase.role` field separates two different eval purposes so the release gate is
well-posed (a high pooled PDSQI mean and deliberately-bad discriminator notes cannot both live
in one pool):

| `role` | `generated_note` is... | Feeds |
|---|---|---|
| `quality` (default) | a high-quality reference exemplar | PDSQI quality aggregates (accurate / thorough / mean) and faithfulness |
| `calibration` | a range-spanning / adversarial note (may have a deliberate flaw) | judge<->reference agreement (ICC / Gwet AC2) only — excluded from the quality mean |

Every case is still scored by the judge and appears in the per-case report; `role` only
controls which cases feed which aggregate. Faithfulness is a quality-lane metric, so it does
not run on calibration cases.

### Judge calibration levers

All opt-in via `HARNESS_JUDGE_*` env; defaults preserve the prior single-pass behaviour.

| Env | Default | Effect |
|---|---|---|
| `HARNESS_JUDGE_ANCHORED` | `false` | Append rubric-faithful per-score guidance + 2 balanced exemplars to the prompt. Reduces a small judge's two main biases: over-penalising a single omission, and letting an inaccurate assertion bleed into unrelated dimensions |
| `HARNESS_JUDGE_SEED` | `none` | Base decoding seed. For K=1 it is the deterministic seed; for K>1, sample i uses `seed + i` so samples are distinct but reproducible. `none` draws a fresh random seed per sample |
| `HARNESS_JUDGE_SELF_CONSISTENCY` | `1` | Sample the judge K times and take the per-dimension median. `1` = single deterministic pass. Median reduces variance, not bias |
| `HARNESS_JUDGE_SC_TEMPERATURE` | `0.2` | Decoding temperature for K>1 diversity samples |

### Model configuration (judge is model-agnostic)

Selected entirely via env (`HARNESS_JUDGE_*`); nothing is hardcoded.

| Provider | `HARNESS_JUDGE_PROVIDER` | Key env |
|---|---|---|
| LM Studio / vLLM / OpenAI-compatible (default, <=20B) | `openai_compat` | `HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL`, `HARNESS_JUDGE_MODEL` |
| Azure OpenAI (large) | `azure` | `HARNESS_JUDGE_AZURE_ENDPOINT`, `HARNESS_JUDGE_AZURE_API_KEY`, `HARNESS_JUDGE_AZURE_DEPLOYMENT` |
| AWS Bedrock (large) | `bedrock` | `HARNESS_JUDGE_MODEL` (model id), `HARNESS_JUDGE_BEDROCK_REGION` |

Swapping the judge backend is a config change, not a code edit: `harness.eval.judge.providers.build_judge_client`
dispatches on `HARNESS_JUDGE_PROVIDER` and raises (fail-closed, never a silent local fallback)
when the chosen provider's config is incomplete.

Additional per-family reasoning-control knobs (all `HARNESS_JUDGE_*` env; defaults are safe
everywhere):

| Env | Default | Effect |
|---|---|---|
| `HARNESS_JUDGE_OUTPUT_MODE` | `with_explanation` | `score` = compact score-only JSON; `with_explanation` = per-dimension rationale. `score` is markedly more reliable for <=~7B judges |
| `HARNESS_JUDGE_MAX_TOKENS` | `8192` | Completion budget. Must stay <= the judge's loaded context window — larger makes LM Studio reject/terminate the request (`400 {'error':'terminated'}`) |
| `HARNESS_JUDGE_TRANSIENT_RETRIES` / `_BACKOFF_S` | `3` / `12.0` | Bounded app-level retry (linear backoff) for transient backend failures (a local model engine terminated/unloaded under load, a dropped connection, a momentary 5xx). A genuinely-down backend still aborts once retries are exhausted |
| `HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT` | `json_object` | `response_format.type` sent on json_mode calls. LM Studio rejects `json_object` (HTTP 400) and small models choke under a strict `json_schema` grammar — set `text` for LM Studio |

The judge reads the server-split `reasoning_content` / `reasoning` field when `content` is
blank; otherwise it strips reasoning forms (`<think>` blocks, harmony analysis/commentary
channels, Gemma `<unused94>thought` / `<|think|>` markers, markdown fences) and extracts the
final balanced JSON object, so a stray `{` inside leaked chain-of-thought never wins over the
real score object.

**Reasoning mode itself is not an env var.** `HARNESS_JUDGE_REASONING_MODE`,
`HARNESS_JUDGE_SUPPRESS_REASONING`, and `HARNESS_JUDGE_EXTRA_BODY` were removed — they are now
platform settings a platform admin writes without a redeploy, both defaulting to reasoning off:

| Setting | Lever | Default | Reaches |
|---|---|---|---|
| `harness.judge.reasoningMode` | prompt — `auto` \| `think` \| `none` | `none` | the PDSQI-9 rubric judge (this gate, `/eval/run`) |
| `harness.judge.reasoningEffort` | wire — `extra_body.reasoning_effort` | `minimal` | every judge call, including the live groundedness / citation-verify sensors |

The CI gate runs on the in-code floor (`none` / `minimal`), not on the control plane: no
gateway is reachable from a GitLab job, and a gate wants one fixed, reproducible posture. The
deployed judge follows the registry. Full detail:
`docs/implementation/TASK-968-Reasoning-Off-For-Text-Generation/README.md`.

### Judge selection is DB-resident and fail-closed

A model id is never an env var and never a literal in code — the eval gate resolves the same
row the Temporal runtime resolves:

```
AiRoutingPolicy(taskKey='harness.judge', isDefault, enabled, ACTIVE) -> modelId
  -> AiModel(id, ENABLED) -> (provider, sourceUri)
```

- Order is tenant -> SYSTEM, two tiers. With no request tenant (the gate's normal case) it
  resolves SYSTEM only, never a customer tenant.
- Fail closed: missing / disabled / unreachable / unknown-provider raises
  `JudgeSelectionUnavailable` and exits 2. There is deliberately no env fallback.
- Env still supplies the connection config (`base_url`, `api_key`, decoding knobs) — the same
  selection-vs-connection split the runtime uses.
- The read is a direct, read-only SQL query with `asyncpg` lazily imported, so the harness
  service keeps its "no DB client" property and only this offline tool pays for it — the same
  sanctioned-exception shape as `apps/guardrail/core/tenant_config.py`.

```bash
# what the gate will use, without running it
PYTHONPATH=src conda run -n arcaenv python -m harness.eval.judge.selection --field model
```

### Live gate results — current status

**2026-08-18, `curated-v2.0.0`: FAIL on ICC — 0.7306.** Full run via `run-gate.sh` against the
owner's live LM Studio, judge resolved from the DB (`gemma-4-e4b-it-qat`, SYSTEM
`harness.judge`), 36/36 cases scored, 0 dropped, sequential, wall clock 3555 s (59.3 min).

| Metric | Threshold | 2026-08-18 (`curated_v2`) | 2026-08-17 (`curated_v1`) | Gate |
|---|---|---|---|---|
| `pdsqi_accurate` | >= 4.0 | 4.833 | 5.00 | pass |
| `pdsqi_thorough` | >= 4.0 | 4.833 | 5.00 | pass |
| `pdsqi_mean` | >= 4.0 | 4.875 | 5.00 | pass |
| `faithfulness` | >= 0.85 | 0.9938 | 0.9920 | pass |
| `icc` | >= 0.8 | 0.7306 | 0.6568 | **FAIL** |
| `gwet_ac2` | (reported) | 0.9196 | 0.9439 | — |
| n (paired ratings) | — | 288 | 144 | — |
| Gate status | | FAIL | FAIL | FAIL |

Decomposition (`python -m harness.eval.calibration.breakdown`, offline, no model calls) found:
the residual is concentrated in two presentation dimensions where the judge has almost no
dynamic range (`comprehensible` is a literal 5 on all 36 cases, ICC -0.0000; `succinct` SD
0.401, ICC 0.148), while the clinically load-bearing dimensions agree well (`accurate` 0.8661,
`useful` 0.8653, `organized` 0.7974, `synthesized` 0.7929). The held-out split (`holdout` ICC
0.7682) is *higher* than `dev` (0.7045), so the labelling rules were not fitted to the cases
they are judged on. The judge under-uses the bottom of the scale on catastrophic notes: on the
four L1 anchors it scores mean 2.719 against a reference of 1.750. De-biasing the judge's
systematic +0.1319 leniency lifts ICC only 0.7306 -> 0.7350 — the residual is genuine rank
disagreement, not a fixable offset.

Historical predecessor run (2026-08-17, `curated-v1.0.0`, `google/gemma-4-e4b`, 18/18 cases,
36.7 min wall clock): also FAIL on ICC (0.6568), for a different reason — the quality lane had
**zero judge variance** (a literal 5 on all 8 dimensions of all 12 quality cases), which cannot
contribute to a variance-ratio statistic no matter how good the agreement is (Gwet AC2 on the
same data: 0.9861). `curated_v2` was built specifically to design variance into that lane.

Earliest recorded run (2026-06-07, `google/gemma-4-e4b`, 4096-token context, `curated_v1`,
18/18 cases): PASS — `icc` 0.821, `pdsqi_mean` 4.86, `faithfulness` 0.990. Superseded as the
primary evidence by the runs above, which do not reproduce it; see "Context-length finding"
and "the model, not the context" below for why.

### What actually caused the earlier PASS: the judge model, not the context

Two separate hypotheses were tested and both narrowed to one cause. First, whether the 2026-06-07
PASS was a context-window effect (4096 discriminating vs 131072 not): **falsified** — the same
six cases, same prompt, `temperature=0`, `seed=7`, scored byte-identical across a 32x range of
loaded context (4096/8192/32768/131072). The only real effect of a small window is silent
truncation: at 4096, one case's completion (1954 tokens) plus prompt (2142) hit exactly 4096,
LM Studio returned `finish_reason: length`, the JSON was unparseable, and `GoldenSetRunner`
silently dropped the case — so a small window must be pinned for headroom, never for
calibration (`run-gate.sh` pins 8192 with `max_tokens` 4096 for this reason).

Second, comparing `google/gemma-4-e4b` (what the 2026-08-17 gate ran) against
`gemma-4-e4b-it-qat` (the owner's chosen judge) on the same six cases at the same 8192 context:
`google/gemma-4-e4b` returns a flat 5 on all 8 dimensions of all 3 quality cases — the
zero-variance signature that drove `icc -> 0.0000`; `gemma-4-e4b-it-qat` does not, and is also
roughly 1.8x faster. The gate had been running a different model than the platform's own
`harness.judge` selection; that divergence is now structurally impossible since the gate
resolves the DB-resident row (see "Judge selection" above).

### Label provenance

Both shipped fixtures carry `clinician_pdsqi` reference labels that are curated/synthetic,
rubric-derived — authored from the Epic PDSQI-9 grade descriptors, **not** collected from real
clinicians. The ICC reported by a live run is therefore judge<->curated-reference agreement,
not judge<->real-clinician agreement. A green gate proves the harness + judge are wired and
internally consistent against a defensible rubric; it does not by itself constitute clinical
validation. Production calibration still requires the real clinician-authored golden set (see
`golden/README.md`): >= 50 (spec: N >= 132) transcript->note cases across specialties/tenants,
each with real human-in-the-loop clinician PDSQI ratings, owned + versioned by a clinical SME.

### Historical corpus-level eval deltas (2026-06-07)

Two earlier, standalone corpus runs (kept for the record; not part of the current gate):

- **Phase 2 — runtime inferential sensors** (`harness.eval.inferential_corpus_eval`) ran the
  live `GroundednessSensor` + `SafetySensor` over all 18 `curated_v1` cases. Corpus aggregate
  (groundedness threshold 0.8): `groundedness` mean 0.844 (quality lane 0.983, calibration lane
  0.567), 14/18 PASS; safety 17/18 PASS on the full 7-dimension screen, one deterministic
  false-positive (a benign pediatric otitis note tripping `harm`). Fabrication and numeric
  dose-falsification cases were caught (groundedness 0.000 and 0.500 respectively);
  disorganization and missing-citations did not lower groundedness, correctly, since those
  flaws are not entailment failures and are owned by other sensors. Claims were derived
  eval-side by sentence-segmenting each note (production derives them from live NLP NER), so
  absolute numbers would move with real NER claims though the direction should not. The default
  safety path has since migrated from Ollama `ibm/granite3.3-guardian:8b` to LM Studio
  `granite-guardian-4.1-8b` (Ollama was removed from the platform entirely) — these figures were
  not re-run against the new default.
- **Phase 3 — retrieval eval** (`harness.eval.retrieval_eval`) indexed a synthetic 9-chunk,
  2-tenant corpus into an in-memory Qdrant with the real `HybridRetriever` and the real
  in-process fastembed BM25 sparse embedder (dense embedder and cross-encoder reranker
  stubbed). Result on `golden/fixtures/retrieval_synthetic_v0.json`: `recall_at_k_mean` (k=5)
  1.000, `hit_at_k_rate` 1.000, `mrr` 1.000, `citation_validity_rate` 1.000, `cross_tenant_leaks`
  0. This is a wiring + tenant-isolation proof on a tiny, well-separated synthetic set (locked
  in CI by `tests/unit/eval/test_retrieval_eval.py`), not a discrimination/recall benchmark. A
  release-grade retrieval eval still needs a clinician-curated retrieval golden set and the
  live dense-embedding + reranker channels (BAAI/bge-m3 in LM Studio, the `hope-reranker` TEI
  service) scored, not just the BM25 lexical channel.

## Gotchas

- **The eval gate is a local/scheduled quality check, not a per-MR blocking CI job** (owner
  decision, 2026-08-17): LM Studio has no CI-runnable container image, and standing up a
  dedicated self-hosted runner just to host a desktop app was explicitly declined. So
  `harness-eval-gate` in `.gitlab/ci/test.yml` stays behind an explicit `RUN_INFRA_TESTS=true`
  opt-in and carries `allow_failure: true` — it will never redden an ordinary shared-CI
  pipeline. The supported way to get a real, blocking PASS/FAIL verdict before merging
  harness-generator changes is to run `apps/harness/eval/run-gate.sh` locally against your own
  running LM Studio instance, before merging any change to the harness generator, its prompts,
  the judge config, or the golden set — and on a periodic (weekly) cadence on a machine that
  already runs LM Studio, since nothing in shared CI will otherwise tell you this gate rotted.
- **Warm-load matters more than anything else when timing a run.** LM Studio JIT-loads a model
  on first use. Measured on the owner's instance: the cold call took 19.9 s and the very next
  warm call took 0.098 s — a 200x difference for the same request. `run-gate.sh` pays that load
  once up front and prints both numbers so a cold-call extrapolation does not overestimate the
  run time by 10x or more.
- **A small loaded context truncates silently, it does not calibrate.** A completion that hits
  the context ceiling returns `finish_reason: length`, produces unparseable JSON, and
  `GoldenSetRunner` silently drops the case — shrinking `n` without an error. Context must be
  pinned for headroom (prompt + reasoning + JSON), never chosen to influence scores; scores
  measured identical across a 32x range of context in the same run.
- **Do not "fix" a failing ICC by moving the threshold.** `EvalConfig.icc_gate_enabled=false`
  exists for a judge whose ICC is structurally uninformative (a rejected backend once measured
  ~-8.3e-17), not for a real, well-defined moderate/borderline reading. 0.8 is drawn from the
  PDSQI-9 literature. Lowering the bar or disabling the gate converts a true negative into a
  green light — the honest resolutions are judge-side (a judge with usable dynamic range on the
  low-signal dimensions) or reference-side (clinician review of the golden set), and both are
  named as open rather than acted on.
- **The promptfoo contract step is separate from the ICC gate** and can pass while the ICC gate
  fails (and vice versa) — `run-gate.sh` runs both and reports each status independently.

## Related

- [`golden/README.md`](../src/harness/eval/golden/README.md) — golden-set sources, provenance
  tiers, and the clinician review loop
- [`promptfoo/README.md`](./promptfoo/README.md) — the offline output-contract gate
- [`06-python-services.md`](../../../.claude/rules/06-python-services.md) — the sanctioned
  direct-DB-read exception this gate's judge selection relies on
- [`apps/harness/README.md`](../README.md) — the live document loop this eval harness validates
  offline
