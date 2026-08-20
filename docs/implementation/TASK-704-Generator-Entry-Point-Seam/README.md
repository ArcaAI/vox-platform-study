# TASK-704 — Generator Entry-Point Seam

| | |
|---|---|
| **Status** | Review |
| **Wave** | 0 · **Size** | M |
| **Epic slug** | `generator-entry-point-seam` |
| **Depends on** | — |
| **Design refs** | D1 (staged generator migration — this is the "consolidate" phase), D4 (generic engine — this service is explicitly named as the future interpreter dispatcher) |
| **Findings closed** | — (structural prerequisite named directly in [04-target-architecture.md](../../architecture/consultation-session-workflow/assessment/04-target-architecture.md) §"The generator decision" → "Recommendation" step 1; it re-triages the routing weakness underlying conformance findings on `pipeline.harnessEnabled`, A-09, A-19, A-22) |

## 1. Requirement Analysis

`pipeline.harnessEnabled` is supposed to be a single switch that decides whether a consultation's
note is produced by the safeguarded `HarnessDocWorkflow` (sensors, groundedness, MCP terminology
check, WORM gate) or the legacy BullMQ `SummaryProcessor` (none of those). Today it is not a
switch for the platform — it is a switch for exactly one of the seven places note generation can
be triggered. Every other trigger runs the legacy generator unconditionally, regardless of what
the tenant's `harnessEnabled` policy says. A tenant that believes it is on the harness path (both
seeded real tenants, ArcaAI and the demo workspace, set `harnessEnabled=true`) still gets an
ungated legacy draft from six of the seven ways a note can be produced.

This ticket delivers **one seam** — `NoteGenerationService` — that every generation entry point
routes through, and makes `harnessEnabled` mean what the flag's own name and every operator's
mental model already assume. It does **not** change which generator wins for any tenant, does not
build new harness capabilities, and does not attempt the migration itself (that is Wave 2,
`harness-sole-generator`, per [design.md](../../programs/agentic-workflow-platform/design.md)
D1). It also fixes a **silent-drop defect** discovered independently of the routing gap: when the
harness path is selected but `HarnessGatewayService` is not wired (an `@Optional()` NestJS
dependency), the current code logs a success-shaped message and produces zero notes with no error
anywhere in the system.

Per [design.md](../../programs/agentic-workflow-platform/design.md) D4/§Plane 1,
`NoteGenerationService` is deliberately named to become the interpreter dispatcher once the
workflow substrate exists (Wave 2+). **Nothing about that future is built here.** This ticket adds
no node registry, no compiler, no interpreter hook — only the entry-point consolidation and the
single `harnessEnabled` read. Building any of the future shape now would be exactly the
speculative work `.claude/rules/_karpathy.md` §2 forbids.

**Out of scope:**
- Building a harness-side equivalent for pre-summary or comprehensive-summary generation (no such
  Temporal workflow exists today — see §2 below). The seam must be honest that these two trigger
  kinds fall back to legacy even on a harness-enabled tenant, and say so in a structured, tested
  way — not silently, and not by inventing new harness capability.
- The Wave-1 `legacy-safety-floor` epic (writing `SummaryMeta` + `assuranceCompletedAt` +
  groundedness on the legacy branch) — that is a named, separately-sized epic that depends on this
  one landing first.
- The session-state-machine work (`session-state-machine`, Wave 1) — this ticket does not touch
  `ConsultationStatus` transitions.

## 2. Current State Evaluation

### 2.1 The real entry-point count is seven, not three or four

Re-derived directly against `feat/loop` (excluding `.claude/worktrees/**`, `**/dist/**`,
`**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`). The design brief that seeded this
ticket named three unforked entry points (`generateSummaryAsync`, `SummaryService.generate`,
`ComprehensiveSummaryProcessor`); the actual count is **seven**, and only one reads
`harnessEnabled`:

| # | Entry point | File : line | Reads `harnessEnabled`? |
|---|---|---|---|
| 1 | `ConsultationEventHandler.handleTranscriptionCreated` (`@OnEvent(TranscriptionCreated)`) — auto-pipeline on transcript finalize | `packages/applications/src/services/consultation/events/consultation-event.handler.ts:93-258`, fork at `:146` | **YES — the only fork** |
| 2 | `ConsultationController.generateSummary` → `SummaryService.generateSummary` (sync) | `apps/api/src/modules/consultation/consultation.controller.ts:918-929` → `packages/applications/src/services/consultation/summary/summary.service.ts:402-581` | No |
| 3 | `ConsultationController.generatePreSummary` → `SummaryService.generatePreSummary` (sync) | `consultation.controller.ts:944-955` → `summary.service.ts:259-397` | No |
| 4 | `ConsultationController.generateSummaryAsync` (route `:1146`) → `ConsultationJobService.createSummaryJob` → BullMQ `GenerateSummary` queue → `SummaryProcessor.process` | `consultation.controller.ts:1138-1173` → `packages/applications/src/services/consultation/jobs/consultation-job.service.ts:161-219` → `.../jobs/processors/summary.processor.ts:62-270` | No |
| 5 | `ConsultationController.generatePreSummaryAsync` (route `:1183`) → `ConsultationJobService.createPreSummaryJob` → BullMQ → `PreSummaryProcessor.process` | `consultation.controller.ts:1175-1200` → `consultation-job.service.ts:97-`(`createPreSummaryJob`) → `.../jobs/processors/pre-summary.processor.ts:21` | No |
| 6 | `ConsultationController.generateComprehensiveSummary` (sync) → `ChainSummaryService.generateComprehensiveSummary` | `consultation.controller.ts:1217-1230` → `.../summary/chain-summary.service.ts:103` | No |
| 7 | `ConsultationController.generateComprehensiveSummaryAsync` → BullMQ `GenerateComprehensiveSummary` queue → `ComprehensiveSummaryProcessor.process` | `consultation.controller.ts:1250-` → `.../jobs/processors/comprehensive-summary.processor.ts:49-286` | No |

Confirmed by direct grep of each processor/service file: zero occurrences of `harnessEnabled` in
`pre-summary.processor.ts`, `summary.processor.ts`, `comprehensive-summary.processor.ts`,
`summary.service.ts`, or `chain-summary.service.ts`. Entry point #5
(`generatePreSummaryAsync`/`PreSummaryProcessor`) was not named in any prior assessment pass and
is confirmed here as a genuine seventh path.

### 2.2 `harnessEnabled` resolution today

- **Cascade + code default**: `ConfigResolver.resolvePipelineToggles`
  (`packages/applications/src/services/config-resolver/config-resolver.service.ts`), doctor →
  department → tenant → SYSTEM-tenant default → code default (comment at `:8-16`).
  `harnessEnabled` is clamped to `maxScope: PipelinePolicyScope.DEPARTMENT` (never per-doctor)
  with `codeDefault: false` (`config-resolver.service.ts:80`).
- **Registry descriptor**: `packages/applications/src/services/settings-registry/descriptors/pipeline.descriptors.ts:41-45`
  — `globalOnly: true`; `failMode: 'open-to-default'` applied uniformly to all `PIPELINE_SETTINGS`
  (`:63`) — a tuning-knob posture, not fail-closed selection.
- **The one fork/read site**: `consultation-event.handler.ts:146` — `if (config.harnessEnabled) {`
  — fed by `ConsultationEventHandler.resolvePipelineConfig` (`:461-515`), which merges a
  per-consultation `metadata.pipelineConfig` override (highest priority, `:471-472`) over the
  `ConfigResolver` cascade (`:479-486`, with `harnessEnabled` surfaced only when defined so a
  legacy config without a resolver never sees a synthesized value, `:495-500`). This method is the
  **actual single source of truth for the decision today** — it just isn't reachable from anywhere
  except this one handler.

### 2.3 The silent-drop defect — confirmed exactly as flagged

`consultation-event.handler.ts:63` declares the dependency optional:

```ts
@Optional() @Inject(HarnessGatewayService) private readonly harnessGatewayService?: HarnessGatewayService,
```

`:172-181` calls it with optional chaining:

```ts
await this.harnessGatewayService?.start(consultationId, { ... });
```

If the dependency is absent, this evaluates to `undefined` — no throw, no rejected promise. The
very next statement (`:183-189`) logs unconditionally, regardless of whether `.start()` actually
ran:

```ts
this.logger.log({
  message: 'Harness document workflow start requested',
  consultationId,
  harnessJobId,
  contextItemId,
  correlationId,
});
return;
```

Net effect: a harness-enabled tenant, with the gateway dependency missing (a plausible
misconfiguration in any environment that doesn't wire `HarnessGatewayServiceModule`), gets a
success-shaped log line and zero notes — no BullMQ fallback, no error surfaced anywhere. No
existing test exercises `harnessEnabled=true` with `harnessGatewayService` undefined
simultaneously (`consultation-event.handler.test.ts` covers "gateway called when both true" and
"legacy path when harnessEnabled absent" as separate cases, never the missing-dependency case).

### 2.4 The assurance-guard vacuum this compounds

`summary.service.ts:866-867`, inside `approveSummary`:

```ts
const draftMeta = await this.summaryMetaRepository.findByContextItem(contextItemId);
const signedBeforeAssurance = !!draftMeta && !draftMeta.assuranceCompletedAt;
```

A draft produced by any of the six unforked legacy entry points has no `SummaryMeta` row at all
(`draftMeta` is `null`), so `signedBeforeAssurance` evaluates `false` and the clinician-facing
`SIGNED_BEFORE_ASSURANCE` WORM annotation (`:959-973`) never fires — a legacy draft is
indistinguishable from an assured one in the audit trail. This ticket does not change the
assurance guard itself (that is `legacy-safety-floor`, Wave 1) — it is cited here because
consolidating entry points behind one seam is the documented precondition for fixing it correctly
in one place instead of six.

### 2.5 What already exists and must be reused

- **Application-service folder pattern** — `packages/applications/src/services/department/`:
  `IDepartmentService.ts`, `department.service.ts`, `department.service.module.ts`,
  `department.dto.mapper.ts`, `dto/`, `__tests__/`, `index.ts`. A simpler, non-CRUD exemplar of the
  same shape (a coordinating service with no owned Prisma model) is
  `packages/applications/src/services/ai-task-default/` — `IAiTaskDefaultService.ts`,
  `ai-task-default.service.ts`, `ai-task-default.service.module.ts`, `constants.ts`, `dto/`,
  `__tests__/`, `index.ts`.
- **`packages/applications/src/services/consultation/`** already has 12 sibling folders:
  `consultation`, `context`, `events`, `harness`, `highlight`, `jobs`, `live-documentation`,
  `loop`, `ocr`, `prompt`, `shared`, `summary`, `timeline`. The new seam is a 13th sibling,
  `note-generation/`, matching this pattern — not a subfolder of `summary/` or `jobs/`, because it
  must be importable by both without creating a circular dependency.
- **`HarnessGatewayServiceModule`** (`packages/applications/src/services/consultation/harness/harness-gateway.service.module.ts`)
  is a deliberate leaf module (comment `:8-12`): "Kept separate from the inbound harness-internal
  module so the BullMQ-heavy `ConsultationJobServiceModule` and `SummaryServiceModule` can import
  just the outbound gateway without a circular dependency." The new `NoteGenerationServiceModule`
  imports it the same way.
- **`ConsultationJobServiceModule`** (`.../jobs/consultation-job.service.module.ts:18`) already
  imports `HarnessGatewayServiceModule` with the comment `// harnessEnabled routing in
  ConsultationEventHandler` (`:33`) — direct evidence the module graph already anticipated this
  routing living somewhere central; today it just doesn't.
- **`SysEventType`** (`packages/domains/src/enums/sysEventType.enum.ts`) is generic
  (`ResourceCreated/Viewed/Updated/Deleted/Archived`, `WebHookRun`, `SendContactMessage`) — no
  dedicated note-generation event exists. `SummaryService.generateSummary`/`generatePreSummary`
  already broadcast `SysEventType.ResourceCreated` with `data: { consultationId, type: 'summary' |
  'pre_summary' }` (`summary.service.ts:379-384`, `:557-562`). The seam must not duplicate these —
  it wraps existing generation calls, which keep broadcasting exactly as they do today.

## 3. Knowledge & Best Practices

- `.claude/rules/04-application-services.md` — `NoteGenerationService` extends `BaseService`,
  uses symbol-token DI (`INoteGenerationService` in `INoteGenerationService.ts`), and its module
  wires `CommonServiceModule` + `CoreDatabaseModule` per the standard pattern. It must **not**
  duplicate `broadcastSysEvent` calls the wrapped services already make (see §2.5).
- `.claude/rules/01-development-workflow.md` — TDD Red-Green-Refactor; every task below states its
  failing test before its implementation.
- `.claude/rules/_karpathy.md` §2/§3 — no speculative interpreter-dispatcher shape, no
  "flexibility" beyond what routes the seven known entry points today. Surgical: the event handler
  keeps its DNA-redaction-resolution and transcript-loading logic (`:146-181`) — only the
  fork-and-call gets extracted.
- **Never silently succeed on a missing critical dependency.** The Karpathy "no error handling for
  impossible scenarios" guidance does not apply here — a missing `HarnessGatewayService` on a
  harness-enabled tenant is not impossible, it is the exact defect in §2.3. The fix must make this
  case **loud**: throw from the seam (surfacing as a BullMQ job failure/retry for async triggers,
  a thrown exception for sync triggers, a 5xx for the HTTP-driven paths) rather than returning
  a success-shaped result.
- **Pitfall specific to this ticket**: do not let "one reader of `harnessEnabled`" become "harness
  now runs for trigger kinds it never had a workflow for." Pre-summary and comprehensive-summary
  generation have no `HarnessDocWorkflow`-equivalent today (confirmed §2.1 — no harness call
  anywhere in `pre-summary.processor.ts` or `comprehensive-summary.processor.ts`/`chain-summary.service.ts`,
  and no Temporal workflow in `apps/harness` is named for either). The seam must resolve
  `harnessEnabled` for every trigger, but for these two kinds it returns a structured
  "not supported by harness yet, falling back to legacy" decision, logged and unit-tested — never
  a silent no-op, never an invented harness call.
- `.claude/rules/09-infrastructure-devops.md` — no new env var; the seam reads `harnessEnabled`
  exactly the way `ConfigResolver` already resolves it (global-kv adjacent, `global-kv`/`db-config`
  tiers untouched by this ticket).

## 4. Implementation Plan

### Task 1 — Failing tests for the seam's dispatch contract
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/consultation/note-generation/__tests__/note-generation.service.test.ts` (new)
- **Approach:** Write (RED) tests against a not-yet-existing `NoteGenerationService.generate(trigger, params)`
  covering: (a) `TRANSCRIPTION_CREATED` trigger with `harnessEnabled=true` and a mocked
  `HarnessGatewayService` present → gateway `.start()` called with the same shape as today's
  handler builds (`:172-181`); (b) same trigger, `harnessEnabled=false` → legacy delegate invoked,
  gateway never called; (c) `harnessEnabled=true` with `HarnessGatewayService` undefined → the
  call **throws** (or rejects) rather than returning success — this is the regression test for
  §2.3; (d) `SUMMARY_REGENERATE` trigger (the async-regenerate case) mirrors (a)/(b)/(c); (e)
  `PRE_SUMMARY` and `COMPREHENSIVE_SUMMARY` triggers with `harnessEnabled=true` → decision result
  is `{ generator: 'legacy', reason: 'harness-not-supported-for-trigger' }`, legacy delegate still
  invoked, no exception. Mock `ConfigResolver`, `HarnessGatewayService`, and the legacy delegate
  callbacks. Follow `consultation-event.handler.test.ts`'s existing mocking style for
  `ConfigResolver`/`HarnessGatewayService`.
- **Verify:** `pnpm --filter @arcaai/applications test -- note-generation.service.test.ts` — RED
  (module does not exist yet).

### Task 2 — Implement `NoteGenerationService`
- **Agent:** T3 · sonnet-5 · medium
- **Files:**
  - `packages/applications/src/services/consultation/note-generation/INoteGenerationService.ts` (new)
  - `packages/applications/src/services/consultation/note-generation/note-generation.service.ts` (new)
  - `packages/applications/src/services/consultation/note-generation/note-generation.service.module.ts` (new)
  - `packages/applications/src/services/consultation/note-generation/types.ts` (new — `GenerationTrigger` enum: `TRANSCRIPTION_CREATED`, `SUMMARY_REGENERATE`, `PRE_SUMMARY`, `COMPREHENSIVE_SUMMARY`; `GenerationDecision` type)
  - `packages/applications/src/services/consultation/note-generation/index.ts` (new)
- **Approach:** `NoteGenerationService extends BaseService`. Move the resolution logic from
  `ConsultationEventHandler.resolvePipelineConfig` (`:461-515`) into this service verbatim (same
  cascade-merge behavior, same fail-closed-to-defaults `catch`), renamed `resolveConfig`. Add
  `generate(trigger: GenerationTrigger, params): Promise<GenerationDecision>`:
  1. Resolve config via the moved `resolveConfig`.
  2. For `TRANSCRIPTION_CREATED` / `SUMMARY_REGENERATE`: if `config.harnessEnabled` — call
     `this.harnessGatewayService.start(...)` (constructor-injected **required**, not
     `@Optional()` — the throw-loud fix; NestJS DI will fail fast at boot if
     `HarnessGatewayServiceModule` isn't imported into this service's module, which is exactly the
     desired "loud" failure mode instead of a silent runtime no-op). Return `{ generator:
     'harness', harnessJobId }`.
  3. If `!config.harnessEnabled`, or trigger is `PRE_SUMMARY`/`COMPREHENSIVE_SUMMARY`: return `{
     generator: 'legacy', reason: config.harnessEnabled ? 'harness-not-supported-for-trigger' :
     'harnessEnabled-false' }` and let the caller run its existing legacy generation call — the
     seam does not itself invoke `SummaryService`/`ChainSummaryService`/BullMQ (those keep their
     own call signatures; the seam only owns the **decision**, not every side effect, keeping this
     ticket's diff to entry-point wiring rather than a rewrite of five generation implementations).
  Symbol token `INoteGenerationService` per `.claude/rules/04-application-services.md`.
- **Verify:** `pnpm --filter @arcaai/applications test -- note-generation.service.test.ts` — GREEN
  (Task 1's tests pass, including the throw-on-missing-gateway case).

### Task 3 — Route `ConsultationEventHandler` through the seam
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/consultation/events/consultation-event.handler.ts`,
  `packages/applications/src/services/consultation/events/__tests__/consultation-event.handler.test.ts`
- **Approach:** Replace the inline fork (`:146-190`) with a call to
  `noteGenerationService.generate(GenerationTrigger.TRANSCRIPTION_CREATED, {...})`; the
  transcript-loading (`:150-165`) and DNA-redaction-resolution (`:167-170`) logic stays in the
  handler (it is trigger-specific request assembly, not routing) and is passed as `params` to the
  seam. Delete the now-dead `@Optional() @Inject(HarnessGatewayService)` constructor param — the
  handler no longer calls the gateway directly. Update
  `consultation-event.handler.test.ts`: existing "gateway called when both true" / "legacy path
  when harnessEnabled absent" cases now assert delegation to `NoteGenerationService.generate`
  instead of a direct gateway call; add the case from Task 1(c) at this integration level too
  (missing-gateway now surfaces as a thrown/logged error the `@OnEvent` handler's existing
  try/catch converts to a warn-level log — never a "start requested" success log with zero
  effect).
- **Verify:** `pnpm --filter @arcaai/applications test -- consultation-event.handler.test.ts`; full
  suite `pnpm --filter @arcaai/applications test`.

### Task 4 — Route the async "regenerate" entry point (#4) through the seam
- **Agent:** T3 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/consultation/jobs/consultation-job.service.ts`,
  `.../jobs/processors/summary.processor.ts`,
  `.../jobs/consultation-job.service.module.ts`,
  `.../jobs/__tests__/consultation-job.service.test.ts`,
  `.../jobs/processors/__tests__/summary.processor.test.ts`
- **Approach:** This is the entry point the target-architecture document names explicitly as the
  acceptance case ("`POST :id/summary/async` produces a draft **with** a `SummaryMeta` on a
  harness-on tenant"). In `SummaryProcessor.process` (or `ConsultationJobService.createSummaryJob`,
  whichever owns the point where legacy generation actually starts — verify against
  `summary.processor.ts:62-270` before choosing), call
  `noteGenerationService.generate(GenerationTrigger.SUMMARY_REGENERATE, {...})` before running the
  legacy BullMQ generation body; when the decision is `{ generator: 'harness' }`, the processor
  returns without running its own legacy generation (harness produces the note asynchronously via
  its own callback path into `HarnessInternalController`, exactly as entry point #1 already does).
  Import `NoteGenerationServiceModule` into `ConsultationJobServiceModule`.
- **Verify:** `pnpm --filter @arcaai/applications test -- summary.processor.test.ts
  consultation-job.service.test.ts`.

### Task 5 — Route the remaining unsupported-by-harness entry points (#2, #3, #5, #6, #7) through the seam's decision, with documented fallback
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/consultation/summary/summary.service.ts`,
  `.../summary/chain-summary.service.ts`,
  `.../jobs/processors/pre-summary.processor.ts`,
  `.../jobs/processors/comprehensive-summary.processor.ts`,
  `.../summary/summary.service.module.ts`,
  `.../jobs/consultation-job.service.module.ts` (already imported in Task 4),
  test files for each of the four modified services/processors
- **Approach:** Each of these five call sites (sync `generateSummary`, sync `generatePreSummary`,
  `generatePreSummaryAsync`/`PreSummaryProcessor`, sync `generateComprehensiveSummary`,
  `generateComprehensiveSummaryAsync`/`ComprehensiveSummaryProcessor`) calls
  `noteGenerationService.generate(...)` with the appropriate `GenerationTrigger` **purely to make
  the read happen through the single seam and get the decision logged** — per §3/Task 2, the
  decision for `PRE_SUMMARY`/`COMPREHENSIVE_SUMMARY` is always `{ generator: 'legacy', reason:
  'harness-not-supported-for-trigger' }`, and for sync `generateSummary` on a harness-enabled
  tenant the decision is `{ generator: 'harness', ... }` — **this is a real behavior change**:
  today, sync `generateSummary` always runs legacy regardless of the flag; after this task, a
  harness-enabled tenant calling the sync endpoint gets routed to the harness start call exactly
  as the async path does (with the synchronous HTTP response representing "generation started",
  matching the pattern the existing async routes already use for harness triggers). Each call site
  logs its decision at INFO for observability. No new harness workflow is invented for pre-summary
  or comprehensive-summary — those two always fall back, and the fallback path is asserted by a
  test at each of the four sites.
- **Verify:** `pnpm --filter @arcaai/applications test`.

### Task 6 — Grep-gate test: `harnessEnabled` has exactly one runtime reader
- **Agent:** T1 · haiku-4-5 · default
- **Files:** `packages/applications/src/services/consultation/note-generation/__tests__/harness-enabled-single-reader.grep-gate.test.ts` (new)
- **Approach:** Follow the file-reading pattern already used by
  `packages/applications/src/services/settings-registry/__tests__/consultation-gate-seed-parity.test.ts`
  (reads source files with `node:fs`, not live imports). Read every `.ts` file under
  `packages/applications/src/services/consultation/**` (excluding `__tests__/**` and
  `note-generation/**` itself) and assert none contains the literal `.harnessEnabled` outside of
  passing it as a constructed `params`/`trigger` argument — concretely: assert zero occurrences of
  `if (config.harnessEnabled` / `if (cascade?.harnessEnabled` / equivalent conditional forms
  anywhere except inside `note-generation/note-generation.service.ts`. This is the acceptance
  criterion named in the source design doc ("a grep-gate asserting `harnessEnabled` has one
  runtime reader") made concrete and repo-enforced.
- **Verify:** `pnpm --filter @arcaai/applications test -- harness-enabled-single-reader.grep-gate.test.ts`.

### Task 7 — E2E: harness-on tenant regenerate produces an assured draft
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/api/tests/e2e/task-704-generator-seam.spec.ts` (new)
- **Approach:** Against a seeded harness-enabled tenant (ArcaAI or demo — confirm which is
  reachable in the e2e fixture set), call `POST :id/summary/async`, poll the job to completion,
  then assert the resulting draft has a `SummaryMeta` row with `assuranceCompletedAt` set (mirrors
  the existing harness-path assertion style already used for entry point #1's e2e coverage — find
  and imitate that spec rather than inventing new polling helpers). This is the literal acceptance
  criterion from the design brief and from `04-target-architecture.md`'s remediation table.
- **Verify:** `pnpm test:up:api` (terminal 1) then `pnpm test:e2e -- task-704-generator-seam`.

### Task 8 — Full verification pass
- **Agent:** T2 · sonnet-5 · low
- **Files:** none (verification only)
- **Approach:** Run every layer gate touched by this ticket and capture real output.
- **Verify:** `pnpm --filter @arcaai/applications build`, `pnpm --filter @arcaai/applications test`,
  `pnpm api:build`, `pnpm test:unit`, `pnpm lint`.

## 5. Acceptance Criteria

- [ ] `pnpm --filter @arcaai/applications build` passes
- [ ] `pnpm --filter @arcaai/applications test` passes, including the new `note-generation/__tests__/*`
      suite and updated tests in `events/`, `jobs/`, `summary/`
- [ ] `pnpm api:build` passes
- [ ] `pnpm test:unit` passes
- [ ] `pnpm test:up:api` then `pnpm test:e2e -- task-704-generator-seam` — a harness-on tenant's
      `POST :id/summary/async` produces a draft **with** a `SummaryMeta` row and
      `assuranceCompletedAt` set
- [ ] Unit test proves: a missing `HarnessGatewayService` dependency on a harness-enabled trigger
      throws (surfaces as a job failure / thrown exception), never a silent success log with zero
      notes produced
- [ ] The grep-gate test (Task 6) passes, proving `harnessEnabled` is read in exactly one runtime
      location across `packages/applications/src/services/consultation/**`
- [ ] `pnpm lint` — zero new errors, including `only-warn` warnings in `packages/*` treated as
      errors per `.claude/rules/01-development-workflow.md`
- [ ] Barrel `index.ts` for `note-generation/` exported; `NoteGenerationServiceModule` registered
      wherever any of the seven entry points' modules now import it
      (`ConsultationJobServiceModule`, `SummaryServiceModule`, `ChainSummaryServiceModule`)
- [ ] Ticket README's Implementation Summary and Change History updated with actual command output
      pasted (`.claude/rules/01-development-workflow.md` completion checklist)

## 6. Risks & Open Questions

- **HUMAN-GATED: sync `generateSummary` behavior change (Task 5).** Making the sync
  `POST :id/summary` route start a harness workflow (rather than always running legacy) for
  harness-enabled tenants is a real, user-visible behavior change beyond pure consolidation — the
  synchronous HTTP response would represent "generation started," not "generation complete," for
  those tenants, matching the existing async pattern but diverging from what the sync route
  historically returned. Confirm with the product owner before Task 5 ships this specific change;
  if rejected, Task 5 narrows to logging-only for that one call site (decision computed and logged,
  but the sync legacy call always still runs — closer to today's behavior, at the cost of leaving
  one of the seven entry points only partially "governed" by the flag). Answer: Lets review, suggest best practices.
  **RESOLVED (2026-08-16, best-practices call — see §7 "Resolution of the deferred risks" for the
  full reasoning): keep logging-only, permanently, not pending.** Two independent, sufficient
  reasons: (1) calling `generate()` unconditionally while the legacy body always still runs would
  duplicate-generate on every harness-enabled tenant; (2) even a REPLACE-shaped version collides
  with `SummaryResponse`'s response contract (`id`/`content`/`version` of an already-persisted
  ContextItem) — there is nothing for a 'harness' decision to synchronously return without either
  changing this endpoint's HTTP contract (an undisclosed migration, exactly what this risk item
  exists to gate) or blocking on a durable Temporal workflow that is deliberately not instant
  (sensors/groundedness/MCP checks). Entry point #4 (`POST :id/summary/async`) already is the
  harness-routing entry point for the `SUMMARY_REGENERATE` trigger and already replaces (never
  supplements) its legacy body on a 'harness' decision — that is where a harness-enabled tenant's
  regenerate should go today. No kill-switch was added because there is nothing for it to gate;
  the guidance's REPLACE-not-supplement + explicit-revertible-switch requirements are recorded as
  forward guidance in the code comment (`summary.service.ts:generateSummary`) for whoever revisits
  this in the Wave-2 `harness-sole-generator` migration, pointing at this repo's established
  pattern (`consultation-gates.constants.ts` / `consultation-gates.descriptors.ts` — a `global-kv`
  `killSwitch: true` descriptor resolved per-call via `TenantSettingsService.resolvePlatform`)
  rather than inventing a new flag mechanism.
- **Harness has no pre-summary/comprehensive-summary equivalent.** This ticket treats that as a
  standing gap, not something to fix — confirmed no code path in `apps/harness` implements either.
  If a future ticket adds harness support for these, the seam's `GenerationDecision` shape already
  has room for a third outcome; no rework of the seam's public contract should be needed, but this
  is not verified by any test in this ticket and should not be assumed. **Answer**: Lets review, suggest best practices.
  **RESOLVED (2026-08-16): accept as-is, no action.** Re-verified directly (2026-08-16): `types.ts`'s
  `GenerationDecision` is a discriminated union (`GenerationDecisionHarness | GenerationDecisionLegacy`)
  and `HARNESS_SUPPORTED_TRIGGERS` is a single `ReadonlySet` consulted once in `generate()` — adding
  a harness-side PRE_SUMMARY/COMPREHENSIVE_SUMMARY capability later is additive (a new Set member +
  a new decision-union member), not a rewrite. Building anything more now (a stub decision, an
  unused capability flag) would be exactly the speculative work `_karpathy.md` §2 forbids for a
  capability that does not exist. No further action in this ticket.
- **`HarnessGatewayService` becoming a required (non-`@Optional()`) dependency of
  `NoteGenerationService`** changes a DI failure mode from "silent no-op at runtime" to "boot
  failure if the module graph is wrong." This is the intended fix (§2.3), but it means any
  deployment or test fixture that previously relied on the optional/absent gateway to exercise the
  legacy path via a harness-enabled config must now also supply a (possibly mocked) gateway — audit
  existing fixtures in Task 3's test update for this. **Answer**: Lets review, suggest best practices.
  **RESOLVED (2026-08-16): audited, no regression, keep as required.** Every fixture that
  constructs `ConsultationEventHandler`, `SummaryProcessor`, `PreSummaryProcessor`,
  `ComprehensiveSummaryProcessor`, `SummaryService`, or `ChainSummaryService` now supplies a mocked
  `INoteGenerationService` (grepped across `events/__tests__/consultation-event.handler.test.ts`,
  `jobs/__tests__/{summary,pre-summary,comprehensive-summary}.processor.test.ts`,
  `jobs/processors/__tests__/summary.processor.summary-meta-floor.test.ts`,
  `summary/__tests__/{summary,chain-summary}.service.test.ts`, `loop/__tests__/loop-context-signal.service.test.ts`)
  — none constructs `NoteGenerationService` itself with a missing gateway in a passing (non-throw)
  test, and `consultation-event.handler.test.ts` (`:1046`) explicitly covers `generate()` rejecting
  and asserts the handler's existing try/catch turns it into a warn-level log rather than an
  unhandled rejection. Production boot-time safety is structural (module DI), not test-fixture
  dependent, and is unchanged from Task 2/3's implementation. Full suite green (see §7 Verification,
  including the applications-package rerun performed for this pass: 491 files / 9122 tests passed).
- **Fan-out risk**: Tasks 4 and 5 touch overlapping module-registration files
  (`consultation-job.service.module.ts`). Execute Task 4 before Task 5 (already sequenced above,
  not parallel) to avoid a merge conflict on the same import line. **Answer**: Lets review, suggest best practices.
  **RESOLVED (2026-08-16): moot, confirmed clean.** Both tasks landed in the same commit
  (`d21915881`) with the sequencing already followed — `consultation-job.service.module.ts` carries
  exactly one `NoteGenerationServiceModule` import, and `pnpm --filter @arcaai/applications build`
  is clean. No further action; noted here only to close the item.

## 7. Implementation Summary

All 8 tasks executed. Tasks 1–6 and 8 are fully complete and verified with real
command output (below). Task 7 (live e2e) is **authored, and its creation-only
half was executed against a real live stack in a follow-up pass (2026-08-16,
below) with a partial, honestly-reported result** — see "Resolution of the
deferred risks + Task 7 live run (2026-08-16)". Task 5's sync `generateSummary`
short-circuit is **not** applied — this is now a final, decided outcome (not a
pending HUMAN-GATED item) — see "Deviations from the literal plan" below and
§6's resolution.

### Resolution of the deferred risks + Task 7 live run (2026-08-16)

This pass had local infra available (Postgres/Redis/Temporal/Vault/MinIO/Qdrant
up) and made the four owner-deferred ("Lets review, suggest best practices")
calls recorded in §6, plus attempted Task 7's live e2e. Summary — full
reasoning is inline in §6 next to each item:

1. **Sync `generateSummary` stays legacy-only, permanently.** Decided against
   routing it to harness at all (not just "logging-only for now"), for two
   independent reasons: it would duplicate-generate if `generate()` ran
   alongside the always-run legacy body, and even a REPLACE-shaped version
   has nothing to synchronously return through `SummaryResponse`'s
   already-persisted-ContextItem contract without either an undisclosed HTTP
   contract change or a novel blocking wait on a deliberately-non-instant
   Temporal workflow. The code comment in `summary.service.ts` now states
   this as decided and records the forward guidance (REPLACE not supplement,
   `global-kv` kill-switch, following `consultation-gates.constants.ts`'s
   established pattern) for whoever revisits it in Wave 2. No new descriptor
   was added — there is nothing for it to gate today, and adding one now
   would be unused, speculative infrastructure.
2. **Harness's missing pre-summary/comprehensive-summary equivalent**: accepted
   as-is, re-verified `GenerationDecision`'s discriminated-union shape needs no
   rework to add a third outcome later. No action.
3. **`HarnessGatewayService` required-dependency audit**: performed — every
   test fixture that constructs a seam caller now supplies a mocked
   `INoteGenerationService` (or, for `NoteGenerationService` itself, a mocked
   gateway); zero fixtures rely on the old optional/absent-gateway shape. No
   regression, keep as required.
4. **Fan-out risk on `consultation-job.service.module.ts`**: moot — Tasks 4/5
   already landed in one commit, one clean import.

**Task 7 live run — what actually happened, exactly as observed:**

- Brought up isolated test infra (`pnpm infra:test:up` — fresh
  `hope-postgres-test`/`hope-redis-test`/`hope-vault-test`/`hope-minio-test`/`hope-qdrant-test`
  containers), applied the full migration ledger with `db:migrate:deploy`
  (additive, not `db push --force-reset` — see the note below on why the
  force-reset path is intentionally never used directly), seeded (`RUN_SEED=all`),
  started `apps/api` against `.env.test` (`pnpm test:up:api`), confirmed
  `GET /api/v1/health` → 200.
- First `pnpm test:e2e -- task-704-generator-seam` attempt: killed by me
  mid-run after misreading Playwright's OWN `globalSetup`
  (`tests/setup/playwright.global-setup.ts`) resetting/reseeding the test DB
  as external interference — it is not; that reset-then-reseed is the
  documented, standard behavior of `pnpm test:e2e` (its `execSync('pnpm
  test:db:reset', …)` legitimately carries
  `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes'`, pre-committed in that
  script for exactly this isolated-test-DB case — not something I set myself
  to bypass Prisma's AI-agent guard). Logged here as a self-correction, not
  hidden.
- Second attempt hit a real gap: `pnpm test:e2e`'s `globalSetup` only seeds
  when `RUN_SEED` is already `all` in the invoking shell (`scripts/test-run.sh`
  sets it; a bare `pnpm test:e2e` does not), so the DB was schema-pushed but
  left unseeded and the run stalled. Re-ran with `RUN_SEED=all` exported.
- **Third attempt ran to completion for real, against the live stack:**
  `beforeAll` (`POST :id/summary/async` against the seeded harness-enabled
  `GEN_COMPLETED` consultation) **succeeded** — a real BullMQ job was created
  end to end through the seam, proving entry point #4 is live and reachable.
  The follow-up assertion (`GET jobs/:jobId` → expected 200) **got a 500**.
  Root cause, confirmed by direct inspection of the running API's compiler
  output and `git status`: a concurrent sibling session was actively editing
  unrelated consent-enforcement files in this SAME shared working tree at
  that exact moment (`apps/api/src/guards/patient-consent.guard.ts` and
  `apps/api/src/bootstrap/consent-route-coverage-audit.ts`, both newly
  created ~14:07–14:09, alongside modified `packages/exceptions` consent
  exception files) — `nest start --watch` picked up the in-flight,
  incomplete edit and broke apps/api's TypeScript build (`TS2305: Module
  "@arcaai/applications" has no exported member 'RequiresConsent'` etc.,
  nothing to do with note-generation). This is very likely also what made
  the unrelated `consent-assert.test.ts` test fail transiently in the
  `pnpm --filter @arcaai/applications test` rerun performed during the same
  window (§6 item 3's evidence) — same concurrent-edit window, same domain.
  **Not a TASK-704 defect**; not fixed here (out of scope, another session's
  in-flight work, per "Siblings share this tree — touch only your ticket's
  files").
- Given the working tree is not currently in a stable, isolated state for
  live e2e (a real, observed constraint of the shared multi-agent
  environment, not a hypothetical one), Task 7 was not re-attempted a fourth
  time in this pass. The **FULL harness-loop assertions remain unexecuted** —
  they need apps/harness + a Temporal worker + apps/text + apps/nlp
  additionally running, which this pass did not start.
- Cleaned up after: stopped this pass's `pnpm test:up:api` process. Test
  infra containers (`infra:test:up`) were left running (idempotent, and other
  sessions on this same shared test-infra port set may depend on them).

**Honest bottom line for Task 7**: the creation-only half is now proven live
(job creation through the real seam, real Postgres, real Redis, real BullMQ) —
stronger evidence than the previous "authored but never executed" state — but
the full pass-through-to-200 assertion and the `HARNESS_E2E_FULL` full loop
are still not clean, for reasons external to this ticket's code. Acceptance
criteria below reflect this precisely; nothing here is reported as passing
that did not actually pass.

### What the seam does

- **New package**: `packages/applications/src/services/consultation/note-generation/`
  — `types.ts` (`GenerationTrigger`, `GenerationDecision`, `GenerateParams`),
  `INoteGenerationService.ts` (symbol-token interface), `note-generation.service.ts`
  (`NoteGenerationService extends BaseService`), `note-generation.service.module.ts`,
  `index.ts`. `resolveConfig()` is `ConsultationEventHandler.resolvePipelineConfig`
  moved verbatim; `generate()` is the new decision + (on `'harness'`) side effect.
- **The throw-loud fix (§2.3)**: `NoteGenerationService`'s constructor takes
  `HarnessGatewayService` as a **plain required param, not `@Optional()`**, and
  `generate()` calls `this.harnessGatewayService.start(...)` — no `?.` — so a
  missing gateway throws a `TypeError` at the call site (unit-tested) and, in
  production DI, `NoteGenerationServiceModule` failing to import
  `HarnessGatewayServiceModule` is a **boot-time** Nest DI error, not a silent
  runtime no-op.
- **Entry point #1** (`ConsultationEventHandler.handleTranscriptionCreated`):
  the inline `if (config.harnessEnabled)` fork is replaced by a call to
  `noteGenerationService.generate(GenerationTrigger.TRANSCRIPTION_CREATED, params)`.
  Transcript-loading + DNA-redaction resolution stay in the handler (trigger-specific
  request assembly) but now run **unconditionally** before calling the seam (a
  deliberate, documented trade-off — see below) rather than only inside the old
  `if` branch. `resolvePipelineConfig` was deleted from the handler; both callers
  (`handleTranscriptionCreated`'s autoSummaryEnabled gate and
  `handleSummaryGenerated`'s NER-skip decision) now call
  `noteGenerationService.resolveConfig(consultationId)`.
- **Entry point #4** (`POST :id/summary/async` → `SummaryProcessor.process`):
  the seam call sits at the top of `process()`, right after CLS rebind — before
  ANY legacy work starts. On `{generator:'harness'}` the processor calls
  `jobService.notifyComplete(jobId, {contextItemId:'', content:'', harnessJobId})`
  and returns without running its own generation body — the actual note is
  produced asynchronously by the harness workflow via `HarnessInternalController`,
  exactly as entry point #1 already does. `SummaryJobResult` gained one new
  optional field, `harnessJobId?: string`, to carry this (see Deviations).
- **Entry points #3/#5/#6/#7** (pre-summary + comprehensive-summary, sync +
  async): each calls `noteGenerationService.generate(...)` purely to route the
  read through the seam and log the decision — `PRE_SUMMARY`/`COMPREHENSIVE_SUMMARY`
  are outside `HARNESS_SUPPORTED_TRIGGERS`, so the decision is always
  `{generator:'legacy', reason:'harness-not-supported-for-trigger'}` and the
  call is side-effect-free; generation always runs, unaffected, best-effort
  (a seam failure is caught, logged, and never blocks the draft).
- **Entry point #2** (sync `generateSummary`) — **HUMAN-GATED, see below.**

### Deviations from the literal plan (judgment calls, with reasoning)

1. **Sync `generateSummary` does NOT call `generate()`.** `generate()` is not
   side-effect-free for `SUMMARY_REGENERATE` when `harnessEnabled=true` — it
   calls `harnessGatewayService.start(...)`. Calling it "just to log" from the
   sync route while ALSO always running the legacy body afterward (as the
   literal Task 5 approach text describes for all five call sites uniformly)
   would silently start a REAL harness workflow on every harness-enabled
   tenant's sync call, on top of the legacy draft this route always still
   produces — a duplicate-generation regression, and a much larger undisclosed
   behavior change than the one the ticket's own Risk section already flags.
   Instead, `generateSummary` calls only the side-effect-free
   `noteGenerationService.resolveConfig(consultationId)` and logs the resolved
   `harnessEnabled` for observability; nothing below it is gated on the value.
   This is the safe reading of "logging-only… legacy call always still runs."
2. **Unconditional transcript-loading + DNA-redaction prep in the handler.**
   To avoid the handler itself branching on `config.harnessEnabled` (which
   would reintroduce a second routing-shaped reader outside the seam), entry
   point #1 now always prepares the harness-start inputs before calling
   `generate()`, even when the decision turns out `'legacy'`. Trade-off: a
   small, bounded extra cost (a transcript lookup + a DNA-redaction cascade
   check) on every auto-pipeline event for non-harness-enabled consultations.
   Accepted as consistent with "harnessEnabled read in exactly one place"
   over micro-optimizing a Wave-0 consolidation ticket.
3. **One documented, allow-listed second `harnessEnabled` reader.**
   `ConsultationEventHandler.handleSummaryGenerated` still reads
   `config.harnessEnabled` (via `noteGenerationService.resolveConfig`) to
   decide whether to skip the legacy auto-NER job (the harness workflow
   persists its own `NamedEntity` rows). This answers a **different**
   question than "which generator produces the note" — it is not one of the
   seven note-generation entry points in §2.1, predates this ticket, and the
   design doc's own acceptance line (04-target-architecture.md:257 /
   :68) scopes the grep-gate to generation entry points, not NER. The
   grep-gate test (Task 6) allow-lists exactly this one site by file + line
   text, and the source carries a matching `TASK-704 grep-gate NOTE` comment
   so the two cannot silently drift apart. Verified by temporarily injecting
   a second fake conditional read elsewhere and confirming the gate fails,
   then reverting (see command output below).
4. **`SummaryJobResult.harnessJobId?: string` added to `jobs/dto/job.dto.ts`.**
   Not in Task 4's stated file list, but a direct, minimal, additive
   consequence of implementing it correctly: the processor needs a way to
   signal "routed to harness" through the existing `SummaryJobResult` shape
   without fabricating a real `contextItemId`.

### Verification (actual command output)

```
$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc
(clean exit, no output)

$ pnpm --filter @arcaai/applications test   [full suite, not just this ticket's files]
 Test Files  480 passed | 1 skipped (481)
      Tests  9016 passed | 4 skipped (9020)
   Duration  60.49s
EXIT_CODE:0

$ pnpm --filter @arcaai/api typecheck
> tsc --noEmit
(clean exit, no output)

$ pnpm api:build
 Tasks:    10 successful, 10 total

$ pnpm --filter @arcaai/api test   [full apps/api unit suite]
 Test Files  200 passed | 2 skipped (202)
      Tests  2875 passed | 4 skipped (2879)
EXIT_CODE:0

$ npx eslint <every file this ticket touched in packages/applications, non-test>
✖ 8 problems (0 errors, 8 warnings)   — all 8 are "File ignored" notices for
  __tests__ files (eslint's test-file ignore pattern), zero real warnings/errors.

$ npx eslint apps/api/tests/e2e/task-704-generator-seam.spec.ts
(clean exit, no output)

$ pnpm --filter @arcaai/applications lint   [full package]
✖ 182 problems (0 errors, 182 warnings)   — all 182 are pre-existing
  `eslint-comments/require-description` warnings in files this ticket never
  touched (verified by diffing the warning file list against `git status`).
```

Grep-gate self-test (Task 6): temporarily injected a second fake
`if (config.harnessEnabled)` conditional into `summary.service.ts`, reran the
gate — it failed with the injected violation listed by file/line — then
reverted and reran clean. This is real evidence the gate actually catches a
regression, not just that it passes today.

`pnpm test:unit` and `pnpm lint` (repo-root aggregates) were deliberately
**not** run — this session's operating constraints (six sibling agents sharing
this working tree) reserve root-aggregate commands for a separate final
verification pass; package-scoped `build`/`test`/`typecheck`/`lint` above
cover the same ground for every package this ticket touched.

### Verification — 2026-08-16 follow-up pass (risk resolution + Task 7 live attempt)

Only change this pass made to shipped code is the comment/log-message rewrite
in `summary.service.ts` (§7 "Resolution of the deferred risks", item 1) — no
behavior change, so re-verification is a rerun of the same gates plus the live
e2e attempt documented above.

```
$ npx eslint packages/applications/src/services/consultation/summary/summary.service.ts
(clean exit, no output)

$ pnpm --filter @arcaai/applications test   [full suite, re-run against live DB/Redis/Vault/Temporal]
 Test Files  1 failed | 491 passed | 1 skipped (493)
      Tests  1 failed | 9152 passed | 4 skipped (9157)
   Duration  ~61s
   FAILED: src/services/consent/__tests__/consent-assert.test.ts
     expect(decision.reason).toBe('no_grant')  — received a different reason
   Root cause: NOT this ticket. A concurrent sibling session was actively
   editing the consent-enforcement domain in this same shared working tree at
   the exact time this suite ran (see the Task 7 write-up above for the
   file-level evidence — `git status` showed `packages/exceptions/src/domain/
   consentDenied.exception.ts` modified and `consentUnavailable.exception.ts`
   newly added, mid-run). Re-running `packages/applications/src/services/
   consultation/**` in isolation (the tree this ticket actually touches) has
   zero failures; the one failure sits entirely outside this ticket's files.

$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc
(clean exit, no output — ran slow, ~4 min, under the same concurrent
 system load as the consent-domain edits above, but completed clean)
EXIT_CODE:0
```

### Close-out pass (2026-08-16) — clean live re-run, FULL loop still outstanding

Re-ran Task 7's creation-only half live, this time against an already-running,
healthy `apps/api` test instance (reused, not restarted, to avoid racing the
shared working tree's port bind) and an already-migrated/seeded isolated test
DB (`RESET_DB=false` — no destructive reset invoked):

```
$ RESET_DB=false SKIP_DB_PRECHECK=true dotenv -e .env.test -- \
    npx playwright test apps/api/tests/e2e/task-704-generator-seam.spec.ts --reporter=line
  3 skipped   (the FULL-loop describe block — HARNESS_E2E_FULL not set, apps/harness
               + Temporal worker + apps/text + apps/nlp not running in this pass)
  1 passed    (476ms)  — entry point #4's job-creation path, live, clean
```

The follow-up `GET jobs/:jobId` assertion that hit a transient 500 in the
prior pass (caused by a concurrent sibling session's in-flight,
unrelated consent-enforcement edit) now passes cleanly — that edit window
has closed. Re-ran the full `applications` package suite fresh for this pass
too: **493 files / 9183 tests passed, 0 failures** (vs. the prior pass's
1 failure in the unrelated consent domain) — confirms the concurrent-edit
theory was correct and this ticket's own code has no defect.

**The FULL-loop assertions (`HARNESS_E2E_FULL=1` — the literal §5 acceptance
criterion: a draft with `SummaryMeta.assuranceCompletedAt` set) remain
unexecuted in this pass too.** They require `apps/harness` + a Temporal
worker + `apps/text` + `apps/nlp` all running end-to-end against a real (or
stubbed) LLM/judge provider — starting that full stack is a substantially
larger undertaking than this close-out pass's scope (verify + re-run what
infra now permits, fix genuine gaps found), and no prior pass has attempted
it either. This is reported as a real, named boundary, not glossed over:
**Status remains Review** — the creation-only path is now proven clean and
live twice, but the ticket's own literal acceptance criterion needs the full
harness stack running, which this pass did not start.

### Closeout pass (2026-08-16) — full stack actually started; found the real, code-level blocker

This pass had the explicit mandate to try to start `apps/harness` +
`worker:dev` + `apps/text` + `apps/nlp` locally (infra — Postgres, Redis,
Temporal, Vault, MinIO, Qdrant — was already up) and drive the FULL loop
without using `pnpm test:e2e` (Prisma's AI-agent guard) and without any
`db push --force-reset`. Per those constraints, the loop was driven with
direct `curl` calls against an already-running, healthy sibling-session
`apps/api` test instance (`NODE_ENV=test`, port 8968 — confirmed healthy,
untouched, never restarted or modified by this pass) instead of Playwright.

**What was started** (all against `NODE_ENV=test` / `.env.test`, all cleanly
stopped at the end of this pass — verified zero orphaned processes and the
sibling `apps/api` on :8968 unaffected):
- `apps/text` on :8962 (`TEXT_PORT=8962`, matching `.env.test`'s `TEXT_URL`)
- `apps/nlp` on :8964 (`NLP_PORT=8964`, matching `.env.test`'s `NLP_URL`)
- `apps/harness` on :8966 (`HARNESS_PORT=8966`, matching `.env.test`'s
  `HARNESS_URL`) — **with `HARNESS_SMR_BASE_URL`/`HARNESS_NLP_BASE_URL`/
  `HARNESS_API_BASE_URL` overridden via host env** to `:8962`/`:8964`/`:8968`
  respectively. This was necessary: `.env.test` itself carries stale values
  for these three (`http://localhost:8862`/`:8864`/`:8868` — the DEV ports,
  not `.env.test`'s own `TEXT_PORT`/`NLP_PORT`/the actual running test-API
  port). Noted here as a real, secondary environment-config inconsistency;
  not fixed (`.env.test` is a shared file well outside this ticket's scope,
  and the override made it a non-blocker for this pass).
- `worker:dev` (the harness Temporal worker on `harness-task-queue`), same
  overrides.
- LM Studio was confirmed already reachable at `localhost:1234` with
  `google/gemma-4-e4b` loaded (the model `harness.judge` names), so this was
  a genuine attempt at real inference, not a stub.

**Loop driven manually (curl, not Playwright), step by step:**
1. `POST /api/v1/auth/login` (doctor, `__GLOBAL__`) → 200, token obtained.
2. `POST /api/v1/consultations/90000000-0000-0000-0000-000000000001/summary/async`
   → **201**, `jobId` returned.
3. `GET /api/v1/consultations/jobs/:jobId` → **`status: COMPLETED`,
   `result.harnessJobId` set, `result.contextItemId`/`content` empty** —
   this is the exact seam behavior Task 4 implemented: the BullMQ job
   completes immediately without running the legacy body, having routed to
   harness. **This independently reconfirms entry point #4's seam routing is
   correct and live**, now via a path that bypassed Playwright entirely.
4. Harness log confirmed the Temporal workflow actually started:
   `harness.document.start` for `workflow_id:
   harness-doc-90000000-0000-0000-0000-000000000001`.
5. **The workflow's first real activity failed and kept retrying**: the
   `generate` activity's call to `POST http://localhost:8962/api/v1/generate`
   (apps/text) returned **401 `{"detail":"Invalid or missing service
   token"}`**, logged by apps/text as `smr.auth.rejected` /
   `invalid_or_missing_token`.

**Root cause — confirmed by direct code reading, not inference:**
`apps/harness/src/harness/services/smr_client.py`'s `SmrClient` and
`apps/harness/src/harness/services/nlp_client.py`'s `NlpClient` **never send
an `X-Service-Token` header at all** — grepped across both files: zero
occurrences of `X-Service-Token` or `service_token` in either. Their
constructors don't even accept a token parameter (`SmrClient.__init__(self,
base_url, *, timeout=120.0, transport=None)`, same shape for `NlpClient`).
Contrast with `apps/harness/src/harness/services/api_client.py`, which
correctly does (`ApiClient.__init__(..., service_token: str = "", ...)`,
sent as `headers["X-Service-Token"]` at `:269`) — and with
`activities.py`'s three tool-client factories: `_api_client` passes
`settings.service_token.get_secret_value()`; `_smr_client` and `_nlp_client`
(`:207-208`) pass only a `base_url` and timeout, nothing else.

`apps/text`'s `ServiceAuthMiddleware`
(`apps/text/src/text/api/middleware/auth.py`) requires a matching
`X-Service-Token` on every non-exempt route whenever `settings.service_token`
is non-empty — and it is non-empty in **both** `.env.dev` and `.env.test`
(`TEXT_SERVICE_TOKEN`, `NLP_SERVICE_TOKEN`; confirmed distinct 64-char
secrets, not shared with `HARNESS_SERVICE_TOKEN`). Per
`.claude/rules/06-python-services.md`, "empty token = dev-mode bypass" is
documented as the ONLY case that skips this check — and neither `.env.dev`
nor `.env.test` is in that state for `text`/`nlp`.

**This is the exact step that blocks `HARNESS_E2E_FULL`, and it is a
standing, code-level gap in `apps/harness`'s tool clients — not an
environment, infra, or timing problem, and not something this pass could
close within TASK-704's scope** (the affected files,
`apps/harness/src/harness/services/{smr_client,nlp_client}.py` and their
call sites in `activities.py`, are entirely outside this ticket's file list
in §4, and fixing them is a harness-side auth-wiring fix, not a
generator-entry-point-seam change). Concretely: in **any** environment where
`apps/text`/`apps/nlp` are configured the documented, non-dev-bypass way (a
real `TEXT_SERVICE_TOKEN`/`NLP_SERVICE_TOKEN`), the harness Temporal
worker's `generate` and `classify_tokens` activities will 401 on their first
real call, every time, regardless of whether LM Studio, Temporal, Postgres,
Redis, or apps/api are healthy — which they all were confirmed to be in this
pass. The workflow does not fail outright; it retries the activity per its
`RetryPolicy` indefinitely, which is why the consultation was observed
stuck at `OPEN` (never reaching `PENDING_REVIEW`) for the duration of this
pass.

**Cleanup**: the worker (left retrying against a real 401) and all four
locally-started Python services were stopped at the end of this pass
(verified: zero `uvicorn text|nlp|harness` / `harness.temporal.worker`
processes remain). The sibling `apps/api` instance on :8968 was only ever
queried, never modified or restarted, and remained healthy throughout and
after. The Temporal workflow execution
(`harness-doc-90000000-0000-0000-0000-000000000001`) is left in its
in-progress (retrying-activity) state in the shared Temporal server — no
worker is currently consuming `harness-task-queue`, so it is idle, not
consuming resources, and durable (a future worker reconnecting would resume
it, and would hit the identical 401 until the client-auth gap above is
fixed).

**Flagged for a separate, out-of-scope fix**: a background-task suggestion
was filed (see repository task-tracking; title: "Harness SmrClient/NlpClient
never send X-Service-Token") rather than fixed here, per this session's
"touch only your ticket's files" constraint and because the fix belongs to
`apps/harness`'s tool-client layer, not to `NoteGenerationService`'s
entry-point consolidation. **Follow-up filed and implemented, status
Completed**: [TASK-738](../TASK-738-Harness-Peer-Service-Auth/README.md) —
`SmrClient`/`NlpClient` now send `X-Service-Token`; unit-tested; full harness
suite green (1326 passed, 4 pre-existing unrelated failures); live-verified by
starting `apps/text`+`apps/nlp` and curling both directly — confirmed this
ticket's exact 401 repro without a token, confirmed it clears with the fix.
TASK-738 does not itself re-run this ticket's `HARNESS_E2E_FULL` loop (the
full `HarnessDocWorkflow` + real generation + `SummaryMeta.assuranceCompletedAt`
assertion); that live re-confirmation is still outstanding before this
ticket's own status can move past Review.

**Bottom line**: `HARNESS_E2E_FULL` remains genuinely blocked, but the
reason is now precise and code-level (not "nobody has tried starting the
stack yet," which was the honest-but-vaguer state of every prior pass). The
seam itself (this ticket's actual deliverable) is reconfirmed correct — a
harness-enabled tenant's `POST :id/summary/async` really does create a job,
really does route to harness with zero legacy-body execution, and really
does start the durable `HarnessDocWorkflow` — exactly as designed. What
remains unverified end-to-end is harness's OWN ability to call `apps/text`/
`apps/nlp`, which is a pre-existing defect in code this ticket never
touches, not a gap in the seam.

### Files changed

**New** (`packages/applications/src/services/consultation/note-generation/`):
`types.ts`, `INoteGenerationService.ts`, `note-generation.service.ts`,
`note-generation.service.module.ts`, `index.ts`,
`__tests__/note-generation.service.test.ts`,
`__tests__/harness-enabled-single-reader.grep-gate.test.ts`.

**New** (e2e): `apps/api/tests/e2e/task-704-generator-seam.spec.ts`.

**Modified**:
`packages/applications/src/services/consultation/index.ts` (barrel),
`events/consultation-event.handler.ts` + its test,
`jobs/consultation-job.service.module.ts`,
`jobs/dto/job.dto.ts`,
`jobs/processors/summary.processor.ts` + its test,
`jobs/processors/pre-summary.processor.ts` + its test,
`jobs/processors/comprehensive-summary.processor.ts` + its test,
`summary/summary.service.ts` + `summary.service.module.ts` + its test,
`summary/chain-summary.service.ts` + `chain-summary.service.module.ts` + its test.

### Acceptance criteria status

- [x] `pnpm --filter @arcaai/applications build` passes
- [x] `pnpm --filter @arcaai/applications test` passes, including the new
      `note-generation/__tests__/*` suite and updated tests in `events/`,
      `jobs/`, `summary/`
- [x] `pnpm api:build` passes
- [x] `pnpm --filter @arcaai/api test` passes (package-scoped proxy for
      `pnpm test:unit`'s apps/api slice — the root aggregate itself was not
      run; see Verification above)
- [~] `pnpm test:up:api` then `pnpm test:e2e -- task-704-generator-seam` —
      **executed against a real live stack twice: 2026-08-16 and again in the
      2026-08-16 close-out pass.** First run: the creation-only case's
      `beforeAll` (real `POST :id/summary/async` through the seam) passed; the
      follow-up `GET jobs/:jobId` assertion failed with a transient 500 caused
      by a concurrent sibling session's in-flight, unrelated consent-enforcement
      edit (full narrative in §7). **Close-out pass re-run: clean, 1/1 creation
      test passing, 0 failures** — the concurrent-edit window had closed;
      confirms the prior failure was never a TASK-704 defect (see §7 "Close-out
      pass"). **2026-08-16 closeout pass**: the full stack (apps/harness +
      worker + apps/text + apps/nlp) WAS started this time and the loop WAS
      driven manually (curl, not `pnpm test:e2e`) against a live sibling
      `apps/api` test instance. Entry point #4's job-creation + harness-routing
      behavior reconfirmed live (job `COMPLETED` instantly with `harnessJobId`
      set, zero legacy execution) and the durable `HarnessDocWorkflow` was
      confirmed to actually start. **The FULL loop still cannot complete**, but
      the blocking reason is now precise and code-level, not an unattempted
      stack: `apps/harness`'s `SmrClient`/`NlpClient` never send
      `X-Service-Token`, so every `generate`/`classify_tokens` activity 401s
      against a properly-configured (non-dev-bypass) `apps/text`/`apps/nlp` —
      confirmed by direct code reading (zero occurrences of `X-Service-Token`
      in either client, contrast with `ApiClient` which sends it correctly).
      This is a standing defect in files entirely outside this ticket's scope
      (`apps/harness/src/harness/services/{smr_client,nlp_client}.py`); flagged
      as a separate follow-up rather than fixed here. Full narrative: §7
      "Closeout pass (2026-08-16) — full stack actually started; found the
      real, code-level blocker".
- [x] Unit test proves: a missing `HarnessGatewayService` dependency on a
      harness-enabled trigger throws — `note-generation.service.test.ts`
      tests (c) under `TRANSCRIPTION_CREATED` and `SUMMARY_REGENERATE`
- [x] The grep-gate test (Task 6) passes, self-tested to actually catch a
      regression (see above)
- [x] `pnpm lint` equivalent (package-scoped `pnpm --filter @arcaai/applications
      lint` + targeted `eslint` on every touched file) — zero new
      errors/warnings
- [x] Barrel `index.ts` for `note-generation/` exported;
      `NoteGenerationServiceModule` registered in `ConsultationJobServiceModule`,
      `SummaryServiceModule`, `ChainSummaryServiceModule`
- [x] Ticket README's Implementation Summary and Change History updated with
      actual command output pasted

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Wave-0 ticket-authoring agent |
| 2026-08-16 | Implemented Tasks 1–6 and 8 (seam, all seven entry points wired, grep-gate, verification); Task 5's sync `generateSummary` short-circuit deliberately withheld (HUMAN-GATED — see §6 and §7 "Deviations"); Task 7 e2e spec authored but not executed (no live/full stack in this session). Status → Review pending (a) product-owner sign-off on the Task 5 behavior change and (b) a live + `HARNESS_E2E_FULL` e2e run. | T2/T3 implementation agents (this session) |
| 2026-08-16 | Resolved all four owner-deferred "Lets review, suggest best practices" items in §6 with reasoning + evidence (full write-up in §7): (1) sync `generateSummary` decided to stay legacy-only PERMANENTLY, not pending — response-contract mismatch + duplicate-generation risk, code comment updated from HUMAN-GATED-pending to DECIDED with forward guidance for a future Wave-2 revisit; (2) harness's missing pre-summary/comprehensive-summary equivalent accepted as-is, re-verified the decision type needs no rework; (3) `HarnessGatewayService` required-dependency audited across every test fixture that constructs a seam caller — no regression; (4) Task 4/5 module fan-out risk confirmed moot (already landed clean). Brought up isolated test infra (`infra:test:up`), applied the migration ledger (`db:migrate:deploy`, not `--force-reset`), seeded, and ran `apps/api` + `pnpm test:e2e -- task-704-generator-seam` against a real live stack: entry point #4's job-creation path passed live; the follow-up job-status assertion hit a 500 caused by a concurrent sibling session's unrelated, in-flight consent-enforcement edit in this shared working tree (evidenced by file timestamps + `git status`, not a TASK-704 defect). Full applications suite re-run live (491/493 files, 9152/9157 tests; the one failure is in the unrelated consent domain, same concurrent-edit window). Status remains Review — the sync-`generateSummary` risk is now closed for good, but a clean Task 7 e2e run (plus the never-yet-attempted `HARNESS_E2E_FULL` full loop) is still outstanding, blocked on the shared tree quieting down rather than on this ticket's own code. | Sonnet 5 (this session) |
| 2026-08-16 | **CLOSE-OUT PASS.** Re-ran `pnpm test:e2e -- task-704-generator-seam` live against an already-running, already-seeded test stack (`RESET_DB=false`, no destructive reset): the creation-only case (entry point #4's `POST :id/summary/async` job creation) now passes cleanly, including the `GET jobs/:jobId` follow-up that previously hit a transient 500 from a concurrent sibling session's in-flight consent-enforcement edit — that edit window has since closed, confirming the prior failure was never a TASK-704 defect. Re-ran the full `applications` suite fresh: 493 files / 9183 tests, 0 failures (vs. the prior pass's 1 unrelated failure). The FULL-loop (`HARNESS_E2E_FULL=1`) assertions — requiring apps/harness + a Temporal worker + apps/text + apps/nlp running end to end — were NOT attempted; starting that stack is out of scope for this close-out pass and remains the one concrete gap before the ticket's literal §5 acceptance criterion is directly proven. Status remains Review, with the reason now narrowed to exactly one item. No application code changed. | Close-out pass agent |
| 2026-08-16 | **CLOSEOUT PASS — actually started the full stack.** Started `apps/text` (:8962), `apps/nlp` (:8964), `apps/harness` (:8966), and its Temporal worker locally against `.env.test`/isolated test infra (all already up), overriding harness's stale `.env.test` `HARNESS_SMR_BASE_URL`/`HARNESS_NLP_BASE_URL`/`HARNESS_API_BASE_URL` via host env to match the actually-running instances. Drove the loop manually with `curl` (not `pnpm test:e2e`, per this session's constraint) against an already-running sibling `apps/api` test instance on :8968: login, `POST summary/async` → 201, job polled to `COMPLETED` with `harnessJobId` set and zero legacy execution (reconfirms entry point #4's seam routing live, independent of Playwright), and confirmed the durable `HarnessDocWorkflow` genuinely started. **Found the real, code-level blocker**: `apps/harness`'s `SmrClient`/`NlpClient` (`smr_client.py`, `nlp_client.py`) never send `X-Service-Token`, so the `generate` activity 401s against `apps/text`'s `ServiceAuthMiddleware` (confirmed non-empty `TEXT_SERVICE_TOKEN`/`NLP_SERVICE_TOKEN` in both `.env.dev` and `.env.test`, i.e. not the dev-bypass case) — verified by direct code reading (zero `X-Service-Token` references in either client; contrast with `ApiClient`, which sends it correctly). This is a standing defect entirely outside this ticket's file scope, not an environment/timing issue and not fixable within TASK-704. Flagged as a separate out-of-scope follow-up rather than fixed here. Cleanly stopped all four locally-started processes at the end of the pass (verified zero orphans); the sibling `apps/api` instance was only queried, never modified, and remained healthy throughout. Status remains Review — the seam itself is reconfirmed correct; what remains unverified is harness's own ability to authenticate to apps/text/apps/nlp, a pre-existing gap in code this ticket never touches. Full narrative in §7. | Closeout pass agent (this session) |
| 2026-08-20 | **Re-verification pass: the `SmrClient`/`NlpClient` `X-Service-Token` blocker (flagged above) is confirmed CLOSED, and further evolved.** Directly inspected the current tree: `apps/harness/src/harness/services/smr_client.py` was renamed to `text_client.py` (TASK-707/740 `smr`→`text` identifier alignment) and both it and `nlp_client.py` build their `X-Service-Token`/`X-Tenant-Id` headers correctly. The per-target `HARNESS_SMR_SERVICE_TOKEN`/`HARNESS_NLP_SERVICE_TOKEN` fix TASK-738 shipped was itself superseded by owner decision D-D (2026-08-17): the tool-client factories in `activities.py` now resolve the token via `settings.peer_service_token(settings.{text,nlp}_service_token)` — the single shared `INTERNAL_ACCESS_TOKEN` wins, the per-peer token is a zero-cost legacy fallback. Re-ran the targeted suite fresh (`conda run -n arcaenv python -m pytest apps/harness/src/harness/tests/unit/services/test_nlp_client.py apps/harness/src/harness/tests/unit/services/test_text_client.py apps/harness/src/harness/tests/unit/temporal/test_activities.py apps/harness/src/harness/tests/unit/services/test_mandatory_tenant_header.py -q --no-cov`): **76 passed** (includes `TestToolClientFactoriesSendServiceToken`, the regression guard TASK-738 added). No application code changed in this pass — the fix was already complete and current; this entry just re-confirms it with fresh command output so `HARNESS_E2E_FULL`'s remaining blocker list can drop this item. **`HARNESS_E2E_FULL` itself was NOT re-attempted** (starting the full harness+worker+text+nlp+LLM stack was out of scope for this pass, and the shared dev machine was running many concurrent sibling sessions at the time — several background test invocations in this pass were killed by resource contention before this scoped, lightweight rerun succeeded). Status remains Review: the one concrete blocker this ticket's own closeout passes identified is now independently reconfirmed closed, but the ticket's literal §5 acceptance criterion (a live `HARNESS_E2E_FULL` run proving `SummaryMeta.assuranceCompletedAt`) still has not been executed by any pass. Not moved to Completed on this evidence alone. | Sonnet 5 (this session) |
