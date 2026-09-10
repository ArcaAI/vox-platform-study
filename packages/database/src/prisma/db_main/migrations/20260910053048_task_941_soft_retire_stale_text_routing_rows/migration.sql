-- TASK-941 R1 — soft-retire the five stale `text.*` AiRoutingPolicy rows.
--
-- TASK-881 retired these task keys. The seed no longer writes them and no resolver
-- reads them, so the rows are unreachable — but any database deployed before that
-- change still carries them, and `GET admin/ai-routing-policies` still lists them.
-- A catalogue that shows five rows no resolver can ever consult is a catalogue that
-- lies to the platform admin reading it.
--
-- The statement was authored COMMENTED in TASK-870's wave-3a migration
-- (`20260905192057_task_870_wave3a_schema_retirement`, lines 77-82) precisely because
-- changing data is an owner decision, not a program's call. The owner decided
-- SOFT-RETIRE on 2026-09-10, so it runs here — in a NEW migration, because a
-- committed one is never edited (`02-database-prisma.md`). That comment block is
-- deleted in the same commit so it stops reading as a pending action.
--
-- SOFT delete, not DELETE: `resourceStatus = 'DELETED'` is this schema's retirement
-- mechanism, the extended client filters it from every read, and the row survives for
-- audit. `_version` is incremented because the DB owns that counter and an OCC reader
-- must see this as a write.
--
-- Idempotent by construction: re-running it matches no row whose status is already
-- DELETED, so a replay is a no-op rather than a second version bump.
UPDATE "core"."AiRoutingPolicy"
   SET "resourceStatus" = 'DELETED',
       "resourceStatusUpdatedAt" = now(),
       "_version" = "_version" + 1
 WHERE "taskKey" IN ('text.live', 'text.finalize', 'text.test', 'text.live.fallback', 'text.finalize.fallback')
   AND "resourceStatus" <> 'DELETED';
