# TASK-711 — `metadata.status` Backfill Mapping

Status: **query NOT run — GATED, local infra is down (no Postgres reachable this session)**.
This document authors the query and the starting mapping rules per README.md §4 Task 1 step 4.
The actual observed-combination output below is a placeholder that MUST be replaced with the real
result of running the query against dev (minimum) — and ideally staging — before Task 12 (the
backfill migration) is written or run. Task 12 is explicitly out of scope for this execution pass
(this pass owns `packages/database` schema/migration-authoring and `packages/domains` only,
Phase 1 + Phase 2 of the plan); whoever picks up Task 12 must run this query first.

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

**NOT RUN.** Local dev infra (Postgres) is down in this execution environment
(`.env.dev` points at `localhost:5432`, unreachable). Per the ticket's hard rule ("Anything
needing a live DB ... do the authoring half only, report the rest as gated"), this section is
left as a gate rather than filled with fabricated numbers.

To fill this in: run the query above against a real environment (`docker exec hope-postgres psql
"$DATABASE_URL" -f <(query)` or via `mcp__postgres__query` once infra is up), paste the full
result set here with the environment name and date, then re-derive §3 below from the *actual*
observed combinations — not just the starting rules.

```
<PASTE OBSERVED RESULT SET HERE — environment: ___, date: ___>
```

## 3. Starting mapping rules (extend, do not replace, from the observed output)

Reproduced from README.md §4 Task 1 step 4 — these are the rules known to be correct from the
code paths already read in §2 of the ticket's Current State Evaluation; the observed query may
surface additional combinations not covered here, each of which must get its own row before the
migration is written (an unenumerated combination halts the migration per Task 12 step 1, by
design — it means this table was stale, not that the migration should guess).

| Observed | Target `status` | Other writes |
|---|---|---|
| column ∈ {`RECORDING`,`DRAFT_PENDING_SENSORS`,`PENDING_REVIEW`,`SIGNED`} | unchanged | strip `metadata.status`/`closedAt`/`reopenedAt` |
| column = `SIGNED`, meta = `CLOSED` | `CLOSED` | strip meta keys |
| column = `OPEN`, meta = `CLOSED`, `has_signed_note = false` | **unchanged (`OPEN`)** | `resourceStatus = ARCHIVED`, `resourceStatusUpdatedAt = metadata.closedAt`, then strip |
| column = `OPEN`, meta ∈ {`OPEN`, null} | unchanged | strip |
| **anything else** | — | **halt the migration with the offending tuple** |

### Why `OPEN` + `meta=CLOSED` + unsigned → `ARCHIVED`, not `CLOSED`

README.md §3.3 pitfall 3: rows with `metadata.status = CLOSED` but no `SIGNED_NOTE` version are
*administratively archived unsigned records*, not signed ones. The typed `CLOSED` state now
presupposes `SIGNED`/`TIMED_OUT` as a legal predecessor (§2 of state-machine.md); writing `CLOSED`
into the column for a never-signed row would either violate that invariant immediately or force
the migration to also forge a `SIGNED` transition — which is exactly the forgery TASK-701 and this
whole program exist to prevent. `resourceStatus = ARCHIVED` preserves "this row is administratively
closed" without touching the clinical lifecycle column, and INV-174/175 stay true for every row
the moment this migration commits.

## 4. Open question this mapping surfaces (do not resolve here)

README.md §6 R4/Q1: if the `OPEN` + `meta=CLOSED` + unsigned bucket is large, that is a product
decision (does the business want a distinct `ABANDONED` state for these, or is `ARCHIVED`/`OPEN`
acceptable?), not an engineering one. The bucket's size is unknown until §2 is filled in — do not
add an `ABANDONED` enum member speculatively.
