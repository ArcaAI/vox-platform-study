# TASK-697 — Residual Python Patches / Security

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `infrastructure` (dependency hygiene) |
| **Ticket number** | TASK-697 |
| **Scope** | Residual in-range Python patches, safe minors, and same-major security fixes on the single uv workspace (`uv.lock`). No TS / pnpm / Compose / image-tag changes. No commit. |

TASK-696 (TS residual) and TASK-698 (infra residual) were claimed by sibling agents. This pass is **TASK-697**.

## Requirement Analysis

After TASK-695 (FastAPI 0.141.1, uvicorn 0.52.3, openai 2.54.0 `<3`, OTel 1.44 / 0.65b0, onnxruntime 1.28 ml / 1.27 nemo, numba 0.67 ml / 0.66 nemo), take leftover **in-range patches**, **safe minors**, and **same-major security fixes** for all Python services (`stt`, `smr`, `guardrail`, `nlp`, `harness`, `tts`) and `packages/py-*`. One lock. Extras stay split. Do not take ecosystem majors.

Hard denylist (must not move): `openai` 3.x · `mcp` 2.0 · `nemo-toolkit` 3 · `torch` / `torchaudio` / `torchvision` / `torchcodec` · `transformers` (5.5.4 ml exact / 4.57 nemo) · large `huggingface-hub` jumps (1.16→1.27 or 0.36→1.x) · `temporalio` 1.30→1.31 · `qdrant-client` while compose is still `qdrant/qdrant:v1.16` · `optimum` 2.3 · `librosa` 1.0 / `numpy` 2.5 / `scipy` 1.18 · `parler-tts` git. Do not co-resolve `stt[ml]` + `stt[nemo]`.

If a bump pulls a denylist package, revert that bump.

## Current State Evaluation

Re-scan (2026-08-15) against the **post-695 lock**, not the pre-695 audit.

- `uv tree --frozen --outdated --depth 1`: only two leftover **direct** deps were in-range and not denylisted — `omegaconf` 2.3.0→2.3.1 (`stt[ml]`) and `symspellpy` 6.9.0→6.10.0 (`nlp`). Everything else at depth 1 was denylist (torch/transformers/huggingface-hub/optimum/openai 3/temporalio/mcp/qdrant-client).
- Full `uv tree --frozen --outdated`: ~90 transitives behind latest; most were majors, calendar jumps, or denylist.
- `uv pip list --outdated` (arcaenv hint only; lock is source of truth): same denylist plus arcaenv drift (`nlp`/`tts` editable names vs PyPI).
- `uv audit --frozen` **before** this pass: **65** known vulnerabilities in 473 packages. Same-major fixes available for `aiohttp` 3.14.1→3.14.3, `gitpython` 3.1.50→3.1.59, `h2` 4.3.0→4.4.1, `pyasn1` 0.6.3→0.6.4. `langchain` 1.3.2→1.3.9 also has a fix (see leftovers).
- Compose Qdrant remains `qdrant/qdrant:v1.16` (dev + test compose). `qdrant-client` stays 1.18.0.
- A naïve `uv lock -P <pkg>` collapsed the TASK-695 `numba` 0.66/0.67 and `onnxruntime` 1.27/1.28 forks. The `stt[nemo]` extra now **pins** those upper bounds so a fresh resolve cannot unify onto ml.

## Implementation Plan

1. Raise leftover direct floors (`omegaconf>=2.3.1`, `symspellpy>=6.10.0`). Pin `stt[nemo]` to `numba>=0.66,<0.67` and `onnxruntime>=1.27,<1.28`.
2. `conda run -n arcaenv uv lock -P …` for every leftover in-range patch/minor and same-major security package. Skip denylist names.
3. Confirm torch 2.8 / transformers 5.5.4 / openai 2.x still locked; confirm the ml/nemo split.
4. Cheap suites: `pnpm py-env:test`, `pnpm py-otel:test`, plus one service smoke. Do not `uv sync` the whole workspace into conda.
5. Capture audit delta and leftovers.

## Implementation Summary

`conda run -n arcaenv uv lock` from the repo root: **Resolved 482 packages**, exit 0. Denylist packages did not move. `stt[ml]` vs `stt[nemo]` stay split. openai still **2.54.0**.

### Packages bumped (locked-from → locked-to)

**Security (same major)**

| Package | From | To | Extra / member |
|---|---|---|---|
| aiohttp | 3.14.1 | 3.14.3 | transitive (deepeval / ragas / fsspec http) |
| gitpython | 3.1.50 | 3.1.59 | transitive (`wandb` / nemo) |
| h2 | 4.3.0 | 4.4.1 | httpx `[http2]` |
| pyasn1 | 0.6.3 | 0.6.4 | google-auth |

**Direct**

| Package | From | To | Extra / member |
|---|---|---|---|
| omegaconf | 2.3.0 | 2.3.1 on `stt[ml]`; 2.3.0 remains on nemo | `stt[ml]` floor raised |
| symspellpy | 6.9.0 | 6.10.0 | `nlp` (dropped `editdistpy`) |

**In-range transitives (patch / same-major minor)**

| Package | From | To |
|---|---|---|
| alembic | 1.18.5 | 1.19.1 |
| annotated-doc | 0.0.4 | 0.0.5 |
| annotated-types | 0.7.0 | 0.8.0 |
| anyio | 4.14.1 | 4.14.2 |
| asgiref | 3.11.1 | 3.12.1 |
| av | 18.0.0 | 18.1.0 |
| certifi | 2026.6.17 | 2026.7.22 |
| cffi | 2.0.0 | 2.1.1 |
| charset-normalizer | 3.4.7 | 3.5.0 |
| colorlog | 6.10.1 | 6.12.0 |
| coverage | 7.15.0 | 7.15.4 |
| datasets | 5.0.0 | 5.0.1 |
| docker | 7.1.0 | 7.2.0 |
| filelock | 3.29.5 | 3.32.3 |
| google-auth | 2.56.2 | 2.56.3 |
| greenlet | 3.5.3 | 3.5.5 |
| grpcio | 1.81.1 | 1.83.0 |
| hf-xet | 1.5.1 | 1.6.0 |
| hiredis | 3.4.0 | 3.4.1 |
| langchain-core | 1.4.8 | 1.5.5 |
| langchain-openai | 1.3.3 | 1.5.1 (`openai>=2.45,<4`; lock kept openai 2.54.0) |
| langgraph-checkpoint | 4.1.1 | 4.2.0 |
| mako | 1.3.12 | 1.4.1 |
| matplotlib | 3.11.0 | 3.11.1 |
| mypy-boto3-bedrock-runtime | 1.43.30 | 1.43.62 |
| narwhals | 2.23.0 | 2.24.0 |
| phonenumbers | 9.0.34 | 9.0.37 |
| platformdirs | 4.10.0 | 4.11.3 |
| posthog | 7.21.3 | 7.39.1 |
| prompt-toolkit | 3.0.52 | 3.0.53 |
| pytest-rerunfailures | 16.4 | 16.5 |
| python-discovery | 1.4.3 | 1.5.2 |
| python-engineio | 4.13.3 | 4.13.5 |
| python-socketio | 5.16.3 | 5.16.4 |
| regex | 2026.6.28 | 2026.7.19 |
| s3transfer | 0.19.0 | 0.19.2 |
| sentry-sdk | 2.64.0 | 2.68.0 |
| smart-open | 8.0.0 | 8.0.1 |
| tldextract | 5.3.1 | 5.3.2 |
| tqdm | 4.68.3 | 4.70.0 |
| typer | 0.26.8 | 0.27.1 |
| typing-inspection | 0.4.2 | 0.4.4 |
| uuid-utils | 0.16.2 | 0.17.0 |
| virtualenv | 21.5.1 | 21.7.4 |
| wheel | 0.47.0 | 0.48.0 |
| wrapt | 2.2.2 | 2.3.0 |
| yarl | 1.24.2 | 1.24.5 |

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
| numba | 0.67.0 (ml) / 0.66.0 (nemo) |
| onnxruntime | 1.28.0 (ml/guardrail) / 1.27.0 (nemo) |
| fastapi / uvicorn | 0.141.1 / 0.52.3 |

### Security findings (`uv audit --frozen`)

| | Before | After |
|---|---|---|
| Known vulnerabilities | 65 | **33** |
| Packages scanned | 473 | 473 |

Cleared this pass: aiohttp (6 advisories, GHSA-cq5v-8q36-5273 / CVE-2026-59881), gitpython (18 advisories, 3.1.51–3.1.59), h2 (GHSA-6hr6-w5qg-qmwg, fixed 4.4.1), pyasn1 (CVE-2026-59884/59885/59886, fixed 0.6.4).

Still open (not same-major, no fix, or denylist):

| Package | Locked | Why leftover |
|---|---|---|
| cryptography | 48.0.1 | Fixes are 49.0.0 / 50.0.0; `presidio-anonymizer` 2.2.364 requires `cryptography>=48.0.1,<49` |
| setuptools | 81.0.0 | Fix is 83.0.0 (not same major) |
| langchain | 1.3.2 | CVE fix 1.3.9 needs `langgraph>=1.2.4` → `langgraph-sdk>=0.4.2` → `websockets<16`; uvicorn `[standard]` is on websockets 16.0. Optional `harness[eval-ragas]` only |
| ragas | 0.4.3 | SSRF CVE-2026-6587; no fix on PyPI (still 0.4.3) |
| diskcache | 5.6.3 | CVE-2025-69872; no fix |
| ecdsa | 0.19.2 | CVE-2024-23342; no fix |
| lightning | 2.4.0 | Advisory looks like a false PYSEC match; 2.4→2.6 is a nemo-stack minor, skipped |
| torch 2.8.0 / 2.12.1 | denylist | CVEs need 2.9–2.13 |
| transformers 4.57.6 | denylist (nemo pin) | Fixes are 5.x |

### Files changed (this ticket only)

- `apps/stt/pyproject.toml` — `omegaconf>=2.3.1`; nemo extra pins for numba/onnxruntime
- `apps/nlp/pyproject.toml` — `symspellpy>=6.10.0`
- `uv.lock` — refreshed
- this README

No `pnpm-lock.yaml`, TS `package.json`, `turbo.json`, GitLab/GitHub CI, or Compose/image-tag edits in this ticket.

### uv lock result

```
Using CPython 3.11.15
Resolved 482 packages in 416ms
```

Exit 0.

### Test evidence

Environment: conda `arcaenv`, Python 3.11.15. Did **not** `uv sync` the whole workspace into conda (ml/nemo conflict). Lock is the source of truth for Docker `uv sync --frozen`.

| Suite | Result |
|---|---|
| `pnpm py-env:test` | **73 passed** in 0.64s |
| `pnpm py-otel:test` | **17 passed** in 0.03s |
| Guardrail auth + health | **15 passed** in 4.61s |
| TTS auth + config | **18 passed** in 0.58s |

### Skipped / true leftovers

| Item | Why |
|---|---|
| openai 3.1.0 | Denylist; stay on 2.54.0 `<3` |
| mcp 2.0.0 / nemo-toolkit 3.0.0 | Denylist |
| torch / torchaudio / torchvision / torchcodec / transformers / huggingface-hub 1.16→1.27 | Denylist |
| temporalio 1.30 → 1.31 | Replay-sensitive; denylist |
| qdrant-client 1.18 → 1.19 | Compose still `qdrant/qdrant:v1.16` |
| optimum 2.1 → 2.3 | Denylist |
| librosa 1.0 / numpy 2.5 / scipy 1.18 | Need Python ≥3.12 |
| starlette 1.3.1 → 1.6.0 | FastAPI 0.141.1 keeps starlette in the 1.3 line |
| tokenizers 0.22.2 → 0.23.1 | Tied to transformers 5.5.4 |
| protobuf 5.29.6 → 7.x | Major; also blocks `googleapis-common-protos` 1.75.1 (`protobuf>=6.33.5`) |
| cryptography 48 → 49/50 | Major + presidio `<49` |
| setuptools 81 → 83/84 | Not same major |
| langchain 1.3.2 → 1.3.9+ | Blocked by websockets 16 vs langgraph-sdk 0.4 |
| fsspec 2024.12 → 2026.7 / packaging 24 → 26 / gevent 25 → 26 / pyarrow 24 → 25 | Calendar / major jumps |
| rich 14 → 15 / websockets 16 → 17 / portalocker 3 → 4 / xxhash 3 → 4 / rfc3986 1 → 2 | Majors |
| Co-resolving stt[ml] + stt[nemo] | Forbidden; extras stay conflicting |

### Verification (2026-08-16)

Re-checked against the current workspace. TASK-697 scoped floors and same-major security pins are still present. `conda run -n arcaenv uv audit --frozen` still reports **33** known vulnerabilities in 478 packages; leftover names match the table above (cryptography / setuptools / langchain / ragas / diskcache / ecdsa / lightning / torch / transformers). Later **TASK-700** intentionally moved some 697 denylist packages (`openai` 3.1.0 on SMR/`harness[eval]`, `mcp` 2.0.0, `temporalio` 1.31.0, `qdrant-client` 1.19.0). `gitpython` is no longer in `uv.lock` (`wandb` 0.28.2 dropped it). `python-json-logger` 4.2.0 appeared on PyPI 2026-08-15 after this pass; it is a non-security minor, not a 697 leftover.

## Change History

| Date | Change |
|---|---|
| 2026-08-15 | Ticket opened as TASK-697. Residual patches + same-major security locked; nemo numba/onnxruntime split pinned; denylist intact. Status `Review`. |
| 2026-08-16 | Verified completion against current implementation: scoped `pyproject.toml` floors, lock pins, ml/nemo split, and audit leftovers still match. Status `Completed`. |
