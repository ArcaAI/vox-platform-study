-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "core"."AiCapability" ADD VALUE 'STORAGE';
ALTER TYPE "core"."AiCapability" ADD VALUE 'WORKFLOW';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "core"."AiUsageUnit" ADD VALUE 'CPU_SECOND';
ALTER TYPE "core"."AiUsageUnit" ADD VALUE 'EGRESS_BYTE';
ALTER TYPE "core"."AiUsageUnit" ADD VALUE 'INGRESS_BYTE';
ALTER TYPE "core"."AiUsageUnit" ADD VALUE 'STORAGE_BYTE_DAY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "core"."UsageMeterMetric" ADD VALUE 'COMPUTE_SECONDS';
ALTER TYPE "core"."UsageMeterMetric" ADD VALUE 'WORKFLOW_CPU_SECONDS';
ALTER TYPE "core"."UsageMeterMetric" ADD VALUE 'STORAGE_BYTES';
