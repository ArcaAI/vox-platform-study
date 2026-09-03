-- retire `DepartmentAgent`.
--
-- A prompt template's binding to a workflow now lives on the NODE that
-- references it (`WorkflowDefinition.graph`), so there is no per-department
-- agent row left to version. `AgentPromotion` is NOT dropped: the promotable
-- moved to a `WorkflowDefinition` version, and the table is a WORM audit record
-- the target tenant still owns.
--
-- WHAT IS DELIBERATELY ABSENT FROM THIS FILE
--
-- `ResourceType.DepartmentAgent` is NOT dropped, and that is the point rather
-- than an omission. Three reasons, each sufficient on its own:
--
--   1. PostgreSQL has no `ALTER TYPE … DROP VALUE`. Removing one member means
--      creating a replacement type, rewriting every column that uses it, and
--      dropping the old — a full rewrite of `AuditLog` for zero benefit. No
--      migration in this repo has ever dropped an enum value.
--   2. Historical `AuditLog` rows record `resourceType = 'DepartmentAgent'` for
--      every mutation the retired service broadcast. Those rows describe events
--      that really happened, and audit history is immutable on a PHI platform.
--      (A local dev database shows zero such rows only because it was reset; an
--      empty dev table is not evidence the value is unused.)
--   3. `resourceType.enum-parity.test.ts` asserts the database enum and
--      `packages/domains/src/enums/generated/ResourceType.ts` agree in BOTH
--      directions. Removing the value from either alone turns that guard red.
--
-- The comment above the member in `audit.prisma` says the same thing, so a
-- future reader does not "tidy up" what looks like a dangling enum member.

/*
  Warnings:

  - You are about to drop the `DepartmentAgent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DepartmentAgentVersion` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "core"."DepartmentAgent" DROP CONSTRAINT "DepartmentAgent_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "core"."DepartmentAgent" DROP CONSTRAINT "DepartmentAgent_promptTemplateId_fkey";

-- DropForeignKey
ALTER TABLE "core"."DepartmentAgentVersion" DROP CONSTRAINT "DepartmentAgentVersion_agentId_fkey";

-- DropTable
DROP TABLE "core"."DepartmentAgent";

-- DropTable
DROP TABLE "core"."DepartmentAgentVersion";

-- DropEnum
DROP TYPE "core"."DepartmentAgentDnaPolicy";

-- DropEnum
DROP TYPE "core"."DepartmentAgentRole";
