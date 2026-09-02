# TASK-790 — Workflow Gateway, Contract & Persistence Completion

| | |
|---|---|
| **Status** | Review |
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

## Implementation Summary

| Item | Status | What landed |
|---|---|---|
| **W1** exposure-plane hardening (C-8) | **DONE** | Palette boundary over COMPILED NODE TYPES + `paletteKey` validated on create |
| **W2** registry-drift detection (H-2) | **DONE** | Read-time checksum comparison sets `needsReview`; `currentRegistryChecksum` added to the DTO |
| **W3** `WorkflowInvariantRule` surface (H-1) | **DONE** | Option (a): validator wired into `validateGraph()` + tenant-scoped CRUD |
| **W4** STT pipeline resolver (H-5) | **DONE** | First production injector, at consultation open |
| **W5** mapper convention (M-4) | **DONE** | `FIELDS_NOT_WRITABLE` on `ContextItemEntityMapper` |
| **W6** seed drift | **PARTIAL** | E0 UUID collision fixed; `compiledConfig` regeneration blocked on TASK-791 (see below) |
| **M-2** `WorkflowRun.resultRef` (791's request) | **PARTIAL** | Column + migration + read-back landed; the PRODUCING half is 791's |

### W1 — the finding was sharper than the ticket described

The ticket expected "a palette allow-list on the exposure route", keyed on the definition's
declared `paletteKey`. **That would not have been a boundary.** Verified against the real engine,
not assumed: nothing in `validate()`/`compile()` requires a graph's nodes to belong to its declared
palette — `validate.ts`'s per-rule loop only SKIPS rules from other palettes
(`if (rule.paletteKey !== null && rule.paletteKey !== ctx.paletteKey) continue`), it never asserts
membership. A graph declaring `paletteKey: 'summarization'` while carrying
`consultation.persistDraft` validates shape-clean and compiles successfully.

So the gate resolves the palette of every NODE TYPE the definition carries, from **two** sources —
the authored `graph` and the `compiledConfig`. Reading the graph is what closes the
`config.gateType` override, which can otherwise hide a gate node's real type in
`compiledConfig.gates` (`compiler.ts`: `typeof config.gateType === 'string' ? config.gateType : node.type`).

Allow-list is `summarization` only. `consultation` is finding C-8 itself. `stt` is refused for a
different reason: every `stt` interpreter node is an explicit registry-parity PLACEHOLDER returning
`DEGRADED` (`interpreter/nodes/stt_placeholder.py`), so exposing it would promise transcription and
deliver nothing. Refusal is 404 (matching the kill-switch and unpublished-slug posture); the reason
goes to a sys-event, never to the caller. `list()` filters with the same predicate.

`WORKFLOW_EXPOSURE_ENABLED` is untouched and remains `false`.

### W3 — chose option (a), and why

The schema header documents the capability in detail, the merge logic is real and tested, and the
model is already in `SYSTEM_SHARED_READ_MODELS`. Deleting it would discard a designed, working
boundary rather than an unwanted one.

Ownership is enforced imperatively with `AUTH-NOTE` markers because it cannot be declarative:
another tenant's row is **404**, but a SYSTEM-owned row is **403** — a privilege boundary, not the
404-over-403 posture, because every tenant legitimately READS the platform register and hiding a row
the caller can see in `list()` would be incoherent.

No `@RequiredSvcScopes`: declaring one requires `SERVICE_ACCOUNT_SCOPE_REGISTRY` and a regenerated
`vox-node` admin area, neither owned by this ticket. Absent scopes deny BOTH machine credential
classes by default (rule 05), so the surface is JWT-only — the safe default, not an oversight.

### W6 — one half closed, one deliberately not

**Closed:** the `E0000000-…` block was handed out twice. `SEED_SERVICE_ACCOUNT_IDS.ARCAAI_ADMIN` is
`e0000000-…-000000000001` and `SEED_CONSENT_GRANT_IDS.PAT_001_TOOL_LOOKUP` was
`E0000000-…-000000000001`. PostgreSQL `uuid` is **case-insensitive**, so those were literally the
same UUID; no insert ever collided only because the rows live in different tables. 24 consent-grant
ids moved to the previously unallocated `F0` block.

**Not closed, on evidence:** regenerating `compiledConfig` now would make things worse.
`scripts/regen-workflow-definition-seed.ts` (new, committed) reproduces all four drifts the ticket
names, and shows two blockers:

1. `registryChecksum()` hashes the WHOLE registry, and TASK-791 has just added three consultation
   nodes. Any value computed in this worktree is knowably stale before it is committed — precisely
   how the current drift arose.
2. `validate()` against the full catalogue returns `ok: false` with `WF-S-002/003/004` findings
   ("expected exactly one node of type `core.start`, found 0"). That is the TASK-716 rule-design gap
   the seed's own docstring already discloses. Regenerating now would replace an honest, scoped
   report with a failing one. The fix lives in `rule-catalogue.ts`, which **TASK-791 owns**.

The durable fix shipped is REPRODUCIBILITY: the blobs were produced by a "throwaway script" that
could never be re-run, which is why they drifted silently. That script is now committed, imports the
built `workflow-contract` dist by relative path (no manifest/lockfile change, preserving the seed's
deliberate non-dependency), prints ready-to-paste literals plus a drift verdict, and never rewrites
the seed so a human reviews the change.

### M-2 — the column alone does NOT close the finding

Two deviations from 791's requested snippet, both verified against source:

1. **Shape.** `deliver.py` returns a DISCRIMINATED UNION — `{"resultRef": ClaimCheckRef}` only when
   claim-check is enabled AND `should_offload()` says the blob is big enough, otherwise
   `{"outputs": {...}}` INLINE. A pointer-only column would silently drop the inline branch, the
   common one for a short note. The column stores the node's `output` verbatim; the requested NAME
   is kept so both tickets code against one identifier.
2. **`@map("_resultRef")` dropped.** An underscore prefix is this schema's reserved marker for META
   fields (`_metadata`, `_version`). A business column wearing it would misfile itself permanently.

**Blocker for 791:** `NodeResult` and `InterpreterResult` are both `extra="forbid"` and carry NO
`output` field, so the deliver activity's `output` is returned to the workflow body and then
DROPPED. Nothing can populate this column until the harness propagates that output up to
`InterpreterResult` and reports it on the finish path.

## Files changed

**Schema / domain (sole schema owner)**
- `packages/database/src/prisma/db_main/workflow-run.prisma` — `resultRef Json? @db.JsonB`
- `packages/database/src/prisma/db_main/migrations/20260822233000_task_790_workflow_run_result_ref/migration.sql` — **NOT APPLIED**; orchestrator owns `db:*`
- `packages/domains/src/{entities,factories,models}/generated/core/WorkflowRun*.ts`
- `packages/domains/src/mappers/generated/core/ContextItemEntityMapper.ts` (W5)

**Seeds**
- `seed/00-constants.ts` (F0 block), `seed/01-policy.ts` (`manage:WorkflowInvariantRule` grant),
  `seed/21-workflow-definition.ts` (exported regeneration inputs)
- `packages/database/scripts/regen-workflow-definition-seed.ts` (new)

**Applications**
- `workflow-exposure/exposure-palette-policy.ts` (new) + service/mapper/dto
- `workflow-definition/` — `assertKnownPaletteKey`, validator wiring, drift-aware mapper
- `workflow-invariant-rule/**` (new service, DTOs, module)
- `workflow-run/` — `resultRef` plumbing
- `consultation/workflow-dispatch/` — STT lane

**API**
- `apps/api/src/modules/workflow-invariant-rule/**` (new)

## Requested contracts

**From TASK-791 — required to actually close M-2.** The `resultRef` column exists and the
run-status route reads it back, but nothing can populate it yet:
- `InterpreterResult` (and/or the finish-path report) must carry the `output.deliver` node's
  `output` object. Both `NodeResult` and `InterpreterResult` are `extra="forbid"` and have no
  `output` field today, so the value is dropped inside the workflow body.
- Whatever reports run completion should pass it as `RecordRunFinishedInput.resultRef`
  (`Record<string, unknown> | null`) — the node's `output` VERBATIM, either
  `{ resultRef: ClaimCheckRef }` or `{ outputs: {...} }`. Omitted means "delivered nothing" and
  leaves the column alone.

**From whoever owns `SERVICE_ACCOUNT_SCOPE_REGISTRY`** (not this ticket): if service accounts should
reach `/admin/workflow-invariant-rules`, declare `svc:admin:workflow-invariant-rule:manage` in the
registry, add it to `seed/94-service-account.ts` + its seed test map, add `@RequiredSvcScopes` to the
controller, and regenerate the `vox-node` admin area. Until then the surface is JWT-only by design.

**For the orchestrator, post-merge:** re-run
`pnpm --filter @arcaai/database exec tsx scripts/regen-workflow-definition-seed.ts` once TASK-791's
node registry and rule catalogue are final, and paste the emitted literals into
`seed/21-workflow-definition.ts`.

## Change History
| Date | Change |
|---|---|
| 2026-08-22 | Ticket created from TASK-789 findings. |
| 2026-08-22 | W1 landed. Exposure boundary implemented over COMPILED NODE TYPES, not the declared `paletteKey` — verified against the engine that a `summarization`-declared graph carrying `consultation.persistDraft` compiles clean, so the ticket's expected shape would not have been a boundary. `paletteKey` validated on create. |
| 2026-08-22 | W2 landed. Read-time `registryChecksum` comparison sets `needsReview`; `currentRegistryChecksum` added so a client can see WHAT drifted. |
| 2026-08-22 | W5 landed. `FIELDS_NOT_WRITABLE` on `ContextItemEntityMapper`; the RED test localised the leak to `toPersistence` (create), not `toPersistenceChanges`. |
| 2026-08-22 | W3 landed, option (a). Validator wired into `validateGraph()`; tenant-scoped CRUD at `/admin/workflow-invariant-rules` with imperative SYSTEM-row protection. |
| 2026-08-22 | M-2 landed (791's schema request), with two documented deviations. Column + migration + read-back only — the producing half is blocked on 791. |
| 2026-08-22 | W4 landed. `SttPipelineResolverService` gets its first production injector at consultation open; TASK-724's realtime grep-gate verified still green. |
| 2026-08-22 | W6 partial. E0/F0 UUID-block collision fixed; `compiledConfig` regeneration blocked on TASK-791's registry + rule catalogue, with a committed reproducible regeneration script in place of the original throwaway. |

## Evidence

Every work item was proven RED before implementation. Selected failures, verbatim:

**W1 — the exposure boundary (the C-8 chain, live before the fix).** The smuggled graph did not
merely fail an assertion; it STARTED A RUN with a caller-supplied `consultationId`:

```
FAIL  workflow-exposure.palette-boundary.test.ts > the boundary is over COMPILED NODE TYPES,
      not the declared paletteKey > refuses a summarization-declared graph carrying a
      consultation write node
AssertionError: promise resolved "{ …(4) }" instead of rejecting
+ { "runId": "01a02a15-cc3a-7910-b15b-086822453919", "status": "started", … }

 Tests  3 failed | 1 passed (4)
```

**W1b — `paletteKey` validation.** All five malformed keys created a row:

```
 Tests  5 failed | 4 passed (9)
```

**W2 — registry drift.** `Tests  2 failed | 3 passed (5)`
**W5 — mapper strip.** `AssertionError: expected { …(21) } not to have property "version"` / received `7`
**W3a — validator wiring.** `AssertionError: expected "vi.fn()" to be called with arguments: [ 'tenant-1', 'summarization', …(1) ]` — `Tests  3 failed | 1 passed (4)`
**W3b — the service did not exist.** `Error: Cannot find module '../workflow-invariant-rule.service'`
**W4 — STT lane.** `Tests  5 failed (5)`
**M-2 — `resultRef`.** `Tests  4 failed (4)`

### Gates (actual output)

```
$ pnpm --filter @arcaai/domains build          -> tsc, clean
$ pnpm --filter @arcaai/applications build     -> tsc, clean
$ pnpm --filter @arcaai/database build         -> tsc, clean
$ pnpm api:build                               -> Tasks: 12 successful, 12 total

$ (packages/applications) npx vitest run
   Test Files  546 passed | 1 skipped (547)
        Tests  9844 passed | 4 skipped (9848)

$ (packages/domains) npx vitest run
   Test Files  154 passed | 2 skipped (156)
        Tests  1847 passed | 2 skipped | 9 todo (1858)

$ (packages/database) npx vitest run
   Test Files  62 passed (62)
        Tests  1586 passed (1586)

$ (apps/api) npx vitest run
   Test Files  258 passed | 2 skipped (260)
        Tests  3996 passed | 4 skipped (4000)

$ pnpm --filter @arcaai/api lint
   ✖ 64 problems (0 errors, 64 warnings)      # 0 from this ticket's files (verified per-file)
$ pnpm --filter @arcaai/applications lint
   ✖ 181 problems (0 errors, 181 warnings)    # was 192; the 11 introduced here were fixed
$ pnpm --filter @arcaai/domains lint
   ✖ 13 problems (0 errors, 13 warnings)      # 0 from this ticket's files

$ pnpm gen:check
   [Generate Data Model]  check: no drift — 174 generated file(s) match the committed files.
   [Generate Data Entity] check: no drift — 101 generated file(s) match the committed files.
   [Generate Data Entity] Schema coverage OK: 99 entity artifact(s) cover every persisted column
                          of 103 Prisma model(s)
   [generate-factory]     check: no drift — 101 generated file(s) match the committed files.
   [generate-factory]     Schema coverage OK: 99 factory artifact(s) …

$ pnpm api:route-manifest
   [emit-route-manifest] wrote 673 routes (425 admin, 402 machine-reachable)

$ npx vitest run task-724-stt-realtime-untouched.grep-gate.test.ts
   Test Files  1 passed (1)                   # W4 stayed off the realtime hot path
```

### Boundary note

Four files were touched outside the literal ownership boundary. All are purely additive, single
blocks, and all are the unavoidable REGISTRATION of code this ticket does own — reverting them
would leave W3(b) built-but-unreachable, which is the H-1 defect itself:

| File | Addition |
|---|---|
| `apps/api/src/app.module.ts` | 2 lines — import + register `WorkflowInvariantRuleModule` |
| `apps/api/src/openapi/tags.ts` | 1 tag entry — an undeclared tag FAILS `tags.test.ts` |
| `packages/applications/src/services/index.ts` | 1 barrel export for the new owned folder |
| `apps/api/route-manifest.json` | regenerated per rule 05 DoD |

Reported to the orchestrator; revert if preferred.
