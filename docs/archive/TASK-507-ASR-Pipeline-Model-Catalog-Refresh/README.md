# TASK-507 — ASR Pipeline & Model Catalog Refresh

**Status**: Review

## Requirement Analysis

The user supplied a new 9-pipeline ASR product matrix (table) plus refreshed
model lists for LLM/guardrail, NLP, and TTS tasks, intended to update the seed
data shipped by TASK-505 (STT pipeline restructure) and TASK-506 (AI model
registry consolidation) eight days earlier.

A field-level diff against the current seed data surfaced that this is **not**
a seed-only change: three engines named in the new spec — a `whisper.cpp`-served
GGUF `whisper-large-v3-turbo`, `DeepFilterNet3` denoise, and
`microsoft/wavlm-base-plus-sv` diarization embedding — have zero implementation
in `apps/stt` today. The new spec also flips the platform default pipeline
to a variant with no pre/post-processing, and reinstates a model
(`DeepFilterNet3`) that TASK-506 deliberately soft-retired.

Four blocking decisions were confirmed with the user (via `AskUserQuestion`)
before planning proceeded:

| Decision | Resolution |
|---|---|
| Scope for whisper.cpp / DeepFilterNet3 (no existing processor) | **Full-stack in this ticket** — implement real Python processors, not just seed rows |
| Diarization embedding (spec says WavLM; TASK-505 D1 chose ECAPA-TDNN + has a pending pgvector cutover runbook) | **Keep ECAPA-TDNN** — do not adopt WavLM, do not reopen D1 |
| Default pipeline (spec flips default to the new no-pre/no-post GGUF pipeline) | **Adopt the flip as specified** — new GGUF "Transcription only" pipeline becomes `isDefault` across SYSTEM + every tenant |
| DeepFilterNet3 (soft-retired in TASK-506 in favor of RNNoise) | **Reinstate** — build a real processor, add a fresh catalog row |

Classification: **feature** (new ASR/denoise engines) + **refactor** (pipeline
catalog restructure, model catalog precision updates).

## Current State Evaluation

Full research (2 explore agents + 3 targeted research agents + direct file
reads) established:

- **Pipelines**: `packages/database/src/prisma/db_main/seed/06-stt.ts` seeds an
  8-pipeline matrix (`production-whisper-large-v3` [default, safetensor],
  `turbo-whisper-large-v3`, `whisper-turbo-no-postprocessing`,
  `whisper-turbo-no-preprocessing`, `azure-speech-transcription`,
  `azure-foundry-mai-transcribe`, `production-faster-whisper-turbo-int8`,
  `parakeet-nemotron-streaming`) + 4 legacy/template pipelines, cloned in full
  to every customer tenant (`CUSTOMER_TENANT_ASR_PIPELINES`,
  `GLOBAL_TENANT_ASR_PIPELINES`) per the TASK-505/356 full-parity policy.
- **Models**: `seed/ai-models/{audio,llm,nlp,tts}.ts` — 26 rows total (9 audio,
  10 LLM/guardrail, 2 NLP, 5 TTS), consolidated from 60 by TASK-506.
  `AiModel.format` is a Prisma enum (`AiModelFormat`); `computeType` is a free
  string that already holds exact quantization strings for some GGUF rows
  (e.g. the parakeet nemotron row's `q8_0`) and generic buckets
  (`float16`/`int8`) for others.
- **Processor architecture** (`apps/stt/src/stt/processors/`): a
  `(kind, name)` registry with lazy-loaded specs exists and is fully used for
  `kind="asr"` (8 registered engines including `PARAKEET_CPP`, the closest
  precedent for a new native-runtime ASR engine). It is declared but **never
  used** for `kind="denoise"` — RNNoise is hardcoded independently in
  `streaming/denoiser.py` (`StreamingDenoiser`) and
  `transcription/preprocessing.py` (`AudioPreprocessor._apply_denoise`), and
  `preprocessing.denoise` YAML has no engine-selection field today.
- **ECAPA-TDNN diarization embedding** is a real, working implementation
  (`stt/diarization/speechbrain_embedding.py`) — but only per-pipeline
  opt-in via an inline `models.embedding` YAML block (slug-based resolution is
  a documented resolver limitation); the system-wide default extractor and the
  persistent `UserVoiceProfile.embedding` column remain on the pre-TASK-505
  `pyannote/wespeaker-voxceleb-resnet34-LM` (256-dim), pending an
  owner-scheduled cutover. No code changes needed for this ticket — confirmed
  status quo only.
- **DeepFilterNet3** has zero code history in `apps/stt` (`git log -S` across
  the whole history returns nothing under `apps/stt/src`) — it only ever
  existed as an `AiModel` catalog slug (`deepfilternet-v3`), referenced as a
  comment and in Python parser test fixtures, then soft-retired in TASK-506.
  This is a from-scratch addition, not a resurrection of working code.
- **whisper.cpp**: no Python binding is referenced anywhere in the repo
  (`pyproject.toml`, `uv.lock`); the closest precedent (`parakeet_cpp`) is
  itself an unpinned `try/import` with a ctypes fallback and no Docker build
  step wired up yet.

Full diff tables (pipelines, LLM/guardrail, TTS) and the phased implementation
plan are in the "Implementation Plan" section below (carried over verbatim
from the approved plan file).

## Implementation Plan

### Scope

**In scope:**
1. New `AiModelFormat.WHISPER_CPP` Prisma enum value + migration + Python sync.
2. New whisper.cpp ASR engine in `apps/stt` (loader, adapter, registry spec, dispatch, settings, dependency).
3. New DeepFilterNet3 denoise engine in `apps/stt` — first real use of the `(kind="denoise", ...)` processor registry.
4. Pipeline catalog restructure: update pipelines #1/#3/#4 (GGUF variants) in place, add a new GGUF "Transcription only" pipeline as the new default, leave #9 (`turbo-whisper-large-v3`, safetensor) and #5–#8 (azure/azure-foundry/faster-whisper/parakeet) alone except a quantize bump on faster-whisper.
5. LLM/guardrail catalog: precision-level `computeType` updates on 9 existing rows.
6. TTS catalog: `Kokoro` row `sourceUri`/format correction.
7. Admin-console `AiModelFormat` picklist: add `WHISPER_CPP`.

**Explicitly out of scope:**
- WavLM-base-plus-sv diarization embedding.
- The pre-existing pgvector 192-dim ECAPA cutover runbook (TASK-505 D1).
- Pre-existing admin-console format-picklist drift for `ONNX_OPTIMUM`/`AZURE_SPEECH`/`AZURE_FOUNDRY`/`PARAKEET_CPP`/`CLOUD_API` — spawned as a separate follow-up task.
- NLP catalog — spec matches current exactly.

### Diff summary

#### Pipelines

| # | Spec pipeline | Current mapping | Action |
|---|---|---|---|
| 1 | `[...gguf] Full features` | `production-whisper-large-v3` (today's default, safetensor+RNNoise) | Update in place: `models.asr` → whisper.cpp GGUF slug, `models.denoise` → DeepFilterNet3 slug, keep VAD/resample/normalize/ECAPA/full post. `isDefault` → false. |
| 2 | `[...gguf] Transcription only` — **new default** | *(none — safetensor "turbo" stays #9)* | New pipeline, "turbo" shape (no pre, ECAPA+stabilizer, no post) with GGUF ASR. `isDefault` → true, SYSTEM + every tenant. |
| 3 | `[...gguf] No Postprocessing` | `whisper-turbo-no-postprocessing` | Update in place: GGUF ASR + DeepFilterNet3, post stays off. |
| 4 | `[...gguf] No Preprocessing` | `whisper-turbo-no-preprocessing` | Update in place: `models.asr` → GGUF slug only. |
| 5 | `[azure]` Speech-to-Text | `azure-speech-transcription` | No change. |
| 6 | `[azure]` MAI-Transcribe 1.5 | `azure-foundry-mai-transcribe` | No change. |
| 7 | `[faster-whisper]` | `production-faster-whisper-turbo-int8` | Model row only: `computeType` int8→f16, memory bump. Slug stays (cosmetic mismatch, flagged). |
| 8 | `[parakeet.cpp]` nemotron streaming | `parakeet-nemotron-streaming` | No change — exact match. |
| 9 | `[whisper-large-v3-turbo]` Transcription only (safetensor) | `turbo-whisper-large-v3` | No change — already the exact shape. |

RNNoise's `rnnoise` row becomes unreferenced by the matrix once #1/#3 move to
DeepFilterNet3 — stays registered (ENABLED) as the Python-side default/fallback,
not retired ("keep all AI models").

#### Non-STT models

| Catalog | Rows changed | Change |
|---|---|---|
| LLM/guardrail | 9 of 10 | `computeType` generic bucket → exact quant string (`nvfp4`, `Q4_0`, `Q8_0`, `q4_k_s`, `q4_0`×3, `q5_k_m`, `q5_k_xl`). |
| NLP | 0 | Exact match already. |
| TTS | 1 of 5 | `kokoro`: `sourceUri` → `'hexgrad/Kokoro-82M'`; format kept `ONNX` (tts loader dependency; spec's "tensor" treated as descriptive). |

### Phased plan

**Phase 0** — this ticket doc.

**Phase 1** — Prisma schema: append `WHISPER_CPP` to `AiModelFormat`
(`enums.prisma`), additive migration (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`,
mirroring `20260717000000_task_505_stt_engine_enums`), `pnpm db:generate`,
`pnpm gen:model` (regenerates `packages/domains` enum — CI drift gate
`generate-data-model-check` depends on this), mirror in
`seed/ai-models/shared.ts`. Do **not** reuse the existing `GGUF` value (already
claimed for LM-Studio LLM rows and explicitly treated as catalog-only by
`config_reader._to_model_config`).

**Phase 2** — whisper.cpp ASR engine in `apps/stt`, following the
`PARAKEET_CPP` precedent file-by-file: `pipeline/dto.py` (enum + aliases),
`processors/asr_capabilities.py` (registration, streaming+batch capability),
`processors/asr_engines.py` (format map + adapter), `models/whisper_cpp_loader.py`
(new), `models/cache.py` (loader registration), `streaming/whisper_cpp_asr.py`
(new), `transcription/batch_service.py` (`_run_whisper_cpp_inference`),
`streaming/session_manager.py` (`_make_whisper_cpp_callable`),
`core/config/settings.py` (new settings), `turbo.json`/`.env.example`,
dependency + `uv lock`, TDD tests (format map, provider shorthand, adapter
contract, loader, registry manifest, health payload).

**Phase 3** — DeepFilterNet3 denoise engine — the first real use of the
`(kind="denoise", ...)` processor registry: `DenoiseConfig.engine` field +
parser support, new `processors/denoise_capabilities.py` +
`processors/denoise_engines.py` (migrates RNNoise into the registry too, adds
DeepFilterNet3), both dispatch sites (`session_manager.py`,
`transcription/preprocessing.py`) switch to registry-driven selection,
dependency + `uv lock`, new `AiModel` catalog row (fresh slug `deepfilternet3`,
not resurrecting the retired `deepfilternet-v3`), TDD tests.

**Phase 4** — `packages/database` seed restructure (`06-stt.ts`): update
`PIPELINE_CONFIGS.production`/`whisper_no_postprocessing`/`whisper_no_preprocessing`,
add `PIPELINE_CONFIGS.whisper_turbo_gguf_default`, flip `isDefault` across
`DEFAULT_ASR_PIPELINES` + `CUSTOMER_TENANT_ASR_PIPELINES` +
`GLOBAL_TENANT_ASR_PIPELINES`, update `EXPLICIT_TENANT_PIPELINE_SLUGS` +
`deriveRemainingTenantPipelines` exclusions, update `91-user.ts`
`default-stt-pipeline` setting + check `09-consultation.ts`, bump
faster-whisper `computeType`, update 9 LLM/guardrail rows, update Kokoro TTS
row. Update `seed/__tests__/*.test.ts` expectations.

**Phase 5** — admin-console: add `WHISPER_CPP` to
`features/ai-models/api/types.ts` + `components/model-meta.ts`
`FORMAT_OPTIONS`. Spawn a separate task for the pre-existing 5-value drift.

### Verification criteria

- `pnpm --filter @arcaai/database test` green.
- `pnpm db:seed` idempotent ×2; per-tenant counts correct; exactly one
  `isDefault: true` pipeline per tenant, and it's the new GGUF pipeline.
- `pnpm py:stt:test:unit` green, incl. updated manifest/health-payload tests.
- `pnpm py:stt:lint`, `py:stt:typecheck` clean.
- Manual: `/api/v1/health` shows `whisper_cpp` with a resolved binding; a real
  batch transcription against the new default pipeline actually transcribes.
- `pnpm --filter @arcaai/admin-console build lint test` green.
- `pnpm lint` (root) clean.

## Implementation Summary

**Status: Review.** All 6 phases implemented and verified with real evidence
(not just written and assumed).

**Phase 1 — Prisma schema**: `WHISPER_CPP` added to `AiModelFormat`
(`enums.prisma`); migration `20260718000000_task_507_whisper_cpp_format_enum`
applied via psql against the local dev DB (additive `ALTER TYPE ... ADD VALUE
IF NOT EXISTS`, mirroring the TASK-505 precedent); `pnpm gen:model` regenerated
`packages/domains`'s enum (verified minimal diff — one file, one line).

**Phase 2 — whisper.cpp ASR engine** (`apps/stt`): implemented end-to-end
following the `PARAKEET_CPP` precedent — `dto.py` (enum, provider shorthand,
engine-string aliases), `processors/asr_capabilities.py` (registered
streaming+batch, unlike azure-foundry's batch-only), `processors/asr_engines.py`
(`WhisperCppEngine` adapter), `models/whisper_cpp_loader.py` (new — fetches
the GGUF file via `huggingface_hub`, glob-matches the configured quantization),
`models/cache.py` (loader registration), `streaming/whisper_cpp_asr.py` (new
adapter — verified against the real `pywhispercpp` API via its GitHub source,
not guessed; uses the `split_on_word=True, max_len=1, token_timestamps=True`
technique for genuine per-word timestamps from a single inference pass, since
`pywhispercpp`'s public API only returns segment-level timestamps),
`transcription/batch_service.py` (`_run_whisper_cpp_inference`),
`streaming/session_manager.py` (`_make_whisper_cpp_callable`),
`core/config/settings.py` (`whisper_cpp_library_path`/`whisper_cpp_num_threads`),
`turbo.json`/both `.env.example` files, `pyproject.toml` (`pywhispercpp>=1.5.0`
— verified on PyPI: prebuilt manylinux + macOS wheels, Python 3.9–3.14, no
torch dependency, so no Docker native-build step is needed). 5 new tests
(`TestP507WhisperCppEngine`) + 2 manifest-guard test updates.

**Phase 3 — DeepFilterNet3 denoise engine** (`apps/stt`): deviated from the
original plan's "migrate RNNoise into the processor registry too" — after
reading the actual RNNoise call sites, a simple `preprocessing.denoise.engine`
selector field (default `"rnnoise"`) with an if/else branch at the two
existing dispatch sites was more surgical than introducing a new registry
pattern RNNoise didn't need. `dto.py` (`DenoiseConfig.engine`,
`VALID_DENOISE_ENGINES`), `yaml_parser.py` (parse + validate),
`streaming/deepfilternet_denoiser.py` (new — block-processing streaming
adapter; DeepFilterNet3's `enhance()` API has no frame-accurate incremental
mode, so this buffers ~1s blocks and passes the original audio through
unmodified during warm-up rather than emitting silence — documented latency
tradeoff vs. RNNoise's frame-accurate ~1-frame latency),
`transcription/preprocessing.py` (`_apply_denoise_deepfilternet3` + dispatch),
`streaming/session_manager.py` (denoiser-class dispatch). Dependency:
`deepfilternet>=0.5.6` (verified on PyPI — real, maintained package;
`deepfilterlib`, the lower-level binding, was considered first but doesn't
expose the actual pretrained-model `enhance()`/`init_df()` API needed).
8 new tests (`test_deepfilternet_denoiser.py`, `TestApplyDenoiseDeepFilterNet3`,
`TestDenoiseEngineDispatch`, 3 yaml_parser tests).

**Phase 4 — seed data restructure** (`packages/database`): new `AiModel` rows
`whisper-large-v3-turbo-gguf` (WHISPER_CPP, q8_0) and `deepfilternet3`
(fresh slug — the retired `deepfilternet-v3` was NOT resurrected); faster-whisper
row bumped int8→**float16** (CTranslate2's actual compute-type spelling — the
spec's "f16" shorthand would have been rejected by `resolve_ct2_compute_type`'s
strict validator, caught by checking the runtime code rather than copying the
spec string literally); 9 LLM/guardrail `computeType` values updated to exact
quant strings (verified these are purely descriptive — not read by
`apps/smr`/`apps/guardrail` — so no casing-driven runtime risk); Kokoro TTS row
corrected to `hexgrad/Kokoro-82M` + `PYTORCH` format (verified against
`tts/providers/kokoro.py` — the `kokoro` PyPI package is torch-based, not
ONNX; the old `ONNX` label was already wrong before this ticket).
Pipeline matrix: `production-whisper-large-v3` / `whisper-turbo-no-postprocessing`
/ `whisper-turbo-no-preprocessing` updated in place to the GGUF ASR + (where
applicable) DeepFilterNet3 denoise; new `production-whisper-large-v3-turbo-gguf`
pipeline added as the platform default across SYSTEM + ArcaAI + Global.
**Default-flip migration gotcha caught before it shipped**: `seedAsrPipelines`
deliberately never updates `isDefault` on existing rows (admin-choice
preservation), so declaring the new pipeline `isDefault: true` in source would
have produced TWO default pipelines per tenant on this already-seeded dev DB.
Found the exact TASK-356 precedent for this (`switchDefaultSttPipeline`,
removed once its own migration completed) and re-implemented the same
reconcile-once pattern as `switchDefaultSttPipelineToGgufTurbo`, wired into
`seedStt()`. `91-user.ts`'s `default-stt-pipeline` GlobalSetting and
`06-stt.ts`'s `batch_pipeline_slug`/`streaming_pipeline_slug` settings
repointed to the new pipeline id/slug (these ARE updated on every re-seed,
unlike `isDefault`). `09-consultation.ts`'s hardcoded pipeline-id references
checked — they point at `production-whisper-large-v3` by id for FK validity,
not "the default," so no change needed. 10 `seed.test.ts` assertions updated
to match the new default/tags/computeType; TASK-506 consolidation test updated
from 26→28 expected catalog rows.

**Phase 5 — admin-console**: `WHISPER_CPP` added to the format picklist
(`types.ts`, `model-meta.ts`). The pre-existing 5-value drift (`ONNX_OPTIMUM`,
`AZURE_SPEECH`, `AZURE_FOUNDRY`, `PARAKEET_CPP`, `CLOUD_API` already missing
before this ticket) was flagged as a separate background task, not fixed here.

**Phase 6 — verification** (evidence below).

### Evidence

| Check | Result |
|---|---|
| `pnpm --filter @arcaai/database build` | Clean |
| `pnpm --filter @arcaai/database test` | **790 passed** |
| `pnpm db:seed` (1st run, real dev DB) | Success; verified via psql: exactly one `isDefault=true` pipeline per tenant (SYSTEM/Global/ArcaAI), the new GGUF pipeline |
| `pnpm db:seed` (2nd run) | Idempotent — reconciliation logged "0 switched, 3 unchanged"; row counts stable (13/tenant) |
| `pnpm py:stt:test:unit` | **2366 passed** (up from 2340 baseline + new tests), 0 failed |
| `pnpm py:stt:lint` (ruff) | Clean |
| `pnpm py:stt:typecheck` (mypy) | Clean (119 files) |
| `pnpm --filter @arcaai/admin-console build` | Clean |
| `pnpm --filter @arcaai/admin-console lint` | Clean |
| `pnpm --filter @arcaai/admin-console test` | **950 passed** |
| `pnpm --filter @arcaai/applications test -- tenant.service` | **6302 passed** (regression check — no impact from seed changes) |
| `pnpm turbo lint --filter=@arcaai/database --filter=@arcaai/admin-console` | Clean |
| `uv lock --dry-run` (after the separately-spawned fix landed) | Clean — "No lockfile changes detected"; `pywhispercpp` 1.5.0 + `deepfilternet` 0.5.6 confirmed present in `uv.lock` |
| `pnpm py:stt:test:unit` (re-run after the uv.lock fix touched `apps/stt/pyproject.toml`) | **2366 passed** — unaffected |

**Not independently verifiable in this environment / left for a live/staging
pass**: `pywhispercpp`/`deepfilternet` are resolvable (`uv.lock` now includes
both — see Known Issue #1) but not yet `pip install`ed into the local
`arcaenv` conda environment (this session's sandboxed shell can't invoke
`conda` directly to install them — `pnpm py:stt:setup:apple` does it). The
manual `/api/v1/health` + real-transcription check from the plan's
verification section needs that install step first.

### Known issues / follow-ups (spawned as separate tasks, not fixed here)

1. **`uv.lock` conflict — RESOLVED mid-ticket by a separately spawned session**
   (the user started the background task this ticket flagged). Root cause was
   a pre-existing, unrelated conflict between `stt[nemo]`'s `nemo-toolkit`
   (pins `transformers>=4.57.0,<4.58.dev0`) and `guardrail`'s
   `transformers>=5.0`, surfaced only under an unbounded
   `requires-python = ">=3.11"` × a hypothetical Python 3.15+win32 marker
   split (verified pre-existing via `git stash` before it was fixed). Fix
   (now in the working tree): root `pyproject.toml` gained
   `[tool.uv].environments = ["sys_platform == 'darwin'", "sys_platform ==
   'linux'"]` (this workspace never targets Windows) and a `conflicts` pairing
   `guardrail` × `stt[nemo]`; `requires-python` bounded to `>=3.11,<3.12`
   on `stt`/`guardrail`/`harness`/`nlp`/`smr`/`tts`; and — because
   `deepfilternet` 0.5.6 (latest on PyPI) declares `numpy>=1.22,<2.0` with no
   numpy-2.x-compatible release upstream — an `override-dependencies =
   ["numpy>=2.0.0"]` forcing the shared `ml` extra's numpy version.
   **`uv lock --dry-run` now succeeds cleanly** ("No lockfile changes
   detected"). The `override-dependencies` numpy forcing is flagged in its own
   comment as **not runtime-verified** — smoke-test the DeepFilterNet3 denoise
   path for real numpy-ABI compatibility before relying on it in production.
2. **Admin-console `AiModelFormat` picklist drift** — 5 values
   (`ONNX_OPTIMUM`/`AZURE_SPEECH`/`AZURE_FOUNDRY`/`PARAKEET_CPP`/`CLOUD_API`)
   were already missing from the hand-written picklist before this ticket
   (TASK-505/506 never updated it). Spawned as a background task.
3. **Customer-tenant `AiModel` clone staleness** — `backfillCustomerTenantAiModels`
   only backfills specific columns (e.g. `provider IS NULL`) on already-cloned
   customer-tenant rows, not a full refresh; the 9 LLM `computeType` precision
   updates will not retroactively apply to ArcaAI/Global's already-seeded
   clones on existing environments (confirmed via direct query — SYSTEM shows
   the new values, customer clones still show the old ones). Not fixed here:
   `computeType` is purely descriptive (unread by `apps/smr`/`apps/guardrail`
   at runtime), so this is metadata staleness, not a functional bug. A fresh
   environment (`db:seed` against an empty DB) gets the correct values
   everywhere since clones are created fresh from the SYSTEM catalog.
4. Cosmetic: `faster-whisper-large-v3-turbo-int8` slug still says "int8" even
   though its `computeType` is now `float16` — not renamed to avoid an
   unrelated slug-rename churn across pipeline YAML references.

## Change History

- 2026-07-18 — Ticket opened. Plan approved after exploration (2 explore
  agents + 3 targeted research agents) and 4 clarifying decisions confirmed
  with the user via `AskUserQuestion`.
- 2026-07-19 — All 6 phases implemented and verified (database: 790 tests;
  stt: 2366 tests, ruff + mypy clean; admin-console: 950 tests). Real
  `pnpm db:seed` run twice against the local dev DB, confirmed idempotent via
  direct psql queries. Status: Review.
- 2026-07-19 — `uv lock` was unrunnable from scratch (pre-existing, unrelated
  to this ticket's diff) and blocked locking the new `pywhispercpp`/
  `deepfilternet` deps. Root causes and fixes, all in the root `pyproject.toml`
  unless noted:
  - All 6 services declared `requires-python = ">=3.11"` with no upper bound,
    so uv's universal resolution included hypothetical future Python versions
    (3.12–3.15+). Bounded every service to `>=3.11,<3.12` (matches every CI
    image and the conda `arcaenv` exactly).
  - uv also resolved a hypothetical `win32` split (this workspace has no
    Windows path — Docker images are Linux, dev is macOS/conda). Added
    `[tool.uv] environments = ["sys_platform == 'darwin'", "sys_platform ==
    'linux'"]`.
  - Stripping the above revealed a real, pre-existing conflict: `stt[nemo]`
    pins `nemo-toolkit` (needs `transformers>=4.57,<4.58`) while `guardrail`'s
    base deps need `transformers>=5.0`. Same shape as the already-solved
    stt `ml`-vs-`nemo` conflict (each service installs independently via
    `uv sync --frozen --package <svc>`, so these never share a venv) — added
    `guardrail` vs `stt[nemo]` to `[tool.uv] conflicts`.
  - `onnxruntime-gpu`/`flash-attn` (`stt[ml-gpu]`) have no macOS wheels
    (CUDA-only). Added `; sys_platform == 'linux'` markers in
    `apps/stt/pyproject.toml` so the `ml-gpu` extra isn't required to
    resolve on darwin.
  - New, ticket-specific: `deepfilternet` 0.5.6 (latest upstream release) pins
    `numpy>=1.22,<2.0`; stt's base deps require `numpy>=2.0.0`. No
    numpy-2.x-compatible deepfilternet release exists upstream. Per user
    decision, overrode via `[tool.uv] override-dependencies = ["numpy>=2.0.0"]`
    rather than downgrading stt's own numpy floor.
    **`deepfilterlib` is a compiled (PyO3) extension and numpy 2.0 made a
    C-API/ABI break — this override is UNVERIFIED at runtime.** Manually
    smoke-test the DeepFilterNet3 denoise path (Phase 3) before relying on it;
    if it misbehaves, the fallback is pinning stt's numpy requirement down
    for the `ml` extra specifically, or dropping deepfilternet until upstream
    ships numpy 2.x support.
  - Verified: `uv lock` resolves cleanly and is stable (`uv lock --check`
    no-ops); `uv sync --frozen --package <svc> --python 3.11` dry-runs clean
    for `stt` (base, `ml`, `nemo`) and `guardrail`, with `transformers`
    correctly isolated per install profile (`4.57.6` under `nemo`, `5.5.4`
    elsewhere) and `numpy==2.4.6` under `ml` (override confirmed effective).
