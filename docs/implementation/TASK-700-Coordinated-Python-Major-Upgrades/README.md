# TASK-700 — Coordinated Python Major Upgrades

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `infrastructure` (dependency hygiene) |
| **Ticket number** | TASK-700 |
| **Scope** | Coordinated Python **majors** on the single uv workspace (`uv.lock`). No TS / pnpm / Compose / GitLab image-tag changes. No commit. |

TASK-695/697 already took FastAPI 0.141.1, uvicorn 0.52.3, openai 2.54.0 `<3`, OTel 1.44 / 0.65b0, and residual same-major security. TASK-696/698/699/701 were reserved for sibling TS/infra agents. This pass is **TASK-700**.

## Requirement Analysis

Take the remaining **ecosystem majors** that TASK-695/697 denylisted, in compatibility sets that must land together or not at all:

| Set | Target | Gate |
|---|---|---|
| P1 | openai **3.1.x** (drop `<3`) | SMR + harness eval call sites; langchain-openai must not drag openai back to 2.x |
| P2 | mcp **2.0.0** | harness `mcp-tools` extra APIs; extra stays lazy/flag-gated |
| P3 | temporalio **1.31.x** | paired with infra Temporal server 1.31; revert if replay tests fail |
| P4 | qdrant-client **1.19.x** | paired with infra Qdrant image v1.19; skip if it forces an unrelated denylist move |
| P5 | Remaining CVE majors | cryptography 49 only if presidio allows; langchain 1.3.9+ only if websockets/uvicorn resolve; setuptools 83; ragas/diskcache/ecdsa if a fix exists |
| P6 | ML stack | **Default skip.** Only if `stt[ml]` still installs with pyannote 4.x and `stt[nemo]` stays a conflicting extra. Revert entirely if torch 2.13 breaks pyannote. |

Hard constraints (must not regress):

- `stt[ml]` vs `stt[nemo]` extras **stay conflicting**. nemo keeps numba `<0.67` and onnxruntime `<1.28`.
- Workspace `requires-python = ">=3.11,<3.12"`. Do not bump librosa/numpy/scipy to versions that need Python ≥3.12.
- One `uv.lock`. `conda run -n arcaenv` only. No `uv sync` of both ml+nemo into conda.
- Do not edit `pnpm-lock.yaml`, TS `package.json`, docker-compose, or GitLab (infra owns images).

Infra pairing (TASK-701 may land images later): still bump clients to `qdrant-client` 1.19.x and `temporalio` 1.31.x.

## Current State Evaluation

Re-scan (2026-08-15) against the **post-697 lock** (`uv tree --outdated --depth 1`):

| Package | Locked (pre-700) | Latest | Set |
|---|---|---|---|
| openai | 2.54.0 (`<3`) | 3.1.0 | P1 |
| mcp | 1.28.1 | 2.0.0 | P2 |
| temporalio | 1.30.0 | 1.31.0 | P3 |
| qdrant-client | 1.18.0 | 1.19.0 | P4 |
| cryptography | 48.0.1 | 49/50 | P5 (presidio-anonymizer 2.2.364 pins `<49`) |
| langchain | 1.3.2 | 1.3.15 | P5 (langgraph-sdk 0.4.x wants `websockets<16`; uvicorn `[standard]` is on 16) |
| setuptools | 81.0.0 | 84.0.0 | P5 |
| ragas / diskcache / ecdsa | 0.4.3 / 5.6.3 / 0.19.2 | no newer fix | P5 skip unless a release appears |
| torch / transformers / huggingface-hub / optimum | denylist ML | — | P6 default skip |

P1 research: openai 3.0 breaking change is HTTPX2 as the default HTTP client (`httpx` is no longer auto-installed). SMR OpenAI / Azure / OpenAI-compat providers and harness eval judges construct `AsyncOpenAI` / `AsyncAzureOpenAI` **without** a custom `http_client`. `chat.completions.create` is unchanged. langchain-openai **1.5.1** already declares `openai>=2.45,<4`. Blocker: `instructor` 1.15.4 (via optional `harness[eval-ragas]`) still requires `openai<3`.

P2 research: mcp 2.0 removes `streamablehttp_client`, yields a 2-tuple, moves headers/timeout onto `httpx2.AsyncClient`, and renames `CallToolResult.isError` → `is_error`.

## Implementation Plan

1. P1: raise openai floors, drop `<3`, `uv lock`. If instructor/ragas blocks, isolate `eval-ragas` via uv conflicts (do not drag openai back to 2.x).
2. P2: raise mcp floor, update `mcp_client.py`, `uv lock`.
3. P3: raise temporalio floor, `uv lock`, run harness replay-compat. Revert P3 if replay fails.
4. P4: raise qdrant-client floor, `uv lock`. Revert if denylist ML pins move.
5. P5: try leftover CVE majors independently; skip if incompatible.
6. P6: default skip unless the whole extra still resolves with pyannote 4.x + conflicting nemo extra.
7. Confirm lock: ml/nemo still conflict; openai 3.x / temporalio 1.31 / qdrant-client 1.19 if those sets succeeded.
8. Tests: `pnpm py-env:test`, `pnpm py-otel:test`, SMR isolated generate, harness units that can run, guardrail auth/health.

## Implementation Summary

`conda run -n arcaenv uv lock` from the repo root: **Resolved 487 packages**, exit 0. Did **not** `uv sync` both `stt[ml]` + `stt[nemo]` into conda. Installed only the bumped wheels into `arcaenv` for tests (`openai` 3.1.0, `temporalio` 1.31.0, `qdrant-client` 1.19.0, `mcp` 2.0.0 + `httpx2` 2.10.0).

### Scoreboard

| Set | Status | From → To | Notes |
|---|---|---|---|
| **P1** | **Taken** | openai 2.54.0 `<3` → **3.1.0** (SMR + `harness[eval]`) | `harness[eval-ragas]` keeps openai **2.54.0** via uv conflicts (`instructor` 1.15.4 still `openai<3`). langchain-openai 1.5.1 stays (`openai>=2.45,<4`); it sits on the ragas fork and does **not** drag SMR back to 2.x. No generate/eval call-site edits: HTTPX2 is the default client; `chat.completions.create` is unchanged. Raised `ragas>=0.4.3` so uv cannot silently downgrade ragas 0.4.3 → 0.3.1. |
| **P2** | **Taken** | mcp 1.28.1 → **2.0.0** (+ mcp-types 2.0.0) | `mcp_client.py`: `streamable_http_client`, headers/timeout on `httpx2.AsyncClient`, yield `(read, write)`, `is_error` with `isError` fallback. Extra stays lazy/flag-gated. |
| **P3** | **Taken** | temporalio 1.30.0 → **1.31.0** | Replay-compat **18 passed**. Do not revert. Paired with infra Temporal server 1.31 (TASK-701). |
| **P4** | **Taken** | qdrant-client 1.18.0 → **1.19.0** | Did not force an unrelated denylist ML move. Paired with infra Qdrant image v1.19 (TASK-701). |
| **P5 cryptography** | **Skipped** | 48.0.1 stays | Latest presidio-anonymizer is still 2.2.364 with `cryptography>=48.0.1,<49`. Do not break presidio. |
| **P5 langchain** | **Skipped** | 1.3.2 stays | `uv lock -P langchain` resolved with **no version change**. langchain 1.3.15 needs langgraph-sdk 0.4.x (`websockets<16`); uvicorn `[standard]` is on websockets **16.1.1**. Did not pin websockets `<16` (would downgrade a working FastAPI/uvicorn extra). |
| **P5 setuptools** | **Partial / not unified** | 81.0.0 remains on nemo torch; **84.0.0** on the default path | `uv lock -P setuptools==83.0.0` **collapsed** the torch 2.8 / 2.12 fork. Do not `-P setuptools`. A full re-resolve forked 81 (torch 2.12.1) + 84. CVE-class bump is present on the non-nemo path only. |
| **P5 ragas / diskcache / ecdsa** | **No newer fix** | 0.4.3 / 5.6.3 / 0.19.2 | ragas floor raised to `>=0.4.3` so P1 cannot silently drop it. |
| **P6** | **Skipped (reverted leak)** | ml torch **2.8.0** / torchcodec **0.7.0** / torchvision **0.23.0** / transformers **5.5.4** / huggingface-hub **1.16.1** / optimum **2.1.0** / nemo-toolkit **2.7.3** / pyannote.audio **4.0.7** | A fresh resolve pulled nemo torch **2.13.0**. Pinned `stt[nemo]` `torch>=2.12,<2.13` and re-locked to **2.12.1**. Do not take torch 2.13. |

### Lock confirmation (must-not-regress)

| Package | Locked |
|---|---|
| fastapi / uvicorn | 0.141.1 / 0.52.3 |
| openai | **3.1.0** default + **2.54.0** `eval-ragas` fork |
| mcp | **2.0.0** |
| temporalio | **1.31.0** |
| qdrant-client | **1.19.0** |
| numba | 0.67.0 (ml/guardrail) / **0.66.0** (nemo) |
| onnxruntime | 1.28.0 (ml/guardrail) / **1.27.0** (nemo) |
| transformers | **5.5.4** (ml) / **4.57.6** (nemo) |
| torch | **2.8.0** (ml / pyannote) / **2.12.1** (nemo) |
| aiohttp / h2 / pyasn1 | 3.14.3 / 4.4.1 / 0.6.4 |
| omegaconf | 2.3.1 (ml) / 2.3.0 (nemo) |
| symspellpy | 6.10.0 |
| cryptography | 48.0.1 |
| langchain | 1.3.2 |
| `stt[ml]` vs `stt[nemo]` | still conflicting extras |

Incidental: `gitpython` is no longer in `uv.lock` (wandb no longer pulls it). TASK-697's 3.1.59 pin is therefore unused, not regressed.

### Code / floor changes

- `apps/smr/pyproject.toml` — `openai>=3.1.0,<4`
- `apps/harness/pyproject.toml` — `openai>=3.1.0,<4` (`eval`); `mcp>=2.0.0`; `temporalio[opentelemetry]>=1.31.0`; `qdrant-client>=1.19.0`; `ragas>=0.4.3`; mypy override includes `httpx2`
- `apps/stt/pyproject.toml` — `stt[nemo]` `torch>=2.12.0,<2.13.0` (block accidental P6)
- `pyproject.toml` — `[tool.uv] conflicts` for `harness[eval-ragas]` vs `smr` and vs `harness[eval]`
- `apps/harness/src/harness/tools/mcp_client.py` — MCP 2 client API
- `uv.lock` — refreshed

No `pnpm-lock.yaml`, TS `package.json`, Compose, or GitLab edits in this ticket.

### uv lock result

```
Using CPython 3.11.14
Resolved 487 packages in 237ms
Updated torch v2.8.0, v2.13.0 -> v2.8.0, v2.12.1
```

(After the nemo torch pin. Earlier `uv lock -P setuptools==83.0.0` collapsed the torch fork and was discarded.)

### Test evidence

Environment: conda `arcaenv`, Python 3.11.15. Did **not** `uv sync` the whole workspace into conda (ml/nemo conflict). Lock is the source of truth for Docker `uv sync --frozen`.

| Suite | Result |
|---|---|
| `pnpm py-env:test` | **73 passed** in 0.56s |
| `pnpm py-otel:test` | **17 passed** in 0.02s |
| Isolated SMR `test_generate_uses_injected_registry` | **1 passed** in 1.51s |
| Harness eval judge + MCP client units | **59 passed** in 20.62s |
| Harness Temporal `test_replay_compat.py` | **18 passed** in 2.36s |
| Guardrail auth + health | **15 passed** in 3.58s |
| MCP 2 extra-path import + py_compile of SMR/harness openai + mcp call sites | `COMPILE_AND_IMPORT_OK` (openai 3.1.0, mcp 2.0.0, `streamable_http_client`, `AsyncOpenAI`) |

Full `smr:test:unit` was **not** used as a P1 gate (known `.env.dev` `SMR_SERVICE_TOKEN` leak → 401s on protected routes; same as TASK-695).

### Leftover incompatible stacks

| Item | Why |
|---|---|
| cryptography 49/50 | presidio-anonymizer 2.2.364 pins `<49` |
| langchain 1.3.9+ | langgraph-sdk 0.4.x wants `websockets<16`; uvicorn `[standard]` is on 16.1.1 |
| setuptools unified 83/84 | `-P setuptools` collapses the torch 2.8 / 2.12 fork; 84 exists only on the non-nemo path |
| ragas / diskcache / ecdsa | no newer PyPI release than 0.4.3 / 5.6.3 / 0.19.2 |
| instructor / ragas vs openai 3 | `eval-ragas` stays on openai 2.54; wait for instructor `openai>=3` |
| P6 ML (torch 2.13, transformers, huggingface-hub 1.27, optimum 2.3, nemo 3) | default skip; torch 2.13 leaked once and was reverted. pyannote 4.x stays on torch 2.8 |
| librosa 1.0 / numpy 2.5 / scipy 1.18 | need Python ≥3.12; workspace is `>=3.11,<3.12` |
| Co-resolving `stt[ml]` + `stt[nemo]` | forbidden; extras stay conflicting |

These leftovers were explicit skips / isolates for this ticket, not unfinished take-sets. Follow-up re-scan is TASK-706 (Gates A–D). FastAPI 0.141.1 / uvicorn 0.52.3 were already landed by TASK-695/697 (lock confirmation only). Pydantic was not in this ticket's remaining majors (still 2.13.4).

## Change History

| Date | Change |
|---|---|
| 2026-08-15 | Ticket opened as TASK-700. Coordinated Python majors (P1–P5; P6 optional). Status `In Progress`. |
| 2026-08-15 | P1–P4 taken (openai 3.1 + eval-ragas 2.54 fork, mcp 2.0, temporalio 1.31, qdrant-client 1.19). P5 mostly skipped (presidio / websockets / no newer ragas). P6 skipped; nemo torch pinned `<2.13` after a 2.13 leak. Replay 18 passed. Status `Review`. |
| 2026-08-16 | Completeness review against current lock/floors/MCP client: P1–P4 still taken as claimed; P5/P6 leftovers remain the documented skips (TASK-706). `uv.lock` still 487 `[[package]]` entries. Status `Completed`. |
