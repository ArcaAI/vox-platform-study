# TASK-660 — Loop Event Plane

**Status:** Completed

**Wave:** W2 · **Tier:** sonnet-5 / medium · **Depends on:** TASK-658 (merged `55fa735c5`)

**Base commit:** `370a3672b` on `dev-2.1` (`docs(TASK-654): Wave 1 merged; add build-order and db:migrate contract notes`). This worktree spawned from `main` (the known repo default) — reset with `git reset --hard dev-2.1` before any work, per execution-plan §1.1.

## 1. Requirement Analysis

Context events must reach the (future, TASK-662) `ConsultationLoopWorkflow`, and loop output must reach the client. This ticket builds ONLY the plumbing — no workflow, no reasoning, no agent config. Scope, in order (per execution-plan §"TASK-660"):

1. **Filter the existing consumers FIRST.** `ConsultationPipelineEvent.ContextAdded` is gated by `LIVE_CONTEXT_TYPES` in `context.service.ts`. Two consumers rely on that gate today (`LiveDocumentationService.handleContextAdded`, `OcrEnrichmentProcessor.handleContextAdded`) — each needed an explicit kind filter BEFORE the gate widens, proven by tests, so neither starts seeing traffic it was not written for.
2. **Then widen the gate** so transcripts and derived kinds also emit `ContextAdded`.
3. **New listener** — `@OnEvent(ConsultationPipelineEvent.ContextAdded)` on a new service that signals the loop. No controller/route change (same pattern as `OcrEnrichmentProcessor`). No-op when no loop is configured.
4. **New signal method** on `HarnessGatewayService` — copy `signalEdit` verbatim, swap URL suffix + payload interface.
5. **New SSE stream** `consultation:loop:{id}` following the trajectory exemplar precisely.

### 1.1 Must not change

LiveDoc's internals (`flush`, `buildSmrUserPrompt`, `groundEntitiesToNote`, the generation-counter/`AbortController` supersede machinery, the throttle) — only the kind filter at its `@OnEvent` entry. The clinical invariants (SMR before NER; NER over the raw transcript delta; entities dropped if absent from the rendered note). The `LIVE_SOAP_SNAPSHOT` + `metaData.agent` lineage seam. The three existing SSE streams. `apps/harness/.../workflows.py`.

### 1.2 Concurrency boundary

TASK-659 (agent config) and TASK-661 (schema compatibility) run in parallel worktrees against the same wave. TASK-661 owns `packages/applications/src/services/consultation-context-schema/**` and the validation-hook region of `context.service.ts` (`resolveContextKind`, ~line 202). This ticket touches ONLY the `LIVE_CONTEXT_TYPES` region (~line 64) of that file — kept minimal and localized so the three parallel merges don't collide.

## 2. Current State Evaluation

Verified against `dev-2.1` @ `370a3672b`:

- `LIVE_CONTEXT_TYPES` (`context.service.ts:65`, pre-change) = `{WORKNOTE, CASE_NOTE, ATTACHMENT}`. Used at TWO call sites in the same file: `addContext` (emits `ContextAdded`) and `deleteContext` (emits `ContextRemoved`) — both gates share the one `Set`.
- `LiveDocumentationService.handleContextAdded` had **no kind filter at all** — it reacted to every `ContextAdded` emission, relying entirely on the upstream gate to keep transcripts/derived kinds out.
- `OcrEnrichmentProcessor.handleContextAdded` **already** carried an explicit, positive-allowlist filter — `if (payload.contextType !== ContextItemType.ATTACHMENT) return;` (line 95) — because it was written to react to attachments only. This is a POSITIVE check (`=== ATTACHMENT`), not a denylist of the pre-widening kinds, so it already tolerates new kinds arriving on the gate without any code change. A pre-existing unit test (`ignores non-ATTACHMENT context types (no DB read)`) already proved this; two more cases (TRANSCRIPT, STRUCTURED) were added for direct evidence against this ticket's specific widening.
- `TRANSCRIPT` ContextItems are, in production, written by `sttInternal.service.ts` directly via `ContextItemFactory.CreateContextItem` — NOT through `ContextService.addContext`. That path emits a *different* event, `TranscriptionCreated`, and never touches `LIVE_CONTEXT_TYPES`. Widening the gate therefore does not change what the STT pipeline emits; it changes what `ContextService.addContext` emits when a caller passes `type: TRANSCRIPT` (a legal `AddContextRequest.type` value today — the DTO's `@IsEnum(ContextItemType)` already allowed it).
- `STRUCTURED` is the tenant-declared context primitive TASK-658 added to `ContextItemType` — the concrete "derived kind" the README's §4.2 cascade language refers to.
- `HarnessGatewayService` had three outbound signal-shaped methods (`start`, `signalApproval`, `signalEdit`) — `signalEdit` (`:188-201`) is the exact shape to copy: `POST {harnessUrl}/api/v1/internal/workflows/:id/signal/<verb>` with `X-Service-Token` + JSON body.
- The trajectory SSE stream (`consultation.controller.ts:566-608`) is the simplest of the four existing streams: no snapshot, no fold, plain `merge(relay$, heartbeat$)` over `RedisSubscriberService.subscribeToChannel`, reusing the shared `TRAJECTORY_HEARTBEAT_MS` (`:177`) constant. `AgentTrajectoryService`'s `republishToLiveView` (`:339-356`) is the matching publisher-side shape: a plain `cacheService.publish(channel, JSON.stringify(...))`, best-effort, no fold. `HarnessProgressService`/`HarnessAssuranceService` are the WRONG exemplar for this ticket — they carry snapshot/fold/late-join logic the spec explicitly does not ask for ("following the trajectory exemplar precisely").
- `HarnessInternalController`'s `reportProgress` route (`:334-342`) is the exact internal-POST shape to copy: `@Post(...)`, `@HttpCode(200)` (best-effort ack, not a created resource), no `Idempotency-Key` (nothing durable is written).

## 3. Implementation Plan

### 3.1 Step 1 — consumer filters (commit stage a)

- `LiveDocumentationService`: add a private `LIVE_DOC_CONTEXT_TYPES` set (`{WORKNOTE, CASE_NOTE, ATTACHMENT}` — the pre-widening membership of `LIVE_CONTEXT_TYPES`) and an early return in `handleContextAdded` when `payload.contextType` is not in it.
- `OcrEnrichmentProcessor`: no code change (filter already present, already correct shape); added two regression tests (TRANSCRIPT, STRUCTURED) directly evidencing the widening this ticket introduces.

### 3.2 Step 2 — widen the gate (commit stage b)

- `context.service.ts`: add `ContextItemType.TRANSCRIPT` and `ContextItemType.STRUCTURED` to `LIVE_CONTEXT_TYPES`. Because `deleteContext` shares the same `Set`, `ContextRemoved` also now fires for these two kinds on delete — verified safe: `LiveDocumentationService.handleContextRemoved` filters by `contextItemId` membership in its own tracked-notes list, and since `handleContextAdded`'s new filter means TRANSCRIPT/STRUCTURED never get added to that list, the remove path is a no-op for them by construction (no additional filter needed there).
- Updated one pre-existing test (`context.service.context-added.test.ts`) that asserted the OLD "TRANSCRIPT does NOT emit" behavior — flipped to assert the NEW "TRANSCRIPT DOES emit" behavior, plus a new STRUCTURED case. Updated one pre-existing test (`context.service.test.ts`, the `deleteContext` describe block) that used TRANSCRIPT as its "non-live type" example — swapped to `AUDIO_RECORDING`, which stays outside the widened set (a media container with no text content).

### 3.3 Step 3 — listener + gateway signal (commit stage c)

- `HarnessGatewayService.signalContextAdded(consultationId, payload)` — copies `signalEdit` verbatim: `POST {harnessUrl}/api/v1/internal/workflows/:id/signal/context-added`, `X-Service-Token` header, same best-effort semantics. New `HarnessContextAddedSignal` interface.
- New `LoopContextSignalService` (`packages/applications/src/services/consultation/loop/loop-context-signal.service.ts`) — `@OnEvent(ConsultationPipelineEvent.ContextAdded)`, calls `HarnessGatewayService.signalContextAdded`. Registered as a new provider in `LiveDocumentationServiceModule` (imports `HarnessGatewayServiceModule`) — exactly how `OcrEnrichmentProcessor` was added: no controller, no route.
  - **No-op when no loop is configured**: gated behind `HARNESS_LOOP_ENABLED` (`ConfigService.get`, `=== 'true' || === '1'`, default OFF) — the same plain-env-flag posture as `OCR_ENABLED`/`HARNESS_WARM_START_ENABLED`. A real per-tenant/per-consultation loop policy is TASK-659/662's job.
  - **Idempotent under duplicate emission**: a bounded in-memory `Set<string>` keyed on `${consultationId}:${contextItemId}:${timestamp}` — the same triple that makes two emissions "the same event" (a re-emit with fresh content, e.g. `OcrEnrichmentProcessor`'s enrichment re-fire, carries a NEW timestamp and is correctly treated as a new signal, not a duplicate).
  - **Best-effort**: a `signalContextAdded` rejection is logged and swallowed — the context-add path must never fail because the loop is unreachable.

### 3.4 Step 4 — SSE plane (commit stage d)

- `ConsultationLoopEventService` (`.../loop/consultation-loop-event.service.ts`) — the publisher. Channel prefix `consultation:loop:`, one method `publishEvent(consultationId, dto)`, plain `cacheService.publish` (no fold/snapshot), best-effort `{ ok: boolean }` ack. New `ConsultationLoopEventServiceModule` (Redis-only wiring, mirrors `HarnessProgressServiceModule`).
- `HarnessInternalController`: new `POST consultations/:id/loop-event` route, `@HttpCode(200)`, delegates to `ConsultationLoopEventService.publishEvent`. No `Idempotency-Key` — nothing durable is written (mirrors `progress`/`assurance-event`, not the WORM callbacks).
- `ConsultationController`: new `GET :id/loop/stream` route — `@Sse()` + `@TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })` + `@StreamScope({ namespace: 'consultation_loop', param: 'id' })`, byte-for-byte the same `merge(relay$, heartbeat$)` shape as `streamTrajectory`, reusing the SAME `redisSubscriber` field and the SAME `TRAJECTORY_HEARTBEAT_MS` constant (no new field, no new constant).
- New DTOs (`.../loop/dto/loop-event.dto.ts`): `HarnessLoopEventRequest` (class-validator request body), `HarnessLoopEventAck`, `LoopEventDto` (the wire shape published on the channel).
- Wired `ConsultationLoopEventServiceModule` into `apps/api`'s `consultation.module.ts` (imports + controllers already there).

### 3.5 TDD list → where it's proven

| TDD item | Test |
|---|---|
| Widening emits for transcripts | `context.service.context-added.test.ts` — `emits ContextAdded for a TRANSCRIPT (loop event plane widening)`, `...for a STRUCTURED item...` |
| LiveDoc ignores kinds outside its filter (regression) | `live-documentation.service.test.ts` — new `describe('ContextAdded kind filter (regression — TASK-660 widening)')` (3 cases) |
| OCR ignores non-attachments (regression) | `ocr-enrichment.processor.test.ts` — pre-existing WORKNOTE case + new TRANSCRIPT/STRUCTURED cases |
| Loop signal is idempotent under duplicate emission | `loop-context-signal.service.test.ts` — `is idempotent under duplicate emission...`, plus a companion case proving a re-emit with a NEW timestamp is NOT treated as a duplicate |
| The new listener is a no-op when no loop is configured | `loop-context-signal.service.test.ts` — unset / `false` cases |
| SSE relays events and emits heartbeats | `consultation.controller.loop.test.ts` — relay case + fake-timer heartbeat case |
| Cross-tenant consultation id → 404, not 403 | `consultation.controller.loop.test.ts` — `@TenantOwnedResource(Consultation/id)` decorator-metadata assertion (same level of proof as the pre-existing trajectory-stream test; the global `TenantOwnedResourceSseGuard` is what actually enforces the 404 at runtime and is covered by its own suite). A live-stack Playwright cross-tenant probe (mirroring `harness-progress-stream-cross-tenant.spec.ts`) was NOT added — `pnpm test:e2e` is not one of this ticket's gates and no live Postgres/Redis stack was available in this worktree; of the four existing SSE streams, only `harness-progress` has a dedicated e2e spec, the other three (including the `streamTrajectory` this route mirrors) rely on the same decorator-metadata unit test alone. |

## 4. Implementation Summary

### 4.1 Files changed

**Widening (my owned region only) + regression filters**
- `packages/applications/src/services/consultation/context/context.service.ts` — `LIVE_CONTEXT_TYPES` widened to add `TRANSCRIPT`, `STRUCTURED` (lines ~59–72 only; did not touch `resolveContextKind` / the TASK-661-owned validation-hook region).
- `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` — new `LIVE_DOC_CONTEXT_TYPES` filter + early return in `handleContextAdded`; `ContextItemType` import added.
- `packages/applications/src/services/consultation/context/__tests__/context.service.context-added.test.ts` — TRANSCRIPT test flipped from "does NOT emit" to "emits"; new STRUCTURED case; header comment corrected.
- `packages/applications/src/services/consultation/context/__tests__/context.service.test.ts` — `deleteContext` "non-live type" example changed from TRANSCRIPT to AUDIO_RECORDING (TRANSCRIPT moved into the live set).
- `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.service.test.ts` — new regression `describe` block (3 cases).
- `packages/applications/src/services/consultation/ocr/__tests__/ocr-enrichment.processor.test.ts` — 2 new regression cases (TRANSCRIPT, STRUCTURED).

**Gateway signal**
- `packages/applications/src/services/consultation/harness/harness-gateway.service.ts` — new `HarnessContextAddedSignal` interface + `signalContextAdded` method.
- `packages/applications/src/services/consultation/harness/__tests__/harness-gateway.service.test.ts` — new `describe('signalContextAdded')` (2 cases).

**New listener**
- `packages/applications/src/services/consultation/loop/loop-context-signal.service.ts` (new)
- `packages/applications/src/services/consultation/loop/__tests__/loop-context-signal.service.test.ts` (new, 6 cases)
- `packages/applications/src/services/consultation/live-documentation/live-documentation.service.module.ts` — registers `LoopContextSignalService` as a provider; imports `HarnessGatewayServiceModule`.

**SSE plane**
- `packages/applications/src/services/consultation/loop/dto/loop-event.dto.ts` (new)
- `packages/applications/src/services/consultation/loop/dto/index.ts` (new)
- `packages/applications/src/services/consultation/loop/consultation-loop-event.service.ts` (new)
- `packages/applications/src/services/consultation/loop/consultation-loop-event.service.module.ts` (new)
- `packages/applications/src/services/consultation/loop/index.ts` (new barrel)
- `packages/applications/src/services/consultation/loop/__tests__/consultation-loop-event.service.test.ts` (new, 3 cases)
- `packages/applications/src/services/consultation/index.ts` — `export * from './loop'`
- `apps/api/src/modules/consultation/harness-internal.controller.ts` — new `reportLoopEvent` route + constructor param.
- `apps/api/src/modules/consultation/__tests__/harness-internal.controller.test.ts` — 5 constructor call sites updated (new trailing param) + new `describe` block (3 cases).
- `apps/api/src/modules/consultation/consultation.controller.ts` — new `streamLoop` route.
- `apps/api/src/modules/consultation/__tests__/consultation.controller.loop.test.ts` (new, 5 cases)
- `apps/api/src/modules/consultation/consultation.module.ts` — wires `ConsultationLoopEventServiceModule`.

**Other**
- `turbo.json` — touched then reverted by `pnpm env:sync` (see §4.3). `HARNESS_LOOP_ENABLED` is a plain, undeclared `ConfigService` read (same posture as `OCR_ENABLED`), NOT registered in the settings-registry — see §4.4.

### 4.2 New channel / route names

- Redis channel: `consultation:loop:{consultationId}` — append-only, no snapshot, no fold (mirrors `consultation:trajectory:{id}`).
- Internal POST (harness → gateway): `POST /api/v1/internal/harness/consultations/:id/loop-event`.
- Outbound signal (gateway → harness, best-effort, receiver not built until TASK-662): `POST {HARNESS_URL}/api/v1/internal/workflows/:id/signal/context-added`.
- Client SSE: `GET /api/v1/consultations/:id/loop/stream` (`@StreamScope` namespace `consultation_loop`).

### 4.3 The `turbo.json` detour

Initially hand-added `HARNESS_LOOP_ENABLED` to `turbo.json#globalEnv` to declare the new env knob. Running `pnpm env:sync` (needed anyway, to check for drift before the `env-sync.test.ts` gate) **reverted** that addition: `turbo.json#globalEnv` is machine-generated from the settings-registry ∪ the API/admin-console/tools env descriptors ∪ a scan of literal `process.env.X` reads (`scripts/env-sync.mts`) — a `ConfigService.get('X')` read is invisible to that scan, and `HARNESS_LOOP_ENABLED` was never registered as a settings-registry descriptor. Registering it there (mirroring `harness.warmStartEnabled` in `feature-flags.descriptors.ts`) would have been the "proper" alternative, but it is real governed surface (kill-switch invariants, `fail-mode.governance.test.ts` coverage, category listings) — heavier than this ticket's placeholder "is a loop configured at all" gate needs. `OCR_ENABLED` — the closest precedent, a plain deploy-time capability flag — is ALSO not registered and not in `turbo.json`/`.env.sample` today, so `HARNESS_LOOP_ENABLED` following the same (undeclared) posture is consistent with the existing codebase, not a new gap. `git diff` on `turbo.json` and every generated env artifact is empty after the final `pnpm env:sync` run — no drift.

### 4.4 Cascade side-effect verified safe

Widening `LIVE_CONTEXT_TYPES` affects BOTH `addContext` (`ContextAdded`) and `deleteContext` (`ContextRemoved`) since they share the one `Set`. `LiveDocumentationService.handleContextRemoved` was not given an explicit kind filter (the ticket only named `handleContextAdded`) because it is safe by construction: it looks up the incoming `contextItemId` in `session.contextNotes`, and since the ADD path's new filter guarantees a TRANSCRIPT/STRUCTURED item is never added to that list, the REMOVE path finds no match and no-ops. Confirmed by reading `handleContextRemoved`'s body — no test asserts this affirmatively today (it already existed before this ticket and is not part of the given TDD list), but it did not need to change and no `applications` test broke because of the widening.

## 5. Verification Evidence

Build order followed per execution-plan §1.1b: `pnpm install` → `pnpm db:generate` → `@arcaai/database` build → `@arcaai/domains` build → `@arcaai/applications` build → tests → `apps/api` build → `pnpm test:unit` (which additionally needs `room`, `noise-filter`, `vad`, `stt`, `med-ner`, `vox`, `ui` built first) → `pnpm lint`.

No live Postgres was available in this worktree; `DATABASE_URL`/`DIRECT_URL` were set to a placeholder connection string on the command line for `prisma generate` (schema-only, no live connection needed) and `tsc`/build steps that read `IConfigService` types at compile time. No migration, no schema change, no `db:push`/`db:migrate` — this ticket carries none.

### `pnpm --filter @arcaai/applications build`

```
> @arcaai/applications@0.0.1 build
> rimraf dist tsconfig.tsbuildinfo && tsc
EXIT:0
```

### `pnpm --filter @arcaai/applications test`

```
 Test Files  461 passed | 1 skipped (462)
      Tests  8699 passed | 4 skipped (8703)
   Duration  51.82s
```

Baseline (per execution-plan): 459 files / 8,685 tests. This run: 461 files / 8,699 tests — +2 files (`loop/__tests__/*`), +14 tests net (9 new in the `loop` folder + 2 new OCR regression cases + 3 new LiveDoc regression cases + 2 new harness-gateway `signalContextAdded` cases, minus the 1 existing TRANSCRIPT-context-added test that was rewritten in place rather than duplicated). Zero failures.

(One RED was observed and fixed during development, not shipped: `loop-context-signal.service.test.ts`'s "no-op when unset" case initially failed because `buildDeps(undefined)` — with a `= 'true'` default parameter — silently substituted the default for an explicitly-passed `undefined`, a classic JS gotcha; the default was removed so `buildDeps()`/`buildDeps(undefined)` genuinely leaves the config mock unset.)

### `pnpm api:build`

```
 Tasks:    9 successful, 9 total
Cached:    0 cached, 9 total
```

### `pnpm test:unit`

```
 Test Files  967 passed | 2 skipped (969)
      Tests  16466 passed | 10 skipped | 9 todo (16485)
   Duration  123.40s
```

Plus the workspace-scoped `test` scripts turbo also runs in this pipeline (`@arcaai/vox`, `@arcaai/ui`, `apps/compat-playground`, `apps/admin-console`) — all green:

```
packages/ui test:              Test Files  242 passed (242)   / Tests  656 passed (656)
packages/agentic-sdk-v2 test:  Test Files  255 passed (255)   / Tests 4131 passed (4131)
apps/compat-playground test:   Test Files   21 passed (21)    / Tests  223 passed (223)
apps/admin-console test:       Test Files  172 passed (172)   / Tests 1339 passed (1339)
```

### `pnpm lint`

```
@arcaai/applications:lint: ✖ 187 problems (0 errors, 187 warnings)
@arcaai/api:lint: ✖ 65 problems (0 errors, 65 warnings)
 Tasks:    31 successful, 31 total
```

`apps/api`'s warning count matches the stated baseline exactly (65 pre-existing warnings). Zero errors anywhere. Grepping the full lint output for every file this ticket touched or added (`loop`, `context.service.ts`, `live-documentation.service.ts`, `harness-gateway.service.ts`, `consultation.controller.ts`, `harness-internal.controller.ts`, `consultation.module.ts`, `live-documentation.service.module.ts`) surfaces zero new warnings — the one hit (`consultation.controller.ts`, pre-existing `eslint-comments/require-description` warnings at lines 1122/1138/1159/1173) is unrelated: those are pre-existing directive comments far below where `streamLoop` was inserted (~line 609).

### `pnpm env:sync` (drift check)

```
$ git diff --stat turbo.json .env.sample apps/api/.env.sample apps/harness/.env.sample \
    apps/admin-console/.env.sample packages/tools/.env.sample \
    docs/implementation/TASK-558-Environment-Configuration-Refactor/env-surface.generated.md
(empty — no drift)
```

## 6. Commits

Staged in the order the "Must not change" / risk-ordering section of the ticket demands (consumer filters land before the gate widens):

| Stage | Commit | Contents |
|---|---|---|
| (a) consumer filters | — | `LiveDocumentationService` kind filter + regression tests; OCR regression tests (no code change needed there) |
| (b) gate widening | — | `LIVE_CONTEXT_TYPES` widened; updated pre-existing tests that asserted the old behavior |
| (c) listener + gateway signals | — | `HarnessGatewayService.signalContextAdded`; `LoopContextSignalService` + wiring |
| (d) SSE plane | — | `ConsultationLoopEventService` + DTOs + module; `HarnessInternalController`/`ConsultationController` routes; `consultation.module.ts` wiring |

(SHAs filled in after commit — see `git log --oneline -5` in the final report.)

## 7. Incomplete / Deferred

- **Live-stack Playwright cross-tenant e2e** for `GET :id/loop/stream` was not added (see §3.5 TDD table) — consistent with 3 of the 4 existing streams, and outside this ticket's stated gates (`pnpm test:e2e` not listed).
- **The receiving side of `signalContextAdded`** (an actual `contextAdded` Temporal signal handler in `apps/harness`) does not exist yet — this is TASK-662's job. Until then the outbound POST from `LoopContextSignalService` will 404 against a real harness deployment when `HARNESS_LOOP_ENABLED=true`; the caller already treats this as best-effort/non-fatal.
- **`HARNESS_LOOP_ENABLED` is a placeholder flag**, not a real loop-configuration surface (per-tenant/per-consultation policy is TASK-659/662's job). It exists only so this ticket's "no-op when no loop is configured" requirement is genuinely testable and defaults safely OFF.

## Change History

- 2026-08-11 — Initial implementation (this document).
- 2026-08-12: Status corrected to Completed — verified via git log (commit `f39c9d810`); implementation confirmed merged. Doc header was stale.
