# TASK-790 — Workflow Gateway, Contract & Persistence Completion

| | |
|---|---|
| **Status** | Pending |
| **Type** | `feature` / `bugfix` |
| **Parent** | TASK-789 (see `seam-findings.md`, `requirements-traceability.md`, `OWNERSHIP-MAP.md`) |
| **Branch** | `feat/task-790-workflow-gateway` off `dev-2.2` |
| **Owns** | `apps/api/src/modules/**` (except `harness-admin/**`), `packages/applications/src/services/workflow-*/**`, `.../consultation/{harness,workflow-dispatch}/**`, `packages/database/**`, `packages/domains/**`, `packages/workflow-contract/**` (except the three registry/rule files 791 owns) |

## Context

TASK-789 found the platform runs two agentic-loop substrates. TASK-789 itself already landed the
two prerequisites: **C-9** (added `AgentStepType.NODE` so interpreter traces are no longer silently
dropped) and **C-1** (`ConsultationWorkflowDispatchService` — the first production caller of the
`WorkflowAssignment` cascade, and the only thing that stamps `trigger: 'consultation open'`).

Your job is to finish the gateway/persistence side so a tenant-authored workflow is safe, valid and
observable end to end.

## Work items

### W1 — Harden the exposure plane before its kill-switch can be flipped (C-8) — HIGHEST PRIORITY
`POST /workflows/:slug/invoke` forwards caller-controlled `dto.input` verbatim into
`InterpreterInput.payload` with `sandbox: false`. The interpreter's `external_write` suppression
(`interpreter/workflow.py:228`) fires **only** when `sandbox` is true, so consultation-palette nodes
reached this way call the same `persist_draft` activity `HarnessDocWorkflow` uses — writing real
`ContextItem` rows. The route carries no `@ForbidApiKey` (API-key reachable by design), and
Workflow Studio's `paletteKey` is a free-text input.

Required:
- A published `consultation`-palette definition must NOT be invocable through the public exposure
  plane. Decide and implement the boundary (palette allow-list on the exposure route is the
  expected shape), with tests proving a consultation graph is refused and an approved palette is not.
- Validate `paletteKey` server-side on create/update against the known palette set — a typo must
  not silently produce an orphaned, never-assignable definition (C-5/D-5).
- Do NOT flip `WORKFLOW_EXPOSURE_ENABLED`. It stays `false`; you are removing the reason it must.

### W2 — Registry-drift detection actually fires (H-2)
`node-registry.ts:558-563` documents that a definition's stamped `registryChecksum` is compared at
read time to trigger `NEEDS_REVIEW`. `needsReview` is **never assigned `true` anywhere**. The
seeded SYSTEM row's checksum (`2ae7222a…`, over 7 entries) is already stale against the current
registry (30 entries).

Implement the comparison and set `needsReview` on read; surface it on the definition response DTO.
Test: a definition stamped with an old checksum comes back `needsReview: true`.

### W3 — `WorkflowInvariantRule` has no HTTP surface (H-1)
Zero controllers reference it, so a tenant admin cannot write a row, and `WorkflowValidatorService`
(169 lines, tested) is imported nowhere. Either:
(a) expose tenant-scoped CRUD and wire `WorkflowValidatorService` into
    `WorkflowDefinitionService.validateGraph()` so tenant strictness rules actually merge; or
(b) if the owner decision is that this capability is not wanted, DELETE the service, the model and
    the migration rather than leaving built-but-unreachable code.
Recommend (a) — the schema header documents the intent. State your choice in the README with reasoning.

### W4 — Wire the STT pipeline resolver (H-5, partial)
`SttPipelineResolverService` is exported for a consumer its own module comment calls "a FUTURE,
separate wiring pass" and is injected nowhere. Wire `resolvePipelineId` into the session/
consultation-open flow so an `stt`-palette assignment resolves to a `pipelineId` — completing the
lane TASK-789 confirmed is otherwise live (publishing already writes a real `AsrPipeline`).

### W5 — Mapper convention violation (M-4)
`ContextItemEntityMapper` lacks `FIELDS_NOT_WRITABLE = ['version']` that rule 03 mandates for
OCC-written models (sibling `SummaryMetaEntityMapper:18` has it). Not currently exploitable —
`Repository.updateWithVersion` strips `version` defensively — but fix the convention violation.

### W6 — Seed drift (from `seed-spec.md`)
The seeded `compiledConfig` carries `caps.maxNodeSeconds: 900` and `compilerVersion:
'task-720-seed-1'` while the service stamps `600` and `'0.1.0'` — a republish would drift. Also the
`E0000000-…` ID block was handed out twice (service accounts and consent grants share a value).
Regenerate the seed blobs from the REAL `compile()`/`validate()` — never hand-type them.

## Requested contracts
Record here any endpoint another ticket needs from you, with its exact shape.

## Change History
| Date | Change |
|---|---|
| 2026-08-22 | Ticket created from TASK-789 findings. |
