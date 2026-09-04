-- TASK-864 — Workflow Studio v2.
--
-- 1. `ALTER TYPE … ADD VALUE 'WorkflowRun'` — the run read model gains a sys-event on
--    terminal status (owner decision D-5) so a run-completed webhook can fan out. Postgres
--    cannot add an enum value inside the same transaction that uses it; Prisma runs each
--    migration in its own transaction and nothing below reads the new member, so it is safe.
-- 2. `WorkflowWebhookSecret` — the inbound webhook trigger's per-definition HMAC secret,
--    keyed (tenantId, workflowSlug). Reversible ciphertext (see workflow-webhook.prisma).
--
-- Generated with `prisma migrate diff --from-schema <git HEAD schema> --to-schema <working
-- schema> --script`, hand-reviewed, NEVER applied here (the local dev DB is db-push-managed).

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'WorkflowRun';

-- CreateTable
CREATE TABLE "core"."WorkflowWebhookSecret" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowSlug" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowWebhookSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowWebhookSecret_tenantId_idx" ON "core"."WorkflowWebhookSecret"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowWebhookSecret_tenant_slug_key" ON "core"."WorkflowWebhookSecret"("tenantId", "workflowSlug");

