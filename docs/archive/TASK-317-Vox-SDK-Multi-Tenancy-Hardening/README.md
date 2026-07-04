# TASK-317 — `@arcaai/vox` SDK Multi-Tenancy Hardening

| Field | Value |
|---|---|
| **Ticket** | TASK-317-Vox-SDK-Multi-Tenancy-Hardening |
| **Created** | 2026-05-29 |
| **Updated** | 2026-05-30 |
| **Status** | `Completed` — W1..W5 merged into `fix/2605-review` (`6947fd96`, `15c3072a`, `d9e961a5`, `83f1db7b`, `f19ef6fb`) |
| **Classification** | Refactor + bugfix (security / multi-tenancy / browser-side data isolation) |
| **Priority** | High — closes 4 BLOCKER/Critical (C-1..C-4) + 1 HIGH (C-5) + 6 MED (D-1..D-6) + 5 LOW (E-1..E-5) from the 2026-05-25 vox-SDK audit |
| **Audit driver** | [`docs/multi-tenancy-audit/05-vox-sdk-review.md`](../../multi-tenancy-audit/05-vox-sdk-review.md) |
| **Prior context** | TASK-305 (schema — audit 02) ✅, TASK-306 (DDD layers — audit 03) ✅, TASK-307 (API gateway — audit 04) ✅ — `05` is the **last unaddressed audit doc** in the multi-tenancy series |
| **Prior SDK work to align with** | TASK-262 / TASK-293 (vox deep assessments), TASK-297 (`DEF-*` SDK security defenses), TASK-303/304 (vox ORT + local-STT). `.cursor/rules/08-vox-sdk.mdc` is the SDK pattern reference |
| **Base branch** | `fix/2605-review` (HEAD `4bc4697d` — TASK-316 rate-limit merge) |
| **Scope** | `packages/agentic-sdk-v2`, `packages/room`, `packages/utils`, `apps/example` (browser-side only — no API/server changes) |

---

## 1. Requirement Analysis

### 1.1 Description

Close the 2026-05-25 vox-SDK audit (`05-vox-sdk-review.md`). TASK-305/306/307 hardened the **server** (schema, services, API gateway) where tenant resolution and PHI isolation are now defense-in-depth. The audit verdict for the **browser SDK** is **Request Changes**: `@arcaai/vox` is safe in the common *single-tenant-per-tab* case, but leaks across three real client-side seams:

1. **Browser persistence is not consistently tenant/user-namespaced** — the `personalization` IndexedDB row and the `selected-models` localStorage key are global, and `clearOnLogout` over-clears every tenant's namespaced data (C-2, C-3, D-1).
2. **The Zustand store is a module-level singleton** — concurrent `AgenticProvider`s (multi-tenant operator console) share one store, and a tenant switch never resets stale session state (C-1, C-5).
3. **Cross-tab / SharedWorker plumbing is partially un-scoped** — the WebSocket dedup key omits user/tenant, the cross-tab sync channel is not given the tenantId it supports, and the cross-tab HMAC secret is per-worker not per-tenant (C-4, D-4, D-5).

### 1.2 Verified current state (re-checked 2026-05-29 — review line numbers had drifted)

These files were last touched by **TASK-304 W2 (`4e5a9b71`, 2026-05-25)** and the impersonation sweep (`8a8b2ac0`). Status below is from a fresh code read, **not** the 2026-05-25 review text.

| Code | Sev | Finding | **Verified status (2026-05-29)** | Current location |
|---|---|---|---|---|
| **C-1** | Critical | Module-level Zustand singleton | **STILL-OPEN** | `store/agenticStore.ts:306` — `create<...>()` at module scope, no factory/context |
| **C-2** | Critical | `clearOnLogout` clears *other* tenants' storage | **PARTIALLY-FIXED** (still over-clears) | `store/agenticStore.ts:470-546` — sweeps all `arcaai-user-preferences/*` + wholesale IDB `.clear()` |
| **C-3** | Critical | Personalization IDB key is global | **STILL-OPEN** — *and TASK-304 added a comment declaring the global key intentional* | `core/PersonalizationManager.ts:20,119-132,288-303`; `core/configDB.ts:25` = v2 |
| **C-4** | Critical | WS dedup keyed on `id` only | **PARTIALLY-FIXED** (SSE got `sseDedupKey(id,userId)`; WS still `id`-only) | `core/SharedConnectionWorker.ts:65-68,85,207-215`; `core/SharedConnectionManager.ts:191-202` |
| **C-5** | High | Tenant switch does not reset session state | **STILL-OPEN** | `providers/AgenticProvider.tsx:474-527` (`rehydrateUserNamespace` rehydrates config only) |
| **D-1** | Med | `SELECTED_MODELS` global localStorage key | **STILL-OPEN** (comment claims "namespaced at call site" — it is not) | `core/ModelRegistry.ts:462-480`; `core/constants.ts:361-364` |
| **D-2** | Med | `PREFERENCES` global key | **DEAD KEY** — no live writer; only `removeItem` in `clearOnLogout` | `core/constants.ts:362`; `store/agenticStore.ts:474` |
| **D-3** | Med | Transformers.js cache not tenant-scoped | **STILL-OPEN** (zero tests) | `packages/utils/src/transformers-cache.ts:24-31` |
| **D-4** | Med | HMAC secret per-Worker not per-tenant | **STILL-OPEN** (channels already namespaced → low residual) | `core/CrossTabHmacKeyManager.ts:66-76` |
| **D-5** | Med | `useArcaSession` omits tenantId to `createCrossTabSync` | **STILL-OPEN** (`SimpleCrossTabSync` *supports* it at `:80,263-264`) | `hooks/useArcaSession.ts:88-92` |
| **D-6** | Med | `AudioContextManager` process-wide singleton | **STILL-OPEN** (structurally correct; needs dev-warning) | `packages/room/src/core/AudioContextManager.ts:58-63,94-112` |
| **E-1** | Low | Logger init failure → `console.error` fallback | **STILL-OPEN** | `providers/AgenticProvider.tsx` logger init |
| **E-2** | Low | `JSON.parse(SELECTED_MODELS)` no validation | **STILL-OPEN** | `core/ModelRegistry.ts:466-467` |
| **E-3** | Low | `apps/example` is not a vox consumer | **STILL-OPEN** | `apps/example/src/LiveTranscriptionDemo.tsx` |
| **E-4** | Low | WS opens without tenant claim | **STILL-OPEN** | `core/SttV2WebSocketClient.ts:191-209` |
| **E-5** | Low | No concurrent multi-`AgenticProvider` tests | **STILL-OPEN** | (test gap — paired with C-1) |

### 1.3 Scope decisions (user-confirmed 2026-05-29)

| # | Decision | Choice | Impact |
|---|---|---|---|
| D-A | Ticket | **TASK-317-Vox-SDK-Multi-Tenancy-Hardening** | This doc |
| D-B | **C-3 conflict** — TASK-304 deliberately made the personalization key global ("backend is source of truth") | **Override TASK-304** — namespace per `${tenantId}::${userId}`, bump `ARCAAI_CONFIG_DB_VERSION` 2→3, drop the legacy global row on upgrade. The TASK-304 justification comment is removed. | W1 |
| D-C | **C-1** — concurrent multi-tenant in one tab | **Supported → in scope now.** Do the full store-per-provider refactor (`createAgenticStore()` + context + migrate every hook). | W4 |
| D-D | **D-3 + D-4** ("Full" effort, low residual) | **Include both now.** | W3 (D-4), W5 (D-3) |

### 1.4 Scope rules (mirrors TASK-307 §1.2)

1. **TDD-first.** Every fix ships with a failing test first; cross-tenant/cross-user negative tests use a `describe('TASK-317 W*.x — …')` marker (mirrors TASK-297 `DEF-*` convention).
2. **Pattern reuse over new patterns.** Reuse the already-correct prior art in the same codebase (see §2.2) rather than inventing parallel mechanisms.
3. **Backend remains authoritative.** These are *defense-in-depth* client fixes; one-time local cache loss on the configDB v3 upgrade is acceptable.
4. **Browser-only.** No API/server/Prisma changes. (The server-side tenant boundary is already enforced by TASK-305/306/307.)
5. **Surgical.** Touch only what each finding requires; match existing SDK style and `.cursor/rules/08-vox-sdk.mdc`.

### 1.5 Acceptance criteria

| # | Closes | Criterion | Verification |
|---|---|---|---|
| AC-1 | C-3 | `PersonalizationManager` takes a `namespace` ctor arg; cache key = `arcaai-personalization/${tenantId}::${userId}`; `AgenticProvider` injects the same `ns` it already builds for `USER_PREFERENCES_STORE` | Unit: two namespaces → two distinct IDB rows; no cross-read |
| AC-2 | C-3 | `ARCAAI_CONFIG_DB_VERSION` 2→3; `onupgradeneeded` deletes the legacy global `arcaai-personalization` row (one-time) | Unit: upgrade path drops legacy key; backend re-hydrates |
| AC-3 | C-2 | `clearOnLogout(ns)` removes **only** the outgoing `arcaai-user-preferences/${ns}` localStorage key and the `arcaai-personalization/${ns}` IDB row — no iterate-and-delete-all, no wholesale store `.clear()` | Unit: tenant-A logout leaves tenant-B keys + IDB intact |
| AC-4 | D-1 | `STORAGE_KEYS.SELECTED_MODELS` reads/writes namespaced `arcaai-selected-models/${ns}` | Unit: per-namespace isolation |
| AC-5 | E-2 | `loadSelectedFromStorage` validates parsed JSON with a `valibot` schema (`{ stt?, vad?, ner? }` of strings); invalid → `null` + `logger.warn` | Unit: poisoned/typed-wrong JSON → null, no throw |
| AC-6 | D-2 | Dead `STORAGE_KEYS.PREFERENCES` removed (or retained solely as a documented one-time legacy-cleanup with a TSDoc note) | Grep: no live writer; `clearOnLogout` legacy cleanup documented |
| AC-7 | C-5 | On `effectiveTenantId` change, `AgenticProvider` resets session slices (`consultation`, `contextItems`, `transcriptSegments`, `summaries`, `modelRegistry`) **before** the new tenant config resolves | Unit: switch A→B → store session slices null/empty before reload |
| AC-8 | C-4 | `WSSubscription` carries `userId` (+ `tenantId`); `wsDedupKey(id, userId)` mirrors `sseDedupKey`; `SharedConnectionManager.subscribeWS` passes the discriminator | Unit: two users, same `id` → two sockets (regression mirrors `SimpleCrossTabSync.test.ts:491` cross-tenant case) |
| AC-9 | D-5 | `useArcaSession` passes `tenantId` (from `store.apiClient.getTenantId()` / `authUser.tenantId`) into `createCrossTabSync` options | Unit: call site asserts `tenantId` argument present |
| AC-10 | E-4 | `SttV2WebSocketClient.connect` refuses to open (rejects) when no tenant claim is resolvable from the connect context | Unit: missing tenant → reject; present → connect |
| AC-11 | D-4 | Cross-tab HMAC uses a per-tenant subkey `HKDF(workerSecret, tenantId)`; rotates on `setTenantId` | Unit: different tenant → different signing key; forged cross-tenant message fails `verify` |
| AC-12 | C-1 | `createAgenticStore()` factory exported; `AgenticProvider` holds the instance in `useRef` and exposes it via context; `useAgenticStore` becomes a context-reading hook (`useStore(ctx, selector)`); module-level singleton export removed or shimmed `@deprecated` | Unit + typecheck: all internal hooks read via context |
| AC-13 | C-1, E-5 | Multi-instance test suite: two `AgenticProvider`s (tenant A + B) in one render tree assert store isolation; tenant-switch-mid-session; impersonation start→stop personalization isolation | New `__tests__/multi-instance.test.tsx` green |
| AC-14 | D-3 | Custom (`source: 'custom'`) Transformers.js model weights cached under a tenant-scoped name (`vox/${tenantId}/transformers`); public weights unchanged; orphan cleanup on tenant switch | New `transformers-cache.test.ts` green |
| AC-15 | D-6 | `AudioContextManager.acquire()` emits a dev-mode warning when `referenceCount > 1` with a different tenant caller | Unit: second different-tenant acquire warns |
| AC-16 | E-1 | Logger-init failure routes to a configured fallback transport (or documents the console fallback as the intended base case with a TSDoc note) | Unit/review |
| AC-17 | E-3 | `apps/example` either ported onto `<AgenticProvider>` **or** renamed `apps/raw-ws-demo` with a README note that it is not a vox consumer | Decision recorded; rename/doc applied |
| AC-18 | docs | NEW `docs/multi-tenancy-audit/09-vox-sdk-followup-closure.md` (canonical closed/deferred record, mirror of `07`/`08`); closure banner + per-finding `[CLOSED W*.x <sha>]` markers in `05`; new `§8` in `06-implementation-summary.md`; `08-vox-sdk.mdc` + `technical-architecture-overview.md` updated with the multi-tenant SDK contract | Doc diffs approved |

---

## 2. Current State Evaluation

### 2.1 Why the audit's "safe in single-tenant-per-tab" verdict still leaves real exposure

Even without concurrent providers, three present-day flows leak:

- **Shared workstation sign-out → sign-in** (different user/tenant): C-3 hydrates the next user from the previous user's global personalization row (voice-profile id, model ids); C-2 then wipes the *incoming* user's other-namespace data on the next logout.
- **Tenant switch / admin impersonation in the same tab**: C-5 leaves `consultation`/`transcript`/`summary` populated with the previous tenant's PHI until an explicit close.
- **Multiple tabs, same origin**: C-4 (WS dedup by `id`) and D-5 (un-namespaced cross-tab channel) can cross-wire streams when ids collide.

The concurrent-multi-provider scenario (now in scope per D-C) additionally requires C-1.

### 2.2 Prior art to reuse (already in this codebase)

| Pattern | Source (verified) | Use in TASK-317 |
|---|---|---|
| `${tenantId}::${userId}` IDB namespacing via `makeIdbKey(ns)` | `providers/AgenticProvider.tsx` + `core/configDB.ts` (`USER_PREFERENCES_STORE` is already namespaced) | AC-1 (apply the *same* `ns` to `PERSONALIZATION_STORE`) |
| `configDB` version bump + non-destructive `onupgradeneeded` | `core/configDB.ts:25,45-53` | AC-2 (v2→3 + legacy-row drop) |
| `sseDedupKey(id, userId)` | `core/SharedConnectionWorker.ts:113` | AC-8 (`wsDedupKey` is the symmetric fix) |
| `SimpleCrossTabSync` already accepts `tenantId` (channel `agentic.<tenantId>`) | `core/SimpleCrossTabSync.ts:80,263-264` | AC-9 (just thread it from the hook) |
| `valibot` already a dependency (`^1.3.1`) | `package.json:69` | AC-5 (schema-validate stored JSON) |
| `zustand ^5.0.12` `createStore` + `useStore(ctx)` | `package.json:70` + Zustand v5 docs | AC-12 (factory + context, documented pattern) |
| `DEF-*` cross-tenant test markers + `*.taskNNN.test.ts` files | `providers/__tests__/AgenticProvider.task297.test.ts` | All new tests (`describe('TASK-317 W*.x …')`) |
| "Access via hooks — do not import the store directly" | `.cursor/rules/08-vox-sdk.mdc` | AC-12 (context migration is consistent with the documented contract) |

### 2.3 Existing test coverage to extend (not break)

`store/__tests__/agenticStore.test.ts` (incl. `clearOnLogout` 908-968), `core/__tests__/PersonalizationManager*.test.ts`, `core/__tests__/SimpleCrossTabSync.test.ts` (has the only `cross-tenant should not leak` case), `core/__tests__/ModelRegistry.test.ts`, `core/__tests__/SharedConnectionManager.test.ts` (no cross-tenant WS today), `hooks/__tests__/useArcaSession.test.ts`, `providers/__tests__/AgenticProvider.task297.test.ts`, `packages/room` `AudioContextManager.test.ts`, `core/__tests__/SttV2WebSocketClient.test.ts`, `core/__tests__/constants.test.ts`.

> ⚠️ **C-2 anti-regression**: `agenticStore.test.ts:908-968` currently asserts that `clearOnLogout` removes *all* `arcaai-user-preferences/*` keys. AC-3 inverts that contract — those assertions must be **rewritten** (not just extended) to assert outgoing-namespace-only scoping. Flag in the W1 PR.

---

## 3. Implementation Plan

> **Approval gate** — §1.3 scope confirmed 2026-05-29. This section needs sign-off before W1 code is written.
> **Estimated effort**: ~16–20 engineer-hours (C-1 refactor dominates).

### 3.0 Execution model — strict-sequential waves (TASK-306 style)

Unlike TASK-307's parallel worktrees, the SDK findings cluster in a few tightly-coupled files (`agenticStore.ts`, `AgenticProvider.tsx`, `PersonalizationManager.ts`). Parallel worktrees would conflict heavily. **Run waves sequentially**, each its own branch off the prior wave's merge, with a mandatory `code-reviewer` subagent verdict (APPROVED / APPROVED-WITH-MINOR-NITS, 0 critical/important) before merge into `fix/2605-review`.

**Surgical-first ordering** (present-day protection lands before the big refactor):

```
W1 storage namespacing  →  W2 tenant-switch reset  →  W3 cross-tab/WS  →  W4 store-per-provider  →  W5 cache/hygiene/docs
   (C-2,C-3,D-1,E-2,D-2)     (C-5)                      (C-4,D-5,D-4,E-4)    (C-1,E-5)                  (D-3,D-6,E-1,E-3,docs)
```

W4 wraps `create(...)` in a factory; the W1–W2 logic written inside the store (`clearOnLogout`, session slices) is preserved verbatim, so W4 is a mechanical wrapping, not a rewrite. W4's hook-migration is the only wide diff.

### Wave 1 — Browser-storage tenant/user namespacing (C-2, C-3, D-1, E-2, D-2)

**Branch**: `task-317/w1-storage-namespacing` · **Est**: 4h

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 1.1 | AC-1 — add `namespace` ctor param to `PersonalizationManager`; key = `arcaai-personalization/${ns}`; remove the TASK-304 "intentionally global" comment | `core/PersonalizationManager.ts:14-20,87,119-132,288-303` | Unit: two ns → two rows | M |
| 1.2 | AC-1 — `AgenticProvider` passes the existing `ns` into `new PersonalizationManager(...)` | `providers/AgenticProvider.tsx` (where PM is constructed) | Unit: provider wires ns | S |
| 1.3 | AC-2 — bump `ARCAAI_CONFIG_DB_VERSION` 2→3; `onupgradeneeded` deletes legacy global `arcaai-personalization` row | `core/configDB.ts:25,45-53` | Unit: upgrade drops legacy row | S |
| 1.4 | AC-3 — `clearOnLogout(ns)` scoped to outgoing ns only (no `*`-sweep, no wholesale `.clear()`); **rewrite** `agenticStore.test.ts:908-968` contract | `store/agenticStore.ts:470-546` + test | Unit: B's data survives A's logout | M |
| 1.5 | AC-4 — namespace `SELECTED_MODELS` → `arcaai-selected-models/${ns}` in `ModelRegistry` | `core/ModelRegistry.ts:462-480`; `core/constants.ts:357-364` | Unit: per-ns isolation | S |
| 1.6 | AC-5 — valibot schema on `loadSelectedFromStorage`; invalid → null + warn | `core/ModelRegistry.ts:462-470` | Unit: poisoned JSON → null | S |
| 1.7 | AC-6 — remove dead `STORAGE_KEYS.PREFERENCES` (or TSDoc it as legacy cleanup only) | `core/constants.ts:362`; `store/agenticStore.ts:474` | Grep: no writer | XS |

**W1 gate**: AC-1..AC-6 tests green; `pnpm test --filter @arcaai/vox` green (no regression except the intentionally-rewritten 1.4 contract); typecheck + lint clean.

### Wave 2 — Tenant-switch session reset (C-5)

**Branch**: `task-317/w2-tenant-switch-reset` · **Est**: 1.5h

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 2.1 | AC-7 — in `rehydrateUserNamespace`, on `effectiveTenantId` change reset `consultation`/`contextItems`/`transcriptSegments`/`summaries`/`modelRegistry` before the new config resolves | `providers/AgenticProvider.tsx:474-527` | Unit: switch A→B clears slices | M |
| 2.2 | AC-7 — confirm exact reset action names against the store (`setConsultation`/`setContextItems`/`setTranscriptSegments`/`setSummaries`/`setModelRegistry`) | `store/agenticStore.ts` | Typecheck | S |

**W2 gate**: AC-7 green; no regression in `AgenticProvider.task297.test.ts`.

### Wave 3 — Cross-tab / WebSocket isolation (C-4, D-5, D-4, E-4)

**Branch**: `task-317/w3-crosstab-ws-isolation` · **Est**: 4h

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 3.1 | AC-8 — `WSSubscription` carries `userId`(+`tenantId`); add `wsDedupKey(id,userId)`; key `wsConnections` by it | `core/SharedConnectionWorker.ts:65-68,85,207-215` | Unit: two users same id → two sockets | M |
| 3.2 | AC-8 — `SharedConnectionManager.subscribeWS` passes the discriminator; add cross-tenant WS no-leak regression | `core/SharedConnectionManager.ts:191-202` + test | Unit (mirror `SimpleCrossTabSync.test.ts:491`) | M |
| 3.3 | AC-9 — `useArcaSession` passes `tenantId` into `createCrossTabSync` | `hooks/useArcaSession.ts:88-92` | Unit: tenantId arg present | S |
| 3.4 | AC-11 — per-tenant HMAC subkey `HKDF(workerSecret, tenantId)`; rotate on `setTenantId` | `core/CrossTabHmacKeyManager.ts:66-76` + worker | Unit: forged cross-tenant msg fails verify | M |
| 3.5 | AC-10 — `SttV2WebSocketClient.connect` rejects when no tenant claim resolvable | `core/SttV2WebSocketClient.ts:191-209` | Unit: missing tenant → reject | S |

**W3 gate**: AC-8..AC-11 green; `SimpleCrossTabSync` cross-tenant case still green.

### Wave 4 — Store-per-provider refactor + multi-instance tests (C-1, E-5)

**Branch**: `task-317/w4-store-per-provider` (rebased onto post-W3) · **Est**: 5h

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 4.1 | AC-12 — `createAgenticStore()` factory wrapping current `create(...)` config (vanilla `createStore`) | `store/agenticStore.ts:306` | Unit: two factories → independent state | M |
| 4.2 | AC-12 — `AgenticProvider` holds store in `useRef`, provides via context; add `useStoreApi()` | `providers/AgenticProvider.tsx` | Unit: provider-scoped store | M |
| 4.3 | AC-12 — migrate every internal hook from module `useAgenticStore` → context `useStore(ctx, selector)`; keep a `@deprecated` shim export for external importers | `hooks/**`, `store/agenticStore.ts` | Typecheck + full suite green | L |
| 4.4 | AC-13 — `__tests__/multi-instance.test.tsx`: two providers/two tenants isolation; switch-mid-session; impersonation start→stop | NEW test | Green | M |

**W4 gate**: AC-12/AC-13 green; full `@arcaai/vox` suite green; typecheck + lint clean; no consuming-app (`apps/ui-playground`) breakage (`do not import store directly` already the contract).

### Wave 5 — Cache scoping + hygiene + closure docs (D-3, D-6, E-1, E-3, docs)

**Branch**: `task-317/w5-cache-hygiene-docs` · **Est**: 3h + 1h docs

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 5.1 | AC-14 — tenant-scope `source:'custom'` Transformers caches (`vox/${tenantId}/transformers`); public weights unchanged; orphan cleanup on switch; add the missing `transformers-cache.test.ts` | `packages/utils/src/transformers-cache.ts:24-31` + NEW test | Unit green | M |
| 5.2 | AC-15 — `AudioContextManager.acquire()` dev-warning when `referenceCount>1` with a different tenant caller | `packages/room/src/core/AudioContextManager.ts:94-112` | Unit: warns | S |
| 5.3 | AC-16 — logger-init fallback transport or documented console base case | `providers/AgenticProvider.tsx` logger init | Review | S |
| 5.4 | AC-17 — port `apps/example` onto `<AgenticProvider>` OR rename `apps/raw-ws-demo` + README note | `apps/example/**` | Decision recorded | S |
| 5.5 | AC-18 — NEW `09-vox-sdk-followup-closure.md`; closure banner + per-finding markers in `05`; `§8` in `06`; update `08-vox-sdk.mdc` + `technical-architecture-overview.md`; finalize §4/§5 of this README | docs | Diffs approved | M |

**W5 gate**: AC-14..AC-18 green; all audit docs cross-linked; this README's Implementation Summary populated with merge SHAs; status → `Completed`.

---

## 4. Testing Strategy

- **TDD per wave** — write the cross-tenant/cross-user negative test FIRST, confirm RED against today's behaviour, then fix. Markers: `describe('TASK-317 W*.x — …')`.
- **Placement** — unit/component in `packages/{agentic-sdk-v2,room,utils}/src/**/__tests__/`; multi-instance React test via `@testing-library/react` `renderHook`/`render` with two providers.
- **Mocks** — `AudioContext`, `MediaStream`, `WebSocket`, `BroadcastChannel`, IndexedDB (fake-indexeddb or existing harness), `caches` (Cache Storage) per existing test setup.
- **Anti-regression** — keep `SimpleCrossTabSync` cross-tenant case green; rewrite (not delete) the `clearOnLogout` contract in `agenticStore.test.ts` per AC-3.
- **Gate per wave** — `pnpm test --filter @arcaai/vox` (+ `@arcaai/room`, `@arcaai/utils` for W5) green; `pnpm typecheck`; `pnpm lint`; `ReadLints` on touched files clean.

## 5. Implementation Summary

> W1–W5 merged into `fix/2605-review` (W5 `f19ef6fb`). The canonical per-finding closure ledger is [`docs/multi-tenancy-audit/09-vox-sdk-followup-closure.md`](../../multi-tenancy-audit/09-vox-sdk-followup-closure.md). All 16 audit findings (C-1..C-5, D-1..D-6, E-1..E-5) closed; D-3 + E-4 ship the mechanism with production-wiring deferred (§5.4).

### 5.1 What shipped (by wave)

| Wave | ACs | Closes | Key change | Merge SHA |
|---|---|---|---|---|
| **W1** Storage namespacing | AC-1..AC-6 | C-2, C-3, D-1, D-2, E-2 | `PersonalizationManager` namespace ctor + IDB key `arcaai-personalization/${ns}`; configDB v2→3 legacy-row drop; `clearOnLogout(ns)` outgoing-namespace-only; `SELECTED_MODELS` → `arcaai-selected-models/${ns}`; valibot validation; dead `PREFERENCES` documented as legacy-cleanup only | `6947fd96` |
| **W2** Tenant-switch reset | AC-7 | C-5 | `clearTenantSessionData()` store action clears the 10-field tenant PHI/session set synchronously on `effectiveTenantId` change before the async re-hydrate tail (auth/impersonation untouched); `tenantConfig` reload on switch | `15c3072a` |
| **W3** Cross-tab / WS isolation | AC-8..AC-11 | C-4, D-4, D-5, E-4 | `wsDedupKey(id,userId)` (fail-closed on user mismatch); per-tenant `HKDF(secret, tenantId)` HMAC subkey (master secret stays in the SharedWorker); `useArcaSession` threads `tenantId` into `createCrossTabSync`; opt-in `requireTenantClaim` on `SttV2WebSocketClient.connect` | `d9e961a5` |
| **W4** Store-per-provider | AC-12, AC-13 | C-1, E-5 | `createAgenticStore()` factory + `AgenticStoreContext`; per-provider store in `useRef`; internal `useAgenticStore` → context hook; module singleton `@deprecated agenticStoreSingleton` shim; public `useArcaStore`/`useStoreApi` accessors; `multi-instance.test.ts` (two-tenant isolation + switch-mid-session + impersonation) | `83f1db7b` |
| **W5** Cache scoping + hygiene | AC-14..AC-17 | D-3, D-6, E-1, E-3 | `getTransformersCacheName`/`clearTenantCustomTransformersCache` → `vox/${tenantId}/transformers` (fail-closed; `db46a669`; **mechanism only — §5.4**); `AudioContextManager` cross-tenant dev-warning (`f2fbdcaf`); logger console fail-safe TSDoc (`478c61b2` + nit `1c50137d`); `apps/example/README.md` raw-WS demo note, rename declined (`6814c6fd`) | `f19ef6fb` |
| **W5.5** Closure docs | AC-18 | docs | NEW `09-vox-sdk-followup-closure.md`; closure banner + 15 per-finding markers in `05`; new `§7` in `06`; `08-vox-sdk.mdc` + `technical-architecture-overview.md` multi-tenant SDK contract; this §5 + merge-SHA table | `f19ef6fb` |

### 5.2 Files changed (by area)

- **`@arcaai/vox` storage / persistence (W1)** — `core/PersonalizationManager.ts`, `core/configDB.ts`, `core/ModelRegistry.ts`, `core/constants.ts`, `store/agenticStore.ts` (`clearOnLogout`), `providers/AgenticProvider.tsx` (namespace wiring) + tests.
- **`@arcaai/vox` tenant-switch reset (W2)** — `store/agenticStore.ts` (`clearTenantSessionData()` / `clearSensitiveData()`), `providers/AgenticProvider.tsx` (synchronous reset + `tenantConfig` reload) + `AgenticProvider.tenant-switch.task317.test.ts`.
- **`@arcaai/vox` cross-tab / WS (W3)** — `core/SharedConnectionWorker.ts`, `core/SharedConnectionManager.ts`, `core/CrossTabHmacSharedWorker.ts`, `core/CrossTabHmacKeyManager.ts`, `core/SimpleCrossTabSync.ts`, `core/SttV2WebSocketClient.ts`, `hooks/useArcaSession.ts`, `hooks/useSharedConnection.ts` (`useSharedWS` threading) + 4 test files.
- **`@arcaai/vox` store-per-provider (W4)** — `store/agenticStore.ts`, `store/index.ts`, `providers/AgenticProvider.tsx`, `core.ts` (public accessors), `providers/__tests__/multi-instance.test.ts` (NEW) + 7 migrated test files; `apps/ui-playground` reads migrated off the singleton onto `useArcaStore`/`useStoreApi`.
- **`@arcaai/utils` (W5)** — `packages/utils/src/transformers-cache.ts` (+ NEW `transformers-cache.test.ts`).
- **`@arcaai/room` (W5)** — `packages/room/src/core/AudioContextManager.ts` (+ test).
- **Hygiene / docs (W5)** — `providers/AgenticProvider.tsx` (logger TSDoc note), `apps/example/README.md` (NEW).
- **Closure docs (W5.5)** — `docs/multi-tenancy-audit/09-vox-sdk-followup-closure.md` (NEW), `05-vox-sdk-review.md`, `06-implementation-summary.md`, `.cursor/rules/08-vox-sdk.mdc`, `docs/technical-architecture-overview.md`, this README.

### 5.3 Merge-SHA table

| Wave | Branch | Merge SHA |
|---|---|---|
| W1 | `task-317/w1-storage-namespacing` | `6947fd96` |
| W2 | `task-317/w2-tenant-switch-reset` | `15c3072a` |
| W3 | `task-317/w3-crosstab-ws-isolation` | `d9e961a5` |
| W4 | `task-317/w4-store-per-provider` | `83f1db7b` |
| W5 | `task-317/w5-cache-hygiene-docs` | `f19ef6fb` |

### 5.4 Deferred (mechanism shipped, production-wiring deferred)

- **D-3 / AC-14** — `getTransformersCacheName` + `clearTenantCustomTransformersCache` are shipped + unit-tested but **dormant** (no in-repo caller); not wired into the live `AgenticProvider` tenant-switch, and Transformers.js isn't yet configured to write the tenant-scoped name. Future integration ticket.
- **E-4 / AC-10** — `requireTenantClaim` is opt-in, not wired into the prod streaming callers (`PluginManager.buildStreamingTransport` / `StreamingSessionManager`), and `resolveTenantClaim` doesn't yet accept the prod discriminator (`ticket`/`sessionId`). Follow-up.

Per-wave review-time minor nits are catalogued in [`09-vox-sdk-followup-closure.md` §2.2](../../multi-tenancy-audit/09-vox-sdk-followup-closure.md). **Final gate:** vox 2948 / utils 145 / room 493 green; typecheck-neutral.

## 6. Risks & mitigations

| Risk | Sev | Mitigation |
|---|---|---|
| configDB v3 upgrade drops the legacy global personalization row → one-time local pref loss | LOW | Backend is authoritative; re-hydrates on next load. Documented in AC-2. |
| Namespaced `selected-models` key → existing users re-pick/re-fetch model selection once | LOW | Defaults re-seed from `/tenant/me/config`; acceptable one-time reset. |
| C-1 hook migration is wide (every hook) → regression surface | MED | W4 is sequential after W1–W3; full suite gate; `@deprecated` shim preserves any external `useAgenticStore` importer; `apps/ui-playground` smoke. |
| C-2 contract inversion breaks existing `clearOnLogout` test | EXPECTED | Intentional — rewrite the assertions in 1.4; call out in PR. |
| HKDF per-tenant HMAC interop across tabs opened pre-fix | LOW | Cross-tab messages are best-effort + signed; mismatched-key messages are dropped (fail-closed), not crashing. |

## 7. Out of scope / deferred

- **Server-side** anything (closed by TASK-305/306/307).
- **`apps/example` full re-architecture** beyond the AC-17 port-or-rename decision.
- No new finding beyond `05`'s C/D/E set.

## 8. Success criteria (final gate)

- [ ] AC-1..AC-18 met with evidence pasted per wave
- [ ] All W1..W5 gates green; `code-reviewer` verdict APPROVED / APPROVED-WITH-MINOR-NITS (0 critical/important) per wave
- [ ] `pnpm test --filter @arcaai/vox --filter @arcaai/room --filter @arcaai/utils` green; typecheck + lint clean
- [ ] `09-vox-sdk-followup-closure.md` written; `05` closure banner + markers; `06 §8` added
- [ ] §5 of this README populated with merged commits; status → `Completed`

## 9. Change History

| Date | Description | Files |
|---|---|---|
| 2026-05-29 | Initial plan drafted post-TASK-307. Re-verified all 16 findings against current code (statuses in §1.2 differ from the 2026-05-25 review — line drift + TASK-304 partial changes). Confirmed scope decisions D-A..D-D (TASK-317 number; override TASK-304 on C-3 → namespace; C-1 store-per-provider in scope; include D-3/D-4). 5 sequential waves. Awaiting approval to begin W1. | this file |
| 2026-05-30 | Execution kickoff. Reconfirmed strict-sequential waves (§3.0) over parallel worktrees after overlap analysis (`AgenticProvider.tsx` touched by W1/W2/W4/W5; `agenticStore.ts` by W1/W2/W4; `useArcaSession.ts` by W3/W4). Branch `task-317/w1-storage-namespacing` created off `fix/2605-review` @ `4bc4697d`. Each wave: fresh impl subagent (TDD) → `code-reviewer` gate → local merge. | this file |
| 2026-05-30 | **W1 merged** (`6947fd96` into `fix/2605-review`). AC-1..AC-6 closed; vox suite 2928 green; W1 diff typecheck-neutral (13 pre-existing tsc errors untouched). `code-reviewer` APPROVED-WITH-MINOR-NITS after 2 fix cycles: C-1 (managers wired to constant `pre-login` ns → live namespace accessor + re-hydrate after `/auth/me`/switch, fail-closed); I-1 (personalization `hydrate()` merged → authoritative per-namespace reset, fixes impersonation round-trip bleed). **Deferred follow-ups** (→ W5 `09` closure doc): M-1 `loadFromBackend` race in opt-in `hybrid`/`backend` storage (non-security; default `local`); M-4 `clearOnLogout` has no production caller (pre-existing). | `agentic-sdk-v2` storage/provider + tests |
| 2026-05-30 | **W2.1 review fix — C-1 (Critical): tenant-switch reset was incomplete.** The switch handler cleared only 5 slices (`consultation`/`contextItems`/`transcriptSegments`/`summaries`/`tenantConfig`) but left tenant-A PHI that `useArca()` still surfaces resident after an A→B same-tab switch: `relatedConsultations`, `sharedContext`, `entities` (medical NER — diagnoses/medications), `currentTranscript` (raw transcript text), `dnaStyle`. Fix: added store action `clearTenantSessionData()` as the single source of truth for the 10-field tenant PHI/session set (no auth/impersonation), refactored `clearSensitiveData()` to reuse it, and replaced the 5 provider setters with one synchronous `store.clearTenantSessionData()` (runs before the async re-hydrate tail; auth/impersonation untouched so the in-flight switch survives). RED→GREEN: extended `AgenticProvider.tenant-switch.task317.test.ts` to populate+assert the full set cleared synchronously. Vox suite 2929 green; typecheck-neutral (13 pre-existing). Side note: `clearSensitiveData()` now additionally nulls `tenantConfig` (verified safe — no runtime callers; no existing test asserts its survival). | `store/agenticStore.ts`, `providers/AgenticProvider.tsx`, `providers/__tests__/AgenticProvider.tenant-switch.task317.test.ts` |
| 2026-05-30 | **W2.1 review — M-2 (Minor) fixed:** after a same-tab switch `tenantConfig` is nulled, but the mount-time `loadTenantConfig()` promise (cached in `tenantConfigPromiseRef`) was never re-run — tenant B operated with `useArcaConfig().tenantConfig === null` until a remount. The re-hydrate tail now re-invokes `modelRegistry.loadTenantConfig()` for the incoming identity (same assumption as the department re-fetch beside it), refreshes `tenantConfigPromiseRef`, sets the new `tenantConfig`, and bumps the registry version (publishes any tenant-default model). Isolated in its own try/catch so a config-fetch failure never blocks `configReady`. Vox suite 2929 still green; typecheck-neutral. | `providers/AgenticProvider.tsx` |
| 2026-05-30 | **W2.1 review — M-1 deferred:** the switch reset runs in `useEffect`, leaving a one-frame paint window (tenant B identity rendered with not-yet-cleared tenant-A PHI). AC-7 ("before the new config resolves") is still met. Not switching to `useLayoutEffect` this pass — recorded as a deferred hardening for the W5 `09` closure doc. | (none — note only) |
| 2026-05-30 | **W2 merged** (`15c3072a` into `fix/2605-review`). AC-7 closed; vox suite 2929 green; typecheck-neutral. `code-reviewer` APPROVED-WITH-MINOR-NITS — C-1 resolution confirmed full PHI coverage; auth/impersonation untouched; M-2 reload correct. **Deferred → W5 `09`:** one-frame `useEffect` paint window; transient `*Error` slices not in the switch reset; no generation guard for rapid double-switches. | (merge) |
| 2026-05-30 | **W3 implemented on `task-317/w3-crosstab-ws-isolation`** (off `fix/2605-review`; pending review/merge). All 4 ACs closed via strict per-AC TDD (RED test commit → GREEN impl commit). **AC-8 (C-4, `3cf6f47a`):** added `wsDedupKey(id,userId)` symmetric to `sseDedupKey`; `WSSubscription`/`ManagedWS` now carry `userId`+`tenantId`; `wsConnections` keyed by dedup key; user-mismatch refuses to share a slot (fail-closed); `ws_send` routes to the sender-port's own socket; unsubscribe forwards `userId` (prefix-scan fallback). Added test-only `__handleMessageForTests`/`__resetConnectionsForTests` (jsdom never fires `onconnect`). **AC-9 (D-5, `6b9d7112`):** `useArcaSession` resolves `apiClient.getTenantId()` and threads it as `createCrossTabSync(config, { tenantId })` → channel `agentic.<tenantId>`. **AC-11 (D-4, `dc1399f1`):** per-tenant signing subkey `HKDF(secret, tenantId)` via shared `deriveTenantHmacKey` (worker + fallback derive identically); `CrossTabHmacKeyManager.setTenantId()` rotates the subkey (fallback derives locally, SharedWorker threads `tenantId` per-RPC so the master secret never leaves the worker); `SimpleCrossTabSync` binds/rotates alongside the per-tenant channel. **AC-10 (E-4, `e0cbbfc3`):** `SttV2WebSocketClient.connect()` gains opt-in `requireTenantClaim` — rejects before opening a socket unless a claim resolves from `tenantClaim` option or URL `tenantId`/`tenant` (default-off preserves bare-URL callers). **Gates:** vox suite **2941 green** (was 2929; +12 W3 tests); typecheck-neutral (**13 pre-existing tsc errors, 13 after** — incl. the known `MockWebSocket.bufferedAmount` TS2339 ×4, untouched); lint 0 errors (40 pre-existing prettier warnings, none in W3 files); `SimpleCrossTabSync` cross-tenant no-leak case (`:491`) still green. **Deviation:** AC-10 guard is opt-in and not yet wired into production callers (`PluginManager`/`StreamingSessionManager`) — flagged for the integration step (production WS URLs currently carry `sessionId`+`ticket`, not `tenantId`). | `core/SharedConnectionWorker.ts`, `core/SharedConnectionManager.ts`, `core/CrossTabHmacSharedWorker.ts`, `core/CrossTabHmacKeyManager.ts`, `core/SimpleCrossTabSync.ts`, `core/SttV2WebSocketClient.ts`, `hooks/useArcaSession.ts` + 4 test files |
| 2026-05-30 | **W3 merged** (`d9e961a5` into `fix/2605-review`). AC-8..AC-11 closed; vox suite 2945 green; typecheck-neutral. `code-reviewer` APPROVED after 1 fix cycle: I-1 (Important) — `useSharedWS` wasn't threading `userId`/`tenantId`, so the AC-8 `(id,userId)` WS dedup was dormant in production (collapsed to `id::anon`); now mirrors `useSharedSSE` (`a2553fcd`). M-1 — empty/whitespace `tenantId`→`undefined` for worker/fallback HKDF parity (`27e4cd8e`). HKDF crypto verified sound/fail-closed; master secret never leaves the SharedWorker. **Deferred → W5 `09`:** AC-10 production wiring (`requireTenantClaim` into `PluginManager.buildStreamingTransport`/`StreamingSessionManager`; extend `resolveTenantClaim` to accept the real prod discriminator `ticket`/`sessionId`). | (merge) |
| 2026-05-30 | **W4 implemented on `task-317/w4-store-per-provider`** (off post-W3 `fix/2605-review`; pending review/merge). Store-per-provider refactor closing audit **C-1/E-5** (cross-tenant state bleed via the module-level Zustand singleton). Strict TDD (RED → GREEN). **AC-12 (`59fb5619`, `9277f7f5`):** extracted the W1–W3 store config verbatim into a named `agenticStoreInitializer` `StateCreator`; added `createAgenticStore()` (vanilla `createStore`) → fully-independent instances; `AgenticProvider` lazy-inits ONE instance per mount into a `useRef` and publishes it via new `AgenticStoreContext`; added fail-loud `useStoreApi()` (throws outside a provider — never falls back to a global). The **internal** `useAgenticStore` was redefined IN PLACE as a context hook (`useStore(useStoreApi(), selector)`), so all **13** hook source files that already `import { useAgenticStore } from '../store'` (`useArca`, `useArcaConfig`, `useArcaContext`, `useArcaAudio`, `useArcaSession`, `useArcaSummary`, `useArcaPipelines`, `useConsultationJob`, `useAuth`, `useHealthCheck`, `useApiOperation`, `useSharedConnection`, `useVoiceEmbedding`) rebound to the per-provider store with ZERO edits; the provider's own reads use `useStore(storeApi)`. A `@deprecated agenticStoreSingleton` (`create(...)`) is retained and re-exported from `core.ts` as the PUBLIC `useAgenticStore` so external importers keep compiling. **No internal code reads the singleton** (grep-verified: the only non-test references are its definition + the `core.ts` public re-export); **zero `.getState()/.setState()/.subscribe()` on any global in non-test source**. Non-React consumers (AgenticClient / PluginManager / PersonalizationManager / ModelRegistry / ConfigManager / cross-tab sync) are constructed per-mount and wired into the per-instance store via `store.initialize()/setConfigManager()/onChange()`, so they bind per-provider. **AC-13 (`c692bb1c` RED, `52b8e764` GREEN):** `providers/__tests__/multi-instance.test.ts` renders two providers (tenant A+B) asserting (a) distinct `StoreApi` identity + full-slice isolation, (b) mid-session `clearTenantSessionData()` on A leaves B intact, (c) impersonation start→stop on A keeps B's auth/preferences isolated. RED proved the leak on the singleton (A's state appeared in B; identical `useBoundStore` identity); GREEN after the refactor. **Gates:** vox suite **2948 green** (was 2945; +3 W4 tests, 136 files); typecheck **zero new errors** (13 pre-existing; line-normalized `comm` "new" set empty — only delta is the pre-existing `AgenticProvider.tsx` `ISDKLogger→ConfigManagerLogger` TS2322 shifting 288→302 as W4 added lines above it); lint **0 errors** (41 pre-existing prettier warnings); `ReadLints` clean on all 12 touched files; **`apps/ui-playground` smoke** — type-check zero new errors (605=605 pre-existing; SDK-src error line-shift only) AND production `vite build` ✓ (23.24s) against the rebuilt refactored `dist`. **Deviation (intended C-1 consequence, → W5 `09` closure doc):** external consumers that read the GLOBAL singleton's *provider-initialized* state at runtime — e.g. `apps/ui-playground` `useAgenticStore.getState().apiClient`/`.configManager` and `useAgenticStore((s)=>s.apiClient)` in its `use-realtime-transcription`/`use-file-transcription`/`use-auto-refresh` — now read the *uninitialized* singleton, because the provider initializes a per-instance store. Compile/build are preserved (gate met); the `@deprecated` marker signals these consumers should migrate to official hooks / a public accessor. | `store/agenticStore.ts`, `store/index.ts`, `providers/AgenticProvider.tsx`, `core.ts`, `providers/__tests__/multi-instance.test.ts` (NEW) + 7 migrated test files (`AgenticProvider.{test.tsx,task297,namespacing.task317,tenant-switch.task317,ner-config}` + `store/__tests__/agenticStore{,.impersonation}.test.ts`) |
| 2026-05-30 | **W4 merged** (`83f1db7b` into `fix/2605-review`). AC-12/AC-13 closed. `code-reviewer` APPROVED after 1 fix cycle: C-1 (Critical/blocking) — `apps/ui-playground` read provider-initialized `apiClient`/`configManager`/`logger` off the now-INERT `@deprecated` singleton → runtime break incl. a SILENT TASK-245 impersonation preference-isolation regression (`user-list`). Fixed by exporting public context accessors `useArcaStore` (context-backed, **not** the singleton) + `useStoreApi` + `AgenticStoreApi` from `core.ts` (`75033853`) and migrating all 7 ui-playground reads off the singleton (`e04b6957`) — 0 remaining `useAgenticStore` in ui-playground. M-1 prettier `<T>`; M-2 `structuredClone(initialState)` per instance → structural isolation (`c15663f1`). Re-review confirmed the fix is runtime-correct (provider-initialized store read through the context). Gates: vox 2948 green; vox typecheck 13=13; ui-playground type-check 605=605 + `vite build` ✓; ui-playground tests 0 new failures. **Deferred → W5 `09` / follow-up:** pre-existing ui-playground `tsc` errors; 3 pre-existing ui-playground test failures (mock/source drift — `use-file-transcription` `uploadAndTranscribeWithProgress`; `use-auto-refresh.impersonation` stale assertion). | (merge) |
| 2026-05-30 | **W5 implemented on `task-317/w5-cache-hygiene-docs`** (off post-W4 `fix/2605-review`; pending review/merge). AC-14..AC-17 closed via per-AC TDD (RED → GREEN). **AC-14 (D-3, `db46a669`):** `getTransformersCacheName({source,tenantId})` resolves `vox/${tenantId}/transformers` for `source:'custom'` (fails closed — throws — without a usable tenantId); `clearTenantCustomTransformersCache(tenantId)` is the orphan-cleanup hook (deletes only `vox/${tenantId}/*`, never the shared public cache); public HF-hub weights stay on `transformers-cache` (unchanged). utils suite **145 green** (was 140; +5). **Mechanism only — no in-repo caller; live tenant-switch wiring + Transformers.js cache-naming DEFERRED → `09` §2.1.** **AC-15 (D-6, `f2fbdcaf`):** `AudioContextManager.acquire()` learns the caller tenant via optional `AudioContextAcquireOptions.tenantId` and emits a dev-mode `console.warn` when the process-wide singleton is held by a DIFFERENT tenant (`referenceCount>1`); holder tenants tracked in a `Set` cleared at `referenceCount===0`; warning-only, lifecycle unchanged. room suite **493 green** (was 488; +5); type-check 0 errors. **AC-16 (E-1, `478c61b2`, softened by review nit `1c50137d`):** documented the always-on `ConsoleTransport` as the intended logger fail-safe base case (TSDoc) rather than wiring a redundant fallback transport — comment-only. **AC-17 (E-3, `6814c6fd`):** added `apps/example/README.md` documenting the app as a standalone raw-WebSocket/fetch demo, NOT a `@arcaai/vox` consumer (still sends `Authorization`+`X-Tenant-ID`; server boundary authoritative); rename to `apps/raw-ws-demo` declined as non-trivial (referenced by Dockerfile / CI / pnpm-lock). **Review nits → `09` §2.2:** AC-14 dormant mechanism; `AudioContextManager` phantom-holder over-warn on interleaved partial-release; AC-16 note style. | `packages/utils/src/transformers-cache.ts` (+test), `packages/room/src/core/AudioContextManager.ts` (+test), `providers/AgenticProvider.tsx` (logger TSDoc), `apps/example/README.md` (NEW) |
| 2026-05-30 | **W5.5 closure documentation** (doc-only; no production code touched). Created the canonical [`09-vox-sdk-followup-closure.md`](../../multi-tenancy-audit/09-vox-sdk-followup-closure.md) (mirror of `07`); added the TASK-317 closure banner + `[CLOSED W<n> <sha>]` markers on all 15 finding headings in `05` (D-3 + E-4 also `[DEFERRED → 09 §2.1]`); appended `§7` to `06-implementation-summary.md`; added a "Multi-Tenancy & Data Isolation" section to `.cursor/rules/08-vox-sdk.mdc` (+ updated the store-access note to the public context accessors); added a browser-side SDK isolation layer to `docs/technical-architecture-overview.md` § Multi-tenancy enforcement layers; finalized §5 (Implementation Summary) + the merge-SHA table of this README. Top-of-file Status remains `In Progress` and the W5 merge SHA stays a `<W5-merge-sha — filled at close-out>` placeholder pending the orchestrator's post-merge close-out. | `docs/multi-tenancy-audit/09-vox-sdk-followup-closure.md` (NEW), `05-vox-sdk-review.md`, `06-implementation-summary.md`, `.cursor/rules/08-vox-sdk.mdc`, `docs/technical-architecture-overview.md`, this file |
| 2026-05-30 | **W5 merged + ticket close-out** (`f19ef6fb` into `fix/2605-review`). AC-14..AC-18 closed; code review APPROVED-WITH-MINOR-NITS (0 Critical/0 Important; 3 non-blocking nits → `09` §2.2); closure docs reviewed for SHA/finding-coverage/lineage accuracy. **All 18 ACs met; all 16 audit findings (C-1..C-5, D-1..D-6, E-1..E-5) closed** (D-3 + E-4 ship the mechanism, production-wiring deferred → `09` §2.1). Final gate: vox **2948** / utils **145** / room **493** green; typecheck-neutral (13 pre-existing vox `tsc` errors unchanged). Replaced the `<W5-merge-sha …>` placeholder with `f19ef6fb` and flipped Status → `Completed` across this README, `05`, `06`, and `09`. | `09-vox-sdk-followup-closure.md`, `05-vox-sdk-review.md`, `06-implementation-summary.md`, this file |
