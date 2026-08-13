-- Many-to-many origins <-> tenants (owner-directed)
-- Supersedes the GLOBAL uniqueness on `TenantAllowedOrigin.origin` introduced
-- in 20260804000000_task_610_tenant_allowed_origins. Several tenants may
-- legitimately share one origin (— "different tenant admin can
-- have many tenants, and they also share the same origins"); a row is now a
-- grant of ONE tenant's permission to act from that origin, not a claim on
-- the origin itself. Uniqueness moves to the (origin, tenantId) PAIR: the
-- same tenant cannot register the same origin twice, but two different
-- tenants sharing an origin must succeed. Index-only — no column added,
-- removed, or renamed; no data migration needed (the prior global-unique
-- index guarantees every existing row already has a distinct `origin`, so no
-- existing row pair can violate the new composite constraint).

-- DropIndex
DROP INDEX "core"."TenantAllowedOrigin_origin_unique";

-- CreateIndex
CREATE UNIQUE INDEX "TenantAllowedOrigin_origin_tenantId_unique" ON "core"."TenantAllowedOrigin"("origin", "tenantId");
