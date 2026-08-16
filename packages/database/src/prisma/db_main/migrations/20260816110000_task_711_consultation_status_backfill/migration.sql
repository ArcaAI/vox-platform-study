-- TASK-711 Task 12 — backfill migration for the legacy `metadata.status` tracker.
--
-- Implements backfill-mapping.md §3 (revised) verbatim. Postgres forbids using a
-- newly-added enum value in the same transaction that adds it, so this is a
-- SEPARATE migration from 20260816010000 (PRIMED/DRAINING/TIMED_OUT) and
-- 20260816100654 (CLOSED_COMPLETE/CLOSED_INCOMPLETE) — both already committed.
--
-- Design invariants (do not weaken without re-reading README §3.3 pitfall 3 and
-- backfill-mapping.md "Why OPEN + meta=CLOSED + unsigned -> CLOSED_INCOMPLETE"):
--   1. NO statement in this migration may WRITE 'SIGNED' into the `status`
--      column — that is the exact forgery TASK-701/this program exists to
--      prevent, landing in the column rather than presentation. The final
--      assertion block proves this the correct way: the SIGNED row count may
--      only ever DECREASE or stay flat here (rows in the SIGNED+meta=CLOSED
--      bucket correctly and intentionally MOVE OUT of SIGNED into
--      CLOSED_COMPLETE below — that is a real, expected count change, not a
--      forgery); an INCREASE would mean some statement fabricated a new
--      sign-off, which is what the assertion actually guards against.
--   2. Every UPDATE's WHERE clause is narrow enough to be a no-op on a second
--      run (idempotent) — verified by the ticket's own Verify criterion
--      (apply twice, second run reports zero rows changed).
--   3. An observed (column_status, meta_status) combination NOT covered by one
--      of the buckets below HALTS the migration with the offending tuple,
--      rather than silently guessing (the "extend, do not replace" discipline
--      backfill-mapping.md §2/§3 establishes). The DO block below is that guard.
--      Verified (2026-08-16, hope_shadow): `prisma migrate deploy` wraps this
--      whole file in one transaction on PostgreSQL, so a RAISE EXCEPTION here
--      rolls back every statement in this file, atomically — a partially
--      applied backfill is not a state this migration can leave the database
--      in via the deploy path. NOTE: this atomicity is `prisma migrate
--      deploy`-specific; running this file directly via `psql -f` does NOT
--      get the same guarantee (psql continues past an error by default) —
--      always apply through `prisma migrate deploy`, never a manual psql run,
--      against a real environment.

-- Capture the pre-migration SIGNED count before any UPDATE below runs — the
-- baseline the final assertion compares against.
CREATE TEMP TABLE task_711_backfill_signed_before AS
SELECT count(*) AS n FROM core."Consultation" WHERE "status" = 'SIGNED';

-- Guard: abort if any row's (column_status, meta_status, has_signed_note) triple
-- does not match one of the 9 buckets enumerated in backfill-mapping.md §3. This
-- is the exact same shape as the discovery query in §1 (Task 1 / this migration's
-- own worklist), re-run as an assertion rather than a report.
DO $$
DECLARE
  offending RECORD;
BEGIN
  SELECT c."id"                                          AS id,
         c."status"                                      AS column_status,
         c."metadata"->>'status'                          AS meta_status,
         EXISTS (SELECT 1
                   FROM core."ContextItemVersion" v
                   JOIN core."ContextItem" i ON i.id = v."contextItemId"
                  WHERE i."consultationId" = c.id
                    AND v."changeReason" = 'approved')     AS has_signed_note
    INTO offending
    FROM core."Consultation" c
   WHERE NOT (
     -- Bucket 1: column already past OPEN — untouched, meta stripped regardless of its value.
     c."status" IN ('RECORDING', 'DRAINING', 'PRIMED', 'DRAFT_PENDING_SENSORS', 'PENDING_REVIEW',
                     'SIGNED', 'TIMED_OUT', 'REOPENED', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE')
     -- Bucket 2: column = SIGNED handled above already (SIGNED is in the list); this branch is
     -- for column = OPEN, which is the only value the observed dataset (backfill-mapping.md §2)
     -- and the starting design rules actually enumerate sub-cases for.
     OR (c."status" = 'OPEN' AND (
           c."metadata"->>'status' IS NULL
        OR c."metadata"->>'status' = 'OPEN'
        OR c."metadata"->>'status' = 'REVIEW'
        OR c."metadata"->>'status' = 'TRANSCRIBING'
        OR c."metadata"->>'status' = 'RECORDING'
        OR c."metadata"->>'status' = 'SUMMARIZING'
        OR (c."metadata"->>'status' = 'CLOSED' AND NOT EXISTS (
              SELECT 1 FROM core."ContextItemVersion" v
                       JOIN core."ContextItem" i ON i.id = v."contextItemId"
                      WHERE i."consultationId" = c.id AND v."changeReason" = 'approved'
            ))
     ))
   )
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'TASK-711 backfill: unenumerated (status, metadata.status, has_signed_note) combination on Consultation %: status=%, meta_status=%, has_signed_note=%. '
      'Re-run the backfill-mapping.md §1 discovery query against this environment and extend §3''s mapping table before re-applying this migration.',
      offending.id, offending.column_status, offending.meta_status, offending.has_signed_note;
  END IF;
END $$;

-- Bucket: column = SIGNED, meta = CLOSED -> CLOSED_COMPLETE (a human signed before closing).
-- Narrow WHERE (status still SIGNED) makes this a no-op on a second run, since the
-- first run already flips these rows to CLOSED_COMPLETE.
--
-- The UPDATE runs INSIDE this DO block (not as a separate top-level statement)
-- so `GET DIAGNOSTICS ... = ROW_COUNT` reads ITS row count — across a
-- top-level-statement boundary, a fresh `DO` block's ROW_COUNT does not see
-- the PREVIOUS statement's count (a real pitfall verified while authoring
-- this migration: the naive "UPDATE; DO $$ GET DIAGNOSTICS $$;" shape always
-- reports 0, silently).
DO $$
DECLARE rows_touched INT;
BEGIN
  UPDATE core."Consultation"
     SET "status" = 'CLOSED_COMPLETE'
   WHERE "status" = 'SIGNED'
     AND "metadata"->>'status' = 'CLOSED';
  GET DIAGNOSTICS rows_touched = ROW_COUNT;
  RAISE NOTICE 'TASK-711 backfill: % row(s) SIGNED+meta=CLOSED -> CLOSED_COMPLETE', rows_touched;
END $$;

-- Bucket: column = OPEN, meta = CLOSED, no signed note -> CLOSED_INCOMPLETE (closed, no
-- clinical sign-off ever recorded). `resourceStatus` is left untouched (ENABLED stays
-- ENABLED) — the row is now correctly typed and stays visible in default reads.
DO $$
DECLARE rows_touched INT;
BEGIN
  UPDATE core."Consultation" c
     SET "status" = 'CLOSED_INCOMPLETE'
   WHERE c."status" = 'OPEN'
     AND c."metadata"->>'status' = 'CLOSED'
     AND NOT EXISTS (
           SELECT 1 FROM core."ContextItemVersion" v
                    JOIN core."ContextItem" i ON i.id = v."contextItemId"
                   WHERE i."consultationId" = c.id AND v."changeReason" = 'approved'
         );
  GET DIAGNOSTICS rows_touched = ROW_COUNT;
  RAISE NOTICE 'TASK-711 backfill: % row(s) OPEN+meta=CLOSED+unsigned -> CLOSED_INCOMPLETE', rows_touched;
END $$;

-- Strip the three legacy keys LAST, from every row that still carries any of them —
-- covers every "unchanged" bucket (column already non-OPEN; OPEN+OPEN/null/legacy
-- free-form values) AND the two buckets just flipped above, in one idempotent pass.
-- `- 'status' - 'closedAt' - 'reopenedAt'` is a no-op on a key that is already absent,
-- so a second run touches zero additional keys once the first run has stripped them.
DO $$
DECLARE rows_touched INT;
BEGIN
  UPDATE core."Consultation"
     SET "metadata" = "metadata" - 'status' - 'closedAt' - 'reopenedAt'
   WHERE "metadata" IS NOT NULL
     AND ("metadata" ? 'status' OR "metadata" ? 'closedAt' OR "metadata" ? 'reopenedAt');
  GET DIAGNOSTICS rows_touched = ROW_COUNT;
  RAISE NOTICE 'TASK-711 backfill: % row(s) had legacy metadata.status/closedAt/reopenedAt keys stripped', rows_touched;
END $$;

-- Final assertion: the SIGNED row count may only ever decrease or stay flat.
-- A decrease is the EXPECTED, correct effect of the SIGNED+meta=CLOSED ->
-- CLOSED_COMPLETE bucket above (those rows legitimately stop being SIGNED and
-- become CLOSED_COMPLETE instead). An INCREASE would mean some statement
-- above wrote 'SIGNED' into a row that was not already SIGNED — the exact
-- forgery this program exists to prevent — and aborts the migration.
DO $$
DECLARE
  before_count INT;
  after_count INT;
BEGIN
  SELECT n INTO before_count FROM task_711_backfill_signed_before;
  SELECT count(*) INTO after_count FROM core."Consultation" WHERE "status" = 'SIGNED';

  IF after_count > before_count THEN
    RAISE EXCEPTION 'TASK-711 backfill: SIGNED row count INCREASED from % to % — this migration must never write SIGNED into a row that was not already SIGNED.',
      before_count, after_count;
  END IF;

  RAISE NOTICE 'TASK-711 backfill: SIGNED count % -> % (a decrease reflects rows correctly moved to CLOSED_COMPLETE; must never increase).', before_count, after_count;
END $$;

DROP TABLE task_711_backfill_signed_before;
