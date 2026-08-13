# TASK-568 — v1-Compat STT Provider-Switch Surface (`useArcaSttProvider` + `onStatus` wiring)

- **Status**: Review (implemented + gate-green 2026-07-28; staged-not-committed, owner tail = commit + live-stack browser pass)
- **Type**: feature
- **Ticket number**: TASK-568 — next free after TASK-567 (confirmed 2026-07-28). NOTE: TASK-567 §4's *optional* sub-ticket split previously suggested reusing 568–570; that suggestion is amended in TASK-567 to "allocated at split time" — this ticket owns 568.
- **Size**: S
- **Dependencies**: **TASK-567 Phase F must land first** — this ticket is a thin compat adapter over the v2 surface 567 adds (`useArcaAudio().switchToFallback()`, `activePipeline`, `sttConnectionState`, the `provider_switched` status frame). Contract context: TASK-560 §5 (frozen v1 hook shapes), TASK-564 §5 (frozen metadata-passthrough contract), TASK-563 (migration guide this ticket extends).

---

## 1. Requirement Analysis

Owner requirement: give application developers migrating from HOPE-v1 (the TASK-560–566 `@arcaai/vox/compat` audience) **a simple way to implement the user control flow for switching between STT providers** — i.e. the TASK-567 R4 "end-user switches to the tenant's default fallback on-the-flight", exposed on the compat surface so a v1-style app can build it without adopting the full v2 hook set.

Restated as verifiable outcomes:

1. A v1-migrated app can render a "Switch transcription provider" control with **one new hook** — no v2 store knowledge, no `useArcaAudio` adoption, no WS awareness.
2. A v1-migrated app is **told when an automatic fallback switch happens** through the v1 callback style it already uses (so it can toast/banner), without changing any frozen v1 signature.
3. Existing compat consumers that ignore this feature are byte-for-byte unaffected (frozen contracts intact; additive-only).

Classification: `feature` (SDK compat lane only — no backend, no DB, no console work; all of that is TASK-567).

## 2. Current State Evaluation (code-verified 2026-07-28, branch `thuynh/2607`)

- **Compat surface** (`packages/agentic-sdk-v2/src/compat/`, entry `src/compat.ts`, tsup entry `dist/compat.*` — TASK-561): `ArcaCompatProvider`, `mapV1ConfigToAgenticConfig`, `useArcaSessionManager`, `useAudioCapture`, `useArcaSpeechToText`, `useSMR`, plus the frozen v1 type surface in `compat/types.ts`. Adapters consume ONLY the public v2 API (stated invariant in the `src/compat.ts` header — this ticket keeps it).
- **The ready-made notification channel is already frozen into the v1 contract but unwired**: `UseArcaSpeechToTextProps.onStatus?: (status: string, data?: unknown) => void` exists (`useArcaSpeechToText.ts:55`) — reproduced from the v1 shape in TASK-560 §5.3 — but the hook body never destructures or calls it. Wiring it is additive behavior on an existing optional prop, not a contract change.
- **No provider concept exists anywhere in compat**: `V1SdkConfig.sttPipelineId` (`compat/types.ts:44`) is the only pipeline-adjacent field, consumed once at config-adapt time. v1 itself never had provider switching, so there is **no v1 name to reproduce** — a switch hook is a compat-native *extension*, which the migration guide must label as such (it is the one import a migrated app adds that has no v1 ancestor).
- **v2 prerequisites do not exist yet** (they are TASK-567 Phase F): no `switchToFallback()` on `useArcaAudio`, no `activePipeline`, no `sttConnectionState` in `agenticStore.ts`, no `provider_switched` status frame; `SttWebSocketClient` reconnect callbacks unwired. Verified in the TASK-567 exploration pass (its §2.4).
- **Metadata-passthrough machinery (TASK-564/565)** — `speechToTextMetadata.ts` timeline + `composeDeliveredMetadata` precedence — is orthogonal; a provider switch must not disturb the timeline (`captureStartMs` anchor survives a switch because capture never stops — test-locked in §5).
- 82 compat tests green in isolation (`src/compat/__tests__/`); contract tests lock the frozen shapes.

## 3. Design (decisions)

### D-1 One new hook, additive-only: `useArcaSttProvider`

New file `src/compat/useArcaSttProvider.ts`, exported from `src/compat.ts` (append-only). Deliberately tiny — the "simple thing":

```ts
export interface ProviderSwitchInfo {
  fromPipeline: { id: string; name?: string };
  toPipeline: { id: string; name?: string };
  reason: 'auto' | 'user';
  atMs: number; // capture-relative, same base as the metadata timeline
}

export interface UseArcaSttProviderProps {
  /** Fired on EVERY switch (auto or user) — the toast/banner hook point. */
  onProviderSwitched?: (info: ProviderSwitchInfo) => void;
  /** Fired when a user-requested switch fails. Reuses the frozen v1 ErrorInfo. */
  onSwitchFailed?: (error: ErrorInfo) => void;
}

export interface UseArcaSttProviderReturn {
  /** Pipeline currently transcribing (null before capture starts). */
  activeProvider: { pipelineId: string; name?: string; isFallback: boolean } | null;
  /** True when the tenant has a default fallback configured AND the session can switch. */
  fallbackAvailable: boolean;
  isFallbackActive: boolean;
  switchStatus: 'idle' | 'switching' | 'switched' | 'failed';
  /** User control flow entry point (TASK-567 R4). Idempotent; rejects with ErrorInfo
   *  code 'FALLBACK_UNAVAILABLE' when no fallback is configured or no session is live. */
  switchToFallback: () => Promise<void>;
}
```

Implementation: a thin adapter over the TASK-567 v2 surface — `useArcaAudio().switchToFallback()` + `activePipeline` + `sttConnectionState` selectors. No store internals, no clients of its own (compat invariant preserved). Error mapping to the frozen `ErrorInfo` shape (`category: 'processing'`, codes `FALLBACK_UNAVAILABLE` | `SWITCH_FAILED`).

Naming: `useArcaSttProvider` (provider state + control). `useArcaSttFallback` was considered and rejected — the hook also answers "which provider am I on now?", not just fallback.

### D-2 Auto-switch notification rides the EXISTING frozen `onStatus` prop

`useArcaSpeechToText` wires its already-declared `onStatus` prop (behavior addition, zero signature change): on a v2 `provider_switched` event it calls `onStatus('provider_switched', { fromPipeline, toPipeline, reason })`, and additionally forwards the connection transitions v1 apps could never see (`onStatus('reconnecting')`, `onStatus('reconnected')`) now that TASK-567 wires the underlying callbacks. Apps that never passed `onStatus` see no change. The status string set is documented in the migration guide and locked by contract test.

### D-3 Degraded/no-op posture (compat runs against mixed backends)

If the deployment predates TASK-567 (no fallback configured, no switch endpoint): `fallbackAvailable` is `false`, `switchToFallback()` rejects with `FALLBACK_UNAVAILABLE`, `onStatus` simply never fires switch events. No capability probing beyond what the v2 surface exposes; no retries; no silent fallback to session-restart in v1 compat (the v2 `useArcaAudio` degraded path from TASK-567 §3.6, if it engages, surfaces here as a normal switch — compat doesn't reimplement it).

### D-4 Explicit non-goals

Pipeline *listing/selection* UI helpers (v1 apps pass `sttPipelineId` via config; richer selection is a v2-native concern — `usePipelines()`), switching *back* to primary mid-session (567 non-goal), any change to `sendAudioData`/metadata semantics, any new `V1SdkConfig` field.

## 4. Implementation Plan (single lane: `packages/agentic-sdk-v2`)

| # | Action | File |
|---|---|---|
| 1 | NEW | `src/compat/useArcaSttProvider.ts` — the §3 D-1 hook |
| 2 | UPDATE | `src/compat/useArcaSpeechToText.ts` — destructure + wire `onStatus` (D-2); ref-pattern like `onTranscriptRef` so effects don't re-subscribe |
| 3 | UPDATE | `src/compat/types.ts` — add `ProviderSwitchInfo` (append-only; frozen shapes untouched) |
| 4 | UPDATE | `src/compat.ts` — export hook + types (append-only) |
| 5 | NEW | `src/compat/__tests__/useArcaSttProvider.test.tsx` + UPDATE `useArcaSpeechToText` tests (§5) |
| 6 | UPDATE | migration guide (TASK-563 doc, `docs/` + package README section) — "Provider switching (no v1 ancestor)" section with a copy-paste control-flow example (button + toast) |
| 7 | UPDATE | `apps/example` v1-style demo — minimal switch button + status toast (proves the DX claim) |
| 8 | UPDATE | this README (Implementation Summary, evidence) |

Order: 1→5 TDD (RED first), 6–7 after green, 8 last. Gate: `pnpm --filter @arcaai/vox build test lint typecheck` (note the pre-existing `window is not defined` flake in the full vox suite — TASK-564 memory; compat suite green in isolation is the merge bar, matching 564–566 precedent).

## 5. TDD Plan (RED first; outputs pasted before implementation)

1. `useArcaSttProvider` returns `fallbackAvailable: false` + `activeProvider: null` before capture; `switchToFallback()` rejects `FALLBACK_UNAVAILABLE` (frozen `ErrorInfo` shape asserted).
2. With a mocked v2 surface exposing a fallback: `switchToFallback()` → `switchStatus` transitions `idle → switching → switched`; `isFallbackActive` true; `onProviderSwitched` fired with `reason: 'user'`; second call is idempotent (no duplicate v2 call).
3. v2 switch rejection → `switchStatus: 'failed'`, `onSwitchFailed` with `SWITCH_FAILED`, state recoverable (retry allowed).
4. Auto-switch event from v2 → `onProviderSwitched` `reason: 'auto'` AND `useArcaSpeechToText`'s `onStatus('provider_switched', …)` fires with the documented payload; apps without `onStatus` unaffected (no throw).
5. Contract locks: existing frozen `UseArcaSpeechToTextProps`/`Return` shape snapshots unchanged; `compat.ts` export surface snapshot is append-only vs the TASK-561/564 baseline.
6. Metadata timeline integrity across a switch: `sendAudioData` entries recorded before a switch still correlate to finals after it (capture-relative base survives — extends the TASK-565 timeline tests).
7. Reconnect statuses (`reconnecting`/`reconnected`) surface through `onStatus` when the v2 callbacks fire.

## 6. Acceptance & DoD

- [ ] A v1-migrated app implements the full user control flow (button → switch → confirmation, plus auto-switch toast) using only `@arcaai/vox/compat` imports — demonstrated in `apps/example` and the migration guide
- [ ] All frozen contracts (TASK-560 §5, TASK-564 §5) byte-identical: shape-snapshot tests green; export surface append-only
- [ ] Degraded posture verified: no fallback configured → clean `FALLBACK_UNAVAILABLE`, never a crash or silent no-op promise resolution
- [ ] Compat suite green in isolation; `pnpm --filter @arcaai/vox build lint typecheck` green; RED evidence + gate output pasted here
- [ ] Migration guide updated; TASK-567 §4/§3.6 cross-references updated to point here for the compat lane

## 7. Risks & Rollback

| Risk | Mitigation |
|---|---|
| TASK-567 Phase F surface drifts from the shapes assumed here (`switchToFallback`/`activePipeline`/`sttConnectionState` names) | This ticket freezes NOTHING against 567 — it adapts to whatever 567 lands; re-verify names at implementation start (TASK-526 §9.1 precedent) |
| `onStatus` wiring surprises an app that passed it for other reasons | v1 apps' `onStatus` was already typed `(status: string, data?)` and v1 fired its own status strings; new strings are additive and documented; test 4 locks the payload |
| Compat layer touched while TASK-564/565/566 work is uncommitted on this branch | Coordinate: 568 starts only after 560–566 are committed (owner tail already pending per those tickets); file overlap is `useArcaSpeechToText.ts` + `compat.ts` + `types.ts` |
| Rollback | Purely additive: remove the new hook file + the `onStatus` wiring block + exports; frozen surface untouched by construction |

## 8. References

- Compat exemplars: `src/compat/useArcaSpeechToText.ts` (adapter style, ref-pattern, frozen-contract discipline), `src/compat/speechToTextMetadata.ts` (timeline), `src/compat/__tests__/` (contract-lock test style)
- Contracts: TASK-560 README §5 (frozen v1 shapes), TASK-564 README §5 (metadata passthrough), TASK-563 (migration guide to extend)
- Backend/v2 feature this adapts: `docs/implementation/TASK-567-Tenant-STT-Fallback-Provider-BYOK/README.md` (§3.4 switch mechanism, §3.6 SDK surface)

## 9. Implementation Summary

Implemented against the TASK-567 Phase F v2 surface as it landed on the tree
(verified names: `useArcaAudio().switchToFallback()` / `activePipeline` /
`sttConnectionState`, store `ActivePipelineInfo`, `SttConnectionState`).

Files:

- **NEW** `packages/agentic-sdk-v2/src/compat/useArcaSttProvider.ts` — the §3 D-1
  hook. Thin adapter over `useArcaAudio()`; owns no client/store. `activeProvider`
  / `fallbackAvailable` / `isFallbackActive` derived from `audio.activePipeline`;
  `switchStatus` local; `switchToFallback()` idempotent, rejects `ErrorInfo`
  (`FALLBACK_UNAVAILABLE` when no live backend pipeline, `SWITCH_FAILED` on v2
  rejection). `onProviderSwitched` fires for BOTH auto and user switches via an
  effect that detects the `activePipeline.isFallback` flip; the `reason` is
  derived from an in-flight-user-switch ref, `fromPipeline` from the pre-flip
  pipeline ref, `atMs` from a capture-anchored base.
- **UPDATE** `src/compat/useArcaSpeechToText.ts` — wired the already-frozen-but-
  unwired `onStatus` prop (D-2) with the `onTranscriptRef` ref pattern
  (`onStatusRef`): `provider_switched` (on the fallback flip, payload
  `{fromPipeline,toPipeline}` — the only fields the v2 store surfaces),
  `reconnecting`, `reconnected`. Zero change to the frozen signature; apps
  without `onStatus` unaffected.
- **UPDATE** `src/compat/types.ts` — appended `ProviderSwitchInfo` (compat-native,
  frozen shapes untouched).
- **UPDATE** `src/compat.ts` — appended the hook + type exports (append-only).
- **TESTS** `src/compat/__tests__/useArcaSttProvider.test.tsx` (5) + additions to
  `useArcaSpeechToText.test.ts` (4: provider_switched, reconnect pair,
  no-`onStatus` no-op, metadata-timeline-survives-switch). Export surface
  asserted append-only; return shape locked via `expectTypeOf`.
- **DOCS** migration guide (`TASK-560-.../MIGRATION_GUIDE.md`) — new "Provider
  switching (no v1 ancestor)" section with the copy-paste control flow.
- **EXAMPLE** `apps/example/src/compat-consultation.tsx` — `useArcaSttProvider`,
  a "Switch provider" button, active-provider line, and a switch banner (covers
  user + auto).

Divergence from the plan (adapting to what 567 actually landed): the
`onStatus('provider_switched', …)` payload carries `{fromPipeline,toPipeline}`
only — the v2 store surfaces the active pipeline but not the switch `reason` or a
separate from/reason tuple, so `reason` is NOT fabricated at this layer. The
richer `reason`-bearing `ProviderSwitchInfo` lives on `useArcaSttProvider`.

### Evidence (2026-07-28, branch `thuynh/2607`)

- `pnpm --filter @arcaai/vox build` → **Build success** (all 4 tsup entries + `build:dts` `tsc` emit clean).
- `pnpm --filter @arcaai/vox typecheck` → `tsc --noEmit` clean (0 errors).
- `pnpm --filter @arcaai/vox test` → **216 files / 3686 tests passed** (the known `window is not defined` full-suite flake did not occur this run; compat suite green in isolation = 8 files / 93 tests).
- `pnpm --filter @arcaai/vox lint` → 0 errors; touched compat files 0 warnings (repo-wide pre-existing warnings unrelated).

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-28 | Ticket authored: compat-lane companion to TASK-567. Decisions: one additive `useArcaSttProvider` hook (state + `switchToFallback()`), auto-switch notification through the already-frozen-but-unwired `onStatus` prop on `useArcaSpeechToText` (zero contract change), degraded `FALLBACK_UNAVAILABLE` posture, explicit non-goals. 8-step plan, 7-item TDD list. Status Pending. |
| 2026-07-28 | Implemented all 8 plan steps against the landed 567 Phase F surface. Added `useArcaSttProvider` + `onStatus` wiring + `ProviderSwitchInfo` + exports + 9 tests + migration-guide section + example switch UI. Gate green (build/test/typecheck/lint). Documented the payload divergence (`onStatus` carries from/to only; `reason` on the richer hook). Status → Review; staged-not-committed. |
