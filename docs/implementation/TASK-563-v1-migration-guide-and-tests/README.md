# TASK-563 — v1→v2 Migration Guide, Example & Contract/E2E Tests

| | |
|---|---|
| **Status** | Review |
| **Type** | docs + tests |
| **Parent** | [TASK-560](../TASK-560-v1-v2-consultation-migration/README.md) |
| **Depends on** | TASK-561 (SDK hooks) **and** TASK-562 (endpoints) landed |
| **Suggested tier** | sonnet-5-high (guide + example) · claude-opus-4-8-medium (contract/e2e tests) |

> **Goal:** Give application engineers a concrete, copy-pasteable migration path, prove it with a working example, and lock the v1 contract shapes with cross-version tests so future v2 changes can't silently break migrated apps.

---

## 1. Requirement Analysis

Three deliverables:
1. **Migration guide** — a v1→v2 mapping doc app engineers follow: import changes, the one `<AgenticProvider>`/`<ArcaCompatProvider>` wrapper, config adapter, hook-by-hook diffs, behavior notes (metadata sink, pull vs push transcripts, doctorId dropped), and the endpoint path parity table.
2. **Working example** — the full workflow (session → mixed-stream record → live transcripts → stop → summary) using `@arcaai/vox/compat`, runnable.
3. **Contract + e2e tests** — assert the compat SDK output and the shim endpoints match the frozen v1 shapes (TASK-560 §5).

## 2. Current State Evaluation

- `apps/example` is a deliberate raw-WebSocket demo (not an SDK consumer) — good host for a NEW compat example page, or add a `apps/example/src/compat-consultation.*`. Alternatively demonstrate in the playground consultation screen (TASK-543) — but keep the canonical example framework-light so v1 teams recognize it.
- v1 reference workflow to mirror 1:1: TASK-560 §J of the v1 SDK inventory (the exact code a v1 app writes today).
- Contract sources of truth: TASK-560 §5 + `SMR_Summary_Endpoints.md`.

## 3. Implementation Plan

### 3.1 Migration guide — `docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md`

Sections:
- **TL;DR checklist** (3 steps): wrap app once; swap imports `@arcaai/agentic-sdk` → `@arcaai/vox/compat`; map `SDK_CONFIG_OPTIONS` via `mapV1ConfigToAgenticConfig` (or use `<ArcaCompatProvider options={…}>`).
- **Side-by-side hook table**: v1 hook/method → v2 compat equivalent → behavior notes/caveats.
- **Behavioral differences that need app awareness** (from TASK-560 §2.2/§6): `doctorId` dropped (server-derived); transcripts are pull-state but `onTranscript` still fires; `sendAudioData` metadata is a sink; live backend transcription needs a `pipelineId`; mixed-stream is now real (`secondaryDeviceId`) — optional upgrade; summary returns per-turn segments now.
- **Endpoint parity table**: `/api/smr/api/v1/summary/sync` + `/presummary` unchanged path + `x-api-key`; async/session/STT-WS raw endpoints not reproduced (use SDK).
- **"What you must change vs. what stays"** matrix.
- **Before/after full code sample** (the §3.2 example inline).

### 3.2 Working example

- `apps/example/…/compat-consultation.tsx` (or a small standalone) implementing TASK-560 §J verbatim but on `@arcaai/vox/compat`, wrapped in `<ArcaCompatProvider>`. Demonstrates: `useArcaSessionManager` create+start, `useAudioCapture`+`useArcaSpeechToText` live transcript render (interim + final), stop, `useSMR.summarizeSync`, render `Enhanced` summary.
- README snippet: how to run it against a local gateway.

### 3.3 Contract tests

- **SDK contract** (`packages/agentic-sdk-v2` vitest): assert `@arcaai/vox/compat` hook return shapes match TASK-560 §5.2/§5.3 (type-level + runtime for `useSMR` response pass-through). A `expectTypeOf` / structural assertion that the v1 `SummaryResponse`/`MedicalSession` shapes are honored.
- **Endpoint contract** (`apps/api` e2e, may reuse TASK-562's spec or extend): POST real requests, validate responses against a JSON-schema copy of TASK-560 §5.4/§5.5 (Enhanced + Simplified + PreSummary). Include the `x-api-key` auth matrix and a cross-tenant isolation case.
- **Regression lock**: a golden fixture (a canned `SessionData`) + its expected structural response keys, so schema drift fails CI.

### 3.4 E2E workflow test (optional, if live stack available)

- Playwright driving the example: start session → feed a fixture audio (or mock STT) → assert transcript segments render → stop → assert a summary renders. Gate behind the same infra the SDK e2e uses; keep hermetic where possible.

### 3.5 Verification

- Guide reviewed against the actual compat API (no drift from TASK-561/562 as-built).
- Example builds and runs; screenshot/log evidence captured.
- Contract tests green in `pnpm --filter @arcaai/vox test` and `pnpm test:e2e`.

## 4. Best Practices

- Keep the guide honest about the *unavoidable* change (one Provider wrapper) — don't oversell "zero change."
- Golden fixtures live under `tests/` fixtures; reference TASK-560 §5 as the authority, don't restate schemas divergently.
- If TASK-561/562 changed any signature during build, update TASK-560 §5 first (source of truth), then this guide.

## 5. Implementation Summary

All three deliverables landed against the AS-BUILT compat code (TASK-561 SDK hooks
+ TASK-562 gateway shim), additive-only. No divergence from TASK-560 §5 was found
that required editing §5 first (the as-built `mapV2StatusToV1` is a superset of the
§5.2 mapping, and the optional `summarizeAsync`/`/summary/async` path is documented
honestly as outside the reproduced shim set per §5.6/D1) — so §5 stands unchanged.

### 5.1 Migration guide

- `docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md`
  — TL;DR 3-step checklist; the one unavoidable change (single
  `<ArcaCompatProvider>` wrapper); side-by-side v1→compat hook map; seven
  behavioral-difference notes (doctorId server-derived/`metadata.legacyDoctorId`;
  pull-state transcripts but `onTranscript` still fires; `sendAudioData` metadata
  sink; `pipelineId` for live backend STT; real mixing via `secondaryDeviceId` as
  an optional upgrade; per-turn segments F2; pause/resume local-only);
  endpoint-parity table (`/summary/sync` + `/presummary` byte-identical path +
  `x-api-key`; async/session/STT-WS raw endpoints NOT reproduced — SDK-driven);
  before/after full code sample; "what changes vs. what stays" matrix. Honest
  about the single Provider wrapper being unavoidable.

### 5.2 Working example

- `apps/example/src/compat-consultation.tsx` — the full workflow on
  `@arcaai/vox/compat` (framework-light plain React).
- `apps/example/src/compat-main.tsx` + `apps/example/compat.html` — a **second,
  additive** Vite entry mounting it wrapped in `<ArcaCompatProvider>` (the
  existing raw-WS demo `index.html` is untouched).
- Wiring: added `@arcaai/vox: workspace:*` to `apps/example/package.json`, a
  `typecheck` script, `src/vite-env.d.ts` (typed `import.meta.env`), and a
  multi-page `rollupOptions.input` in `vite.config.ts`. README gained a
  compat-example run snippet (env vars + `/compat.html`).
- **Builds + typechecks:** `pnpm --filter live-transcription-example typecheck`
  (tsc clean) and `pnpm --filter live-transcription-example build` both green —
  the build emits `dist/compat.html` + `dist/assets/compat-*.js` alongside the
  existing `index.html`.

### 5.3 Contract tests

- **SDK contract** (`packages/agentic-sdk-v2/src/compat/__tests__/contract.test.ts`)
  — type-level (`expectTypeOf`) locks on the §5.2/§5.3/§5.4 hook return shapes
  and v1 type surface (`MedicalSession`, `SummaryResponse`, `SMRRequest`, …),
  plus runtime checks: barrel exports the v1 names, `mapV2StatusToV1` honors
  §5.2, and `useSMR` passes the shim `SummaryResponse`/`PreSummaryResponse` body
  through **unchanged**. Runs in `pnpm --filter @arcaai/vox test`.
- **Endpoint contract (JSON-schema lock)** — zod schemas
  `tests/contracts/smr-compat.schemas.ts` mirroring §5.4/§5.5 (Enhanced +
  Simplified + SummaryResponse envelope + PreSummaryResponse + SessionData
  request); golden fixtures `tests/fixtures/smr-compat.fixture.ts`; hermetic
  regression test `tests/contracts/smr-compat.contract.test.ts` validating the
  goldens AND asserting drift bites (missing v1-required key → parse fails).
- **E2E extension** — `apps/api/tests/e2e/task-562-smr-compat.spec.ts` now
  validates a LIVE 200 response against the shared `SummaryResponseSchema` /
  `PreSummaryResponseSchema`. Hermetic when SMR is down (status ≠ 200 → shape
  check skipped); requires the live gateway (`pnpm test:up:api`) + SMR :8862 to
  exercise the 200 path.

### 5.4 Verification evidence

```
$ pnpm --filter @arcaai/vox test
 Test Files  212 passed (212)
      Tests  3613 passed (3613)        # +13 from contract.test.ts

$ npx vitest run tests/contracts/smr-compat.contract.test.ts
 Test Files  1 passed (1)
      Tests  18 passed (18)

$ pnpm --filter live-transcription-example typecheck   # tsc --noEmit → clean
$ pnpm --filter live-transcription-example build        # vite build → dist/compat.html + compat-*.js emitted

$ pnpm --filter @arcaai/vox lint                         # 0 errors (3 pre-existing warnings elsewhere)
```

### 5.5 Files

**Created:** `docs/.../TASK-560-.../MIGRATION_GUIDE.md`;
`apps/example/src/compat-consultation.tsx`, `apps/example/src/compat-main.tsx`,
`apps/example/compat.html`, `apps/example/src/vite-env.d.ts`;
`packages/agentic-sdk-v2/src/compat/__tests__/contract.test.ts`;
`tests/contracts/smr-compat.schemas.ts`, `tests/contracts/smr-compat.contract.test.ts`,
`tests/fixtures/smr-compat.fixture.ts`.
**Edited:** `apps/example/package.json`, `apps/example/vite.config.ts`,
`apps/example/README.md`; `apps/api/tests/e2e/task-562-smr-compat.spec.ts`;
this README.

### 5.6 Follow-ups / out of scope

- The live Playwright happy-path (schema validation of a real 200) needs a booted
  SMR :8862 behind the gateway — gate behind `pnpm test:up:api` + `pnpm test:e2e -- task-562`.
- The compat example is not auto-run in CI (no headed-browser e2e for `apps/example`);
  it is covered by typecheck + build. A driven-browser walkthrough against a live
  stack is a manual step (TASK-563 §3.4, optional).

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-27 | (planning) | Ticket created from TASK-560. |
| 2026-07-28 | (impl) | Delivered all three: MIGRATION_GUIDE.md; compat example (`apps/example` second Vite entry, builds+typechecks); SDK contract test (+13, `@arcaai/vox` 3613 green) and hermetic endpoint JSON-schema lock (18 green) + golden fixture + TASK-562 e2e live-schema extension. Additive-only; no §5 divergence. Status → Review. |
