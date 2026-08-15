# TASK-706 — Python Blocker Gates

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `infrastructure` (dependency hygiene) |
| **Ticket number** | TASK-706 |
| **Scope** | Re-scan the four leftover Python blockers after TASK-700. Bump only if PyPI unblocks. Own `uv.lock`. No TS / pnpm / Compose / commit. |

TASK-700 landed openai **3.1.0** (SMR + `harness[eval]`), mcp 2.0, temporalio 1.31, qdrant-client 1.19, FastAPI 0.141.1. TASK-702–705 are reserved for sibling agents. This pass is **TASK-706**.

## Requirement Analysis

Check four gates. Apply a bump only when the **published** constraint on PyPI allows it. If still blocked, keep the TASK-700 conflict / pin and write the watch.

| Gate | Target | Unblock condition | Must not |
|---|---|---|---|
| **A** | Unify openai 3 onto `harness[eval-ragas]` | `instructor` allows `openai>=3` | Force openai 3 under instructor `<3`; wipe the uv conflict |
| **B** | cryptography 49/50 | `presidio-anonymizer` (or analyzer) allows `cryptography>=49` | Bump cryptography while presidio pins `<49` |
| **C** | langchain 1.3.9+ | `langgraph-sdk` allows websockets 16, **or** a langchain 1.3.x that does not need `websockets<16` | Downgrade uvicorn `[standard]` websockets **16.1.1** |
| **D** | ML stack (document only) | Confirm pyannote still keeps ml on torch 2.8 | Bump torch / transformers / nemo; co-resolve `stt[ml]` + `stt[nemo]` |

Hard constraints (same as TASK-700):

- Workspace `requires-python = ">=3.11,<3.12"`.
- One `uv.lock`. `conda run -n arcaenv` only. No `uv sync` of both ml+nemo into conda.
- Do not edit `pnpm-lock.yaml`, TS `package.json`, or docker-compose.
- Do not treat SMR 401s as a regression (known `.env.dev` `SMR_SERVICE_TOKEN` leak).
- If a bump pulls torch / transformers / an openai downgrade, revert.

## Current State Evaluation

Re-scan (2026-08-15) against the **post-700 lock** and live PyPI / upstream `main`.

### Locked (post-700)

| Package | Locked | Role |
|---|---|---|
| openai | **3.1.0** default + **2.54.0** `eval-ragas` fork | Gate A |
| instructor | 1.15.4 | Gate A (via ragas) |
| ragas | 0.4.3 | Gate A |
| cryptography | 48.0.1 | Gate B |
| presidio-analyzer / anonymizer | 2.2.364 / 2.2.364 | Gate B |
| langchain | 1.3.2 | Gate C |
| langgraph | 1.2.2 | Gate C |
| langgraph-sdk | 0.3.15 | Gate C (no websockets pin) |
| websockets | 16.1.1 (uvicorn `[standard]`) | Gate C |
| uvicorn | 0.52.3 | Gate C |
| pyannote.audio | 4.0.7 | Gate D |
| torch | **2.8.0** (`stt[ml]`) / **2.12.1** (`stt[nemo]`) | Gate D |

Root `pyproject.toml` still declares uv conflicts: `harness[eval-ragas]` vs `smr`, and `harness[eval-ragas]` vs `harness[eval]`.

### PyPI (2026-08-15)

| Package | Latest | Constraint that matters |
|---|---|---|
| instructor | **1.15.4** (same as lock) | `openai>=2.0.0,<3.0.0` |
| ragas | **0.4.3** (same) | pulls `instructor` (unbounded) |
| presidio-anonymizer | **2.2.364** (same) | `cryptography>=48.0.1,<49.0.0` |
| presidio-analyzer | **2.2.364** (same) | no cryptography pin |
| cryptography | **50.0.0** | — |
| langchain | **1.3.15** | `langgraph>=1.2.11,<1.3` from 1.3.15; **1.3.3+** already needs `langgraph>=1.2.4` |
| langgraph | **1.2.11** | `langgraph-sdk>=0.4.2,<0.5` from **1.2.3+** |
| langgraph-sdk | **0.4.2** | `websockets>=14,<16` |
| websockets | 17.0.1 | uvicorn stays on 16.1.1 |
| pyannote.audio | **4.0.7** (same) | `torch>=2.8.0` (floor; 4.0.2–4.0.3 were `torch==2.8.0`) |

### Upstream `main` (not released — watch only)

| Repo | Finding |
|---|---|
| [567-labs/instructor](https://github.com/567-labs/instructor) `main` | Declares version **1.16.0** but still `openai>=2.0.0,<3.0.0`. Next PyPI cut will **not** unblock Gate A. |
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) `libs/sdk-py` | `websockets>=14,<17` — **widened past 16**. Next `langgraph-sdk` PyPI (likely 0.4.3+) is the Gate C unblock. |
| [microsoft/presidio](https://github.com/microsoft/presidio) `presidio-anonymizer` | Still `cryptography (>=48.0.1,<49.0.0)` at 2.2.364. |

`uv tree --outdated --depth 1` agrees: instructor / presidio / ragas / langchain are not listed as direct outdated members (they are extras / transitives). torch shows latest 2.13.0 — denylist, do not take.

## Implementation Plan

1. Query PyPI + lock for Gates A–D.
2. If a gate is unblocked, raise the floor, `conda run -n arcaenv uv lock`, revert if torch / transformers / openai-downgrade move.
3. If still blocked, do **not** force. Keep the eval-ragas conflict and cryptography 48.0.1.
4. Gate C optional isolate (ragas/langchain extra without uvicorn `[standard]`): only if already the extra design and a small change. It is not — harness **base** declares `uvicorn[standard]>=0.52.3`, and the workspace lock co-resolves all members. Skip.
5. Gate D: document only. Do not bump.
6. Tests: `pnpm py-env:test`, `pnpm py-otel:test`. Harness eval / guardrail only if those extras move.

## Implementation Summary

**No lock or `pyproject.toml` edits.** All four gates remain blocked on published PyPI metadata. `uv.lock` was not re-resolved (a no-op lock can still refresh transitives).

### Scoreboard

| Gate | Status | From → To | Why / watch |
|---|---|---|---|
| **A instructor / eval-ragas / openai 3** | **Still blocked** | instructor 1.15.4 stays; openai **3.1.0** (SMR + `eval`) / **2.54.0** (`eval-ragas`) | Latest instructor and unreleased 1.16.0 `main` still pin `openai<3`. Keep the two uv conflicts. **Watch:** instructor release with `openai>=3` (or ragas dropping instructor). Then bump instructor, drop the eval-ragas conflicts, re-lock, run harness eval-ragas / eval judge. |
| **B presidio / cryptography 49** | **Still blocked** | cryptography **48.0.1** stays; presidio 2.2.364 stays | Latest anonymizer and `main` still `cryptography>=48.0.1,<49`. Latest cryptography is 50.0.0. **Watch:** presidio-anonymizer `>2.2.364` with `cryptography>=49`. Then bump presidio + cryptography together; run guardrail auth/health. |
| **C langchain / websockets** | **Still blocked** | langchain **1.3.2** / langgraph-sdk **0.3.15** / websockets **16.1.1** stay | Every langchain **1.3.3+** needs langgraph `>=1.2.4`, which needs langgraph-sdk `>=0.4.2`, which on PyPI still pins `websockets<16`. Did **not** downgrade uvicorn’s websockets 16. Did **not** split uvicorn off harness base (not a small extra change). **Watch:** PyPI `langgraph-sdk` that allows websockets 16 (`main` already has `>=14,<17`). Then take langchain 1.3.15 in-range. |
| **D ML** | **Document only — still blocked** | ml torch **2.8.0** / nemo torch **2.12.1** / pyannote **4.0.7** / transformers **5.5.4** (ml) / **4.57.6** (nemo) | Latest pyannote.audio is still 4.0.7. 4.0.4+ relaxed the metadata pin from `torch==2.8.0` to `torch>=2.8.0`, but HOPE still pins `stt[ml]` `torch>=2.8,<2.9` and `stt[nemo]` `torch>=2.12,<2.13` after TASK-700’s 2.13 leak. Do not bump. Do not co-resolve the extras. |

### Unblock conditions (next pass)

| Gate | Take the bump when |
|---|---|
| A | PyPI `instructor` requires `openai>=3` (or ragas no longer depends on instructor). Then remove `[tool.uv] conflicts` for `eval-ragas` vs `smr` / `eval`. |
| B | PyPI `presidio-anonymizer` requires `cryptography>=49` (or drops the `<49` cap). Bump anonymizer + cryptography together. |
| C | PyPI `langgraph-sdk` allows `websockets>=16` (upstream `main` already `<17`). Then `uv lock -P langchain` to 1.3.15. Do not pin `websockets<16`. |
| D | A pyannote.audio release that is validated on **torch ≥2.9** (so `stt[ml]` can raise `<2.9`), **or** NeMo 3 shipped as its **own extra** so the ml/nemo fork can move independently. Until then: no torch / transformers / nemo bump. |

### Files changed

None (`uv.lock` and all `pyproject.toml` untouched). This ticket is a re-scan + watch write-up; the TASK-700 pins and uv conflicts stay as the working gates.

### Test evidence

Environment: conda `arcaenv`. No extras touched, so no harness eval-ragas / MCP / guardrail presidio suites.

| Suite | Result |
|---|---|
| `pnpm py-env:test` | **73 passed** (2026-08-15: 1.27s; re-run 2026-08-16: 0.93s) |
| `pnpm py-otel:test` | **17 passed** (2026-08-15: 0.01s; re-run 2026-08-16: 0.02s) |

Harness eval-ragas / MCP and guardrail auth/health were **not** run — those extras did not move. `arcaenv` was missing `pytest` / `hope-otel` at the start of this pass (collection failed); pytest 9.1.1 + editable `hope-otel` were installed into conda only so the scripts could run. That is env repair, not a lock change.

2026-08-16 completion check: PyPI + lock still match the scoreboard (instructor 1.15.4 `openai<3`; presidio-anonymizer 2.2.364 `cryptography<49`; langgraph-sdk 0.4.2 `websockets<16`; pyannote.audio 4.0.7 `torch>=2.8.0`). No unblocked bump was skipped.

## Change History

| Date | Change |
|---|---|
| 2026-08-15 | Ticket opened as TASK-706. Re-scanned Gates A–D against post-700 lock + PyPI + upstream `main`. All four still blocked. No lock edits. Status `Review`. |
| 2026-08-16 | Verified completion against current lock, PyPI metadata, uv conflicts, and `pnpm py-env:test` / `py-otel:test` (73 + 17 passed). All four gates still blocked; no leftover scoped work. Status `Completed`. |
