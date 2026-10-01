# TASK-1030: STT denoise engines (rnnoise + DeepFilterNet3) always available

**Status:** In Progress — code complete and green locally; weights staged in the bucket and the live row re-sourced; awaiting commit/push → deploy → publish → cluster verification
**Type:** infrastructure / bugfix
**Branch:** `dev-2.2` (hope-v2) · `main` (hope-v2-deployment, only if config changes are needed)
**Related:** TASK-860 (DFN3 fails closed), TASK-977 (denoise is the agent's to enable), the 2026-10-01 log review that found STT sessions failing on `deepfilternet3`.

## Requirement Analysis

Owner request (2026-10-01): "make sure deepfilternet3 and rnnoise are ready and always available for any usage."

Every STT image that can run a session — `stt-ml-runtime` (API) and `stt-worker` (batch) — must be able to run
either denoise engine on any streaming or batch session, with **no internet access at session time**.

## Current State Evaluation (verified 2026-10-01)

| Fact | Evidence |
|---|---|
| `pyrnnoise` is installed and importable in the live STT image | `import pyrnnoise` in `hope-stt-5b597dfcc9-9bsll` |
| `deepfilternet` is NOT installed | `ModuleNotFoundError: df`; `apps/stt/pyproject.toml:163` explains why |
| Upstream is frozen at 0.5.6 (2023-08-31); `deepfilternet` pins `numpy<2`, `packaging<24`; `deepfilterlib` only `numpy>=1.22` | PyPI JSON |
| **0.5.6 works on numpy 2.4.6 + torch 2.8** when installed `--no-deps` | throwaway venv: SNR 1.4 → 16.5 dB on 2 s of noisy 48 kHz audio, 0.09 s CPU |
| `init_df` returns **3** values (`DfNet`, `DF`, `str`); `deepfilternet_denoiser.py:84` unpacks **4** | the DFN3 path has never run against the real package |
| DFN3 weights are NOT in the wheel: `init_df` downloads `DeepFilterNet3` (config.ini + `checkpoints/model_120.ckpt.best`, 8.3 MB) from GitHub into `~/.cache` | throwaway venv cache |
| The `deepfilternet3` `AiModel` row says "deepfilternet ships its weights inside the package" (`availability = NOT_APPLICABLE`, no `bucketPrefix`) — false | cluster DB |
| The model publisher fetches from HuggingFace or S3 only; `GITHUB` is a deprecated enum value nothing dispatches on | `model-source-fetcher.service.ts`, `enums.prisma:348` |
| RNNoise silently degrades to NO denoise when its package is absent (`StreamingDenoiser.initialize()` → False) | `session_manager.py:1086` |
| Only agent bound to `deepfilternet3`: ArcaAI `realtime-rado-asr` v3 (DEPRECATED) and v4 (PUBLISHED, inactive); active v6 uses `rnnoise` | cluster DB |

## Owner Decisions

| # | Decision | Answer |
|---|---|---|
| OD-1 | Install route for DeepFilterNet | `deepfilterlib==0.5.6` + `deepfilternet==0.5.6 --no-deps`, guarded by a build-time smoke test |
| OD-2 | Engine unavailable at runtime | **Never break the ASR task (fail OPEN, loudly).** If the selected engine cannot initialise — or `enhance()` fails mid-stream — the session/job continues transcribing WITHOUT denoise. The pod stays READY. The degradation is made visible, never silent: one WARNING per session naming the engine and reason, a `denoise_degraded` status event on the session, a Prometheus counter `stt_denoise_degraded_total{engine,reason}`, and the engine's status in the health body. **This reverses TASK-860 R-5** (DFN3 failed the session closed) by owner decision, 2026-10-01. |
| OD-3 | Where DFN3 weights come from | Models bucket via the `AiModel` row, published from an **S3 source**: the official GitHub release is downloaded once, checksummed, and its `config.ini` + checkpoint uploaded to an internal S3 prefix; the row's `sourceUri` is `s3://…`. No third-party copy, no runtime GitHub/HF dependency. |

## Implementation Plan

1. **Image** (`apps/stt/docker/Dockerfile`, ml-builder): install `deepfilterlib==0.5.6` and `deepfilternet==0.5.6 --no-deps`
   (plus its real runtime deps already present: loguru, appdirs, requests, sympy). Remove the "intentionally NOT installed"
   note in `apps/stt/pyproject.toml`.
2. **Weights through the registry** (OD-3): one-time upload of the official DeepFilterNet3 release (sha256 recorded here) to an internal S3 prefix; the `deepfilternet3` row becomes a published model (`bucketPrefix`,
   `availability` tracked) instead of `NOT_APPLICABLE`; seed + a data migration for live rows. The resolved spec already
   carries `models.denoise` — STT passes its `local_path` to `init_df(model_base_dir=…)`. A missing/unpublished checkpoint
   degrades that session to no-denoise (OD-2); nothing ever downloads at session time.
3. **Runtime** (`apps/stt`): fix the 3-value `init_df` unpack. Both engines follow ONE rule (OD-2): init failure or a
   per-block `enhance()` failure → passthrough for that session, never an exception into the ASR path; DFN3's
   `ModelLoadError` raise becomes a degrade. RNNoise's existing silent degrade gains the same WARNING / status event /
   counter. Same rule in the batch path (`transcription/preprocessing.py`).
4. **Health**: `/api/v1/health` reports `denoise: {rnnoise: ok|error, deepfilternet3: ok|error, detail}`; readiness unchanged.
5. **Build-time gate**: the Dockerfile imports both engines and runs 1 s of audio through each (DFN3 against a checkpoint
   fixture), failing the build otherwise.

### TDD test list

- `init_df` 3-tuple is unpacked; the denoiser initialises from a given `model_base_dir` and never calls the downloader.
- DFN3 with no `local_path` / missing checkpoint / missing package → session STARTS and transcribes without denoise; a
  WARNING, a `denoise_degraded` status event and a counter increment are emitted (was: `ModelLoadError`, session failed).
- DFN3 `enhance()` raising mid-stream → that block passes through, transcription continues, degrade is reported once.
- RNNoise selected but unavailable → transcribes without denoise, and the degrade is now REPORTED (was: silent).
- Batch preprocessing: a job with a broken engine completes with a transcript, and records the degrade.
- Health body lists both engines' status; readiness stays 200 when one is broken.
- Resolver/spec: an enabled denoise stage bound to `deepfilternet3` ships `models.denoise` with its `local_path`.

### Verification

`pnpm stt:test` (via `~/miniconda3/envs/arcaenv/bin/python -m pytest`), applications/domains tests for the row change;
on the cluster: one streaming session per engine (agent bound to each), health body shows both `ok`, and a session on
ArcaAI `realtime-rado-asr` v4 succeeds.

## Implementation Summary

### Code (hope-v2, uncommitted at time of writing)

| Area | Change |
|---|---|
| `apps/stt/src/stt/streaming/denoise_report.py` (new) | `report_denoise_degraded(engine, reason, detail)` — one WARNING + `stt_denoise_degraded_total{engine,reason}`; reasons `package_missing` / `weights_unavailable` / `init_failed` / `enhance_failed` / `unknown_engine` |
| `apps/stt/src/stt/streaming/denoise_selection.py` (new) | `build_streaming_denoiser()` — the one selection rule: `(denoiser, None)` or `(None, degrade)`, never raises; an unknown engine runs NOTHING (never RNNoise in its place). `denoise_engine_status()` for the health body |
| `streaming/deepfilternet_denoiser.py` | Loads from `model_dir` (the row's `local_path`); refuses to load without it (never `init_df`'s GitHub download); real 3-tuple; `log_file=None` (init_df otherwise writes `enhance.log` INTO the weights dir — the cluster mount is read-only, so every load would have failed); never raises; mid-stream `enhance()` failure reported once |
| `streaming/denoiser.py` (RNNoise) | Same degrade contract; init failure and the consecutive-failure auto-disable are now REPORTED |
| `streaming/session_manager.py` + `redis_streams.py` | Assembly uses the shared builder; a degrade publishes a `denoise_degraded` status frame (rides the existing `status` result type — the gateway relays it unchanged) |
| `transcription/preprocessing.py` (batch) | Same rule; DFN3 uses `model_dir` + 3-tuple + `log_file=None`; every degrade reported; an unknown engine returns the original audio |
| `pipeline/dto.py`, `pipeline/spec.py` | `DenoiseConfig.model_path` ← `models.denoise.local_path`; a library naming no engine maps to `unknown:<library>` instead of raising (`UnsupportedDenoiseEngineError` removed) |
| `health/api/routes.py` | `checks.denoise` lists both engines; never changes `status` or readiness |
| `core/metrics.py` | `stt_denoise_degraded_total` |
| `apps/stt/docker/Dockerfile` | `deepfilterlib==0.5.6` + `loguru` + `appdirs`, then `deepfilternet==0.5.6 --no-deps`; build gate: RNNoise denoises 1 s, libdf analysis/synthesis round-trips 1 s, `df.enhance` imports — validated against the real packages (numpy 2.4.6) |
| `apps/stt/pyproject.toml` | Stale "intentionally NOT installed" note replaced |
| `packages/applications/.../model-version.util.ts` | `.ckpt.best` is a weight extension; `config.ini` a relevant source file (else an S3 publish of the release finds "no downloadable files") |
| `packages/applications/.../model-inventory.service.ts` | `deepfilternet` is no longer "weight-less" — inventoried from the bucket |
| `packages/database/.../seed/ai-models/{audio,shared}.ts` | `deepfilternet3` row: `source: S3`, `sourceUri: s3://hope-models/sources/deepfilternet3/0.5.6/`, `sourceRevision: v0.5.6`, availability measured (not claimed); seed enum mirror gains `S3` |

### Weights provenance (OD-3)

Official release `https://github.com/Rikorose/DeepFilterNet/raw/main/models/DeepFilterNet3.zip` (7,986,207 bytes):

| Object | sha256 |
|---|---|
| `DeepFilterNet3.zip` | `49c52edc8947ae1f9bf50d81530beaf3a2c3245aeaf34b6f31ff535cd22284d2` |
| `config.ini` | `415eb925d44990d938fb739f514aa3662c1ec0ea836cff044fa1291b82cb4290` |
| `checkpoints/model_120.ckpt.best` | `23b92884f63ccf54bb026014604625ab231657b6480df65db4095c4c171e6003` |

Downloaded and verified inside the cluster (stt pod), re-verified in `hope-silo-0`, uploaded to
`s3://hope-models/sources/deepfilternet3/0.5.6/`, and re-hashed from the bucket — all three match.
Live SYSTEM row `deepfilternet3` re-sourced by SQL to the S3 source (`_version` 1 → 2, availability `UNKNOWN`).

### Evidence (local)

- `apps/stt` unit suite: **3981 passed** (`python -m pytest tests/unit -n 4`); ruff + black clean on touched files; mypy: the same 4 pre-existing errors as `HEAD` (untouched files).
- New: `tests/unit/streaming/test_task1030_denoise_fail_open.py` (17), health tests (2); updated TASK-977 / session-manager / preprocessing / model-wiring tests to the OD-2 contract.
- `@arcaai/applications` ai-model: **669 passed**; `@arcaai/database` seed + seed tests: **1220 passed**; both `typecheck` clean; applications eslint clean.
- Real-package check (throwaway venv, numpy 2.4.6 / torch 2.8): `init_df(model_base_dir=…, log_file=None)` loads OFFLINE (sockets blocked, empty `HOME`) from a READ-ONLY dir and writes nothing; `enhance` returns `(1, 48000)`.

### Remaining

1. Commit + push → CI builds STT (build gate runs) → `promote-dev`.
2. Publish the `deepfilternet3` row (admin console → model → Download/Publish; needs the deployed publisher, which now accepts the release's files).
3. Cluster verification: health body shows both engines `ok`; a session per engine; ArcaAI `realtime-rado-asr` v4 runs DeepFilterNet3; an unpublished/broken engine degrades with the status frame + counter.

## Change History

| Date | Change |
|---|---|
| 2026-10-01 | Ticket opened; current state verified; OD-1/OD-2 decided (OD-2 revised by the owner: pod stays ready); plan written. |
| 2026-10-01 | OD-3 decided: S3 source from a one-time upload of the official release. |
| 2026-10-01 | Implementation: STT fail-open + reporting, DFN3 from bucket weights, build gate, publisher/inventory/seed changes; weights staged + live row re-sourced. |
| 2026-10-01 | OD-2 revised again by the owner: an unready engine must never break the ASR task — fail open (no denoise) with visible reporting; reverses TASK-860 R-5. |
