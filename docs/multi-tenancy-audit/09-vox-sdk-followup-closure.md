# 09 — TASK-317 `@arcaai/vox` SDK Multi-Tenancy Hardening — Closure Record

| Field | Value |
|---|---|
| **Ticket** | TASK-317 — Vox SDK Multi-Tenancy Hardening |
| **Plan** | [`docs/implementation/TASK-317-Vox-SDK-Multi-Tenancy-Hardening/README.md`](../implementation/TASK-317-Vox-SDK-Multi-Tenancy-Hardening/README.md) |
| **Audit driver** | [`05-vox-sdk-review.md`](./05-vox-sdk-review.md) (this doc cross-walks every TASK-317-closed fix back into the audit) |
| **Status** | **Completed** — W1–W5 merged into `fix/2605-review` (W5 `f19ef6fb`, 2026-05-30) |
| **Plan approved** | 2026-05-29 |
| **Created** | 2026-05-30 |
| **Updated** | 2026-05-30 |
| **Engineer-hours (estimated)** | ≈ 16–20 (plan §3 — the C-1 store-per-provider refactor dominates) |
| **Wave merge SHAs** | W1 `6947fd96`, W2 `15c3072a`, W3 `d9e961a5`, W4 `83f1db7b`, W5 `f19ef6fb` |
| **Approach** | 5 sequential implementation waves + 1 documentation step per the `executing-plans` skill — fresh implementation subagent per wave + mandatory `code-reviewer` subagent between waves + `--no-ff` merges back into `fix/2605-review`. All merged reviews returned **APPROVED** or **APPROVED-WITH-MINOR-NITS** (0 critical, 0 important issues at merge) |
| **Predecessor** | TASK-305 (audit 02 — schema) ✅, TASK-306 (audit 03 — DDD layers) ✅, TASK-307 (audit 04 — API gateway) ✅ — `05` is the **last unaddressed audit doc** in the 2026-05-25 multi-tenancy series |
| **Companion** | Server-side tenant boundary (TASK-305/306/307) remains **authoritative**; these `@arcaai/vox` fixes are *browser-side defense-in-depth* complements |

This is the canonical "what TASK-317 actually closed vs. deferred"
document for the browser SDK. Every audit-finding code from
`05-vox-sdk-review.md` that TASK-317 touched is accounted for below,
with the closure path, wave, marker SHA, and (for deferrals) the
rationale and follow-up pointer. Read
[`06-implementation-summary.md` §7](./06-implementation-summary.md#7-task-317--arcaaivox-sdk-multi-tenancy-hardening-2026-05-30)
for the cross-cutting wave summary; this doc is the granular
per-finding ledger.

> **All waves merged.** W1–W5 are merged into `fix/2605-review` — W5 at
> `f19ef6fb` (2026-05-30). The W5 fixes are the code commits cited in §1
> (D-3 `db46a669`, D-6 `f2fbdcaf`, E-1 `478c61b2`, E-3 `6814c6fd`),
> brought into `fix/2605-review` by merge `f19ef6fb`.

---

## 1. What TASK-317 Closed

### 1.1 Audit findings (`05-vox-sdk-review.md`)

Severity from the audit (`05` §C = Critical / §D = Medium / §E = Low;
C-5 is rated **High** in `05`). Marker SHA is the wave merge SHA for
W1–W4 and the W5 **code-commit** SHA for the (not-yet-merged) W5
findings.

| Code | Severity | Closure path | Wave | Marker SHA |
|---|---|---|---|---|
| **C-1** | Critical | `createAgenticStore()` factory + `AgenticStoreContext`; one store per `AgenticProvider` held in `useRef`; internal `useAgenticStore` redefined as a context hook; module-level singleton retained only as a `@deprecated agenticStoreSingleton` shim | W4 | `83f1db7b` |
| **C-2** | Critical | `clearOnLogout(ns)` scoped to the **outgoing** `${tenantId}::${userId}` only — no `arcaai-user-preferences/*` sweep, no wholesale IDB `.clear()` | W1 | `6947fd96` |
| **C-3** | Critical | `PersonalizationManager` takes a `namespace` ctor arg; IDB key = `arcaai-personalization/${ns}`; `ARCAAI_CONFIG_DB_VERSION` 2→3 drops the legacy global row on upgrade | W1 | `6947fd96` |
| **C-4** | Critical | `wsDedupKey(id, userId)` symmetric to `sseDedupKey`; `WSSubscription`/`ManagedWS` carry `userId`+`tenantId`; user-mismatch refuses to share a socket (fail-closed) | W3 | `d9e961a5` |
| **C-5** | High | `clearTenantSessionData()` store action clears the 10-field tenant PHI/session set **synchronously** on `effectiveTenantId` switch, before the async re-hydrate tail (auth/impersonation untouched) | W2 | `15c3072a` |
| **D-1** | Medium | `STORAGE_KEYS.SELECTED_MODELS` reads/writes namespaced `arcaai-selected-models/${ns}` in `ModelRegistry` | W1 | `6947fd96` |
| **D-2** | Medium | Dead `STORAGE_KEYS.PREFERENCES` retained **only** as a documented one-time legacy-cleanup (no live writer) | W1 | `6947fd96` |
| **D-3** | Medium | `getTransformersCacheName({source,tenantId})` + `clearTenantCustomTransformersCache(tenantId)` cache `source:'custom'` weights under `vox/${tenantId}/transformers` (fail-closed); public HF-hub weights unchanged. **Mechanism shipped + unit-tested; live-wiring DEFERRED → §2.1** | W5 | `db46a669` |
| **D-4** | Medium | Per-tenant HMAC subkey `HKDF(workerSecret, tenantId)`; rotates on `setTenantId`; master secret never leaves the SharedWorker | W3 | `d9e961a5` |
| **D-5** | Medium | `useArcaSession` threads `apiClient.getTenantId()` into `createCrossTabSync(config, { tenantId })` → channel `agentic.<tenantId>` | W3 | `d9e961a5` |
| **D-6** | Medium | `AudioContextManager.acquire()` emits a dev-mode warning when the process-wide singleton is held by a **different** tenant (`referenceCount > 1`); singleton lifecycle unchanged | W5 | `f2fbdcaf` |
| **E-1** | Low | TSDoc note at the logger-init site documenting the always-on `ConsoleTransport` as the intended fail-safe base case (no separate fallback transport — it would be redundant) | W5 | `478c61b2` (+ nit `1c50137d`) |
| **E-2** | Low | `loadSelectedFromStorage` validates parsed JSON with a `valibot` schema; invalid → `null` + `logger.warn` (no throw) | W1 | `6947fd96` |
| **E-3** | Low | `apps/example/README.md` documents the app as a standalone raw-WebSocket/fetch demo, **not** a vox consumer (rename to `apps/raw-ws-demo` declined as non-trivial) | W5 | `6814c6fd` |
| **E-4** | Low | `SttV2WebSocketClient.connect` gains opt-in `requireTenantClaim` — rejects before opening a socket unless a claim resolves. **Opt-in guard shipped; prod-wiring DEFERRED → §2.1** | W3 | `d9e961a5` |
| **E-5** | Low | `providers/__tests__/multi-instance.test.ts` — two providers (tenant A + B) assert store isolation + switch-mid-session + impersonation start→stop | W4 | `83f1db7b` |

**Severity roll-up:** 4 Critical (C-1..C-4) + 1 High (C-5) + 6 Medium
(D-1..D-6) + 5 Low (E-1..E-5) = **16 findings closed** (2 with
production-wiring deferred — see §2.1).

### 1.2 Test-count delta (from the plan README change history)

| Wave | Suite delta | Notes |
|---|---|---|
| W1 | vox → **2928** green | AC-1..AC-6; W1 diff typecheck-neutral (13 pre-existing `tsc` errors untouched). Pre-W1 vox baseline not recorded in the change history |
| W2 | vox → **2929** green | AC-7 (`clearTenantSessionData()` synchronous reset; +1 net) |
| W3 | vox **2929 → 2945** green | AC-8..AC-11 (+12 at implementation, +4 at review = +16 net merged) |
| W4 | vox **2945 → 2948** green | AC-12/AC-13 (+3; multi-instance isolation suite) |
| W5 | utils **140 → 145**, room **488 → 493** green | AC-14 (+5 utils), AC-15 (+5 room). AC-16/AC-17 are TSDoc/README-only — no vox test delta |

**Final green gate:** vox **2948** / utils **145** / room **493**;
typecheck-neutral (13 pre-existing vox `tsc` errors unchanged; lint 0
errors, pre-existing prettier warnings only).

---

## 2. What TASK-317 Deferred

Two classes of deferrals — substantive mechanism-shipped /
production-wiring deferrals, and review-time minor nits. Neither class
is blocking; the security primitive lands in-tree in every case.

### 2.1 Mechanism shipped, production-wiring deferred

| Code / AC | What shipped (tested) | What is deferred | Where it goes |
|---|---|---|---|
| **D-3 / AC-14** (`db46a669`) | `getTransformersCacheName` (fail-closed for `source:'custom'` without a tenantId) + `clearTenantCustomTransformersCache` orphan-cleanup hook, unit-tested (utils +5) | NOT wired into the live `AgenticProvider` tenant-switch, and Transformers.js is not yet configured to **write** under the tenant-scoped name — there is **no in-repo caller today**, so the mechanism is dormant | Future integration ticket (wire `clearTenantCustomTransformersCache` into the tenant-switch path + configure Transformers.js cache naming) |
| **E-4 / AC-10** (`d9e961a5`) | `SttV2WebSocketClient.connect` opt-in `requireTenantClaim` — rejects before opening when no claim resolves from the `tenantClaim` option or URL `tenantId`/`tenant`; default-off preserves bare-URL callers | NOT wired into the production callers (`PluginManager.buildStreamingTransport` / `StreamingSessionManager`), and `resolveTenantClaim` does **not** yet accept the real production discriminator (`ticket` / `sessionId`) — prod WS URLs currently carry `sessionId`+`ticket`, not `tenantId` | Follow-up (extend `resolveTenantClaim` to accept `ticket`/`sessionId` + flip `requireTenantClaim` on in the prod streaming transport) |

### 2.2 Review-time minor nits

Captured during the per-wave `code-reviewer` passes. All minor; none
block any AC. The substantive deferrals above are tracked in §2.1.

| # | Source review | Description |
|---|---|---|
| **317-W1-a** | W1 review | `loadFromBackend` race in the opt-in `hybrid`/`backend` storage modes (non-security; the default mode is `local`) |
| **317-W1-b** | W1 review | `clearOnLogout` has no production caller (pre-existing) |
| **317-W2-a** | W2 review | The switch reset runs in `useEffect`, leaving a **one-frame paint window** where tenant B identity is rendered with not-yet-cleared tenant-A PHI (AC-7 "before the new config resolves" is still met; not switched to `useLayoutEffect` this pass) |
| **317-W2-b** | W2 review | Transient `*Error` slices are **not** included in the switch reset |
| **317-W2-c** | W2 review | No generation guard for rapid double-switches (A→B→A) |
| **317-W3-a** | W3 review | *No residual nit deferred* — the I-1 (`useSharedWS` not threading `userId`/`tenantId`, dedup collapsed to `id::anon`) and M-1 (empty/whitespace `tenantId` HKDF parity) review findings were **fixed in-wave** (`a2553fcd`, `27e4cd8e`). W3's only deferral is the AC-10 production wiring (§2.1 E-4) |
| **317-W4-a** | W4 review | Pre-existing `apps/ui-playground` `tsc` errors (605 = 605; SDK-src error line-shift only) — left untouched |
| **317-W4-b** | W4 review | 3 pre-existing `apps/ui-playground` test failures from mock/source drift — `use-file-transcription` `uploadAndTranscribeWithProgress`; `use-auto-refresh.impersonation` stale assertion |
| **317-W4-c** | W4 review | Future removal of the `@deprecated agenticStoreSingleton` shim once all external importers migrate to the public `useArcaStore` / `useStoreApi` context accessors |
| **317-W5-a** | W5 review | **AC-14 dormant mechanism** — the tenant-scoped transformers cache ships unit-tested but has no in-repo caller (= §2.1 D-3) |
| **317-W5-b** | W5 review | `AudioContextManager` dev-only **phantom-holder over-warn** on interleaved partial-release (the holder-tenant `Set` can over-report a cross-tenant hold when acquires/releases interleave before `referenceCount` returns to 0) — dev-warning only, no runtime effect |
| **317-W5-c** | W5 review | AC-16 note **style** — the console-transport TSDoc wording was softened (`1c50137d`) after review |

---

## 3. Approach (Wave Sequence)

| # | Wave | Branch | Commits | Tests added | Verdict | Merge SHA |
|---|---|---|---|---|---|---|
| 1 | **W1** Browser-storage tenant/user namespacing (C-2, C-3, D-1, E-2, D-2) | `task-317/w1-storage-namespacing` | 11 | AC-1..AC-6 (vox → 2928) | APPROVED-WITH-MINOR-NITS (2 fix cycles: C-1 live-namespace accessor + re-hydrate; I-1 personalization `hydrate()` authoritative reset) | `6947fd96` |
| 2 | **W2** Tenant-switch session reset (C-5) | `task-317/w2-tenant-switch-reset` | 5 | AC-7 (vox → 2929) | APPROVED-WITH-MINOR-NITS (C-1 full PHI coverage confirmed; M-2 `tenantConfig` reload) | `15c3072a` |
| 3 | **W3** Cross-tab / WebSocket isolation (C-4, D-5, D-4, E-4) | `task-317/w3-crosstab-ws-isolation` | 12 | AC-8..AC-11 (+16 → vox 2945) | APPROVED (1 fix cycle: I-1 `useSharedWS` threading; M-1 HKDF empty-tenant parity) | `d9e961a5` |
| 4 | **W4** Store-per-provider refactor + multi-instance tests (C-1, E-5) | `task-317/w4-store-per-provider` | 8 | AC-12/AC-13 (+3 → vox 2948) | APPROVED (1 fix cycle: C-1 ui-playground migrated off the inert singleton onto public context accessors) | `83f1db7b` |
| 5 | **W5** Cache scoping + hygiene (D-3, D-6, E-1, E-3) | `task-317/w5-cache-hygiene-docs` | 8 (W5.1–W5.4 + RED/prettier/nit) | AC-14..AC-17 (utils +5 → 145; room +5 → 493) | APPROVED-WITH-MINOR-NITS (3 nits — §2.2 317-W5-a..c) | `f19ef6fb` |
| 6 | **W5.5** Closure documentation | `task-317/w5-cache-hygiene-docs` | this step | 0 (doc-only) | (folded into the W5 merge) | `f19ef6fb` |

Per-wave methodology (uniform across all 5 implementation waves):

1. Fresh implementation subagent on a new branch off `fix/2605-review`
   (W4 rebased onto post-W3).
2. Strict TDD — RED cross-tenant/cross-user negative test first
   (`describe('TASK-317 W*.x — …')`), GREEN minimal fix.
3. Mandatory `code-reviewer` subagent verdict before merge.
4. `--no-ff` merge into `fix/2605-review` so the wave history is
   preserved.

Strict-sequential waves were chosen over TASK-307-style parallel
worktrees because the SDK findings cluster in a few tightly-coupled
files (`agenticStore.ts`, `AgenticProvider.tsx`, `useArcaSession.ts`)
that several waves touch — parallel worktrees would have conflicted
heavily.

---

## 4. Lessons Learned

- **Mechanism-first / deferred-wiring is the right shape for
  low-residual client fixes.** Both D-3 (tenant-scoped transformers
  cache) and E-4 (`requireTenantClaim`) ship a tested, fail-closed
  mechanism that is intentionally opt-in / not yet wired into the
  production streaming path. This lands the security primitive and
  merges cleanly without churning prod WS URLs (which carry
  `sessionId`+`ticket`, not `tenantId`) — same pattern as TASK-306's
  opt-in AC-10 guard. The live-wiring is a tracked follow-up (§2.1),
  not a silent gap.
- **A source-resolved typecheck/test gate does not catch
  consumer-runtime breakage.** W4's vox suite, vox typecheck, and
  ui-playground type-check were all green, yet `apps/ui-playground`
  read provider-initialized `apiClient`/`configManager`/`logger` off
  the now-**inert** `@deprecated` singleton at runtime — a silent
  TASK-245 impersonation preference-isolation regression that **only
  the consuming-app smoke gate** (`vite build` + ui-playground test
  run) surfaced. When a refactor changes *which object is
  initialized*, a runtime/consumer smoke gate is mandatory, not
  optional.
- **Per-provider store + fail-loud context accessor is the canonical
  isolation primitive.** `createAgenticStore()` + `AgenticStoreContext`
  + the public `useArcaStore(selector)` / `useStoreApi()` (which
  **throws** outside a provider rather than falling back to a global)
  is what actually closes cross-instance state bleed. The module
  singleton survives only as a `@deprecated` shim for external
  importers — and even that proved to be a runtime footgun (see above).
- **Fail-closed namespacing throughout.** Every new key derivation
  refuses rather than silently degrades: `getTransformersCacheName`
  throws for `source:'custom'` without a tenantId; WS dedup refuses to
  share a socket on user-mismatch; cross-tab HKDF derives a per-tenant
  subkey and drops mismatched-key messages. A namespacing bug surfaces
  as a hard failure in dev, not a quiet cross-tenant read.
- **Contract-inversion tests must be rewritten, not extended.** AC-3
  inverted the `clearOnLogout` contract (the pre-existing
  `agenticStore.test.ts` asserted it wiped *all*
  `arcaai-user-preferences/*` keys); those assertions were **rewritten**
  to assert outgoing-namespace-only scoping and called out explicitly
  in the W1 PR, rather than layering new assertions on top of an
  inverted contract.
- **Strict-sequential waves beat parallel worktrees when the change
  surface is a few hot files.** `AgenticProvider.tsx`/`agenticStore.ts`/
  `useArcaSession.ts` are each touched by multiple waves; sequencing
  (each wave off the prior merge) with a code-reviewer gate produced
  0 critical/important issues at every merge across W1–W4.

---

## 5. Cross-references

- **Implementation plan**: [`docs/implementation/TASK-317-Vox-SDK-Multi-Tenancy-Hardening/README.md`](../implementation/TASK-317-Vox-SDK-Multi-Tenancy-Hardening/README.md)
- **Audit driver** (`05-vox-sdk-review.md`): [`./05-vox-sdk-review.md`](./05-vox-sdk-review.md) — TASK-317 closure banner at top; per-finding `[CLOSED W<n> <sha>]` markers on every C/D/E finding heading
- **TASK-305 implementation summary**: [`./06-implementation-summary.md` §7](./06-implementation-summary.md#7-task-317--arcaaivox-sdk-multi-tenancy-hardening-2026-05-30) — the wave-by-wave TASK-317 summary in the same style as §1/§6
- **SDK rule reference**: [`.cursor/rules/08-vox-sdk.mdc`](../../.cursor/rules/08-vox-sdk.mdc) § "Multi-Tenancy & Data Isolation"
- **Architecture overview**: [`docs/technical-architecture-overview.md`](../technical-architecture-overview.md) § Multi-tenancy enforcement layers (browser-side SDK isolation noted as client defense-in-depth)
- **Predecessor closure record**: [`./07-ddd-layers-followup-closure.md`](./07-ddd-layers-followup-closure.md) (TASK-306)
- **Key source files**:
  - [`packages/agentic-sdk-v2/src/store/agenticStore.ts`](../../packages/agentic-sdk-v2/src/store/agenticStore.ts) — `createAgenticStore()` factory, `clearOnLogout(ns)`, `clearTenantSessionData()` (C-1, C-2, C-5)
  - [`packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`](../../packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx) — `AgenticStoreContext`, tenant-switch reset, logger-init fail-safe note (C-1, C-5, E-1)
  - [`packages/agentic-sdk-v2/src/core/PersonalizationManager.ts`](../../packages/agentic-sdk-v2/src/core/PersonalizationManager.ts) — namespaced IDB key (C-3)
  - [`packages/agentic-sdk-v2/src/core/ModelRegistry.ts`](../../packages/agentic-sdk-v2/src/core/ModelRegistry.ts) — namespaced `selected-models` + valibot validation (D-1, E-2)
  - [`packages/agentic-sdk-v2/src/core/SharedConnectionWorker.ts`](../../packages/agentic-sdk-v2/src/core/SharedConnectionWorker.ts) — `wsDedupKey(id, userId)` (C-4)
  - [`packages/agentic-sdk-v2/src/core/CrossTabHmacKeyManager.ts`](../../packages/agentic-sdk-v2/src/core/CrossTabHmacKeyManager.ts) — per-tenant HKDF subkey (D-4)
  - [`packages/utils/src/transformers-cache.ts`](../../packages/utils/src/transformers-cache.ts) — `getTransformersCacheName` / `clearTenantCustomTransformersCache` (D-3, mechanism-only)
  - [`packages/room/src/core/AudioContextManager.ts`](../../packages/room/src/core/AudioContextManager.ts) — cross-tenant dev-warning (D-6)
