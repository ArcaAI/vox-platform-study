-- TASK-635 B-12 fold-in (C1 §8) — re-own the SYSTEM pre-summary default to the
-- SYSTEM tenant and pin its approval snapshot.
--
-- PROBLEM. `PromptTemplate`/`PromptVersion` are tenant-scoped
-- (extensions/tenant-scope.ts TENANT_SCOPED_MODELS) and the read handler injects
-- the CALLER's tenantId. `SYSTEM_DEFAULTS.preSummaryPromptId`
-- (71000000-0000-0000-0000-000000000040) was seeded under the GLOBAL CUSTOMER
-- tenant (50000000-…-0000), so every OTHER tenant's tier-2 lookup missed,
-- `isApprovedTemplate` returned false, and the pre-summary chain fell through to
-- its 503 fail-closed instead of the platform fallback. Latent today only because
-- ArcaAI carries its own TENANT_DEFAULT row; it breaks the first tenant
-- provisioned without one.
--
-- FIX (two halves, same MR). This migration is the DATA half: the row moves to
-- the SYSTEM tenant, which is what `SYSTEM_SHARED_READ_MODELS` semantically
-- means ("platform catalog owned by SYSTEM"). The CODE half adds PromptTemplate
-- + PromptVersion to that set (reads widen to `tenantId IN [caller, SYSTEM]`;
-- writes are NOT widened). Neither partial state breaks anything: before the
-- widening the Global tenant still resolves the row as its owner; after the
-- re-own every tenant resolves it through the widening.
--
-- `approvedVersionNumber = 1` is an integrity upgrade, not a content change:
-- tier-2 then serves the IMMUTABLE PromptVersion V40 snapshot instead of the
-- mutable `content` column via the legacy fallback in `resolveGovernedContent`.
-- The two bodies are byte-identical at seed time (both derive from
-- SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT), and the sha256 lock in
-- packages/database/src/__tests__/system-pre-summary-default-checksum.test.ts
-- keeps them that way.
--
-- UNIQUE-INDEX REVIEW. `PromptTemplate` carries @@unique([tenantId, name]) and
-- @@unique([tenantId, departmentId, ownerUserId, name]). The moved row is named
-- 'Pre-Summary Default Template' with departmentId = NULL and ownerUserId =
-- NULL. The SYSTEM tenant owns 13 golden templates (seed/07a-agent-golden-library.ts,
-- named after DEFAULT_PROMPT_TEMPLATES summary rows) plus the TASK-635 live
-- default ('Live SOAP Running Note — System Default'); none carries this name,
-- so neither index can collide. `PromptVersion` is unique on
-- (promptTemplateId, versionNumber) — untouched by a tenantId move.
--
-- Idempotent (the predicates are id-equalities) and roll-forward only.

UPDATE "core"."PromptTemplate"
   SET "tenantId" = '00000000-0000-0000-0000-000000000000',
       "approvedVersionNumber" = 1
 WHERE "id" = '71000000-0000-0000-0000-000000000040';

UPDATE "core"."PromptVersion"
   SET "tenantId" = '00000000-0000-0000-0000-000000000000'
 WHERE "id" = '72000000-0000-0000-0000-000000000040';
