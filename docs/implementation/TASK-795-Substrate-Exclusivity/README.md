# TASK-795 — Substrate exclusivity, finishing R7, and the realtime delivery plane

| | |
|---|---|
| **Status** | Completed |
| **Type** | bugfix (W1, W2) + feature (RC-1, RC-2) |
| **Branch** | `feat/task-795-substrate-exclusivity` (from `dev-2.2` @ `cbd21e14b`) |
| **Worktree** | `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-task-795` — NOT merged, NOT removed |
| **Blocks** | TASK-798 (its `WorkflowAssignment` seed is gated on W1) |
| **Unblocks** | TASK-796 (interpreter output had nowhere to go), TASK-797 (clinician surfaces) |

## Requirement Analysis

Four work items, in priority order.

**W1 — substrate exclusivity (P0).** Two agentic-loop engines can govern one consultation:

- **Substrate A** — `ConsultationLoopWorkflow` + `HarnessDocWorkflow`, signal-with-started lazily by
  `LoopContextSignalService.handleContextAdded`.
- **Substrate B** — the `WorkflowInterpreter` running a tenant-authored `consultation`-palette graph,
  dispatched at consultation open by `ConsultationWorkflowDispatchService`.

Dispatch was conditional (no assignment ⇒ `dispatched: false`) but **not exclusive**: nothing gated
Substrate A on the dispatch result. Substrate B's `consultation.persistDraft` node calls the SAME
`persist_draft` activity `HarnessDocWorkflow` uses, so with an assignment present both engines run and
both write one `ContextItem` — two uncoordinated writers on one clinical document. Latent only because
zero assignment rows exist; TASK-798 is creating the first one.

**W2 — finish R7.** `PromptAssemblyService` injects `IGateEditExemplarRetriever` with `@Optional()`.
TASK-792 wired two of the four modules that provide it for live generation; two were left unwired and
silently generating zero-shot.

**W3 — guard the regression.** A four-line manual checklist in a comment is what let two of four slip.

**RC-1 / RC-2 — the realtime delivery plane** (boundary extension, mid-ticket). TASK-796 found the
harness cannot write clinical summary text to the gateway at all: of the 18 `/internal/harness/*`
routes none accepts summary text, and the only text-accepting write (`.../draft`) creates a
`RAW_SUMMARY` ContextItem — the FINAL note, and exactly the row W1's gate governs.

## Current State Evaluation (verified against source, not comments)

| Claim | Verdict |
|---|---|
| `LoopContextSignalService.loopAllowedFor` is the existing predicate hook | **True** — `loop-context-signal.service.ts` |
| `ConsultationWorkflowDispatchService` stamps `trigger: 'consultation open'` | **True**, and it is the only site that does |
| Its interface doc claims dispatch is "opt-in and exclusive" | **Half true** — opt-in was implemented, exclusive was not. Corrected. |
| The decision could be recomputed from a `WorkflowRun` row | **FALSE.** `WorkflowRun` has NO consultation linkage — neither `workflow-run.prisma` nor `RecordRunStartedInput` carries a `consultationId`. There is no key to join on. |
| Dispatch fires on every consultation open | **Not quite** — only the CREATE branch of `getOrCreate`. `createRevisit` never dispatches (pre-existing; noted, not changed). |
| Two modules are unwired for R7 | **True** — independently rediscovered by the new W3 guard, which named exactly `HarnessInternalServiceModule` and `ConsultationJobServiceModule`. |
| "TASK-793 made the async JOB path the primary Generate route" | **Conclusion right, module wrong.** The console's only Generate mutation is `useGenerateSummaryAsync` → `POST :id/summary/async`, which resolves the note-generation seam to the **HARNESS** generator (the legacy branch now throws 503) and returns through `HarnessInternalService.assemble`. So the primary path was unwired — via `HarnessInternalServiceModule`, not the jobs module. Both are now wired. |
| Harness contract: "a `null` for an unset optional would 400 the whole publish" | **FALSE.** `class-validator`'s `@IsOptional()` skips `null` as well as `undefined`. `forbidNonWhitelisted` is the rule that bites, and it bites on undeclared KEYS. Pruning is still worth keeping, but it is belt-and-braces. |
| `pnpm api:openapi:check` was green on `dev-2.2` | **FALSE.** Already failing at `cbd21e14b` — see §Pre-existing failures. |

## Exclusivity design

### Where the decision lives

A **durable, namespaced marker inside `Consultation.metadata`** (`packages/applications/src/services/consultation/governing-engine.ts`):

```json
{ "governingEngine": { "engine": "tenant-workflow", "workflowRunId": "...", "workflowDefinitionSlug": "...", "decidedAt": "..." } }
```

The brief offered two candidates. Only one is implementable:

1. *Query `WorkflowRun` for `trigger: 'consultation open'`* — **rejected, not possible.** That table
   carries no consultation linkage; adding one is a `packages/database` change this ticket does not own.
2. *A persisted marker* — **chosen.** `Consultation.metadata` is an existing `Json?` column
   ("Flexible metadata (scheduling info, external refs, etc.)") that nothing under
   `services/consultation/**` reads today. No migration, no cross-boundary request. The marker is
   merged into the existing object, never replacing it, so client-supplied metadata survives.

It satisfies the durability requirement directly: written once at open, before the consultation id has
even been returned to the client, so a later signal — in another process, after a restart — reads it
from the row.

### Which way it fails safe, and why that is the OPPOSITE of the gate next to it

**Fail-safe direction: towards Substrate A.** An indeterminate answer runs the default engine.

- **Read side.** Absent marker, missing row, unwired repository, and a THROWING read all mean
  "Substrate A governs". Only a well-formed, positively-read marker suppresses it.
- **Write side.** The marker lands only AFTER `startWorkflowRun` succeeds, so every earlier failure
  (no claim-check storage, wrong palette, harness down) leaves Substrate A in charge.

The justification is the clinical one: being wrong in the *suppress* direction leaves a consultation
with **no documentation at all**, which is worse than one documented by the default engine. Being wrong
in the *permit* direction gives one document two writers for a window — bad, but recoverable and
visible.

This is deliberately opposite to the entitlement gate immediately above it in the same method, which
fails **closed**. That gate protects a commercial capability, where the cost of being wrong is a
degraded loop on an otherwise unaffected consultation. Different stakes, different direction; both are
documented at the call site so neither reads as an accident.

### Residuals, stated rather than hidden

| Residual | Handling |
|---|---|
| Run started, marker write failed ⇒ both engines write | Reported as `governanceRecorded: false` on the dispatch result and logged at ERROR. The window is narrow: `recordRunStarted` is itself a DB write moments earlier on the same connection. |
| Substrate B genuinely running + marker read throws ⇒ both write for that window | Accepted, per the fail-safe argument above. |
| `metadata` is client-writable at open, so a forged marker could suppress Substrate A | Only for the caller's OWN consultation (it denies itself documentation; it cannot reach another tenant's rows). Requiring a non-empty `workflowRunId` raises the bar. The real fix is a first-class platform-owned column — filed as a requested contract. |

### Cost

`TRANSCRIPT` is on the `ContextAdded` bus, so `handleContextAdded` runs roughly per utterance. The gate
is resolved last (after the free platform veto and the per-tenant entitlement) and its **determinate**
answer is cached per consultation in a bounded map. Caching is sound because the decision is written
once, at open, before any signal can exist. Indeterminate answers are never cached — a DB blip must not
pin a consultation to the wrong engine for its lifetime.

## The realtime delivery plane (RC-1 / RC-2)

**RC-1 reuses the existing channel on purpose.** `POST /internal/harness/consultations/:id/live-summary`
publishes verbatim onto `consultation:live-summary:{id}`, so the existing SSE route,
`useArcaLiveSummary` and the existing console panel work unchanged — zero new consumer surface. It lives
on `LiveDocumentationService` because that class owns the channel and its snapshot key; a second class
deriving the same keys would diverge silently.

*Two publishers on one plane, stated.* When an interpreter graph governs a consultation, the
live-documentation flush loop may still run (it is started by `recording/start`, independently of the
substrate decision), so both can publish and the later write wins the snapshot. Acceptable for an
EPHEMERAL UX plane — nothing there is persisted per tick and the durable note is unaffected — but not
invisible: every payload now carries `source` (absent = flush loop, `'interpreter'` = graph), so a
consumer can always say which engine produced what it shows.

**RC-2 is a NEW channel on purpose.** `consultation:live-assist:{id}` is **declared PHI-carrying**: a
correction proposal quotes the span it would replace, verbatim. That makes it a sibling of
`live-summary` — `@TenantOwnedResource` 404s a cross-tenant probe before the stream opens, and it has
its OWN `consultation_live_assist` StreamScope so a live-summary ticket cannot be replayed to read
proposals. It is explicitly **not** a rider on the loop event plane, whose payload contract is
`extra="forbid"` and states it carries "ids/keys/labels only, NEVER note or transcript text".

Two-branch snapshot (suggestions + corrections): a refreshing clinician keeps both, and a publish
replaces only the branch it carries. Within a branch the newest publish replaces the previous, because
proposals are offsets into one specific text state (`textSha256`) — merging two generations would offer
offsets into text that no longer exists.

No stream-ticket allow-list change was needed: `AuthController.assertConsultationScopeOwnership`
already ownership-checks "every OTHER `consultation_*` namespace (current or future)" fail-closed.

## Implementation Summary

### W1 — substrate exclusivity

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/governing-engine.ts` | NEW — marker constants, `tenantWorkflowGoverns()`, `withGoverningEngineMarker()`, and the design rationale |
| `.../consultation/loop/loop-context-signal.service.ts` | `standDownForTenantWorkflow()` added to `loopAllowedFor`; `ConsultationRepository` injected; bounded per-consultation cache of the determinate answer |
| `.../consultation/workflow-dispatch/consultation-workflow-dispatch.service.ts` | `recordGovernance()` after a successful `startWorkflowRun`; `ConsultationRepository` injected |
| `.../workflow-dispatch/IConsultationWorkflowDispatchService.ts` | `governanceRecorded: boolean` added; the false "opt-in and exclusive" claim corrected |
| `.../consultation/index.ts` | barrel export |

### W2 / W3 — R7

| File | Change |
|---|---|
| `.../consultation/jobs/consultation-job.service.module.ts` | imports `GateEditMiningServiceModule` |
| `.../consultation/harness/harness-internal.service.module.ts` | imports `GateEditMiningServiceModule` |
| `.../gate-edit-mining/__tests__/module-graph.helper.ts` | NEW — accurate NestJS token-reachability walker |
| `.../gate-edit-mining/__tests__/gate-edit-mining.di-wiring.test.ts` | the TASK-792 pinned-gap assertion closed; all four modules now in the wired list |

### RC-1 / RC-2

| File | Change |
|---|---|
| `.../consultation/harness/dto/realtime-delivery.dto.ts` | NEW — both request DTOs, `LiveAssistEventDto`, ack |
| `.../consultation/harness/harness-live-assist.service{,.module}.ts` | NEW — publish + SSE source for `consultation:live-assist:{id}` |
| `.../consultation/live-documentation/live-documentation.service.ts` | `publishInterpreterSummary()` |
| `.../consultation/live-documentation/dto/live-summary.dto.ts` | additive optional `source` / `nodeType` / `ordinal` / `total` |
| `apps/api/src/modules/consultation/harness-internal.controller.ts` | the two internal POST routes (HTTP 200 best-effort ack) |
| `apps/api/src/modules/consultation/consultation.controller.ts` | `GET :id/live-assist/stream` |
| `apps/api/src/modules/consultation/consultation.module.ts` | imports `HarnessLiveAssistServiceModule` |
| `apps/api/route-manifest.json`, `apps/api/openapi.json`, `apps/admin-console/src/server/api-docs/*` | regenerated together |

### Tests added (85 assertions across 10 suites, all RED first)

`substrate-exclusivity.test.ts` · `substrate-exclusivity.di-wiring.test.ts` ·
`substrate-exclusivity.dispatch.test.ts` · `prompt-assembly.retriever-reachability.test.ts` ·
`r7-four-generation-paths.test.ts` · `realtime-delivery-contract.test.ts` ·
`live-assist.service.test.ts` · `interpreter-live-summary.test.ts` ·
`realtime-delivery.routes.test.ts` (+ the updated `gate-edit-mining.di-wiring.test.ts`).

## Evidence

### W1 — RED

```
 × ... > the gate itself > SUPPRESSES the Substrate A signal when the consultation carries the tenant-workflow marker
 ✓ ... > the gate itself > SIGNALS as before when no marker is present — the overwhelming-majority path is unchanged
 × ... > the gate itself > suppresses the consultation-ending signal too when Substrate B governs
 × ... > the gate itself > suppresses the loop-cancel signal too when Substrate B governs
 ✓ ... > fail SAFE > SIGNALS when the marker read THROWS
 ✓ ... > fail SAFE > SIGNALS when the consultation row cannot be found
 ✓ ... > fail SAFE > SIGNALS when no consultation repository is wired at all
 × ... > durability and cost > reads the DURABLE marker from the consultation row, by consultation id
 × ... > durability and cost > re-recognises a governed consultation on a LATER signal in a FRESH process
 × ... > durability and cost > does not re-read the row for every context item of the same consultation
 × ... > durability and cost > never caches an INDETERMINATE answer — a failed read is retried on the next signal
 × ... > durability and cost > decides per consultation, never leaking one consultation decision onto another
 Test Files  1 failed (1)
      Tests  8 failed | 5 passed (13)
```

Write side, RED:

```
AssertionError: expected false to be true // Object.is equality
TypeError: Cannot read properties of undefined (reading 'workflowRunId')
AssertionError: expected [] to deeply equal [ 'startWorkflowRun', 'update' ]
 Test Files  1 failed (1)
      Tests  6 failed | 4 passed (10)
```

DI guard, proven to bite (mutation: `CoreDatabaseModule` removed from `LiveDocumentationServiceModule`):

```
--- MUTATION: CoreDatabaseModule removed from LiveDocumentationServiceModule ---
 × ... > read half > LiveDocumentationServiceModule imports CoreDatabaseModule, so the repository resolves
      Tests  1 failed | 4 passed (5)
```

### W2 / W3 — RED

The guard discovered the two unwired modules by itself, from the filesystem:

```
 ✓ ... > discovers the providers rather than trusting a hand-maintained list
 × ... > resolves IGateEditExemplarRetriever in EVERY module that provides PromptAssemblyService
AssertionError: these modules provide PromptAssemblyService but cannot resolve
IGateEditExemplarRetriever, so they silently generate zero-shot:
HarnessInternalServiceModule, ConsultationJobServiceModule: expected [ Array(2) ] to deeply equal []
```

The TASK-792 pinned-gap assertion failed loudly on close, exactly as it was written to:

```
 × ... > ConsultationJobServiceModule does NOT yet import GateEditMiningServiceModule (cross-boundary, pending)
 × ... > HarnessInternalServiceModule does NOT yet import GateEditMiningServiceModule (cross-boundary, pending)
      Tests  2 failed | 59 passed (61)
```

Proven to bite (mutation: the new import removed from `ConsultationJobServiceModule`):

```
 → these modules provide PromptAssemblyService but cannot resolve IGateEditExemplarRetriever ... ConsultationJobServiceModule
 → ConsultationJobServiceModule does not resolve IGateEditExemplarRetriever at all: expected undefined to be defined
      Tests  2 failed | 5 passed (7)
```

### RC-1 / RC-2 — RED

```
 × ... > RC-1 — HarnessLiveSummaryRequest > rejects a body carrying an undeclared key
 × ... > RC-1 > rejects a section missing its content
 × ... > RC-1 > requires the tenant — an unattributable clinical publish is a defect in the caller
 × ... > RC-2 — HarnessLiveAssistRequest > rejects a kind outside the two the interpreter emits
 × ... > RC-2 > rejects an undeclared key inside a correction proposal
      Tests  7 failed | 5 passed (12)

Error: Cannot find module '../harness-live-assist.service'
      Tests  8 failed (8)

apps/api routes:  Tests  10 failed (10)
```

### GREEN — final gates

```
$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc
(no output — success)

$ pnpm --filter @arcaai/applications test
 Test Files  560 passed | 1 skipped (561)
      Tests  9952 passed | 4 skipped (9956)

$ pnpm --filter @arcaai/applications lint
✖ 181 problems (0 errors, 181 warnings)      <- byte-identical to the pre-ticket baseline

$ pnpm --filter @arcaai/api test
 Test Files  259 passed | 2 skipped (261)
      Tests  4009 passed | 4 skipped (4013)

$ pnpm --filter @arcaai/api lint
✖ 64 problems (0 errors, 64 warnings)        <- none in changed files

$ pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal
[emit-route-manifest] wrote 678 routes (427 admin, 404 machine-reachable)
[emit-openapi] wrote 467 paths
[gen-api-portal] wrote 606 operations ... 179 operations

$ pnpm api:portal:check
[gen-api-portal] no drift (admin 606 ops, business 179 ops)

$ (the 10 new suites)
 Test Files  10 passed (10)
      Tests  85 passed (85)
```

The lint baseline was measured, not assumed: `git checkout HEAD~3 -- packages/applications` reproduces
181/0 errors, and the only delta this ticket ever introduced (one Prettier wrap) was fixed.

## Pre-existing failures found, NOT caused by this ticket

**`pnpm api:openapi:check` was already failing on `dev-2.2` @ `cbd21e14b`.** Measured by restoring the
committed artifacts and running the gate:

```
  manifest routes       673
  spec operations       598
[openapi-coverage] FAILED
5 route(s) are served but carry no OpenAPI metadata:
  GET /api/v1/admin/workflow-invariant-rules      (WorkflowInvariantRuleController.fetchAll)
  POST /api/v1/admin/workflow-invariant-rules     (WorkflowInvariantRuleController.create)
  DELETE /api/v1/admin/workflow-invariant-rules/{id}
  GET /api/v1/admin/workflow-invariant-rules/{id}
  PATCH /api/v1/admin/workflow-invariant-rules/{id}
```

Both generated artifacts were also stale: `route-manifest.json` was missing two `harness-admin`
gate-edit-exemplar routes, and `openapi.json` was missing seven operations.

Regenerating (required by the API definition of done) surfaced those routes, which moves the quality
ratchet by exactly **+2 missing descriptions and +1 missing 4xx**, and all three are attributable to
them:

```
missing description (+2): DELETE /api/v1/admin/workflow-invariant-rules/{id}
                          GET    /api/v1/admin/workflow-invariant-rules/{id}
missing 4xx         (+1): GET    /api/v1/admin/workflow-invariant-rules

this ticket's own route:  GET /api/v1/consultations/{id}/live-assist/stream | desc: True | 4xx: ['404']
```

Fixing them needs `apps/api/src/modules/.../workflow-invariant-rule*` and/or
`scripts/check-openapi-coverage.ts`, both outside this ticket's boundary. Filed as a requested contract
rather than reached across.

## Requested contracts (out of boundary)

1. **`packages/database`** — a first-class, platform-owned `governingEngine` column on `Consultation`,
   replacing the `metadata` marker. Closes the forged-marker gap and makes the decision queryable.
2. **`packages/applications/src/services/workflow-run/**` + `packages/database`** — a `consultationId`
   on `WorkflowRun` / `RecordRunStartedInput`. Today an interpreter run cannot be traced back to its
   consultation at all, which is why option 1 in §Exclusivity design was impossible.
3. **`apps/api` (workflow-invariant-rules) or `scripts/check-openapi-coverage.ts`** — document or
   `@ApiExcludeEndpoint()` the five `WorkflowInvariantRuleController` routes, then re-ratchet. Until
   then `pnpm api:openapi:check` stays red (as it already was).
4. **`apps/harness`** — the contract note in `test_live_delivery_client.py` justifying `_prune` with
   "a `null` … would 400 the whole publish" is incorrect; `@IsOptional()` accepts null. Worth
   correcting so the next reader does not build on it.

## Change History

| Date | Change |
|---|---|
| 2026-08-23 | W1 — substrate exclusivity (marker + gate + dispatch record). Commit `4425bf9` |
| 2026-08-23 | W2 + W3 — R7 finished on all four generation paths; discovered-not-listed regression guard. Commit `1c48d51` |
| 2026-08-23 | RC-1 + RC-2 — realtime delivery plane (live-summary publish, live-assist channel + SSE). Commit `e41f582` |
