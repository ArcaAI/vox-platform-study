# TASK-673 — SDK deferred tails

- **Status:** Review
- **Type:** bugfix / feature (small)
- **Wave:** Follow-up to [TASK-665](../TASK-665-SDK-Schema-Discovery/README.md) (W4 of [TASK-654](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md))
- **Baseline:** `dev-2.1` @ `d5c43c033` (merge(TASK-666): admin console context schema editor)
- **Worktree:** `agent-a38b3348b430b9186` — spawned checked out to a stale local branch off `dev` (a merge of `fix/bucket-role-issues`, HEAD `180d09d6a`), NOT `dev-2.1`. `git reset --hard dev-2.1` performed before any work, per the mandatory Step 0 check.
- **Spec:** TASK-665 README §6 "Incomplete / explicitly out of scope"

---

## 1. Requirement Analysis

TASK-665 shipped SDK schema discovery, validated context-add, and the loop-event hook, but its own README named three items still open. This ticket closes all three:

| # | Item | Source |
|---|---|---|
| 1 | Department-scoped discovery preference at mount (+ tenant-switch replication) | TASK-665 §6, D-2: "not wired... a follow-up can wire it once `me.departmentId` matters enough to justify a second request in the mount path" |
| 2 | `useArca()`'s aggregate `context` object never exposed `addAttachment` | TASK-665 §6: "noticed while implementing AC-5, NOT fixed here: out of scope for this ticket" |
| 3 | No test proved the `mediaId` round trip (`useStorage().uploadFile()` → `addAttachment` → `ContextItem.mediaId`) end to end in the SDK | Explicit ask — closes the loop on the TASK-656/665 fix chain |

### 1.1 Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | `AgenticProvider` mount prefers a DEPARTMENT-scoped consultation-schema bundle over the tenant-scoped default once `me.departmentId` is known, falling back to tenant scope when it is not |
| AC-2 | The same preference is replicated in the tenant-switch rehydrate effect |
| AC-3 | `useArca().context.addAttachment` exists, matches `useArcaContext().addAttachment`'s signature (`(content?, metadata?, mediaId?) => Promise<ContextItem>`), and forwards `mediaId` |
| AC-4 | A test proves `useStorage().uploadFile()` → `mediaId` → `addAttachment` → a `ContextItem` that carries the same `mediaId` |
| AC-5 | Additive-only on the six shared modules (`src/compat.ts`, `src/compat/**`, the `compat` tsup block, `"./compat"` exports, `docs/Compat-API-Reference.md`, and the shape/signature of `AgenticConfig`/`Consultation`/`AudioProcessingConstraints`/`AgenticClient`/`SSEClient`/`agenticStore` selectors/`useArcaAudio`/`useArcaSession`) — none of those files are touched at all |
| AC-6 | `apps/compat-playground` builds |
| AC-7 | No new dependencies (valibot stays the only validator; no Ajv/Zod) |

---

## 2. Current State Evaluation

Verified against `dev-2.1` @ `d5c43c033`, before any TASK-673 code.

| Area | Finding |
|---|---|
| `fetchConsultationSchema` (`ConsultationSchemaClient.ts`) | Already accepts `{ departmentId? }` and builds `?departmentId=` on the query string — TASK-665 built the option bag but never called it with a value. No change needed here. |
| `AgenticProvider` mount sequence | The schema fetch (`consultationSchemaPromiseRef`) is kicked off EAGERLY, before `/auth/me` resolves (so the no-credentials path still populates the store). `me.departmentId` only becomes known at Step 1, inside `init()`, well after the eager fetch already started — this is exactly why TASK-665 left it as D-2 rather than wiring it blind. |
| `AgenticProvider` tenant-switch rehydrate effect | `effectiveDepartmentId` (`impersonated?.departmentId ?? authUser?.departmentId ?? null`) is ALREADY computed in the effect's closure (used by the Step-3/F-9 department prompt-config re-fetch at the bottom of the same effect) — by the time the schema re-fetch runs, the incoming identity's department is already known, so no two-fetch dance is needed there (unlike mount). |
| `useArcaContext().addAttachment` | Already exists with the exact target signature (`(content?, metadata?, mediaId?) => Promise<ContextItem>`), added by TASK-665 AC-5. Confirmed by reading `useArcaContext.ts:164-200`. |
| `useArca.ts`'s `UseArcaContext` interface | Confirmed missing `addAttachment` entirely (also missing `addWorknote`/`fetchWorknotes`/`fetchAttachments`, which are NOT in this ticket's scope — TASK-665 named only `addAttachment` as the noticed gap). `useArca.ts` implements its own local action closures (`addCaseNote`, `addTranscription`, ...) against the raw store rather than delegating to `useArcaContext()` — `addAttachment` needed the same treatment, not a delegation. |
| `useArca.ts` compat usage | `useArca` (the aggregate god-hook) is not imported anywhere under `src/compat.ts`, `src/compat/**`, or `apps/compat-playground/src` — confirmed by grep. Safe to extend freely; not one of the six shared modules anyway. |
| `mediaId` round trip | `StorageFile.mediaId` (`useStorage.ts`), `ContextItem.mediaId`/`AddContextInput.mediaId` (`types/context.ts`), and `addAttachment`'s `mediaId` parameter all exist (TASK-656/665). `useArcaContext.addAttachment.task665.test.ts` proves the POST body carries `mediaId` when supplied, but no test exercises `useStorage().uploadFile()` and `addAttachment()` TOGETHER — the actual caller-facing round trip was unverified. |

---

## 3. Implementation Plan (as executed)

| # | Layer | Files |
|---|---|---|
| 1 | Provider (mount) | `src/providers/AgenticProvider.tsx` — Step 1 gains a conditional department-scoped re-fetch once `me.departmentId` resolves; the eager tenant-scoped `.then()` is guarded against a stale write; Step 4.5 awaits the resolved (department-or-tenant) promise |
| 2 | Provider (tenant switch) | `src/providers/AgenticProvider.tsx` — the rehydrate effect's schema re-fetch now passes `{ departmentId: effectiveDepartmentId ?? undefined }`, already known in that closure |
| 3 | Hook | `src/hooks/useArca.ts` — `UseArcaContext.addAttachment` added to the interface; implementation added (mirrors `addCaseNote`/`addTranscription`); wired into the `context` `useMemo` (both the object and its deps array) |
| 4 | Tests | 3 new test files (see §5 AC → test map) |

### 3.1 TDD list (RED first) → what actually drove code

| # | Test | Drove |
|---|---|---|
| 1 | Department-scoped bundle requested when a department is known | `AgenticProvider.consultationSchema.task671.test.ts` — "prefers the DEPARTMENT-scoped bundle when a department is known at mount". Confirmed RED against the pre-change provider (`git stash` on `AgenticProvider.tsx` alone): assertion failed with `'tenant-version'` received where `'department-version'` was expected. |
| 2 | Falls back to tenant scope when it is not known | Same file — "falls back to the TENANT-scoped bundle when no department is known". This case was ALREADY correct pre-change (D-2's existing behaviour) — included for completeness/regression coverage, not because it was RED. |
| 3 | Department scope is re-resolved on tenant switch | Same file — "re-resolves department scope on a same-tab tenant switch". Confirmed RED the same way: pre-change received `'A-tenant-version'` where `'A-department-version'` was expected. |
| 4 | `useArca().context.addAttachment` exists and forwards `mediaId` | `useArca.api.test.ts` — new `context.addAttachment()` describe block. Confirmed RED against the pre-change hook (`git stash` on `useArca.ts` alone): `TypeError: result.current.context.addAttachment is not a function`. |
| 5 | The full upload → attach → context-item `mediaId` round trip | `mediaId.uploadToAttachment.task671.test.ts` (new file) — this test passed immediately once written (both halves of the round trip already existed from TASK-656/665; it was the COMPOSED path, not either half, that was unverified). Kept as a permanent regression guard against the exact bug class (`mediaId` vs. raw storage `key` confusion) named in the ticket. |

---

## 4. Implementation Summary

**Status: Review.** All three items implemented and covered by tests; every gate green.

### 4.1 Department-scoped discovery preference (mount)

`AgenticProvider.tsx`, inside `init()`'s Step 1 (right after `/auth/me` resolves, before the existing `if (me) { ... }` block):

```ts
let effectiveSchemaPromise = consultationSchemaPromise;
if (me?.departmentId) {
  const departmentSchemaPromise = fetchConsultationSchema(apiClient, providerLogger, {
    departmentId: me.departmentId,
  });
  consultationSchemaPromiseRef.current = departmentSchemaPromise;
  effectiveSchemaPromise = departmentSchemaPromise;
  departmentSchemaPromise.then((bundle) => {
    if (consultationSchemaPromiseRef.current === departmentSchemaPromise) {
      store.setConsultationSchema(bundle);
    }
  });
}
```

- The EAGER tenant-scoped fetch (kicked off before `/auth/me` resolves, to cover the no-credentials path where `init()` returns early — D-2's original rationale, unchanged) still always happens. When a department turns out to be known, a SECOND, department-scoped fetch supersedes it — this is the same "two-fetch" shape the existing tenant-config cascade already uses (Step 2's cached tenant-config promise, then Step 3's separate department prompt-config fetch), so it isn't a new pattern in this file.
- **Race guard**: both the tenant-scoped `.then()` (at the eager-kickoff site) and the department-scoped `.then()` check `consultationSchemaPromiseRef.current === <this promise>` before calling `store.setConsultationSchema`. Without this, a slow-resolving tenant-scoped response landing AFTER the department-scoped one had already applied would silently clobber the more specific bundle. Step 4.5 (below) is the authoritative last write for the NORMAL `init()` path regardless, but the guard also protects any consumer reading the store between the two resolutions.
- Step 4.5 (final apply before `configReady` flips) now awaits `effectiveSchemaPromise` instead of the raw `consultationSchemaPromise` — the department-scoped result when one was kicked, otherwise the original tenant-scoped default (D-2's fallback, unchanged for the no-department case).
- No department, no second network call: verified by `contextSchemaCalls.toHaveLength(1)` in the "falls back" test.

### 4.2 Department-scoped discovery preference (tenant switch)

`AgenticProvider.tsx`'s rehydrate effect already computes `effectiveDepartmentId` (`impersonated?.departmentId ?? authUser?.departmentId ?? null`) for the INCOMING identity before the schema re-fetch runs — unlike mount, there is no "department not known yet" window here, so a single, already-scoped fetch replaces the tenant-scoped default directly:

```ts
const nextConsultationSchemaPromise = fetchConsultationSchema(apiClient, providerLogger, {
  departmentId: effectiveDepartmentId ?? undefined,
});
```

One network call either way (department-scoped when `effectiveDepartmentId` is set, tenant-scoped otherwise) — verified by `contextSchemaCalls.toHaveLength(1)` carrying `departmentId=` in the switch test.

### 4.3 `useArca().context.addAttachment`

`useArca.ts` gained:
- `addAttachment` on the `UseArcaContext` interface, with the exact signature `useArcaContext().addAttachment` already exposes: `(content?: string, metadata?: Record<string, unknown>, mediaId?: string) => Promise<ContextItem>`.
- A local implementation mirroring the existing `addCaseNote`/`addTranscription` closures in the same file (direct `store`/`apiClient` access — `useArca.ts` does not delegate to `useArcaContext()`, so this could not be a one-line re-export). POSTs `{ type: 'ATTACHMENT', content: content ?? '', source: 'USER', structuredData: metadata, mediaId }` to `CONTEXT_ENDPOINTS.ADD(consultation.id)`, calls `store.addContextItem(item)`, returns the item — byte-for-byte the same request shape `useArcaContext.addAttachment` sends.
- Wired into the `context` `useMemo` (object literal + dependency array).

### 4.4 Additive-only verification

| Module | Touched? | Notes |
|---|---|---|
| `src/compat.ts`, `src/compat/**`, compat tsup block, `"./compat"` exports, `docs/Compat-API-Reference.md` | **No** | Zero edits — confirmed by `git status --short` (§5) |
| `AgenticConfig`, `Consultation`, `AudioProcessingConstraints` | **No** | Not touched |
| `AgenticClient`, `SSEClient` | **No** | Not touched — `fetchConsultationSchema`'s `departmentId` option already existed (TASK-665); this ticket only started PASSING a value, never changed the client |
| `agenticStore` selectors | **No** | Not touched — `consultationSchema`/`setConsultationSchema`/`selectConsultationSchema` already existed from TASK-665 |
| `useArcaAudio`, `useArcaSession` | **No** | Not touched |
| `AgenticProvider.tsx` | Yes (not one of the six named modules) | Internal implementation only — no change to `AgenticProviderProps`, no new exports, no behaviour change for a caller with no `departmentId` (the pre-existing tenant-scoped path is byte-identical) |
| `useArca.ts` | Yes (not one of the six named modules; not imported by compat at all — confirmed by grep) | `UseArcaContext` gained one new required-shaped field (`addAttachment`) on an interface not implemented or consumed by compat; every existing field/method on the interface and its implementation is unchanged |

`git diff --stat packages/agentic-sdk-v2/package.json` — empty (no dependency added).

### 4.5 mediaId round trip

New test composes `useStorage()` and `useArcaContext()` against a shared mocked store/`apiClient`: `uploadFile()` resolves `{ key, mediaId: 'media-round-trip-1' }`, `addAttachment(content, undefined, uploaded.mediaId)` POSTs `{ type: 'ATTACHMENT', mediaId: 'media-round-trip-1', ... }`, and the mocked server response echoes the same `mediaId` back on the returned (and store-persisted) `ContextItem`. Also asserts the uploaded `mediaId` differs from the raw storage `key`, guarding directly against the TASK-656 regression class (a caller persisting `key` instead of `mediaId`, which `MediaRepository.findById` cannot resolve — silently breaking every attachment's presigned URL).

---

## 5. Verification Evidence

All commands run from the worktree at `dev-2.1` @ `d5c43c033`. Per TASK-654 execution-plan §1.1b, workspace deps were built first: `pnpm install` → `pnpm --filter @arcaai/room --filter @arcaai/noise-filter --filter @arcaai/vad --filter @arcaai/stt --filter @arcaai/med-ner build`.

**Measured baseline** (this worktree, before any TASK-673 change): `pnpm --filter @arcaai/vox build` clean, `pnpm --filter @arcaai/vox test` → **263 files / 4173 tests passed** — matches the number TASK-665's README recorded, confirming no drift between tickets.

### `pnpm --filter @arcaai/vox build`

```
CJS dist/index.js     851.50 KB
ESM dist/index.mjs    840.15 KB
...
> tsc -p tsconfig.json --emitDeclarationOnly --declaration
(clean — exit 0)
```

### `pnpm --filter @arcaai/vox test`

```
 Test Files  265 passed (265)
      Tests  4179 passed (4179)
```

**Baseline comparison**: **263 files / 4173 tests** → **265 / 4179** (+2 files, +6 tests — 3 department-scoping tests in a new provider test file, 2 `addAttachment` tests added to the existing `useArca.api.test.ts`, 1 new mediaId round-trip test file).

### `pnpm --filter @arcaai/vox lint`

```
/…/hooks/useArcaConfig.ts
  269:0  warning  Unexpected unlimited 'eslint-disable-next-line' comment...
/…/providers/AgenticProvider.tsx
  764:0  warning  Unexpected unlimited 'eslint-disable-next-line' comment...
  989:0  warning  Unexpected unlimited 'eslint-disable-next-line' comment...

✖ 3 problems (0 errors, 3 warnings)
```

Same 3 PRE-EXISTING warnings TASK-665 recorded (line numbers shifted because of code inserted around them — the disable comments themselves are unmodified, one is in a file this ticket never touches). Zero new warnings, zero errors.

### `pnpm --filter @arcaai/vox typecheck`

```
> tsc --noEmit
(clean — exit 0)
```

### `apps/compat-playground` build (AC-6)

```
$ pnpm --filter @arcaai/ui build
(clean — exit 0)

$ pnpm --filter compat-playground build
✓ built in 17.21s
(exit 0; only Rollup's informational >500kB chunk-size notices, no errors)
```

### `apps/compat-playground` test (not a required gate, run anyway as a regression check)

```
 Test Files  21 passed (21)
      Tests  223 passed (223)
```

Matches TASK-665's recorded baseline (223 tests) exactly — zero change, confirming the additive-only changes broke nothing compat depends on.

### AC → test map

| AC | Test | File |
|---|---|---|
| AC-1 (department-scoped preference at mount) | "prefers the DEPARTMENT-scoped bundle when a department is known at mount" | `AgenticProvider.consultationSchema.task671.test.ts` |
| AC-1 (fallback when no department) | "falls back to the TENANT-scoped bundle when no department is known" | same file |
| AC-2 (replicated on tenant switch) | "re-resolves department scope on a same-tab tenant switch" | same file |
| AC-3 (`addAttachment` on the aggregate hook) | "should exist on the aggregate context object and POST with type=ATTACHMENT" + "should forward mediaId on the POST body" | `useArca.api.test.ts` (new `context.addAttachment()` block) |
| AC-4 (upload → attach → context-item round trip) | "threads mediaId from useStorage().uploadFile() through useArcaContext().addAttachment() to the returned ContextItem" | `mediaId.uploadToAttachment.task671.test.ts` |
| AC-5 (additive-only) | `git status --short` shows zero touches to any of the six named files/paths; `useArcaContext.addAttachment.task665.test.ts` (untouched) still passes unchanged | §4.4 above |
| AC-6 (compat-playground builds) | `pnpm --filter compat-playground build` exit 0 | — (build gate, above) |
| AC-7 (no new dependency) | `git diff --stat packages/agentic-sdk-v2/package.json` empty | — |

`git diff --stat packages/agentic-sdk-v2/package.json` — empty (no dependency added).

---

## 6. Incomplete / explicitly out of scope

- **`useArca.ts`'s `UseArcaContext` interface still lacks `addWorknote`, `fetchWorknotes`, and `fetchAttachments`** — these mirror the same "aggregate hook omits a method the focused hook has" shape as `addAttachment`, but TASK-665 named only `addAttachment` as the gap it noticed, and this ticket's scope is deliberately the three named items. A follow-up ticket can close the remaining gap the same way.
- **No response-level `versionSkew` surface** — unchanged from TASK-665 §6; still deferred server-side (TASK-661 §6).

---

## Change History

- 2026-08-12 — Ticket opened. Worktree reset from a stale branch (off `dev`, HEAD `180d09d6a`) to `dev-2.1` @ `d5c43c033` per the mandatory Step 0 check. Read TASK-665's README §6 (the deferred-items list this ticket implements) and the relevant source (`ConsultationSchemaClient.ts`, `AgenticProvider.tsx`'s mount/tenant-switch blocks, `useArcaContext.ts`, `useArca.ts`, `useStorage.ts`, `types/context.ts`) before writing any test.
- 2026-08-12 — Implemented in stages, TDD RED confirmed via targeted `git stash` on each touched file before writing the fix: (1) department-scoped discovery at mount + tenant switch in `AgenticProvider.tsx`, (2) `addAttachment` added to `useArca.ts`'s aggregate `context` object, (3) upload→attach→context-item `mediaId` round-trip test. All gates green; `apps/compat-playground` build + test both green; no new dependency. Status **Review**. Not merged, not pushed.
