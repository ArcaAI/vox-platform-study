-- SummaryMeta generation-stats headline fields (AD-1).
--
-- Purely ADDITIVE: three nullable columns on the existing SummaryMeta table so
-- every persisted summary can carry the normalized stop reason, time-to-first-
-- token and decode throughput alongside the existing token/latency columns.
-- predicted/total token counts are DERIVABLE from inputTokens/outputTokens and
-- are intentionally NOT added.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS) so it is safe to apply via
-- `pnpm db:push` / psql on the db-push-managed dev database, which sits ahead
-- of migration history.

ALTER TABLE "core"."SummaryMeta" ADD COLUMN IF NOT EXISTS "stopReason" TEXT;
ALTER TABLE "core"."SummaryMeta" ADD COLUMN IF NOT EXISTS "ttftMs" INTEGER;
ALTER TABLE "core"."SummaryMeta" ADD COLUMN IF NOT EXISTS "tokensPerSecond" DOUBLE PRECISION;
