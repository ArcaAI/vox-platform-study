-- Pipeline template governance: lineage columns on `AsrPipeline`.
--
-- Owner expectation E4: the 9 SYSTEM-tenant pipelines are TEMPLATES cloned into
-- every new tenant; tenant admins cannot edit the cloned copies (they are
-- always-default) but may clone them or create their own. Today a tenant's
-- clones are byte-indistinguishable from hand-created pipelines, so nothing can
-- enforce that.
--
-- Two additive columns close it:
--
--   sourceTemplateSlug  — provenance. Which SYSTEM template this row descends
--                         from. Nullable: NULL means "not derived from a
--                         template" (the SYSTEM templates themselves, and any
--                         wholly hand-made pipeline). Lineage propagates
--                         through clone chains, so operators can enumerate
--                         every tenant row derived from a given template.
--                         Deliberately NOT a foreign key — `AsrPipeline`
--                         already references pipelines by slug, and templates
--                         must stay deletable without cascading into tenants.
--
--   templateLocked      — the immutability bit. TRUE marks a pristine template
--                         copy; the application layer answers content `update`
--                         and `delete` on such a row with 403 + "Template
--                         copies are read-only — clone to customize".
--                         `toggle` (enable/disable) and `set-default` stay
--                         ALLOWED on locked rows (owner decision OD-1).
--                         Never exposed on a request DTO, so the gateway's
--                         `forbidNonWhitelisted` pipe rejects API flips.
--
-- The index serves the per-tenant locked-copy sweep run by the resync
-- reconciler and the companion backfill migration.
--
-- ADDITIVE ONLY: both columns are nullable-or-defaulted, so existing rows are
-- valid without a rewrite and a code rollback leaves harmless dormant columns.
-- Row DATA is set by the companion `…_backfill` migration, which runs next.

ALTER TABLE "core"."AsrPipeline"
    ADD COLUMN IF NOT EXISTS "sourceTemplateSlug" TEXT,
    ADD COLUMN IF NOT EXISTS "templateLocked" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "AsrPipeline_tenant_locked_idx"
    ON "core"."AsrPipeline" ("tenantId", "templateLocked");
