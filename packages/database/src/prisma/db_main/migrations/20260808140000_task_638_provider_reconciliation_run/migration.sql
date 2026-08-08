-- TASK-638 §6 rule 6 — provider-reconciliation audit trail.
--
-- One row per (provider, run): what we compared, over which settled window,
-- against which vendor total, and what we concluded. This is the financial
-- control that answers an invoice dispute months later, when the drift log line
-- has aged out.
--
-- Append-only by construction: no resourceStatus column (listed in
-- MODELS_WITHOUT_SOFT_DELETE) and no unique key on (provider, window) — a
-- re-run is a second attempt and is recorded as one, because "the first attempt
-- failed" is usually the interesting part.
-- CreateTable
CREATE TABLE "core"."ProviderReconciliationRun" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "windowLabel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "ledgerQuantity" DECIMAL(38,6),
    "providerQuantity" DECIMAL(38,6),
    "providerUnit" TEXT,
    "relativeDrift" DECIMAL(12,6),
    "breachedThreshold" BOOLEAN NOT NULL DEFAULT false,
    "thresholdPct" INTEGER NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderReconciliationRun_tenantId_idx" ON "core"."ProviderReconciliationRun"("tenantId");

-- CreateIndex
CREATE INDEX "ProviderReconciliationRun_provider_window_idx" ON "core"."ProviderReconciliationRun"("provider", "windowStart");

-- CreateIndex
CREATE INDEX "ProviderReconciliationRun_runAt_idx" ON "core"."ProviderReconciliationRun"("runAt");

-- CreateIndex
CREATE INDEX "ProviderReconciliationRun_breach_runAt_idx" ON "core"."ProviderReconciliationRun"("breachedThreshold", "runAt");

