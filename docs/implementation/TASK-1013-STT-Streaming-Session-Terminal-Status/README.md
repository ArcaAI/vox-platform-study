# TASK-1013: `stt_streaming_sessions_total` records a terminal status

**Status:** Review
**Type:** bugfix (observability)
**Branch:** `dev-2.2` (merged from `agent/sharp-hopper-96900a`, merge commit `01c154c64`)
**Related:** TASK-1012 lane W-5 (the static reading that found this), TASK-985 M-19 (which
added the helper but did not wire it), `arca/hope-v2-deployment` `docs/observability-slos.md`

## Requirement Analysis

TASK-1012 lane W-5 found this by reading the code on 2026-09-29.
`streaming_session_finished()` in `apps/stt/src/stt/core/metrics.py` records
`stt_streaming_sessions_total` with a terminal status, but nothing calls it. The counter
therefore only ever carries `status="started"`. As a result, the deployment repo's
"streaming session success" SLI is marked **not yet measurable**.

The task had four parts:

1. Prove the gap with a failing test covering normal close, client disconnect,
   error/teardown and resume-expired.
2. Record the terminal status once per session, using a small, documented vocabulary.
3. Run only the touched test files, plus lint on the touched files.
4. Name the line in the SLO doc that can be flipped once this deploys.

## Current State Evaluation

- **Grep result:** there is no `streaming_session_finished(` call anywhere in `apps/stt/src`.
  The only call to `STREAMING_SESSIONS_TOTAL` is `streaming_session_started()`, and it always
  passes `status="started"`. `streaming_session_ended()` only syncs the active gauge.
- **Vocabulary:** already fixed by TASK-985 as `SESSION_FINISHED_STATUSES = {closed, recovered,
  reaped, failed}`, and the helper raises `ValueError` for anything else. The deployment repo
  already expects this set. On `origin/main` (`60f092c`), `docs/observability-slos.md` §3.1 names
  `closed / recovered / reaped / failed` and defines the SLI as
  `1 - sum(rate(stt_streaming_sessions_total{status="failed"}[1h])) / sum(rate(stt_streaming_sessions_total{status!="started"}[1h]))`.
  The earlier `status="ended"` form matched no series. **No new statuses were added.**
- **"Client disconnect" and "resume-expired"** do not exist as concepts inside STT. They are
  gateway concepts: the WS drops, the resume-grace window runs out, and the gateway calls
  `removeSession` → `DELETE /internal/streaming/sessions/{id}` → `SessionManager.end_session`.
  To STT, both are an ordinary finalize, so both record `closed`. STT's own "expiry" is the idle
  reaper, which records `reaped`.
- **One place to record it:** every terminal path ends in `SessionManager.remove_session`.
  `started` is counted at exactly the moment a session enters `self._sessions`. So if the
  terminal status is recorded in `remove_session`, and only when that call actually pops a live
  session, each started session gets exactly one terminal status. A second finalizer or a late
  removal records nothing.

## Implementation Plan

1. RED: `apps/stt/tests/unit/streaming/test_task1013_session_finished_metric.py` drives the real
   `SessionManager` and reads Prometheus registry deltas. It covers finalize, a double finalize
   plus a late removal, `end_session` (DELETE), CANCEL, an `end_session` that raises, a forced
   removal, removing an unknown id, the reaper succeeding and failing, and a recovered session's
   close.
2. GREEN: `remove_session(session_id, *, outcome="failed")` emits once, and the finalizer,
   reaper, CANCEL and recovery pass or mark their own outcome.
3. Update the existing test doubles that were pinned to the old one-argument `remove_session` /
   `_finalize_session` call shape.

## Implementation Summary

### Status vocabulary (unchanged from TASK-985, now wired)

| Status | Recorded when | Call site |
|---|---|---|
| `closed` | Normal finalize: in-band final frame, control FINALIZE, the gateway DELETE (which is also how a client disconnect or a resume-grace expiry arrives), or a client CANCEL | `_finalize_session_locked` → `remove_session(outcome=…)`; `_cancel_session` |
| `recovered` | The same normal finalize, for a session this process rebuilt in `_recover_sessions`. Its `started` was counted by the process that created it | `_finalize_session_locked` (via `_recovered_session_ids_of`) |
| `reaped` | The idle reaper finalized it | `_reap_expired_sessions` → `_finalize_session(outcome="reaped")` |
| `failed` | Removed without a completed finalize: a finalize trigger that raised, a create-time rollback after registration, a failed recovery, `force_end_all_sessions` | `remove_session` default |

Some paths deliberately record nothing:

- A graceful `SessionManager.stop()` records nothing. Its sessions stay in Redis and are finished
  (as `recovered`) by the process that rebuilds them.
- A create-time rollback that fails *before* the session is registered records nothing, because
  it was never counted as `started` either.

### Code

- `apps/stt/src/stt/streaming/session_manager.py`
  - `remove_session(session_id, *, outcome="failed")`: captures the result of
    `self._sessions.pop(...)` and calls `streaming_session_finished(outcome)` only when a live
    session was actually removed.
  - `_finalize_session` / `_finalize_session_locked` take `outcome: str | None = None`. `None`
    resolves to `closed`, or to `recovered` for a rebuilt session. A durability step that failed
    earlier in finalize (upload, persist) still counts as `closed`, because the session reached
    `session.close()`.
  - The reaper passes `outcome="reaped"`, and CANCEL passes `outcome="closed"`.
  - `_recover_sessions` marks rebuilt ids through a new `_recovered_session_ids_of(manager)`
    accessor. It uses the same `MagicMock(spec=SessionManager)`-tolerant pattern as
    `_language_state_of`, backed by `self._recovered_session_ids` from `__init__`. `remove_session`
    discards the id.
- `apps/stt/src/stt/core/metrics.py`: the `streaming_session_finished` docstring now describes the
  real wiring instead of "line numbers as of TASK-985 D7; re-check before wiring". The HELP text is
  now "Streaming sessions by lifecycle status: started, then one terminal status each"; it used to
  read "Total streaming sessions started", which is no longer true. The metric name and labels
  are unchanged.

### Tests (only the touched files were run)

The new file failed first:
`9 failed, 1 passed` (every failure was `assert {} == {'<status>': 1}`; the one pass was the
"unknown id records nothing" guard). After the change: `10 passed`.

Three existing files had `remove_session` / `_finalize_session` doubles or assertions pinned to
the old call shape. That caused 13 failures, all of them `TypeError: … unexpected keyword argument
'outcome'` or `expected await not found`. None was a behaviour regression. They were updated, and
where they assert the call, they now also pin the outcome:

- `apps/stt/tests/unit/streaming/test_session_manager_finalize_ordering.py`
- `apps/stt/tests/unit/test_session_manager_model_wiring.py`
- `apps/stt/tests/unit/test_streaming_recording.py`

As a regression check, I ran every STT test file that references `remove_session` /
`_finalize_session` (22 files, plus `test_metrics_task985.py` / `test_metrics_task386.py`):
`359 passed` and `105 passed`, 0 failed. I did not run the full `pnpm stt:test`.

Lint (`ruff check`, which is what `pnpm stt:lint` runs) on the six touched files:
`All checks passed!`. `black --check` flags only `session_manager.py`, and its 4 hunks are
already present at `dev-2.2` HEAD; none is in a TASK-1013 line.

### Deployment repo — to flip after this deploys (not edited here)

In `arca/hope-v2-deployment`, `docs/observability-slos.md` on `origin/main` @ `60f092c`:

- **Line 154** (§4 targets): "Streaming session success rate | ≥ 98% | … | **Not yet measurable**
  — `stt_streaming_sessions_total` only carries `status="started"` today (§3.1)" becomes
  **Measured** — `stt_streaming_sessions_total{status}`.
- **Line 74** (§3.1): drop the "**Not measurable today** … has no caller" sentence. The query
  shape stays exactly as written.
- **Line 286** (§5 evidence): `streaming_session_finished()` "is defined but **has no caller**"
  becomes "called from `SessionManager.remove_session` (TASK-1013)".

**The dashboard also needs a change.** `deployment/k8s/base/dashboards/platform.json:882`, panel
target `B` "starts/min", is `sum(rate(stt_streaming_sessions_total[$__rate_interval])) * 60`,
with no status filter. Once terminal statuses are emitted, that panel roughly **doubles**, because
it counts every start plus every finish. It must become
`sum(rate(stt_streaming_sessions_total{status="started"}[$__rate_interval])) * 60` in the same
promotion as this change.

The deployment repo's local checkout (`ada789e`) is behind `origin/main`. I read the doc lines
above from `origin/main` and did not pull.

## Change History

| Date | Change |
|---|---|
| 2026-09-29 | Ticket opened from the TASK-1012 lane W-5 finding. RED→GREEN, the helper is wired into `remove_session`, three existing test doubles were updated, and the deployment-repo flip list is recorded. Status: Review. |
| 2026-09-29 | Merged into `dev-2.2` (`01c154c64`, on top of `2e558d2fc`). Gates re-run on the merged tree: ruff clean on the six touched files; every STT test file that references `remove_session` / `_finalize_session` / `_recover_sessions`, plus the two metrics suites, `464 passed`. Stays in Review until it deploys and the SLO doc lines + the `platform.json:882` panel are flipped in the deployment repo. |
