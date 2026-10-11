# BUG-027 — Workflow Studio: duplicate agent entries (one per version) in the `core.agent` picker

- **Status:** Review
- **Type:** bugfix
- **Source:** https://github.com/ArcaAI/project-hope/issues/27 (JayaramNambiar, 2026-09-30; labels `bug`, `Knowledge & Agents`)
- **Severity:** Medium (cannot tell entries apart; trigger text corrupts; risk of binding the wrong version)

## Requirement Analysis

In Workflow Studio, the Agent dropdown of a `core.agent` node lists the same agent several times with identical name and slug (`realtime-rado-asr` x5, `saaras-test` x3, `realtime-transcription` x3, `pure-radiology-asr` x2, `general-medicine-summarization` x2). Selecting a duplicated one makes the trigger show the slug repeated (`saaras-test saaras-test saaras-test saaras-test`). Reporter asks for slug uniqueness and a de-duplicated or disambiguated list. Workflow: `arcaai-gen-consultation v5 DRAFT`, node `n_asr`. Video: https://github.com/user-attachments/assets/06ad96a9-3fb5-4bc9-b7ac-ad715ffc20d1

## Current State Evaluation

- Picker: `apps/admin-console/src/features/workflow-studio/components/inspector/agent-picker-field.tsx:152-199`: `SelectItem key={agent.slug} value={agent.slug}` for every row of `useAgentOptions(undefined)`.
- Data: `.../workflow-studio/api/client.ts:290-300` `listAgentOptions` calls `GET admin/agents` with `{ task, status: 'PUBLISHED', limit: 200 }` and only filters `hidden` client-side.
- Backend: `apps/api/src/modules/agent-admin/agent-admin.controller.ts:87-91` `fetchAll(@Query('task'))` declares ONLY `task`; `status` and `limit` are ignored (undeclared query keys). `AgentService.list` (`packages/applications/src/services/agent/agent.service.ts:344`) -> `AgentRepository.findAllForTenant` (`packages/domains/src/repositories/generated/core/AgentRepository.ts:338`) returns EVERY version row (DRAFT, PUBLISHED, deprecated) ordered by slug, versionNumber desc. The controller docblock itself says this route is "one row per VERSION".
- Schema: `packages/database/src/prisma/db_main/agent.prisma` — a lineage is `(tenant, slug, versionNumber)` unique with a partial unique index `Agent_tenant_slug_active_unique` allowing one active version per slug. Duplicate slugs are therefore BY DESIGN (versions); slug uniqueness is already enforced per lineage, so the reporter's "enforce slug uniqueness" request is a misdiagnosis.
- Trigger concatenation is a consequence: with several `SelectItem`s sharing one `value`, Radix `SelectValue` portals each matching item's text into the trigger.
- A one-row-per-slug source already exists: `GET agents` (`apps/api/src/modules/agent/agent.controller.ts`, `AgentService.listPublished` -> `findPublishedActiveVisible`, hidden agents filtered), and `GET admin/agents/lineages` (TASK-965).
- Pinning: the node pins `agentRef.versionNumber` from the chosen row (`agent-picker-field.tsx:157`, TASK-1036); deduping must therefore pick the ACTIVE PUBLISHED version, which is also what the resolver serves.
- Tests exist: `inspector/__tests__/agent-picker-field.test.tsx`, `.task949.test.tsx`, `.wizard.task1036.test.tsx`. Not fixed on dev-2.2; last picker commits are TASK-1036 (`e0421a105`) and TASK-949 L0 (`9ff69500e`).

## Root Cause

`listAgentOptions` assumes the server filters to published agents (`status=PUBLISHED`) and one row per slug, but `GET admin/agents` ignores `status`/`limit` and returns every version of every agent; the picker keys and values on slug alone. Confidence: high.

## Implementation Plan

TDD (RED first):
1. `agent-picker-field.test.tsx`: given rows `[saaras-test v3 PUBLISHED active, v2 PUBLISHED inactive, v4 DRAFT]`, the list shows `saaras-test` once and `onChange` receives versionNumber 3.
2. Same test: the selected trigger text shows the agent once (no repetition).
3. `listAgentOptions` unit test (client): filters `status === 'PUBLISHED' && isActive`, drops hidden, tolerates rows lacking the fields (older envelope) by keeping the highest versionNumber per slug.
4. Edge: an agent with a published version but none active (deprecated) is omitted or shown disabled — assert whichever the owner picks.

File order:
1. `workflow-studio/api/client.ts` `listAgentOptions`: filter to PUBLISHED + active and fold to one row per slug (max versionNumber fallback). No backend change needed (`AgentOption.status`/`isActive` already typed, `types.ts:405-406`).
2. `agent-picker-field.tsx`: no structural change; optionally show `v{versionNumber}` for clarity.
3. Optional follow-up: declare `status`/`limit` on the backend or switch the picker to `GET admin/agents/lineages` (paginated, with active version); owner call.

Verification: `pnpm --filter @arcaai/admin-console test inspector/__tests__/agent-picker-field` (own files only), `pnpm admin:typecheck`, `pnpm admin:lint`; orchestrator headed check on the workflow in the report.

## Risks / Open Questions for the owner

- Show only the active version (recommended) vs let authors pick a specific published version? (the node already pins `versionNumber`; a version selector is a feature).
- Deprecated-only or draft-only lineages: hide, or show disabled with a reason?
- Replace the unfiltered `limit: 200` read with the lineages route (pagination beyond 200 versions is silently truncated today)? Larger change, separate ticket suggested.
- Reply to reporter: slug uniqueness is per lineage by design.

## Implementation Summary

Decisions (owner, 2026-10-11): list only the active PUBLISHED version per slug; lineages with no active published version (draft-only / deprecated-only) are hidden. The lineages-route / server-side filter follow-up was not taken.

- `apps/admin-console/src/features/workflow-studio/api/client.ts` — `listAgentOptions` folds the `GET admin/agents` rows through `oneServableVersionPerSlug`: keep `status === 'PUBLISHED' && isActive === true`, one row per slug (highest `versionNumber`), server order preserved; rows that carry neither field fold to their highest version. Done at the shared read (not in the picker) on purpose: `inspector-panel.tsx` (declared prompt variables), `use-composer-data.ts` (output schemas, step names) read the same query with `.find(slug)`, which with every version present hit the newest row — possibly a DRAFT — instead of the version a run resolves.
- `.../api/__tests__/workflow-studio-api.test.ts` — `listAgentOptions (BUG-027)`: versions + draft-only + deprecated-only → `[['saaras-test', 3]]`; status-less rows → highest version.

Evidence:
- RED: both new tests failed (all 6 version rows returned).
- GREEN: `vitest run src/features/workflow-studio` → 102 files, 935 tests passed.
- `tsc --noEmit` (admin-console) exit 0; `eslint` on both changed files exit 0.
- Running console (tenant_admin @ Global): created a DRAFT v2 of `general-medicine-summarization` (`POST admin/agents/:id/versions`) so `GET admin/agents` returned 2 rows for it; opened `general-medicine-consultation` as new draft v2, opened the summarization step's Agent dropdown → 8 options, `general-medicine-summarization` once, trigger shows it once, hidden `dna-writing-style-analyst` absent. Test data left in the local dev DB: agent draft v2, workflow draft v2.

Note for the reporter: duplicate slugs are versions of one agent by design (`(tenant, slug, versionNumber)` unique, one active per slug) — slug uniqueness was never the defect.

## Change History

- 2026-10-06 — Ticket created from GitHub issue #27 (read-only investigation).
- 2026-10-11 — Fixed (active PUBLISHED version per slug, others hidden); tests, typecheck, lint, live console check green. Status Review.
