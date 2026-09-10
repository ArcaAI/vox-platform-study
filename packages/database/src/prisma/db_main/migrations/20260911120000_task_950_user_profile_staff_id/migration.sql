-- TASK-950 — UserProfile.staffId, the tenant staff identifier a context-schema "user identity"
-- field maps to. Nullable, no DB-level unique: UserProfile carries no tenant column, so
-- per-tenant uniqueness is enforced in the application (ContextUserIdentityService's advisory
-- lock + the profile write path's 409 STAFF_ID_TAKEN check). Authored on a replayed shadow
-- database per `02-database-prisma.md` §Authoring a migration; additive, no data step.

-- AlterTable
ALTER TABLE "core"."UserProfile" ADD COLUMN     "staffId" TEXT;

-- CreateIndex
CREATE INDEX "UserProfile_staffId_idx" ON "core"."UserProfile"("staffId");
