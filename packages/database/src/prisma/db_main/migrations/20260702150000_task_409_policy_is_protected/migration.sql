-- Policy Break-Glass (fully additive: no DROP/DELETE/TRUNCATE).
--   Policy.isProtected (boolean, NOT NULL, default false) — rename-proof marker for
--   the anti-lockout protected set. The seed marks `system-full-access` and
--   `rbac-system-manage` true; the column is never writable through the API.

-- AlterTable
ALTER TABLE "core"."Policy" ADD COLUMN     "isProtected" BOOLEAN NOT NULL DEFAULT false;
