# TASK-793 — Console, Playground & SDK: make the clinician path real (R2, R3, R4, R5)

| | |
|---|---|
| **Status** | Pending |
| **Type** | `feature` / `bugfix` |
| **Parent** | TASK-789 |
| **Branch** | `feat/task-793-console-playground` off `dev-2.2` |
| **Owns** | `apps/admin-console/**`, `packages/agentic-sdk-v2/**`, `packages/vox-node/**` |

## Context

TASK-789's sharpest finding is that the backend for the clinician experience is largely **built and
never called**. This ticket is mostly wiring, not construction — check what exists before building.

## Work items

### W1 — The clinician cannot edit the SOAP note (C-3) — HIGHEST PRIORITY, unblocks R5 and R7
`case-note-column.tsx:280` renders the draft as `<article aria-label="Personalized draft note">` —
inert text. The playground's only `PATCH` is job-cancel.

The backend is **complete**: `PATCH :id/summary/:summaryId` with mandatory `If-Match`
(`consultation.controller.ts:1073-1109`), OCC via `updateWithVersion` (`context.service.ts:522`),
append-only `ContextItemVersion` with diffs, and a passing `summary.service.edit-capture.test.ts`.

Build the editing surface. R5 specifically requires the clinician to edit **while the system keeps
transcribing and generating** — so you must handle the concurrent-writer case explicitly:
- What happens to in-progress clinician text when a machine write lands? Merge, or hold the machine
  write, or surface a conflict — pick one, justify it in the README, and TEST it.
- Use the ETag/`If-Match` flow; a 412 must be handled visibly, never swallowed.
- Do not silently discard clinician input under any code path. That is the one unacceptable outcome.

### W2 — R4's inputs are never supplied
`consultation-demo-screen.tsx:300` calls `sdkSession.open({ patientId })`. `departmentId` exists on
the request DTO and on the SDK's `OpenSessionInput`, and the backend resolver reads it
(`summary.service.ts:367,606`) — but it is never sent, so `consultation.departmentId` is null for
every playground consultation and department scoping can never fire. Same for
`GenerateSummaryRequest.dnaStyleId`.

Send them. Add the pickers. Note `DepartmentAgent.dnaStylePolicy` is only `INHERIT|DISABLED` (a
gate, not a selector) — if selecting a specific DNA style needs a schema change, request it from 790.

**This also activates TASK-789's C-1 fix**: `ConsultationWorkflowDispatchService` resolves the
assignment cascade using `departmentId`. Without W2, the department tier can never be consulted.

### W3 — No way to test a workflow (R2)
Workflow Studio's toolbar has only Undo/Redo/Validate/Publish (`studio-toolbar.tsx:62-91`), and
`workflow-runs/api/client.ts` has no POST that starts a run. A sandbox plane DOES exist
(`admin/workflow-definitions/:id/sandbox-runs`) — surface it in Studio so a tenant admin can
actually test the graph they authored. `WorkflowTestFixture` rows are the saved-input mechanism.

### W4 — Surface the R3 capabilities 791 is building
Realtime short summaries, intelligent suggestions, and spelling/medical-term/drug-name corrections
need clinician-facing surfaces. **Coordinate via the orchestrator** — do not invent an event shape;
791 owns the emitting side. Write your expected contract into `## Requested contracts` below and
build against what is brokered. A correction must be *proposed* and clinician-accepted, never
silently applied.

### W5 — Cleanups found in passing
- **M-6**: `DocumentationReviewPanel` is dead code — no route, no importer outside its own test. It
  duplicates half of `CaseNoteColumn`. Delete it or route it; do not leave it.
- **M-7**: the whole async summary path (`generateSummaryAsync`, `getConsultationJob`,
  `cancelConsultationJob`, `consultationJobStreamPath`, and 91 lines of merge logic in
  `useSummaryJobProgress`) has zero call sites. Use it or delete it — decide and say why.
- **M-5**: two parallel client-side SSE stacks solve the identical ticket-mint → EventSource →
  reconnect problem — the SDK's `SSEClient` and the console's `use-event-stream.ts`. Converge them.

## Non-negotiables
- WCAG 2.2 AA, both themes, axe 0 violations per screen (`11-ux-ui-principles.md` §11).
- `@arcaai/ui` + semantic tokens only. Never hardcode colors. `<Skeleton />` for loading.
- Verify in a RUNNING app — the `next-dev-loop` skill is the preferred runtime verification.
  Compiling is not working.
- The console is dynamic-by-default: do NOT enable Cache Components.
- Another session has been active in `apps/admin-console` — rebase before you finish.

## Requested contracts
Record the event/response shapes you need from 791/790 here.

## Change History
| Date | Change |
|---|---|
| 2026-08-22 | Ticket created from TASK-789 findings. |
