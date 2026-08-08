# TASK-639 — SMR Test Environment Leak (401s from a real `.env.dev` token)

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `bugfix` |
| **Created** | 2026-08-08 |
| **Scope** | `apps/smr/src/smr/tests/**` (test harness only — production code is NOT at fault) |
| **Found by** | TASK-636 Phase 4 verification |
| **Sibling tickets** | TTS instance **fixed** in [TASK-636](../TASK-636-Observability-Coverage-And-Dependency-Monitoring/README.md) · guardrail instance in a separate spawned session (`task_8f917f8a`) |

---

## 1. Requirement Analysis

`apps/smr/src/smr/tests/unit` fails **109 of 1072 tests** with
`401 Invalid or missing service token` on endpoints that have nothing to do
with auth. The failures are **collection-order dependent**: the same files pass
when run alone.

The requirement is narrow and testable:

| # | Requirement | Satisfied when |
|---|---|---|
| R1 | The SMR unit suite passes deterministically, in any collection order | `pytest apps/smr/src/smr/tests/unit` → 0 failed, and the same result when files are run individually or reordered |
| R2 | No test run mutates the developer's real process environment | After importing the SMR test package, `os.environ` contains no `SMR_*` value sourced from `.env.dev` |
| R3 | The uvicorn/Docker entrypoint is unchanged | `uvicorn smr.main:app` still resolves a real `FastAPI` instance with all routes registered |

**Explicitly out of scope**: fixing the same defect in `apps/stt` and
`apps/harness` (see §2.4 — they share the mechanism but are not currently
symptomatic), and the pre-existing Azure-provider failures (§2.5).

---

## 2. Current State Evaluation

### 2.1 Measured, not estimated

Both runs are `pytest apps/smr/src/smr/tests/unit -q`, same machine, same session:

| State | failed | passed |
|---|---:|---:|
| **Baseline** — all TASK-636 trace work stashed and the new test file moved aside | **134** | 928 |
| Current — TASK-636 trace work + two partial fixes already applied (§2.3) | **109** | 963 |

> **This is a PRE-EXISTING defect, not a regression.** It was initially
> mis-diagnosed during TASK-636 as damage from the trace-propagation refactor.
> The stash-and-rerun above disproves that: the suite was already 134-failing
> before any of that work existed, and the TASK-636 changes plus the two partial
> fixes *reduced* failures by 25. The mis-diagnosis came from comparing against
> a run of `tests/` (the full suite — different scope, different collection
> order, different leak behaviour) and treating it as a baseline for
> `tests/unit`.

### 2.2 Root cause

`apps/smr/src/smr/main.py` ends with a module-level `app = create_app()`. That
call runs the real `get_settings()`, which calls `hope_env.load_env()`, which
**merges this machine's gitignored `.env.dev` into `os.environ`** — a permanent
mutation of the process environment, not scoped to a test or a fixture.

Verified directly:

```
$ python -c "import os,sys; sys.path.insert(0,'apps/smr/src');
             print('before:', 'SMR_SERVICE_TOKEN' in os.environ);
             import smr.main;
             print('after:', 'SMR_SERVICE_TOKEN' in os.environ)"
before: False
after:  True   (value non-empty)
```

Once a real `SMR_SERVICE_TOKEN` is in `os.environ`, SMR's auth middleware
(`apps/smr/src/smr/api/middleware/auth.py`) switches from dev-mode bypass
(empty token) to **enforcing**. Every subsequent request the suite makes without
that header returns `401`, so tests about SSE streaming, response models, CORS
and provider selection all fail for a reason unrelated to what they assert.

**Five unit-test files import `smr.main` at module level**, any of which can
trigger the leak depending on collection order:

```
test_auth_middleware.py
test_cors_config.py
test_request_id_middleware.py
test_response_models.py
test_secret_management.py
```

This is why the failure count moves when unrelated files are added or renamed:
alphabetical collection order decides whether the leak happens before or after
the tests that care.

### 2.3 Two partial fixes already applied under TASK-636

Both are in the working tree and account for the 134 → 109 improvement. Neither
is complete; this ticket finishes the job.

1. **`tests/conftest.py`** — snapshot/restore `os.environ` around the
   `smr.main` import, mirroring the fix TASK-636 applied to TTS. Removes the
   conftest-time leak, but not the five module-level imports in §2.2.
2. **`tests/unit/test_xread_streaming.py`** — a genuinely separate defect,
   fixed: the SSE endpoint now calls `read_chunk_entries_blocking` (the
   trace-aware variant added by TASK-636 OBS-16), but the test double only
   mocked the old `read_chunks_blocking`. On `AsyncMock(spec=TaskManager)` the
   unmocked call returns a mock rather than a list, so the stream loop
   misbehaved and the file hung. Now mocks both, and mirrors any per-test
   override of the 2-tuple reader onto the 3-tuple one. **That file went from
   hanging to 11 passed in isolation.**

### 2.4 Fleet context — SMR is not alone

| Service | module-level `app = create_app()` | test conftest guarded? |
|---|---|---|
| `smr` | yes | **guarded** (partial, §2.3) |
| `tts` | yes | **guarded** — fixed in TASK-636 |
| `guardrail` | yes | **guarded** — separate session, `task_8f917f8a` |
| `stt` | yes | **unguarded** |
| `harness` | yes | **unguarded** |
| `nlp` | **no** — launched with `--factory` | n/a |

`stt` and `harness` share the exact mechanism and are simply not symptomatic
today: their conftests do not import `main` at module scope, so nothing triggers
it — yet. `nlp` is immune by construction because it uses `uvicorn --factory`,
which is the structurally correct answer and worth noting as precedent.

### 2.5 Not this ticket

`apps/smr/src/smr/tests/unit/test_providers_e1.py` and
`test_provider_key_consistency.py` carry a handful of Azure-provider failures
that persist regardless of environment state. Confirmed pre-existing and
unrelated by stashing (they fail identically with all TASK-636 SMR changes
removed). Do not fold them into this fix.

Also pre-existing and deliberately untouched: `test_sse_trace_propagation_task636.py`
fails `black --check` on lines nobody in TASK-636 wrote.

---

## 3. Implementation Plan

### 3.1 Constraint — do NOT "fix" `main.py`

`apps/smr/Dockerfile` and `scripts/dev-service.sh`'s `smr)` case both launch
`uvicorn smr.main:app` — a plain module-attribute launch, **not** `--factory`.
The module-level `app` is load-bearing for the production entrypoint. Converting
SMR to a factory pattern is a legitimate end-state (it is what `nlp` already
does) but it means changing the Dockerfile and the dev script too, which is a
larger blast radius than this bug warrants. **Fix the test harness first.**

### 3.2 Steps

| Step | Action | Verify |
|---|---|---|
| 1 | Reproduce deterministically. Record the failure count for `tests/unit` and for at least two different collection orders (e.g. `-p no:randomly` vs reversed file order) | The count changes with order — that IS the bug |
| 2 | Neutralise the five module-level imports in §2.2. Prefer the least invasive mechanism that works for all five: either an autouse session fixture that snapshots/restores `os.environ`, or a `conftest.py`-level guard that imports `smr.main` once (already present) **before** any test module does, so their imports become no-ops | `os.environ` has no `.env.dev`-sourced `SMR_*` key after full collection |
| 3 | Make auth posture explicit rather than ambient. Tests that exercise the auth middleware should set the token deliberately via `settings_override`/`monkeypatch`; tests that do not care should get a guaranteed-empty token. Ambient inheritance from a developer's machine is the actual defect | Auth tests pass because they set a token, not because one leaked |
| 4 | Run the whole suite in at least two orders | 0 failed in both, excluding §2.5 |
| 5 | Add a regression guard: a test asserting `os.environ` carries no `SMR_SERVICE_TOKEN` after importing the test package | Guard fails if someone re-introduces an unguarded module-level import |

### 3.3 Consider promoting the fix

TTS, guardrail and SMR will each have a near-identical conftest snippet. If the
third copy looks like drift, the shared home is `packages/py-env` (`hope_env`) —
it already owns env-file resolution, so a `hope_env.testing` helper that
snapshots/restores is a natural fit, unlike the tracing helper that was
deliberately kept out of it (see TASK-636 §Phase 7). **Judgement call for the
implementer; three copies is not automatically wrong.**

### 3.4 Verification criteria

- [ ] `pytest apps/smr/src/smr/tests/unit` → 0 failed (excluding §2.5)
- [ ] Same result with files run individually and in a reordered run
- [ ] `os.environ` unpolluted after collection (asserted by a test)
- [ ] `uvicorn smr.main:app` still yields a real `FastAPI` app with all routes
- [ ] `ruff`, `black --check`, `mypy` clean on touched files
- [ ] No change to any file under `apps/smr/src/smr/` outside `tests/`

---

## 4. Implementation Summary

*(To be completed. Record the before/after failure counts for at least two
collection orders — a single run does not demonstrate the ordering dependency
is gone.)*

---

## 5. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Ticket created from TASK-636 Phase 4 verification. Root cause identified and measured: `smr/main.py`'s module-level `app = create_app()` merges the developer's real `.env.dev` into `os.environ` at import, so a live `SMR_SERVICE_TOKEN` flips the auth middleware from dev-bypass to enforcing and returns 401 to 109 unrelated tests. Five unit-test files can trigger it, which makes the failure count collection-order dependent. **Confirmed PRE-EXISTING, not a TASK-636 regression** — baseline with all trace work stashed is 134 failed / 928 passed vs 109 / 963 with it; the initial "regression" diagnosis during TASK-636 was wrong and is corrected here. Two partial fixes already landed under TASK-636 (conftest env snapshot/restore; a genuinely separate stale-mock defect in `test_xread_streaming.py` that had the file hanging). Fleet scan recorded: 5 of 6 Python services have the same module-level `app`, 3 now guarded, `stt`/`harness` share the mechanism but are not yet symptomatic, `nlp` is immune via `--factory`. | Claude |
