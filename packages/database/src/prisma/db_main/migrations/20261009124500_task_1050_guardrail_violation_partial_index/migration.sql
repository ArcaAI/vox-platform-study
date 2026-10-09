-- TASK-1050 (completed under TASK-1055's migration audit): the violation-view partial
-- index the TASK-1050 W0 draft (docs/implementation/TASK-1050-*/sql/w0_draft.sql §1)
-- asked to be appended to 20261007130131_task_1050_guardrail_evaluation, and which
-- never was. About 2 GuardrailEvaluation rows land per generation request, nearly
-- all ALLOW, so a partial index on the non-ALLOW decisions stays small while
-- serving "warn/block/unverified over time" and the per-consultation Guardrail tab.
--
-- Prisma cannot express a partial index, so `prisma migrate diff` does not report
-- it as drift (same as Agent_tenant_slug_active_unique / AiRoutingPolicy's default
-- unique). IF NOT EXISTS keeps a database that received it by hand consistent.
CREATE INDEX IF NOT EXISTS "GuardrailEvaluation_tenant_violation_at_idx"
  ON "core"."GuardrailEvaluation" ("tenantId", "at")
  WHERE "decision" <> 'ALLOW';
