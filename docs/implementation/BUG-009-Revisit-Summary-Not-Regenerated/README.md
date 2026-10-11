# BUG-009 — Consultation Scribe revisit: old summary shown, no "Generate summary" action

- **Status:** Completed
- **Type:** bugfix (UI + application service `open`)
- **Source:** https://github.com/ArcaAI/project-hope/issues/9 (NeenaPanicker, 2026-09-28; no labels, no comments as of 2026-10-10)
- **Severity:** High / Blocker (per reporter)

## Requirement Analysis

After linking a **Revisit** to an existing completed visit in Playground / Vox Consultation Scribe and stopping the revisit session:

1. The UI keeps showing only the initial visit's summary instead of the revisit's.
2. No control exists to generate a new summary for the revisit session.

Expected: an explicit "Generate New Visit Summary" action for the revisit; the generated summary appends to / updates the revisit record.

Repro: record initial consultation → generate summary, save, sign off → select same patient → start Revisit linked to the completed visit → run and stop the revisit → try to generate/view the revisit summary. Screenshot: https://github.com/user-attachments/assets/733d59e9-35aa-40a7-a875-2104d0fd7411

## Current State Evaluation

Investigated read-only on `dev-2.2` @ `e724d0ae5` (2026-10-10). Not reproduced live yet. The issue was filed 2026-09-28, BEFORE TASK-1045 rewrote `open` (`94c3a568d`, 2026-10-05), so the path the reporter hit and the path on the branch today differ; both are traced below.

**Console (Scribe = `/playground/consultation`, feature `apps/admin-console/src/features/playground-consultation/`)**

- Revisit is declared in the open dialog: `components/scribe/consultations-column.tsx:259-260` (visit-type toggle + parent picker over the patient's own rows, `:308`), sent as `parentConsultationId` (`:341`).
- `handleOpenPatient` (`components/consultation-demo-screen.tsx:505-553`) calls `sdkSession.open(...)` (`:515`) and binds the screen to WHATEVER id the gateway answers (`selectConsultation({ id: opened.id, ... })`, `:476`, `:540-547`), then toasts "Consultation opened" (`:548`). It ignores the response's `recordable` / `encounterAppended` and never checks `opened.id !== parentConsultationId`.
- Every read is keyed on that one id: the note is `useLatestSummary(consultationId)` (`:335`) → `GET consultations/:id/summary/latest` (`api/client.ts:179-187`, `api/hooks.ts:88-101`); the warm start is `usePreSummaryStream(consultationId)` (`:388`, rendered as the "Pre-summary" panel ABOVE the note, `case-note-column.tsx:392-444`, `:744`). So the console never reads a parent's note by itself — if it shows the initial visit's note, it is bound to the initial visit's id, or the content on the child really is the parent's.
- The list maps rows to `{ id, patientId, status, createdAt }` only (`:441`) — `parentConsultationId` is dropped, so a revisit row and its parent are indistinguishable in the Consultations column.
- **"Generate note" gating** (`consultation-demo-screen.tsx:772-774`, `:889`): `harnessActive = !!progress.snapshot && stages.length > 0`, and `onGenerate={harnessActive ? null : handleGenerate}`; `case-note-column.tsx:1024-1029` renders the button only when `onGenerate` is non-null. The progress snapshot is never cleared when the run is terminal (`closed: true`, `api/hooks.ts:270-272` keeps the last snapshot), so on ANY harness-governed consultation — which is every revisit, whose department workflow branches on `n_visit` — the action is hidden for the life of the screen, before and after the run. The empty state then says the harness drafts the note automatically (`case-note-column.tsx:905-911`), so if the revisit finalize produced nothing there is no way out. No status/`isNoteReady`/approved-parent check is involved; it is this one predicate.

**Gateway / application (`packages/applications/src/services/consultation/consultation/consultation.service.ts`)**

- Today (TASK-1045) `openEpisode` (`:1287-1323`): with no `externalRef` (the playground sends none) it takes `findOpenByKey` = the newest NON-closed consultation of `(tenant, doctor, patient, department)` (`:1303`; `ConsultationRepository.ts:433-442`). "Closed" is only `CLOSED_COMPLETE | CLOSED_INCOMPLETE` (`ConsultationRepository.ts:20`) — an **APPROVED (signed) initial visit is still the open match**, because approve does not close (`consultation-approval.service.ts:168`, close is separate: `consultation-lifecycle.service.ts:263-289`).
  - The named `parentConsultationId` only feeds `statedVisitType` (`:1305`); it never forces a new consultation. `append` is true for a revisit whose current encounter ended (`:1306`) — and `stop` always ends it (`consultation-lifecycle.service.ts:201`).
  - So the reporter's sequence (record → stop → sign → open Revisit naming that visit, same department) goes to `appendEncounter` (`:1365`) → `beginNextEncounter` refuses APPROVED (`ConsultationEntity.ts:617-621`) → **409 `CONSULTATION_APPROVED`** (`consultation-encounter.service.ts:39-43`, `:130-131`). The dialog toasts "Could not open the consultation" and the screen stays on the initial visit, note and all. If the encounter had not ended, `answerExisting` (`:1307`, `:1334-1357`) returns **the parent itself** (pinned by `consultation.service.open-episode.task1045.test.ts:382-391`) and the screen re-binds to it with "Consultation opened".
  - This contradicts the request DTO's own contract — "Naming the match ... as `parentConsultationId` opens a new follow-up instead" (`dto/open-consultation.request.ts:28-29`, `:59-64`).
- At report time (pre-TASK-1045, `git show 94c3a568d^`) `findEncounterMatch` returned `null` when `namedParent === match.id`, so a NEW chained consultation was created and the console bound to it. On that path symptom 1 can only come from the child's own content: the revisit's warm start / finalize receive the predecessor's note (`same_day_prequel_summary`, `live-documentation.service.ts:8972-8976`; `isFollowUp`, `:8950`), so the "Pre-summary" panel (and, with a thin revisit transcript, possibly the finalized note) reads as the initial visit's summary.
- `GET :id/summary/latest` is strictly per consultation (`summary.service.ts:1421-1434`, `ContextItemRepository.ts:337-352`, `latest-shown-raw-summary.ts`) — no chain widening. Nothing in the read path leaks a parent note into a child.
- No related open ticket; TASK-1020 (chain model) and TASK-1045 (episode/encounter open) are the owning designs.

## Root Cause

Two independent defects; together they produce the report.

1. **Backend, current branch (confidence: high, from code + the pinned unit test).** `openEpisode` lets the open-key match win over an explicitly named parent. A signed (APPROVED, not CLOSED) visit stays the open match, so a Revisit naming it either 409s (`CONSULTATION_APPROVED`, encounter ended — the normal case) or returns the parent itself; the console stays on / re-binds to the initial visit and shows its note. Regression from TASK-1045 against the TASK-1020 contract still documented on the DTO.
2. **Console (confidence: high).** "Generate note" is hidden whenever the harness-progress stream has EVER reported a stage (`consultation-demo-screen.tsx:774`, `:889`), including after the run is terminal. Every harness-governed consultation — every revisit — therefore has no generate action. Not a lifecycle gate.
3. **What the reporter literally saw on 2026-09-28 (confidence: medium, not reproduced).** On the pre-1045 code the console bound to a new child; the "initial summary" was most likely the revisit's Pre-summary panel (which summarises the prior visit by design) with no finalized revisit note under it, and no generate action because of (2). A repro on the current branch will instead show (1). Confirm by checking which id the screen is bound to (`GET /api/hope/consultations/<id>` in the network log) and the child's `ContextItem` rows (RAW_SUMMARY present or not).

Fix scope: **both UI and backend**. The UI fix alone restores Generate but cannot help when `open` never yields a child consultation.

## Implementation Plan

TDD, layer order Services → Console (no schema / domain change; no new route).

**Tests first (RED):**

1. `packages/applications/src/services/consultation/consultation/__tests__/consultation.service.open-episode.task1045.test.ts` (extend; or a sibling `consultation.service.open-revisit.bug009.test.ts`):
   - open with `parentConsultationId === open match id`, match APPROVED, encounter ended → creates a NEW consultation chained to it (`created.parentConsultationId === match.id`, `encounterRepository.create` seq 1), no 409, no `updateWithVersion` on the parent.
   - same with match STOPPED (not signed) and encounter ended → decision OD-1 (append vs new child); assert the chosen behaviour.
   - open with `parentConsultationId` naming the match's OWN parent (retry of an earlier follow-up open) → returns the match (idempotent).
   - existing case `:382-391` (APPROVED, no parent named) stays green — a plain re-open still returns the row with `recordable: false`.
2. `apps/admin-console/src/features/playground-consultation/components/__tests__/consultation-demo-screen.test.tsx`:
   - revisit open answered with a NEW id → `summary/latest` and `summary/pre-summary/latest` are requested for the child id, never the parent's.
   - open answered with `id === parentConsultationId` or `recordable: false` → a warning toast naming it, not "Consultation opened".
   - harness progress emits stages then `closed: true` and no draft exists → "Generate note" button is present; while stages are in flight (not closed) it is absent.
3. `apps/admin-console/src/features/playground-consultation/components/scribe/__tests__/case-note-column.test.tsx`: Pre-summary panel and draft are labelled distinctly when the consultation is a revisit (OD-3, only if adopted).
4. E2E (orchestrator, after merge): `apps/api/tests/e2e/consultation-lifecycle-task1045.spec.ts` — add "approve, then open a revisit naming it → 201 new id, parentConsultationId set, generate summary async on the child → note on the child".

**File order (GREEN):**

1. `packages/applications/src/services/consultation/consultation/consultation.service.ts` `openEpisode` (`:1303-1307`): when `request.parentConsultationId === open.id` and `open` is not appendable (APPROVED) — or per OD-1 always — fall through to `createEpisode` (which already honours a named parent, `:1403`). Update the method comment and the DTO text in `dto/open-consultation.request.ts` if OD-1 changes the contract.
2. `apps/admin-console/src/features/playground-consultation/components/consultation-demo-screen.tsx`: `harnessActive` → in-flight only (`stages.length > 0 && !progress.snapshot.closed`, `:774`); in `handleOpenPatient` (`:540-548`) detect a returned parent / `recordable: false` and warn; carry `parentConsultationId` into `ConsultationListRow` (`:441`) so the list can badge "Revisit".
3. `components/scribe/consultations-column.tsx`: render the "Revisit" badge from the row (optional, OD-3).
4. Label rename "Generate note" → owner wording (OD-2) in `case-note-column.tsx:1027`.

**Verification:**

- `pnpm --filter @arcaai/applications test src/services/consultation/consultation/__tests__/consultation.service.open-episode.task1045.test.ts` (+ the bug009 file if split)
- `pnpm --filter @arcaai/admin-console test src/features/playground-consultation/components/__tests__/consultation-demo-screen.test.tsx src/features/playground-consultation/components/scribe/__tests__/case-note-column.test.tsx`
- `pnpm --filter @arcaai/applications build`, `pnpm admin:typecheck`, `pnpm admin:lint`
- Orchestrator only: `npx dotenv -e .env.test -- npx playwright test consultation-lifecycle-task1045` with `RESET_DB=false`; headed pass of the repro (initial → sign → revisit → stop → generate) in both themes, confirming the note lands on the child and the parent's stays signed.

## Risks / Open Questions

- **OD-1 (owner): what does naming a STOPPED-but-unsigned visit as parent mean?** TASK-1045 appends a second ENCOUNTER to it (one consultation, two encounters); TASK-1020 and the DTO text create a NEW chained consultation. The APPROVED case must become "new child" (append is impossible); the STOPPED case is a product choice. Recommendation: an explicit `parentConsultationId` always means a new chained consultation; encounter append stays the `externalRef` / unnamed-revisit path.
- **OD-2 (owner): manual generate alongside the harness.** Showing Generate after the run is terminal lets a clinician regenerate a harness note (supersede semantics: `encounter-refinalize.ts` refuses locked statuses). Confirm it should also be offered when a harness draft already exists, and the label ("Generate note" vs the reporter's "Generate New Visit Summary").
- **OD-3: "append to or update the revisit record".** Under the chain model the revisit gets its OWN note on its OWN consultation; the signed parent note is never edited. Confirm that reading; any "combined episode note" is a new feature.
- Risk: changing `openEpisode` touches every no-`externalRef` open (ALaaS sends refs, so it is mostly console/SDK traffic) and the open-key unique index race path (`:1308-1322`); keep the retry test green.
- Risk: the Pre-summary panel legitimately summarises the previous visit for a revisit; if testers read it as "the summary", a labelling change ("Previous visit — pre-summary") may be needed even after the fixes (OD-3).
- Unverified: the screenshot was not inspected (GitHub MCP unavailable), and no live repro was run; root cause 3 stays medium until reproduced.

## Decisions (2026-10-10)

- **OD-1 — named parent always creates a new linked consultation.** Naming a parent (signed or merely stopped) leads to `createEpisode`; `openEpisode` never appends an encounter to a named parent.
- **OD-2 — manual Generate stays available after the harness has drafted a note**, keeping the existing label "Generate note".
- **OD-3 — the revisit gets its own note; the signed parent note is never edited.** The Pre-summary panel gets a clearer label stating it summarises the previous visit.

## Addendum — second read-only investigation (2026-10-10)

Independent re-check on `dev-2.2`; the analysis above holds. Additional findings:

- **OD-1 is blocked by the open-key index (high, evidence).** `Consultation_openKey_uq` (`migrations/20261005160100_task_1045_consultation_lifecycle/migration.sql:397-398`) allows ONE row per `(tenantId, doctorId, patientId, COALESCE(departmentId,''))` with `status NOT IN ('CLOSED_COMPLETE','CLOSED_INCOMPLETE')`. APPROVED and STOPPED parents are inside that predicate, so routing a named-parent open to `createEpisode` hits the unique violation and the `isUniqueViolation` retry (`consultation.service.ts:1316-1320`) hands back the parent again. OD-1 therefore also needs one of: (a) close the named parent (`CLOSED_COMPLETE`, `closedReason` per lifecycle rules) in the same transaction before creating the child, or (b) a migration narrowing the predicate (e.g. also excluding `APPROVED`). **New owner decision OD-4.**
- **Regression source.** Before TASK-1045 the match lookup had `if (namedParent === match.id) return null;` (`git show 94c3a568d^:…/consultation.service.ts:1494`), which created a new child; TASK-1045 (`94c3a568d`) dropped it, so the code now contradicts the DTO text (`dto/open-consultation.request.ts:28-29, 59-64`).
- **Why Generate stays hidden after the run (evidence).** The server fold keeps stages on the terminal frame (`harness/harness-progress.service.ts:147-151`: all stages `completed`, `closed: true`) and replays it for 1 h; the client resets the snapshot only on scope change (`api/hooks.ts:251-257`). The comment at `consultation-demo-screen.tsx:355-357` ("terminal … with `stages: []`") and the test fixture at `__tests__/consultation-demo-screen.test.tsx:608` encode the wrong assumption — fix both.
- **RC-3: summary precedence is not encounter-aware (high on code, medium on reporter impact).** `SummaryService.getLatestSummary` (`summary/summary.service.ts:1421-1426`) returns the latest MODIFIED summary before any newer RAW one, scoped by consultation only (`ContextItemRepository.ts:337-352`), although `ContextItem.encounterSeq` exists. On any append path (externalRef / unnamed revisit) or a regenerate after a doctor edit, the old saved note keeps winning. OD-1 avoids it for named-parent revisits only — candidate follow-up ticket.
- **Inference, minor:** `useLatestSummary` never re-polls once data exists (`api/hooks.ts:96-99`); `handleApprove` onSuccess (`consultation-demo-screen.tsx:695-701`) does not set local status to APPROVED, so Record stays enabled on a signed visit.
- **What the reporter likely hit (medium, not reproduced):** the issue predates TASK-1045 (filed 2026-09-28), when a child WAS created; "initial summary shown" was likely the child's Pre-summary panel (summarises the prior visit) plus the Generate gating — consistent with the OD-3 relabel.

**Plan delta:** add to the TDD list — unit case "named parent == open match, APPROVED and STOPPED → new child, parent closed or index permits it, no retry loop"; fix the `:608` fixture to carry stages; optional RC-3 test in `packages/applications/src/services/consultation/summary/__tests__/` (newer raw vs older modified). If (b) is chosen, a migration per `02-database-prisma.md`.

## Implementation Summary

Not started.

## Final Verification (2026-10-11, cluster api `0.0.0-dev-2-2.b4c248f9`)

Revisit naming the APPROVED visit → 201, new linked consultation `01a12a56-26aa…`. Before the fix this was 409 `CONSULTATION_APPROVED`. The parent is `CLOSED_COMPLETE` with its signature and RAW_SUMMARY kept. Revisit naming the STOPPED visit → new `01a12a56-2e23…`, parent `CLOSED_INCOMPLETE`. A retry returns the same child (`isNew:false`). Meets the expectation: the revisit gets its own consultation and note.

## Change History

- 2026-10-11 — Final verification against the deployed cluster passed; status Completed.

- 2026-10-10 — Ticket scaffolded from GitHub issue #9 (no investigation yet).
- 2026-10-10 — Read-only investigation: backend open-key match beats a named parent (APPROVED parent → 409 / parent returned) and console hides Generate whenever the harness ever reported stages; plan + owner decisions OD-1..OD-3 recorded. Status stays Pending.
- 2026-10-10 — OD-1..OD-3 recorded as the agreed direction (the owner accepted the recommendations).
- 2026-10-10 — Second read-only investigation: Addendum added — open-key unique index blocks OD-1 as written (new OD-4), regression source 94c3a568d, RC-3 summary precedence.
