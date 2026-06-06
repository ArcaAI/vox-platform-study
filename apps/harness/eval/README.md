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
| `../src/harness/eval/golden/` | Golden-set runner + pluggable sources + synthetic fixture |
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
```

## Model configuration (judge is model-agnostic)

Selected entirely via env (`HARNESS_JUDGE_*`); nothing is hardcoded.

| Provider | `HARNESS_JUDGE_PROVIDER` | Key env |
|---|---|---|
| LM Studio / vLLM / OpenAI-compatible (default, ≤20B) | `openai_compat` | `HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL`, `HARNESS_JUDGE_MODEL` |
| Azure OpenAI (large) | `azure` | `HARNESS_JUDGE_AZURE_ENDPOINT`, `HARNESS_JUDGE_AZURE_API_KEY`, `HARNESS_JUDGE_AZURE_DEPLOYMENT` |
| AWS Bedrock (large) | `bedrock` | `HARNESS_JUDGE_MODEL` (model id), `HARNESS_JUDGE_BEDROCK_REGION` |

## OPEN PREREQUISITE — real golden set

The shipped `synthetic_v0.json` is **synthetic, non-clinical** wiring data. The
Phase-0 exit gate (≥50 cases scored; judge ICC ≥ 0.8) requires the **real
clinician-authored golden set** (HLD §7.5 #1/#3), owned + versioned by a clinical
SME. Drop it in by implementing a `GoldenSetSource` (or pointing
`HARNESS_GOLDEN_SET_PATH` at it) — no runner changes needed.
