# BUG-032 — Case-note template resolution: Doctor -> Department -> Hospital, per visit type

- **Status:** Pending
- **Type:** feature (enhancement, filed as issue #32; ticket file keeps the BUG- prefix by request)
- **Source:** https://github.com/ArcaAI/project-hope/issues/32 (JayaramNambiar, 2026-10-01; labels `enhancement`, `Knowledge & Agents`, `Clinical`)
- **Severity:** Medium-High scope (data model + resolver + console UI); no defect

## Requirement Analysis

Resolve the document (case-note) template used for summary generation through a fallback chain with visit-type specificity at every tier: (1) Doctor + visit type (`new_visit`/`revisit`), (2) Department + visit type, (3) Hospital/tenant + visit type, (4) platform SOAP shape. Add doctor-level and visit-typed tenant-level templates, surface scopes/fallback/status in `/document-templates`, and record `resolvedFrom: 'doctor' | 'department' | 'hospital' | 'default'` in the resolution trace. Acceptance criteria: per-tier resolution per visit type, graceful default to SOAP with no error, distinct structures per visit type at all tiers. Reference: tenant "Demo Hospital" has `consultation_note_new_visit` and `consultation_note_revisit` (v1 PUBLISHED), no default, and shows the "Generating the platform SOAP Note shape" banner.

## Current State Evaluation

- `DocumentTemplate` is tenant-scoped only: `packages/database/src/prisma/db_main/document-template.prisma` — unique `(tenantId, slug)` (line ~82), a single `isDefault` flag per tenant (line ~58, index ~84), no department, doctor or visit-type column.
- Resolver: `packages/applications/src/services/document-template/document-template.service.ts:354 resolveForGeneration(tenantId, slug?)` -> `resolveServableVersion` (:432): slug given -> that template; no slug -> the tenant default (`findDefaultForTenant`); unservable -> `PLATFORM_FALLBACK` (SOAP; `platform-document-shapes.ts`). `isDefault` is exclusive per tenant (`demoteExistingDefault`, :460). The interface (`IDocumentTemplateService.ts:97`) takes no doctor, department or visit type.
- Callers: live lane `live-documentation.service.ts:2329` (`ensureTemplateResolved`), note composer `note-input-composer.service.ts:1064`, summary `summary.service.ts:800` (no slug at all).
- Today's visit-type behaviour lives in the WORKFLOW GRAPH, not the template service: a graph branches on `visit_type` (condition node, TASK-946 D2) and each summary node names a template slug; `realtimeDocumentTemplateSlug(lane, branchHandles)` picks it. The seeds are `NEW_VISIT_NOTE_SLUG`/`REVISIT_NOTE_SLUG` (`seed/27-document-template-library.ts:262,374`), both seeded `isDefault: false` on purpose (:91). So a tenant whose graph does not name a template and has no default gets SOAP — exactly the banner in the issue (`features/document-templates/components/effective-template-banner.tsx:35,60`).
- Visit types are the platform's two, derived from `parentConsultationId` (`consultation/visit-type/visit-type.catalogue.ts`, `visit-type.service.ts`, TASK-882); `Department` carries prompt columns per visit slot (`promptSlot`).
- Scope machinery already exists for other entities: `PipelinePolicyScope { TENANT, DEPARTMENT, DOCTOR }` (`enums.prisma:470`) used by `AgentAssignment` and `WorkflowAssignment` (scope + scopeId, tenant/department tiers; DOCTOR is declared but never resolved: `workflow-assignment.service.ts:75-92` walks department then tenant only; no `PipelinePolicyScope.DOCTOR` use in applications/domains). `Consultation.doctorId` names the clinician (open-consultation DTO, TASK-933).
- Console: `apps/admin-console/src/features/document-templates/*` (list, banner, hooks) lists one tenant catalog with a default toggle; no scope or visit-type notions. Backend controller `apps/api/src/modules/document-template/document-template.controller.ts`.
- No provenance of the resolved tier exists today (`ResolvedDocumentTemplate` carries `templateId`, `slug`, `versionNumber`, `documentTemplateVersionId`).
- Related tickets: TASK-1022 (finalizer keeps template headings), TASK-946 D2, TASK-1020 (visit lifecycle), TASK-882 (visit types), TASK-1045 planning (P-E-summarization). Not implemented on dev-2.2.

## Root Cause

Not a defect: the capability is absent. The template layer has one tenant-wide default and no scope/visit-type axes; visit-type choice is delegated to the workflow graph and DOCTOR scope is unused. Confidence: high.

## Implementation Plan

This is large and crosses all layers, so it needs the plan -> owner decisions -> go workflow (rules 01 phase 3). Proposed shape (decide first, see open questions):

Option A (recommended, minimal): a new binding table `DocumentTemplateAssignment { tenantId, scope: PipelinePolicyScope, scopeId, visitType, documentTemplateSlug, ... }`, unique `(tenantId, scope, scopeId, visitType)`, mirroring `WorkflowAssignment`; the template entity itself stays tenant-owned and is only referenced. Option B: add `departmentId`/`doctorId`/`visitType` columns to `DocumentTemplate` (tangles template identity with binding; not recommended).

TDD test list (RED first):
1. Resolver unit tests (`document-template.service.test.ts`): doctor+visit wins; falls to department; to tenant; to SOAP; unservable (draft/unpinned) tier is skipped, not substituted; never throws; returns `resolvedFrom`.
2. Assignment service tests (cross-tenant -> 404, one row per key, DOCTOR scope validates the user belongs to the tenant, 404-over-403).
3. Caller tests: live lane, composer and summary pass `{ doctorId, departmentId, visitType }`; a graph that names a template slug explicitly still wins (explicit bind beats the chain; see question 2).
4. Controller + e2e cross-tenant spec (`*cross-tenant*.spec.ts`), route-manifest authz matrix coverage.
5. Console: list shows scope/visit-type/tier and fallback path; empty/loading/error states; axe.

File order (layer chain): `packages/database` (model + migration `task_<nnn>_*`, allow-lists `TENANT_SCOPED_MODELS`, `ResourceType` + `ADD VALUE`) -> `pnpm gen:model`, hand-authored entity/factory/mapper/repository, `CoreDatabaseModule` -> `packages/applications` (assignment service + DTOs, extend `IDocumentTemplateService.resolveForGeneration` with a context arg; update 3 callers) -> `apps/api` controller + regenerate the FIVE artifacts (`api:route-manifest`, `api:openapi`, `api:portal`, vox-node `gen:admin`) -> admin-console screens -> seeds (assign the two seeded visit-type templates at tenant tier) -> ticket docs.

Verification: `pnpm --filter @arcaai/domains test`, `pnpm --filter @arcaai/applications test <files>`, `pnpm api:build`, `pnpm test:e2e` filter via `npx dotenv -e .env.test -- npx playwright test <filter>`, `pnpm --filter @arcaai/admin-console build lint test`, drift gates `gen:*:check`. Lanes run only their own test files (owner rule); orchestrator gates after merge.

## Risks / Open Questions for the owner

1. Configuration vs content: per `00-project-context.md` document templates are cloned content (reference set) while this cascade reads tenant -> SYSTEM only on absence. Is the chain doctor -> department -> tenant -> platform SOAP (issue) acceptable, i.e. no SYSTEM tier read at runtime, platform SOAP being the code fallback? Confirm.
2. Precedence vs the workflow graph: today the governing workflow's node names the template. Should the chain apply only when the node names none (additive, safest), or override it (changes TASK-946/1022 behaviour)?
3. Doctor-level authoring: who may set it (the doctor, tenant admin, both)? Is a clinician-owned template PHI-adjacent (DNA-style precedent) and subject to the DNA opt-out toggles?
4. Visit types are only `new-visit`/`revisit` (catalogue keys use hyphens; the issue writes `new_visit`) — confirm the key vocabulary and what happens for a visit type with no tier match (use the other type's template? issue says no).
5. Overlap with the Workflow Studio branch approach (graphs already split per visit): would the owner rather solve this with `WorkflowAssignment` DOCTOR scope (declared, unresolved) than a new table?
6. `resolvedFrom` surface: add to the resolution log and `ResolvedDocumentTemplate`, and to the run/trace UI?
7. Same-day return visits (TASK-1020) and chained consultations: which doctor wins if the clinician differs across encounters?
8. Seed/migration: assign the two seeded templates at tenant tier for existing tenants (needs hope-reset note: seed data does not refresh on deploy).

## Implementation Summary

Not started. Awaiting owner decisions (plan -> OD round -> go).

## Change History

- 2026-10-06 — Ticket created from GitHub issue #32 (read-only investigation).
