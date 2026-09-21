-- CreateIndex
CREATE INDEX "Consultation_tenant_updated_idx" ON "core"."Consultation"("tenantId", "updatedAt");
