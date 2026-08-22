# TASK-789 — Requirements Traceability

The owner's seven claims, each with a verdict backed by evidence the orchestrator re-verified
against the working tree.

Verdicts: **IMPLEMENTED** · **PARTIAL** · **ABSENT** · **CONTRADICTED** (built, but a live code
path defeats it).

---

## R1 — The harness agentic-loop workflow is defined by the tenant admin

**Verdict: PARTIAL** — revised after Stage 2 refutation. TRUE for the `stt` palette, CONTRADICTED
for the `consultation` palette.

**Where R1 holds (live today):** publishing an `stt`-palette graph compiles it into a real
`AsrPipeline` via the production `PipelineService` (`workflow-definition.service.ts:333` →
`stt-pipeline.compiler.ts:166-186`). That row appears unfiltered in `GET audio/pipelines` and is
selectable in the playground's Listener control. A tenant admin authoring an STT graph genuinely
changes how live consultations are transcribed. Gated only by the `paletteStt` entitlement, itself
a no-op while the entitlements kill-switch is off.

**Where R1 fails (the agentic loop proper):** for the `consultation` palette, the graph never
governs the loop.

Authoring is genuinely tenant-scoped and correct: `admin/workflow-definitions` carries
`@CanManage('WorkflowDefinition')` with `assertEqualTenants`, and no `isSuperAdmin` branch exists
anywhere in `workflow-definition.service.ts`. A tenant admin really can author and publish.

But the definition never reaches a consultation. `WorkflowAssignmentService.resolve()` — the
department → tenant → platform-default cascade — has no production caller (test-only). Only two
`WorkflowRun.trigger` values are ever stamped: `'workbench sandbox'` and `'api invoke'`.
`'consultation open'` exists solely in `@ApiProperty` description strings.

What actually governs a live consultation is `DepartmentAgent` plus a **fixed 7-key action
vocabulary** hardcoded in `temporal/models.py:1153` and mirrored in
`packages/applications/.../departmentAgent/constants.ts`. The tenant's control is which context
kinds trigger which of seven code-owned actions — not a graph.

---

## R2 — The tenant admin can manage, control and test the workflow using the playground

**Verdict: ABSENT.**

- Workflow Studio's toolbar exposes only Undo/Redo, Validate and Publish
  (`studio-toolbar.tsx:62-91`). No run, test, or dry-run control.
- `workflow-runs/api/client.ts` exposes `list` / `get` / `trace` / `gate` / `approve` — no POST
  that starts a run.
- The one real test control in the admin surface is `TestRunPanel`, and it tests a single
  `PromptTemplate` in isolation, never a graph.
- A sandbox plane does exist (`WorkflowSandboxRunService`, `admin/workflow-definitions/:id/sandbox-runs`)
  and the Workbench can reach it — but it is disjoint from the consultation playground, and it
  tests Substrate B, which is not what production runs.

---

## R3 — One workflow coordinates the full capability chain

**Verdict: PARTIAL, split across two engines, with the tail ABSENT.**

| Capability | Substrate B (authored, not live) | Substrate A (live) |
|---|---|---|
| record | `stt.audioInput`, `consultation.captureBinding` | `livedoc.start/stop` |
| transcribe | `stt.asrEngine`, `stt.transcriptOutput` | via live-doc session |
| realtime entity extraction | `consultation.extractEntities` | `nlp.extract_entities` |
| realtime short summaries | — | — (`client.emit` only announces an action ran; `harness.finalize` is lifecycle-end) |
| autofill SOAP | `consultation.assemblePrompt` + `synthesize` + `persistDraft` | `harness.finalize` → `HarnessDocWorkflow` |
| intelligent suggestions | — | — |
| spelling / medical-term / drug-name correction | — | — |

The last three rows have **no node, activity, or sensor anywhere**. The nearest neighbours only
*verify*: `consultation.bindTerminology` validates codes read-only; `sensors/computational/numeric_dose.py`
flags a dose mismatch and never corrects it.

The 30-node registry is real and in exact TS↔Python parity — the *vocabulary* for most of this
chain exists. It is the dispatch that is missing (R1), plus these three capabilities that were
never built.

---

## R4 — SOAP autofill scoped by department and DNA writing style

**Verdict: PARTIAL — backend real, input never supplied; DNA style is a toggle, not a selection.**

- **Department**: the resolver is correct and tenant-aware (`summary.service.ts:367,606` read
  `consultation.departmentId`). But `consultation-demo-screen.tsx:300` calls
  `sdkSession.open({ patientId })` — `departmentId` is never collected or sent, so
  `consultation.departmentId` is null for every playground consultation and the resolver can never
  fire. The field exists on both the request DTO and the SDK's `OpenSessionInput`.
- **DNA style**: `DepartmentAgent.dnaStylePolicy` is `'INHERIT' | 'DISABLED'` — a binary gate, never
  a picker for *which* style. `GenerateSummaryRequest.dnaStyleId` exists but is never populated by
  any call site. The footer's "Note assistant" control is decorative
  (`onNoteChange={() => undefined}`).
- The fallback chain is documented and real in the prompt layer: doctor-preferred → department
  default agent (visit-type aware) → department column → SYSTEM `CATCHALL_SOAP`.

---

## R5 — The clinician edits the SOAP while the system keeps transcribing and autofilling

**Verdict: CONTRADICTED — fully built backend, zero UI invocation.**

Built and working:
- `PATCH :id/summary/:summaryId` with mandatory `If-Match` (`consultation.controller.ts:1073-1109`)
- OCC via `updateWithVersion` (`context.service.ts:522`), `version` stripped defensively in
  `repository.ts:216-219`
- Append-only `ContextItemVersion` with `contentDiff` / `fieldChanges`
- `HarnessDocWorkflow` accepts an `edit` signal mid-assurance and re-runs assurance against the
  edited content (`workflows.py:331-355`) — a genuine concurrent-writer mechanism

Not invoked: the playground renders the note as `<article>` (`case-note-column.tsx:280`). Its only
`PATCH` is job-cancel. **There is no lost-update defect to characterise, because there is no write
path at all.**

---

## R6 — The clinician is the sole finalizer

**Verdict: IMPLEMENTED.** The strongest part of the system.

- Exactly one site transitions to SIGNED: `summary.service.ts:1184`, inside `approveSummary`.
- It throws without a request user id; the route carries ownership verification
  (doctor-owns-or-`manage Consultation`) plus `@RequiresIfMatch()` OCC.
- The harness's gate-decision callback appends a WORM audit row and explicitly cannot flip status —
  its own comment states apps/api has already written the SIGNED_NOTE + ATTEST as system-of-record.
- `POST admin/workflow-runs/:runId/gate/approve` carries an AUTH-NOTE with
  `@Authorize(['update','Consultation']) @ForbidServiceAccount()`, deliberately overriding the
  class-level read scope so listing runs never implies signing authority. The acting clinician is
  resolved server-side and cannot be named in the request.

---

## R7 — Edits captured as feedback alongside the original, for fine-tuning

**Verdict: PARTIAL — capture is real, the training loop is entirely dead code.**

**Capture works** (this is genuinely good): `ContextItemVersion` is append-only with a real
authorship discriminator (`changeReason` / `changeSource` / `changedBy`), an immutable
`ai_draft_v1` baseline, per-edit diffs, Vault-Transit encryption, and attestation fields.
`approveSummary` additionally diffs the AI baseline against the final signed content. **The
original is retained beside the edit.**

**Everything downstream is dead:**
1. `GateEditExemplar` has no live writer — `GateEditMiningQueue` is the only `@Processor` in
   `packages/applications` registered in no module, and `.enqueue()` has zero call sites.
2. The retrieval half is separately dead — no live-generation module imports
   `GateEditMiningServiceModule`, so `PromptAssemblyService`'s `@Optional()` retriever is always
   `undefined` and few-shot silently degrades to zero-shot.
3. `GoldenCase` has no automated producer; the golden set is self-declared synthetic and an
   "outstanding prerequisite".
4. **No fine-tuning export path exists** — nothing assembles `(original, edited, context)` triples
   into a dataset artifact.
5. `Fedl*` is schema plus RBAC seed rows only.

So the raw material for fine-tuning is being collected correctly and completely. Nothing consumes it.

---

## Summary

| | Verdict |
|---|---|
| R1 tenant-authored workflow | PARTIAL — TRUE for `stt` palette (live), CONTRADICTED for `consultation` palette |
| R2 test from playground | ABSENT |
| R3 coordinated capability chain | PARTIAL — split across two engines; suggestions/correction absent |
| R4 department + DNA scoping | PARTIAL — resolver real, input never supplied |
| R5 concurrent clinician edit | CONTRADICTED — backend complete, UI never calls it |
| R6 clinician sole finalizer | **IMPLEMENTED** |
| R7 feedback capture for training | PARTIAL — capture real, consumers all dead |

**The pattern:** this is not a system missing infrastructure. It is a system whose infrastructure
was built ahead of its wiring, in more than one place, by more than one ticket — and where two
independent implementations of "the agentic loop" grew in parallel without either being retired.

**Revision history:** two Stage-1 findings were struck after adversarial review. C-2 ("the real
invoke path is broken") was based on a **stale Python docstring** — `dto.input` is forwarded. And
R1's blanket CONTRADICTED verdict was too strong — the `stt` palette lane is live. Both errors had
the same cause: a code comment trusted over the code it describes. Every claim that survived was
re-verified against the tree directly.
