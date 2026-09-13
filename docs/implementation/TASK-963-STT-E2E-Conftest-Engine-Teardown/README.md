# TASK-963 — the stt e2e suite errors at fixture setup on a removed private attribute

| Field | Value |
|---|---|
| Status | **Pending** |
| Type | bugfix (test infrastructure) |
| Branch | `dev-2.2` |
| Severity | the ENTIRE `apps/stt/tests/e2e` suite errors — 210 errors, 0 executed |
| Introduced | 2026-09-04, `50bac3ff2` (TASK-861) — undetected for ~9 days |
| Found by | TASK-960/black-sweep verification, 2026-09-13 |

---

## 1. Requirement Analysis

`apps/stt/tests/e2e/conftest.py` tears down SQLAlchemy engines by reaching into two PRIVATE
module attributes of `stt.core.database.connection`:

```python
for engine in list(db_conn._engines.values()):
    await engine.dispose()
db_conn._engines.clear()
db_conn._session_factories.clear()
```

**Neither attribute exists any more.** TASK-861 (`50bac3ff2`, 2026-09-04) rewrote that module:
engines moved into a loop-local namespaced cache (`_ENGINE_NAMESPACE`, `loop_local_size`,
`reset_loop_locals`) as part of making the STT DB read optional and OFF by default. The private
dicts went with it.

Every e2e test therefore fails in fixture setup with:

```
AttributeError: module 'stt.core.database.connection' has no attribute '_engines'
```

## 2. Current State Evaluation

Measured 2026-09-13 on `dev-2.2`:

| Fact | Evidence |
|---|---|
| Blast radius | `pytest apps/stt/tests` → **3 failed, 3468 passed, 210 errors**; all 210 errors are in `tests/e2e` (63 + 48 + 32 + 26 + 17 + 6 + 6 + 4 + 4 in `test_internal_endpoints_comprehensive`, `test_streaming_sessions_api`, `test_health_endpoints_comprehensive`, `test_transcription_http_api`, `test_cross_endpoint_workflows`, `test_internal_endpoints`, `test_huggingface_pipeline`, `test_real_data_transcription`, `test_health_endpoints`), plus 4 in `tests/integration/test_database.py` |
| Call sites | `apps/stt/tests/e2e/conftest.py` lines **162, 167, 168, 240, 245, 246, 330, 335, 336** — three identical blocks |
| `_engines` in `connection.py` | 0 occurrences |
| `_session_factories` in `connection.py` | 0 occurrences |
| Not a formatting artifact | the black sweep (`e27723dff`) reformatted this conftest but left these lines byte-identical; `connection.py` was never in that sweep |

**Why nobody noticed.** These suites need live infra, so they are not part of the routine local
gate and CI's `test-stt` does not exercise them either. A suite that cannot even reach its
assertions looks, from a distance, exactly like a suite that was skipped for want of a database.

## 3. Implementation Plan

The module already exposes the PUBLIC equivalent of what the conftest is hand-rolling.
`close_database()` disposes the current loop's engine and calls
`reset_loop_locals(_ENGINE_NAMESPACE)` — i.e. precisely "dispose stale engines and clear the
cache", which is the stated intent of the comment above each block.

1. **RED** — run one e2e file and capture the `AttributeError` (already reproduced above).
2. **GREEN** — replace each of the three blocks with:

   ```python
   await db_conn.close_database()
   ```

   `close_database()` already swallows a disposal failure (`except Exception` → warning) and still
   resets the loop-locals, so it is safe when `STT_DATABASE_ENABLED=false` and no engine was ever
   created — which is the DEFAULT since TASK-861.
3. Re-run `pytest apps/stt/tests/e2e` with live infra and record the real pass/fail, which nobody
   has seen since 2026-09-04. **Expect further breakage underneath**: nine days of changes have
   landed against a suite that could not run, so fixing the teardown is step one, not the whole job.
4. Add a guard so a private-attribute reach cannot rot silently again — the cheapest is for the
   conftest to use only the public surface (`initialize_database` / `close_database` /
   `engine_cache_size`). Consider a lint rule banning `db_conn._` access from tests.

## 4. Verification Criteria

- [ ] `pytest apps/stt/tests/e2e` collects AND executes — zero `AttributeError` at setup
- [ ] `pytest apps/stt/tests` reports 0 errors (failures, if any, are then REAL and triaged separately)
- [ ] No test reaches a `_`-prefixed attribute of `stt.core.database.connection`
- [ ] `ruff check apps/stt/src/ apps/stt/tests/` stays green

## 5. Open Questions

- **OQ-1 — should these e2e tests touch a database at all?** Since TASK-861 the STT DB connection
  is OPTIONAL and OFF by default (`STT_DATABASE_ENABLED=false`); selection arrives as a
  gateway-resolved `ResolvedAsrSpec` with no Postgres read on the agent path. If the suite no
  longer needs a DB, the right fix may be to DELETE the engine-teardown blocks rather than port
  them. That is an owner call and decides whether step 2 above is a port or a removal.
- **OQ-2 — should this suite be gated?** It is currently unreachable in CI and not in the local
  routine gate, which is why a 9-day outage went unseen. Either wire it somewhere that runs, or
  state explicitly that it is a manual-only suite so its silence is not mistaken for health.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-13 | Opened. Root cause identified (`_engines` / `_session_factories` removed by TASK-861 `50bac3ff2` on 2026-09-04); blast radius measured at 210 errors across 9 e2e files + 1 integration file; public replacement (`close_database()`) identified; two owner questions raised. Not yet implemented. |
