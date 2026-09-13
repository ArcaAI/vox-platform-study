# TASK-964 — the stt SQLAlchemy `AiModel` mirror declares four columns the database dropped

| Field | Value |
|---|---|
| Status | **Pending** — needs an owner decision (§5 OQ-1) before implementation |
| Type | bugfix |
| Branch | `dev-2.2` |
| Introduced | TASK-890 §3.11 / lane L2, when the four bookkeeping columns were dropped |
| Found by | TASK-963 e2e triage, 2026-09-13 |

---

## 1. Requirement Analysis

`apps/stt/src/stt/core/database/models.py` mirrors three `core` tables as read-only SQLAlchemy
models. Its `AiModelRead` declares **four columns that no longer exist**:

```
downloadStatus   downloadedAt   fileSizeMb   localPath
```

These are exactly the four TASK-890 §3.11 removed — `localPath` because it became a DERIVATION
(`derivedLocalPath(bucketPrefix, primaryObject)`), the other three because publish-run bookkeeping
moved into `_metadata.download`.

Any SELECT through this mirror therefore fails:

```
sqlalchemy.exc.ProgrammingError: <asyncpg.exceptions.UndefinedColumnError>
column "downloadStatus" of relation "AiModel" does not exist
```

**The important part is not that the path is deprecated — it is that the path is BROKEN.**
`apps/stt` is documented as supporting the legacy `pipeline_id` route until R4, gated behind
`STT_DATABASE_ENABLED=true`. An operator who sets that flag today does not get a deprecated-but-
working path; they get an `UndefinedColumnError`. The deprecation register promises something the
code can no longer deliver.

## 2. Current State Evaluation

Verified 2026-09-13 against the live dev database (`hope-postgres-0`, schema `core`):

| Mirror | Declared | Phantom columns |
|---|---|---|
| `AsrPipelineRead` (`AsrPipeline`) | 11 | **none** |
| `AiModelRead` (`AiModel`) | 27 | **`downloadStatus`, `downloadedAt`, `fileSizeMb`, `localPath`** |
| `PromptTemplateRead` (`PromptTemplate`) | 10 | **none** |

So the drift is confined to one model — but all four phantoms are LOAD-BEARING in the only
consumer, `apps/stt/src/stt/pipeline/config_reader.py`:

| Site | Use |
|---|---|
| `config_reader.py:313` | `AiModelRead.download_status == "DOWNLOADED"` — a WHERE filter, i.e. the selection predicate |
| `config_reader.py:379` | `download_status=AiModelDownloadStatus(model.download_status)` |
| `config_reader.py:380` | `local_path=model.local_path` |
| `config_reader.py:381-382` | `downloaded_at`, `file_size_mb` |

Deleting the columns alone is therefore NOT sufficient — the reader's filter and four DTO fields
have to go somewhere or be re-derived.

**Why it is invisible.** `STT_DATABASE_ENABLED` defaults to FALSE since TASK-861, so
`get_db_session()` raises `DatabaseDisabledError` long before any SQL runs. The drift only
surfaces where something forces the flag on — which today is
`apps/stt/tests/integration/test_database.py` (1 failure) and the e2e suites TASK-963 just
unblocked (30 errors, all `DatabaseDisabledError` — they never reach the column error because the
flag stops them first).

## 3. Options

**Option A — retire the deprecated reader and the mirror now (recommended).**
The `pipeline_id` path is already non-functional; keeping a reader that cannot execute a single
SELECT is worse than removing it, because it reads as supported. Delete `config_reader.py`'s
deprecated readers, `AiModelRead`, and — if nothing else uses them — `AsrPipelineRead` /
`PromptTemplateRead`. Pulls the R4 removal forward for the half that is already dead.

**Option B — repair the mirror and the reader.**
Drop the four columns from `AiModelRead`; replace the `download_status == "DOWNLOADED"` filter
with `availability == 'AVAILABLE'`; derive `local_path` from `bucketPrefix` + `primaryObject`
(mirroring `derivedLocalPath`, including the `SINGLE_FILE_LIBRARIES` rule); source
`downloaded_at` / `file_size_mb` from `_metadata.download` or drop them from the DTO. More work,
and it re-implements gateway derivation logic inside stt — which is the coupling TASK-861 removed.

## 4. Verification Criteria

- [ ] No SQLAlchemy model declares a column absent from `core` in the live schema
- [ ] `pytest apps/stt/tests/integration/test_database.py` passes, or is deleted with the path
- [ ] `STT_DATABASE_ENABLED=true` either works end to end, or the flag and its path are gone —
      not a third state where it is settable but broken
- [ ] A guard that fails when the mirror drifts again (see §5 OQ-2)

## 5. Open Questions

- **OQ-1 (blocking) — Option A or B?** This is an owner call about whether the `pipeline_id` path
  is worth reviving before R4 deletes it. A is less code and tells the truth; B preserves a
  documented (if unused) capability.
- **OQ-2 — how should this be prevented?** Nothing compares the hand-written SQLAlchemy mirror to
  the Prisma schema, so it can rot silently again. A contract test in `tests/contracts/` comparing
  each mirror's declared columns against the Prisma models would have caught this at the
  introducing commit — the same shape as the existing `resourceType.enum-parity` guard.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-13 | Opened. Four phantom columns on `AiModelRead` confirmed against the live schema; the other two mirrors are clean. All four are load-bearing in `config_reader.py` (one WHERE filter + four DTO fields), so deletion alone is insufficient. Two options and a parity-guard proposal recorded; OQ-1 blocks implementation. |
