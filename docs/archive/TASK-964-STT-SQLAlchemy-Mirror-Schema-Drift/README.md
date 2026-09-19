# TASK-964 — the stt SQLAlchemy `AiModel` mirror declares four columns the database dropped

| Field | Value |
|---|---|
| Status | **Completed** |
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

## 7. Implementation Summary

**Owner decision (2026-09-13): Option B — repair the mirror and the reader — plus the OQ-2 parity guard.**

### The mirror (`core/database/models.py`)

The four phantoms are replaced by the columns that actually superseded them:
`availability`, `bucketPrefix`, `primaryObject`. `AiModelDownloadStatusType` was orphaned by that
change and removed; `AiModelAvailabilityType` takes its place.

### The reader (`pipeline/config_reader.py`)

| DTO field | Reconstructed from |
|---|---|
| `download_status` | `availability` — `AVAILABLE → DOWNLOADED`, everything else `NOT_DOWNLOADED` |
| `local_path` | `bucketPrefix` + `primaryObject`, mirroring `derivedLocalPath` incl. the `SINGLE_FILE_LIBRARIES` rule |
| `downloaded_at` | `_metadata.download.finishedAt` |
| `file_size_mb` | `_metadata.download.sizeMb` |

The selection predicate moved from `download_status == "DOWNLOADED"` to
`availability == "AVAILABLE"`. `NOT_APPLICABLE` is deliberately NOT treated as available: it marks
a cloud row or a library that ships its own weights, neither of which this "downloaded models"
listing ever returned.

Two deliberate choices, both recorded in the code:

- **The availability → download_status mapping is lossy on purpose.** Five measured states, four
  DTO states; anything that is not `AVAILABLE` reports `NOT_DOWNLOADED` rather than inventing a
  correspondence — wrong in the safe direction.
- **The derivation helpers stay LOCAL to `config_reader.py`.** TASK-861 removed stt's dependency on
  gateway-side `localPath` derivation for the live path; putting these in a shared module would
  invite the spec-driven path to start using it again.

### Two stale fixtures, neither cosmetic

- `tests/unit/test_config_reader.py` built a mock carrying the four dead attributes — now expresses
  availability, bucket identity and `_metadata.download`. **20 passed.**
- `tests/integration/test_database.py` had a raw INSERT naming `"downloadStatus"`. Fixing only that
  would then have hit NOT NULL violations on `libraryName`, `servedBy` and `deploymentKind` —
  columns TASK-860 added that this INSERT never learned about. **Two generations of drift were
  stacked here**, and only the first was visible because Postgres reports the column error before
  the constraint error. **4 passed, up from 1 failed / 3 passed.**

### The guard (OQ-2)

`tests/contracts/stt-sqlalchemy-mirror-parity.contract.test.ts` parses every mirror class's
declared columns and asserts each exists in the corresponding Prisma model. Written FIRST: it went
RED naming all four phantoms, and green after the repair. It is deliberately ONE-DIRECTIONAL — a
read-only mirror is expected to be a subset, and demanding equality would fail whenever an
unrelated column is added to a table stt does not read.

### Evidence

| Gate | Result |
|---|---|
| `tests/contracts` | **26 files, 358 tests passed** (was 25/354) |
| `pytest apps/stt/tests/{unit,integration}` | **3485 passed, 5 skipped, 1 failed** |
| `ruff check apps/stt/src/ apps/stt/tests/` | All checks passed |
| `mypy --config-file apps/tts/pyproject.toml` → stt | Success: no issues found in 142 source files |
| `black --check` | clean |

The 1 failure is `test_task799_env_surface.py::test_minio_credentials_default_to_empty`, the
PRE-EXISTING environment-dependent failure documented in TASK-963 §8: `.env.dev`/`.env.test` define
`MINIO_ACCESS_KEY` and `hope_env` promotes it into `os.environ`, so `Settings(_env_file=None)` still
sees a real credential. Unrelated to this ticket — it concerns `Settings`, not the mirror.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-13 | Opened. Four phantom columns on `AiModelRead` confirmed against the live schema; the other two mirrors are clean. All four are load-bearing in `config_reader.py` (one WHERE filter + four DTO fields), so deletion alone is insufficient. Two options and a parity-guard proposal recorded; OQ-1 blocks implementation. |
| 2026-09-13 | OQ-1 answered (Option B) and OQ-2 taken. Mirror repaired, reader ported, two stale fixtures fixed, parity contract added (RED → green). Gates green but for one pre-existing env-dependent failure. |
