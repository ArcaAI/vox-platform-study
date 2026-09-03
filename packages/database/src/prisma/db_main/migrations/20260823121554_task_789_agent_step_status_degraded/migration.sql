-- (finding C-10, the twin of C-9): the interpreter computes a four-valued
-- per-node outcome (`NodeStatus = Literal["SUCCEEDED","DEGRADED","SKIPPED","FAILED"]`)
-- and nodes RETURN `status="DEGRADED"` — but `AgentStepStatus` had no DEGRADED member,
-- so every one of those nodes recorded its trajectory step as ERROR instead. A graph
-- that partially degraded was therefore indistinguishable in the trace from one that
-- failed outright.

-- AlterEnum
ALTER TYPE "core"."AgentStepStatus" ADD VALUE 'DEGRADED';
