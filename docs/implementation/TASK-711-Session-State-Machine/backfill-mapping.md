# TASK-711 — `metadata.status` Backfill Mapping

Status: **query RUN 2026-08-16 against the local `hope` dev database** (`localhost:5432/hope`,
via `docker exec hope-postgres psql`). §2 below is the real result set, not a placeholder. §3's
mapping is revised against the owner's `CLOSED_COMPLETE`/`CLOSED_INCOMPLETE` decision
(state-machine.md §1a) — this **replaces** the earlier `ARCHIVED`-only treatment for the
closed-but-unsigned bucket now that a typed home exists for it. Task 12 (the backfill migration
itself) remains out of scope for this pass (`packages/database` schema/migration-authoring only,
per this pass's ownership) — whoever picks up Task 12 can now implement directly against §3
without re-running discovery, though re-running against staging/prod before Task 12 executes there
is still required (this result set is dev-only, 11 rows).

---

## 1. The query

```sql
SELECT c."status"                                     AS column_status,
       c."metadata"->>'status'                        AS meta_status,
       (c."metadata" ? 'closedAt')                    AS has_closed_at,
       (c."metadata" ? 'reopenedAt')                  AS has_reopened_at,
       c."resourceStatus",
       EXISTS (SELECT 1
                 FROM core."ContextItemVersion" v
                 JOIN core."ContextItem" i ON i.id = v."contextItemId"
                WHERE i."consultationId" = c.id
                  AND v."changeReason" = 'approved')  AS has_signed_note,
       count(*)                                       AS rows
  FROM core."Consultation" c
 GROUP BY 1,2,3,4,5,6
 ORDER BY rows DESC;
```

## 2. Observed output

**Environment:** local dev (`hope` database, `localhost:5432`, container `hope-postgres`).
**Date:** 2026-08-16. **Row count:** 11 consultations total (a small local dev dataset — re-run
before Task 12 executes against any environment with real volume).

```
 column_status | meta_status  | has_closed_at | has_reopened_at | resourceStatus | has_signed_note | rows
---------------+--------------+---------------+------------------+----------------+------------------+------
 OPEN          | OPEN         | f             | f                | ENABLED        | f                |    3
 OPEN          | REVIEW       | f             | f                | ENABLED        | f                |    2
 OPEN          | CLOSED       | t             | f                | ENABLED        | f                |    2
 OPEN          | TRANSCRIBING | f             | f                | ENABLED        | f                |    1
 OPEN          | RECORDING    | f             | f                | ENABLED        | f                |    1
 OPEN          | OPEN         | f             | t                | ENABLED        | f                |    1
 OPEN          | SUMMARIZING  | f             | f                | ENABLED        | f                |    1
(7 rows)
```

**Finding, not anticipated by the starting rules:** every row in this dev dataset has typed
`column_status = OPEN` (the typed column has never been written by real traffic in this
environment). More importantly, `meta_status` takes **four values the starting rules did not
enumerate** — `REVIEW`, `TRANSCRIBING`, `RECORDING`, `SUMMARIZING` — none of which are members of
the currently-live `CONSULTATION_STATUS = { OPEN, CLOSED }` vocabulary
(`update-consultation.request.ts:11-18`) that every *current* writer of `metadata.status` is
constrained to. These are leftover free-form values from before that two-value vocabulary was
settled (the field was always untyped JSON — README §2.2 — so nothing ever stopped an older code
path or a fixture from writing a richer, now-dead vocabulary into it). This is exactly the
"an unenumerated combination means the table was stale, not that the migration should guess"
scenario the ticket's own design anticipated (§3.2 base practices) — extending §3 below rather
than guessing is the correct response, not a design failure.

R4 is answered by this run: the `OPEN + meta=CLOSED + unsigned` bucket is **2 of 11 rows** in dev —
small, and now moot as a "large bucket vanishes into `ARCHIVED`" risk regardless of size, because
§3 below gives it a typed home (`CLOSED_INCOMPLETE`) instead of hiding it behind `resourceStatus`.

## 3. Mapping rules (revised — extend, do not replace, from the observed output)

Every one of the 7 distinct combinations in §2 has an explicit row below (100% coverage, per the
Verify criterion). Revised from the original starting rules per the owner's `CLOSED_COMPLETE`/
`CLOSED_INCOMPLETE` decision (state-machine.md §1a) — the original rules used `CLOSED` as the
closed-column target and `ARCHIVED`/`OPEN` as the unsigned-closed workaround; both are now typed.

| Observed (`column_status`, `meta_status`) | Target `status` | Other writes |
|---|---|---|
| column ∈ {`RECORDING`,`DRAFT_PENDING_SENSORS`,`PENDING_REVIEW`,`SIGNED`} (any meta) | unchanged | strip `metadata.status`/`closedAt`/`reopenedAt` |
| column = `SIGNED`, meta = `CLOSED` | `CLOSED_COMPLETE` *(was `CLOSED`)* | strip meta keys |
| column = `OPEN`, meta = `CLOSED`, `has_signed_note = false` | `CLOSED_INCOMPLETE` *(was: unchanged `OPEN` + `resourceStatus=ARCHIVED`)* | strip meta keys only — `resourceStatus` stays `ENABLED`; the row is now correctly typed and stays visible in default (non-deleted) reads rather than being hidden behind an archival flag |
| column = `OPEN`, meta = `OPEN` (regardless of `has_reopened_at`) | unchanged (`OPEN`) | strip |
| column = `OPEN`, meta IS NULL | unchanged (`OPEN`) | strip (no-op if `metadata` has no `status` key) |
| column = `OPEN`, meta = `REVIEW` | unchanged (`OPEN`) | strip — legacy free-form value, not `CLOSED`, so there is no closure signal to backfill |
| column = `OPEN`, meta = `TRANSCRIBING` | unchanged (`OPEN`) | strip |
| column = `OPEN`, meta = `RECORDING` | unchanged (`OPEN`) | strip |
| column = `OPEN`, meta = `SUMMARIZING` | unchanged (`OPEN`) | strip |
| **anything else** (incl. `has_signed_note = true` with `meta = CLOSED` but `column ≠ SIGNED` — a genuine anomaly, a note was approved but the column never moved) | — | **halt the migration with the offending tuple** |

The four newly-observed non-`CLOSED` legacy values (`REVIEW`, `TRANSCRIBING`, `RECORDING`,
`SUMMARIZING`) fold into the same rule as `OPEN`/null: none of them signal closure, so the typed
column — already sitting at its correct default in every observed row — is left alone and only the
now-meaningless legacy key is stripped. This keeps the "extend, do not replace" discipline: five
explicit rows instead of one wildcard, so a future genuinely-unexpected value (e.g. a `CLOSED`
paired with a column state not listed above) still halts rather than silently matching a
catch-all.

### Why `OPEN` + `meta=CLOSED` + unsigned → `CLOSED_INCOMPLETE`, not `CLOSED_COMPLETE` or `ARCHIVED`

README.md §3.3 pitfall 3 still holds: rows with `metadata.status = CLOSED` but no `SIGNED_NOTE`
version are *administratively closed unsigned records*, not signed ones — writing
`CLOSED_COMPLETE` (or the original design's plain `CLOSED`) into the column for a never-signed row
would be exactly the forgery TASK-701 and this whole program exist to prevent, whether or not the
target member is split. What changed is that `CLOSED_INCOMPLETE` now exists specifically to name
"closed, no human clinical feedback" — the *exact* fact this bucket represents — so the migration
no longer needs `resourceStatus = ARCHIVED` as a workaround for having nowhere typed to put it.
INV-174/175 (as revised, state-machine.md §2 "two answers") stay true for every row the moment this
migration commits: `CLOSED_COMPLETE` is reachable only from `SIGNED`, never written here;
`CLOSED_INCOMPLETE` is reachable only from `TIMED_OUT`/the sweep set at *runtime* — this migration
sets it directly as a one-time historical-fact correction, which is a distinct and already-accepted
category (the "unchanged" rows above also write `status` directly via `UPDATE`, not through
`transitionTo()`; a backfill migration is establishing corrected history, not performing a live
transition, so it is not bound by the live legality matrix's reachability graph).

## 4. Q1 — resolved, not open

README.md §6 R4/Q1 asked whether a distinct state is needed for "closed but never signed" records,
gated on this bucket's size. **Resolved by the owner** (state-machine.md §1a): `CLOSED_INCOMPLETE`
answers it directly — not the speculative `ABANDONED`, and not conditional on R4's count (which
turned out small in dev: 2/11 rows, §2). No further decision needed here.
