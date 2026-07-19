-- TASK-516 Phase 5 — HarnessPolicy.mcpToolsEnabled master switch.
--
-- Purely ADDITIVE + NULLABLE: null ⇒ OFF (the whole MCP external-tools path
-- stays dormant until a global admin explicitly flips this per-tenant knob AND
-- the referenced McpServer.enabled is true). Same per-field-fallthrough posture
-- as the TASK-511 agentic-loop knobs. No default (null is the "off" sentinel),
-- matching the other nullable HarnessPolicy knob columns.
--
-- Additive + idempotent (guarded ADD COLUMN IF NOT EXISTS) so it is safe to
-- apply via `pnpm db:push` / psql on the db-push-managed dev database.

-- AlterTable
ALTER TABLE "core"."HarnessPolicy" ADD COLUMN IF NOT EXISTS "mcpToolsEnabled" BOOLEAN;
