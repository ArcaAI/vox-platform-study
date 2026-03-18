# TASK-027: Python Local Environment Setup Script

- **Ticket**: TASK-027
- **Created**: 2026-02-19
- **Last Updated**: 2026-02-19
- **Status**: Completed

## Requirement Analysis

The HOPE monorepo contains several Python microservices (stt-v2, smr/smr-v2, nlp) that each have their own `pyproject.toml` and dependency sets. Engineers joining the project need a streamlined way to:

1. Verify all required tools are installed (Node.js, Python, conda, Docker, etc.)
2. Create a shared conda environment (`arcaenv`) with Python 3.11
3. Install all Python service dependencies in editable mode
4. Handle platform-specific ML dependencies (Apple Silicon MPS, NVIDIA CUDA)

### Business Context

Reduces onboarding friction for new engineers and ensures consistent development environments across the team.

### Acceptance Criteria

- [x] Script checks and lists all installed frameworks and tools
- [x] Script detects missing prerequisites and provides installation instructions
- [x] Script creates `arcaenv` conda environment with Python 3.11
- [x] Script installs dependencies for stt-v2, smr-v2, and nlp
- [x] Script supports Apple Silicon and NVIDIA GPU ML extras
- [x] Script is accessible via `pnpm py:setup`

## Current State Evaluation

### Python Services in the Monorepo

| Service | Location | Python | Dependency File | Key Frameworks |
|---------|----------|--------|-----------------|----------------|
| stt-v2 | `apps/stt-v2/` | >=3.11 | `pyproject.toml` | FastAPI, Dramatiq, PyTorch (optional) |
| smr-v2 | `apps/smr/src/smr_v2/` | >=3.11 | `pyproject.toml` | FastAPI, Celery, OpenAI, Ollama |
| nlp | `apps/nlp/` | >=3.11 | `pyproject.toml` | FastAPI, spaCy, PyTorch, Transformers |

### Existing Setup Mechanisms

- `apps/stt-v2/Makefile` — conda-based setup for stt-v2 only (uses `stt-v2` env)
- Root `package.json` — `dev:stt-v2` and `dev:smr-v2` scripts use `conda run -n arcaenv`
- No unified setup script existed for all Python services

## Implementation Plan

1. Create `scripts/setup-python-env.sh` with 5 phases:
   - Phase 1: Check prerequisites (Node.js, pnpm, Python, conda, Docker, etc.)
   - Phase 2: List existing conda environments
   - Phase 3: Create/verify `arcaenv` conda environment
   - Phase 4: Install dependencies for all 3 services
   - Phase 5: Verification and summary
2. Add `pnpm py:setup` shortcuts to root `package.json`
3. Document usage

## Implementation Summary

### Files Created

- `scripts/setup-python-env.sh` — Main setup script (executable)

### Files Modified

- `package.json` — Added `py:setup`, `py:setup:check`, `py:setup:apple`, `py:setup:gpu` scripts

### Script Usage

```bash
# Full setup (check + create env + install all deps)
./scripts/setup-python-env.sh

# Or via pnpm
pnpm py:setup

# Check prerequisites only (no changes)
pnpm py:setup:check

# Full setup with Apple Silicon ML support (MPS + FFmpeg)
pnpm py:setup:apple

# Full setup with NVIDIA GPU ML support (CUDA)
pnpm py:setup:gpu

# Install deps only (skip checks, env must exist)
./scripts/setup-python-env.sh --install

# Install with Apple ML into existing env
./scripts/setup-python-env.sh --install --apple
```

### Script Phases

| Phase | Description |
|-------|-------------|
| 1 | Checks: OS, Node.js (>=22), pnpm, Python, **conda** (required), uv, pyenv, Docker, Docker Compose, git, make |
| 2 | Lists existing conda environments, highlights `arcaenv` if present |
| 3 | Creates `arcaenv` with Python 3.11 (or offers to recreate if exists). For `--apple`, installs FFmpeg and sets up `DYLD_LIBRARY_PATH` activation scripts |
| 4 | Installs each service in editable mode: `stt-v2[dev,test]`, `smr[dev,test]`, `nlp`. ML extras added based on `--apple`/`--gpu` flags |
| 5 | Verifies key imports (FastAPI, SQLAlchemy, PyTorch, spaCy) and prints usage instructions |

### Dependencies Installed

All services are installed in **editable mode** (`pip install -e`) so code changes are reflected immediately without reinstalling.

**stt-v2** extras by platform:
- CPU (default): `[dev,test]`
- Apple Silicon: `[ml,dev,test]` + FFmpeg via conda
- NVIDIA GPU: `[ml-gpu,dev,test]`

**smr**: `[dev,test]`

**nlp**: base dependencies (includes torch, spacy, transformers)

### Post-Setup Commands

After running the setup script:

```bash
# Activate the environment
conda activate arcaenv

# Run services
pnpm dev:stt-v2    # STT v2 on port 8001
pnpm dev:smr-v2    # SMR v2 on port 5006

# Run tests
conda run -n arcaenv pytest apps/stt-v2/tests/ -v
conda run -n arcaenv pytest apps/smr/tests/ -v
conda run -n arcaenv pytest apps/nlp/tests/ -v
```
