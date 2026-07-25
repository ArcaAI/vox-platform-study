# TASK-347 — STT Cadence Punctuation Load Failure

- **Ticket:** TASK-347
- **Type:** bugfix (config + logging)
- **Created:** 2026-06-10
- **Updated:** 2026-06-10
- **Status:** Completed

## Requirement Analysis

### Description

At STT (`apps/stt`, FastAPI, :8861) startup the Cadence punctuation model
**downloads** successfully but **fails to load**, printing a raw `FATAL` traceback
into the boot log:

```
File ".../cadence/punctuation_model.py", line 151, in _load_model_and_tokenizer
  self.model = AutoModel.from_pretrained(...)
File ".../transformers/modeling_utils.py", line 4619, in mark_tied_weights_as_initialized
  param = self.get_parameter(tied_param)
File ".../torch/nn/modules/module.py", line 840, in get_parameter
AttributeError: Sequential has no attribute `weight`
FATAL: Error loading model: Sequential has no attribute `weight`
{"event": "Punctuation service initialization failed (non-fatal)", "level": "warning"}
```

The failure is wrapped non-fatally (STT still starts), so the runtime impact is
degraded transcript punctuation **plus** a scary traceback on every boot.

### Acceptance Criteria

1. Boot log no longer prints a raw `FATAL` traceback for this non-fatal condition.
2. Any genuine load-failure path logs **one** clean warning line, with the
   traceback detail at `debug` level only.
3. No mutation of the shared conda env `arcaenv`; no service restarts; no
   `.env`/DB changes; fix is durable in the repo.
4. Verified with unit tests only (the live :8861 stack is left running).

## Current State Evaluation

### Root cause (version facts)

| Package | Installed (arcaenv) | Declared requirement | Note |
|---|---|---|---|
| `transformers` | **5.5.4** | cadence wants `>=4.51.3` (no upper bound) | 5.x added `_finalize_model_loading` → `mark_tied_weights_as_initialized` |
| `cadence-punctuation` | **1.1.0** (latest on PyPI) | `transformers>=4.51.3`, `torch>=2.1.0` | No newer release; predates transformers 5.x |
| `torch` | 2.8.0 | `>=2.1.0` | fine |

Confirmed in arcaenv (read-only): `transformers.__version__ == "5.5.4"` and
`PreTrainedModel.mark_tied_weights_as_initialized` / `_finalize_model_loading`
both exist. These finalize hooks are **new in transformers 5.x**. Cadence's
custom Gemma-3 token-classification model exposes a tied-weights key that
resolves to its classification head — an `nn.Sequential` — and transformers 5.x's
`get_parameter(tied_param)` only resolves leaf `nn.Parameter`s, not submodules,
so it raises `Sequential has no attribute 'weight'`. cadence-punctuation 1.1.0
was released before transformers 5 and declares no upper bound, so pip resolved
5.5.4 and broke the loader. The model itself is fine on transformers <5.

### Usage verdict — is punctuation load-bearing?

**No, not for the current English clinical-workspace flow.** Punctuation
application is gated per-pipeline by `postprocessing.punctuation.enabled`
(default `True` in every seeded pipeline), but the seeded defaults are:

- `streaming_pipeline_slug = turbo-whisper-large-v3` → ASR `openai/whisper-large-v3-turbo`
- `batch_pipeline_slug = production-whisper-large-v3` → ASR `openai/whisper-large-v3`

Whisper emits punctuation and casing natively, so Cadence post-punctuation is
**redundant** for the Whisper pipelines (which are everything the clinical
workspace uses). Cadence (ai4bharat) is aimed at Indic ASR that does not
self-punctuate. Net: with Cadence down, the English mic-consult flow loses
nothing today.

### Constraint matrix (transformers consumers in arcaenv)

| App | transformers constraint | Source |
|---|---|---|
| **stt** | **`==5.5.4`** (hard pin) | `apps/stt/pyproject.toml` `[ml]` — required by `optimum==2.1.0` + ORT Whisper-turbo ONNX, its own ASR |
| nlp (:8864) | `>=4.48.0` | `apps/nlp/pyproject.toml` — flexible |
| guardrail (:8863) | `>=4.40.0` (via `gliner2-onnx`) | flexible |
| smr (:8862) | none | no transformers |
| harness (:8866) | none | no transformers |
| cadence-punctuation | `>=4.51.3` but broken on 5.x | needs transformers <5 to load |

**Implication:** transformers cannot be downgraded in `arcaenv` — STT's own
primary ASR pins `transformers==5.5.4`, and the env is shared. There is no newer
cadence release. So a dependency downgrade is **not a safe option**; Cadence and
STT's ASR have mutually exclusive transformers requirements in one env.

## Implementation Plan (approved approach)

Config-level disable + clean logging (smallest safe fix; no env mutation):

1. Add `PUNCTUATION_ENABLED` setting (default **false**).
2. `punctuation/service.initialize()`: when disabled, log one INFO line and
   return without importing/constructing Cadence (eliminates Cadence's own
   `FATAL` traceback at boot).
3. `punctuate` / `punctuate_batch` / `punctuate_sync`: pass text through
   unchanged when disabled (no per-utterance reload/crash during a live consult).
4. Harden the residual failure path in `main.py` and `worker.py`: keep one clean
   `warning`, move the traceback to `debug`.
5. TDD: failing tests first in `tests/unit/punctuation/test_service.py`.

## Implementation Summary

### Files changed

| File | Purpose |
|---|---|
| `apps/stt/src/stt/core/config/settings.py` | New `punctuation_enabled: bool = False` (env `PUNCTUATION_ENABLED`), documented rationale. |
| `apps/stt/src/stt/punctuation/service.py` | Module flag `_enabled`; `initialize()` skips Cadence + logs one INFO line when disabled; `punctuate`/`punctuate_batch`/`punctuate_sync` pass through when disabled. |
| `apps/stt/src/stt/main.py` | API-process punctuation init failure → one clean `warning` + `debug` exc_info. |
| `apps/stt/src/stt/worker.py` | Batch-worker punctuation init failure → one clean `warning` + `debug` exc_info. |
| `apps/stt/tests/unit/punctuation/test_service.py` | RED→GREEN tests for the disabled path (init skip + 3 passthrough entry points); reset `_enabled` in the autouse fixture. |

Both the API process (`main.py` lifespan) and the batch worker
(`worker.py.initialize_services`) call `punctuation_service.initialize()`, so the
single service-level gate covers both processes.

### Behaviour change

- **Default is now OFF.** Cadence is not loaded; the boot traceback is gone.
- Re-enable (only with a transformers/cadence combo known to load) via env
  `PUNCTUATION_ENABLED=true`. Note: this will NOT load under the current pinned
  transformers 5.5.4 — it requires transformers <5, which conflicts with STT's
  own ASR pin, so it must run in a **dedicated** environment, not `arcaenv`.

### Deviations

- The task allowed an isolated throwaway-env experiment to load the model on an
  older transformers. It was **skipped deliberately**: (a) the chosen fix is
  config-level, proven by unit tests; (b) a transformers downgrade is unusable
  in the shared `arcaenv` regardless of whether it loads in isolation; and
  (c) loading a ~1 GB model risked RAM contention while the user's live :8861
  stack (with its ~4 GB ASR) was mid-test. Root cause is established from the
  stack trace + version facts above.

## Verification (evidence)

Run from `apps/stt` with `conda run -n arcaenv`:

```
$ python -m pytest tests/unit/punctuation/test_service.py -q
23 passed in 2.05s

$ python -m pytest tests/unit/streaming/test_inference_punctuation.py \
    tests/unit/test_batch_service.py::TestBatchPostprocessPunctuation -q
20 passed in 0.64s

$ python -m pytest tests/unit/test_settings.py -q
29 passed in 2.12s

$ ruff check src/stt/{punctuation/service.py,core/config/settings.py,main.py,worker.py}
All checks passed!
```

Real default-settings probe (no mocks):

```
$ python -c "import asyncio; from stt.punctuation import service; \
service.initialize(); print(service._enabled, service._models, \
asyncio.run(service.punctuate('hello world how are you')))"
[info] Punctuation restoration disabled (PUNCTUATION_ENABLED=false); Cadence model not loaded
False {} hello world how are you
```

### What changes on next STT restart

- Boot log shows a single line:
  `Punctuation restoration disabled (PUNCTUATION_ENABLED=false); Cadence model not loaded`
  — no `FATAL` traceback. English Whisper transcripts are unchanged (Whisper
  already punctuates).

### Optional follow-up (not required for current flows)

If/when Indic punctuation is needed, run Cadence in a **dedicated** Python env
with `transformers>=4.51.3,<5` and `cadence-punctuation==1.1.0`, set
`PUNCTUATION_ENABLED=true` there, and point the relevant pipeline at it. Do not
relax STT's `transformers==5.5.4` pin in `arcaenv`.

## Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-10 | Initial fix: default Cadence punctuation OFF; skip load + clean one-line logging; TDD tests. | settings.py, punctuation/service.py, main.py, worker.py, tests/unit/punctuation/test_service.py |
