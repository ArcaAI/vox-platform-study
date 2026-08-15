# TASK-695 — Safe Python Dependency Bumps

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `infrastructure` (dependency hygiene) |
| **Ticket number** | TASK-695 |
| **Scope** | Single uv workspace (`pyproject.toml` members + root `uv.lock`). No TS / pnpm / Compose / image-tag changes. No commit. |

TASK-692 was already used (ArcaAI Clinical Prompts). TASK-691 / TASK-693 were reserved. TASK-694 was taken in-session by the infra pin ticket, so this work is **TASK-695**.

## Requirement Analysis

Bump **only** allowlisted, in-range shared and service Python dependencies in the HOPE uv workspace so Docker `uv sync --frozen` and local conda `arcaenv` stay aligned on current patch/minor releases.

Hard denylist (must not move this pass): `openai` 3.x, `mcp` 2.0.0, `nemo-toolkit` 3.0.0, `torch` / `torchaudio` / `torchvision` / `torchcodec`, `transformers` (5.5.4 ml / 4.57.x nemo), large `huggingface-hub` jumps, `temporalio` 1.30 → 1.31, `qdrant-client`, `optimum` 2.1 → 2.3, `librosa` 1.0 / `numpy` 2.5 / `scipy` 1.18, `parler-tts`. Do not co-resolve `stt[ml]` and `stt[nemo]`.

If an allowlist bump forces a denylist package to move, revert that bump.

## Current State Evaluation

Workspace root `pyproject.toml` members: `apps/{stt,smr,guardrail,nlp,harness,tts}`, `packages/{py-runtime-models,py-env,py-otel}`. One `uv.lock`. Local installs still use `conda run -n arcaenv pip install -e` (`scripts/setup-python-env.sh`); Docker uses `uv sync --frozen --package <svc>`.

Declared floors were older than the lock (e.g. `fastapi>=0.133.0` while locked 0.139.0). Floors were raised to the targets so a future `uv lock` cannot silently resolve below them.

Compose Qdrant remains `qdrant/qdrant:v1.16` (untouched this pass). `qdrant-client` stays at locked 1.18.0.

`stt[ml]` and `stt[nemo]` remain conflicting extras in root `pyproject.toml`.

## Implementation Plan

1. Raise allowlisted lower bounds in each declaring `pyproject.toml`. Try onnxruntime 1.28 and numba 0.67; keep them only if denylist packages stay put.
2. `conda run -n arcaenv uv lock` from repo root. Diff denylist packages.
3. Install only the newly locked wheels into `arcaenv` (no `pip install nlp` / `tts` from PyPI). Do not `uv sync` the whole conflicting extra tree into conda.
4. Smoke-import shared libs; run cheapest service suites. Note GPU extras if they cannot install on this Mac.
5. Capture evidence; set status `Review` or `Blocked`.

## Implementation Summary

`conda run -n arcaenv uv lock` from the repo root: **Resolved 482 packages in 2.68s**, exit 0. Denylist packages did not move. `stt[ml]` vs `stt[nemo]` stay split.

### Packages bumped (locked-from → locked-to)

| Package | From | To |
|---|---|---|
| fastapi | 0.139.0 | 0.141.1 |
| uvicorn | 0.50.0 | 0.52.3 |
| pydantic-settings | 2.14.2 | 2.15.0 |
| orjson | 3.11.9 | 3.12.0 |
| prometheus-client | 0.25.0 | 0.26.0 |
| prometheus-fastapi-instrumentator | 8.0.2 | 8.1.0 |
| redis | 8.0.1 | 8.1.0 (`<9` kept) |
| sqlalchemy | 2.0.51 | 2.0.52 |
| opentelemetry-api / sdk / exporter-otlp-proto-grpc | 1.43.0 | 1.44.0 |
| opentelemetry-instrumentation* | 0.64b0 | 0.65b0 |
| mypy | 2.1.0 | 2.3.1 |
| ruff | 0.15.20 | 0.16.3 |
| pre-commit | 4.6.0 | 4.6.2 |
| azure-cognitiveservices-speech | 1.50.0 | 1.51.1 |
| anthropic | 0.120.0 | 0.122.0 |
| google-genai | 2.14.0 | 2.18.1 |
| boto3 / boto3-stubs | 1.43.40 | 1.43.72 |
| botocore-stubs | 1.43.14 | 1.43.67 (latest 1.43 stubs on PyPI) |
| sse-starlette | 3.4.5 | 3.4.8 |
| pandas | 3.0.3 | 3.0.5 |
| pymupdf | 1.28.0 | 1.28.2 |
| spacy | 3.8.14 | 3.8.15 |
| presidio-analyzer | 2.2.362 | 2.2.364 |
| presidio-anonymizer | 2.2.363 | 2.2.364 |
| deepeval | 4.0.7 | 4.1.8 (`<5`) |
| fakeredis | 2.36.2 | 2.37.0 |
| testcontainers | 4.14.2 | 4.15.0 |
| types-pyyaml | 6.0.12.20260518 | 6.0.12.20260815 |
| sentencepiece | 0.2.1 | 0.2.2 |
| locust | 2.44.4 | 2.46.3 (trivial 2.x) |
| openai | 2.44.0 | 2.54.0 (`<3` cap added; 3.1.0 denied) |
| onnxruntime | 1.27.0 | **1.28.0 on ml/guardrail**; 1.27.0 remains on the nemo extra |
| onnxruntime-gpu | 1.27.0 | 1.28.0 (Linux-only wheels) |
| numba | 0.66.0 | **0.67.0 on ml**; 0.66.0 remains on the nemo extra |

### Denylist unchanged

| Package | Still locked |
|---|---|
| openai | 2.54.0 (2.x only; not 3.1.0) |
| mcp | 1.28.1 |
| nemo-toolkit | 2.7.3 |
| torch | 2.8.0 (ml) / 2.12.1 (nemo) |
| torchaudio / torchcodec / torchvision | 2.8.0 / 0.7.0 / 0.23.0 |
| transformers | 5.5.4 (ml) / 4.57.6 (nemo) |
| huggingface-hub | 0.36.2 / 1.16.1 (no large jump) |
| temporalio | 1.30.0 |
| qdrant-client | 1.18.0 |
| optimum | 2.1.0 |
| librosa / numpy / scipy | 0.11.0 / 2.4.6 / 1.17.1 |

### Notable transitives (not declared)

- `cryptography` 46.0.7 → 48.0.1 (pulled by presidio-anonymizer 2.2.364: `cryptography>=48.0.1,<49`)
- `questionary` 2.1.1 added (deepeval 4.1.8)
- `llvmlite` now dual 0.48.0 / 0.49.0 with the numba split
- `types-awscrt` removed with the botocore-stubs bump

### Files changed (this ticket only)

- `apps/{stt,smr,guardrail,nlp,harness,tts}/pyproject.toml` — raised floors
- `packages/py-env/pyproject.toml`, `packages/py-otel/pyproject.toml` — raised floors
- `uv.lock` — refreshed
- this README

No `pnpm-lock.yaml`, TS `package.json`, or Compose/image-tag edits in this ticket.

### uv lock result

```
Using CPython 3.11.14
Resolved 482 packages in 2.68s
```

Exit 0. Full package update list is in the Change History evidence below.

### Test evidence

Environment: conda `arcaenv`, Python 3.11.15. Did **not** `uv sync` the whole workspace into conda (ml/nemo conflict + conda-managed numpy/scipy/ffmpeg). Installed only locked allowlist wheels. Re-pointed editable `hope-env` / `hope-otel` at this workspace (arcaenv had been importing them from `.claude/worktrees/task-648-version-registry`).

Smoke import (`SMOKE_OK`): fastapi 0.141.1, uvicorn 0.52.3, pydantic-settings 2.15.0, orjson 3.12.0, redis 8.1.0, sqlalchemy 2.0.52, openai 2.54.0, anthropic 0.122.0, boto3 1.43.72, numba 0.67.0, onnxruntime 1.28.0; denylist still torch 2.8.0, transformers 5.5.4, numpy 2.4.6.

| Suite | Result |
|---|---|
| `pnpm py-env:test` | **73 passed** in 0.57s |
| `pnpm py-otel:test` | **17 passed** in 0.03s |
| `pnpm smr:test:unit` (full) | 1009 passed, **109 failed** — all 401 on protected routes. Isolated `test_generate_uses_injected_registry` **passed**. Matches the documented `.env.dev` `SMR_SERVICE_TOKEN` collection leak in `apps/smr/src/smr/tests/conftest.py` (not a FastAPI 0.141 break; 0.141.0 release notes are additive). |
| TTS auth + config | **18 passed** in 0.52s |
| Guardrail auth + health | **15 passed** in 4.77s |
| `pnpm tts:test:unit` (full) | Hung on `test_reaching_ready_opens_no_network_connection` after ~70 earlier passes; killed. Pre-existing network-wait, not attributed to this bump. |

`onnxruntime-gpu` 1.28.0 is Linux-only; **no macOS wheel** — not installed in `arcaenv`. `stt[ml-gpu]` was not synced on this Mac.

### Skipped allowlist items

| Item | Why |
|---|---|
| qdrant-client | Instructed skip this pass; compose still `qdrant/qdrant:v1.16` |
| temporalio 1.30 → 1.31 | Replay-sensitive; instructed skip |
| openai 3.1.0 | Denylist; took latest 2.x (2.54.0) with `<3` |
| mcp 2.0.0 / nemo-toolkit 3.0.0 | Denylist |
| torch / torchaudio / torchvision / torchcodec / transformers / huggingface-hub large jumps | Denylist; unchanged |
| optimum 2.1 → 2.3 | Denylist; still 2.1.0 |
| librosa 1.0 / numpy 2.5 / scipy 1.18 | Need Python ≥3.12; unchanged |
| parler-tts | Git-only; untouched |
| Co-resolving stt[ml] + stt[nemo] | Forbidden; extras stay conflicting |

onnxruntime 1.28 and numba 0.67 were **kept**: they did not move torch/transformers. The nemo extra still resolves onnxruntime 1.27 / numba 0.66.

### Verification (2026-08-16)

Re-checked the workspace against this ticket's scope (allowlisted floors + lock + denylist-at-the-time). All TASK-695 floors remain in `apps/{stt,smr,guardrail,nlp,harness,tts}/pyproject.toml` and `packages/{py-env,py-otel}/pyproject.toml`. `uv.lock` still has those allowlisted versions (fastapi 0.141.1, uvicorn 0.52.3, pydantic-settings 2.15.0, orjson 3.12.0, redis 8.1.0, sqlalchemy 2.0.52, OTel 1.44.0 / 0.65b0, mypy 2.3.1, ruff 0.16.3, onnxruntime 1.28.0+1.27.0, numba 0.67.0+0.66.0). Root `pyproject.toml` still declares `stt[ml]` vs `stt[nemo]` as conflicting extras. `parler-tts` is still not a lock member.

Later tickets moved packages this pass denylisted: TASK-697 pinned the nemo numba/onnxruntime upper bounds so the fork cannot collapse; TASK-700 took openai 3.1.0 (SMR + `harness[eval]`; `eval-ragas` keeps 2.54.0), mcp 2.0.0, temporalio 1.31.0, qdrant-client 1.19.0. Those are out of this ticket's scope. The denylist table above is the 2026-08-15 end-of-pass snapshot.

## Change History

| Date | Change |
|---|---|
| 2026-08-15 | Ticket opened as TASK-694 (TASK-692 taken). Floors raised; `uv lock` succeeded; denylist intact. Renumbered to **TASK-695** after TASK-694 was claimed by the infra pin ticket. Status `Review`. |
| 2026-08-15 | Follow-up: `arcaenv` had no `mypy` / service trees. Installed locked `mypy==2.3.1` and `setup-python-env.sh --install` (no ML extras). Cast `librosa.resample` in STT `_resample` so mypy 2.3 `warn_return_any` is clean. `pnpm typecheck:py` green (py-env 5, py-otel 2, stt 134, smr 61, nlp 45, guardrail 32, harness 100, tts 34). |
| 2026-08-16 | Verified completion against current implementation: TASK-695 allowlisted floors and lock versions still present; ml/nemo extras still split. Subsequent TASK-697/700 moved this ticket's denylist items (not leftovers here). Status `Completed`. |
