# TASK-232: Python Dependency Fix — Native Library Symbol Conflicts

| Field | Value |
|-------|-------|
| **Ticket** | TASK-232 |
| **Type** | bugfix / infrastructure |
| **Created** | 2026-03-01 |
| **Updated** | 2026-03-01 |
| **Status** | Completed |

## Requirement Analysis

### Description

Multiple Python services (NLP, STT-v2) failed to start due to native library symbol conflicts in the shared `arcaenv` conda environment on macOS (Apple Silicon). The root causes were:

1. **NLP service crash**: `ImportError: Symbol not found: _iconv` — PyAV (pip wheel) bundled FFmpeg 7 libs that expected `_iconv` from the system `libiconv`, but conda's `libiconv` exports `_libiconv` (GNU convention).
2. **STT-v2 warnings**: `python-dotenv` parse errors from YAML-style colons in `.env`, missing `omegaconf` module, and `torchcodec` FFmpeg linkage failure.

### Business Context

Both services are critical to the HOPE platform — NLP provides medical entity recognition and STT-v2 provides speech-to-text. Neither could start locally for development.

### Acceptance Criteria

- [x] NLP service starts without import errors
- [x] STT-v2 service starts without python-dotenv parse errors
- [x] STT-v2 diarization dependencies (pyannote.audio, omegaconf) load correctly
- [x] Dependency versions captured in pyproject.toml files
- [x] Setup script updated to install conda-managed packages correctly
- [x] Documentation updated with new FFmpeg version, troubleshooting, and constraints

## Root Cause Analysis

### The libiconv Symbol Conflict

On macOS, there are two `libiconv` conventions:

| Convention | Symbol | Used by |
|-----------|--------|---------|
| POSIX | `_iconv` | macOS system `/usr/lib/libiconv.2.dylib`, pip PyAV wheels |
| GNU | `_libiconv` | conda-forge `libiconv` package |

When PyAV is installed via pip, it bundles its own FFmpeg dylibs that expect the POSIX `_iconv` symbol. But at runtime, the conda env's `libiconv` (GNU convention) is loaded instead, causing the symbol-not-found crash.

### The BLAS/LAPACK Conflict

Similarly, pip-installed `numpy` and `scipy` wheels link against macOS Accelerate framework, but conda's `libopenblas` gets loaded at runtime, causing `$NEWLAPACK$ILP64` symbol mismatches.

### The torchcodec Version Matrix

| torchcodec | torch | FFmpeg |
|-----------|-------|--------|
| 0.6–0.7 | 2.8.x | 4–7 |
| 0.10 | 2.10.x | 4–8 |

Since `pyannote.audio 4.x` pins `torch==2.8.0`, we're locked to `torchcodec 0.7.x`, which requires FFmpeg 6.x. The solution is to use `av` (PyAV) 13.1.0 from conda-forge, which is also built against FFmpeg 6 — satisfying both torchcodec and transformers.

## Implementation Summary

### Changes Made

#### 1. `.env` — Fixed YAML-style colons (lines 174–183)

Replaced YAML-style `KEY: value` with `.env`-standard `KEY=value` for 10 Azure OpenAI configuration entries. Also removed unnecessary quotes around numeric values.

#### 2. Conda environment — Installed/upgraded packages

| Package | Before | After | Source |
|---------|--------|-------|--------|
| ffmpeg | 6.1.2 (broken libiconv) | 6.1.2 (reinstalled) | conda-forge |
| av (PyAV) | 16.1.0 (pip, broken) | 13.1.0 | conda-forge |
| numpy | 2.4.2 (pip) | 2.4.2 | conda-forge |
| scipy | 1.17.1 (pip) | 1.17.1 | conda-forge |
| libiconv | 1.18 | 1.18 (reinstalled) | conda-forge |
| omegaconf | not installed | 2.3.0 | pip |
| torchcodec | 0.7.0 | 0.7.0 (now loads correctly) | pip |

#### 3. `apps/stt-v2/pyproject.toml`

- Added `omegaconf>=2.3.0` to `[ml]` optional dependencies
- Added documentation comment block about conda-managed packages
- Updated torchcodec version constraint notes

#### 4. `apps/nlp/pyproject.toml`

- Added documentation comment block about conda-managed packages (av, numpy, scipy, ffmpeg)
- Organized dependencies into logical groups with section comments

#### 5. `scripts/setup-python-env.sh`

- Replaced single FFmpeg conda install with comprehensive conda-managed package block:
  - `ffmpeg>=6.1,<7`, `av>=13.1,<14`, `numpy>=2.4`, `scipy>=1.17`, `libiconv>=1.18`
- Added `omegaconf>=2.3.0` pip install step
- Moved DYLD_LIBRARY_PATH scripts to only run for `--apple` flag (conda installs are now platform-agnostic)
- Added verification checks for av, numpy, scipy, omegaconf, and transformers.pipeline

#### 6. `apps/stt-v2/src/stt_v2/health/api/routes.py`

- Fixed Redis health check: replaced `broker.connection` (non-existent attribute) with `broker.client.ping()`

#### 6. `knowledge/stt-v2/README.md`

- Updated prerequisites: FFmpeg 8.x (was 6.x)
- Added note explaining FFmpeg version constraint and torchcodec trade-off
- Updated conda setup instructions to use shared `arcaenv` env and `pnpm py:setup:apple`
- Updated manual setup with conda-managed package install sequence
- Added warning about pip vs conda for native packages
- Updated verification script to check av, numpy, scipy, omegaconf, transformers.pipeline
- Updated Tech Stack table with actual installed versions
- Rewrote troubleshooting section:
  - torchcodec warning is now documented as expected/non-fatal
  - Added `_iconv` / `_libiconv` symbol conflict resolution
  - Added `omegaconf` missing module fix

### Files Changed

| File | Purpose |
|------|---------|
| `.env` | Fixed YAML-style colons to `.env`-standard equals signs |
| `apps/stt-v2/pyproject.toml` | Added omegaconf dep, conda-managed package docs, torchcodec notes |
| `apps/nlp/pyproject.toml` | Added conda-managed package docs, organized dependency groups |
| `scripts/setup-python-env.sh` | FFmpeg 8, conda av/numpy/scipy/libiconv, omegaconf, new verifications |
| `knowledge/stt-v2/README.md` | Prerequisites, setup, tech stack, troubleshooting updates |
| `docs/implementation/TASK-232-Python-Dependency-Fix/README.md` | This document |

### Dependency Constraint Summary

```
pyannote.audio 4.0.4
  └── torch==2.8.0, torchaudio==2.8.0
       └── torchcodec 0.7.0 (FFmpeg 4-7)
            └── ffmpeg 6.1.2 (conda) → libiconv 1.18 (conda)

transformers 4.57.6
  └── av (PyAV) — imports at module load via video_classification pipeline
       └── av 13.1.0 (conda) → ffmpeg 6.1.2 (conda)

numpy 2.4.2 (conda) → libopenblas (conda)
scipy 1.17.1 (conda) → libopenblas (conda)
```

All native library dependencies (ffmpeg, av, numpy, scipy, libiconv) are managed
by conda to ensure consistent linkage. Do NOT install these via pip.
