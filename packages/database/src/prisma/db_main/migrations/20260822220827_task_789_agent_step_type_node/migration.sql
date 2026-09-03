-- The harness has emitted `stepType: "NODE"` on every
-- `WorkflowInterpreter` graph-node dispatch since the interpreter shipped
-- (`STEP_NODE` in apps/harness/src/harness/temporal/activities.py), but
-- `AgentStepType` never carried the member. The ingest DTO validates
-- `@IsEnum(AgentStepType)`, so every interpreter trajectory post was rejected 400 —
-- and because that post is fire-and-forget, the rejection was swallowed and the
-- whole trace vanished. Adding the member is what makes Substrate B observable.

-- AlterEnum
ALTER TYPE "core"."AgentStepType" ADD VALUE 'NODE';
