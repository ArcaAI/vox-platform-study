# TASK-459 — Live-Documentation Durability: Truncation + Owner Lock (C5-04 · C5-06)

- **Status**: Review — implemented, adversarially reviewed (+ I-1/I-2 fixes), merged to `fix/2605-review` (Wave 2 Batch 1)
- **Type**: bugfix (data durability + cost)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 2 (P1)
- **Findings**: C5-04 (Med, CONFIRMED) · C5-06 (Med, CONFIRMED) — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md)
- **Branch (when scheduled)**: `fix/task-459-live-doc-durability` (from the Wave-1 landing on `fix/2605-review`)
- **Size**: M
- **Suggested agent**: general-purpose (TS, applications)

## ⚠️ Coordination note (resolved)

This ticket edits `live-documentation.service.ts` — the same file TASK-452 (Wave 1, landed) and the accepted-as-is TASK-453 relate to. The scout confirmed C5-04 (`flush` delta/cursor, ~:444-467) and C5-06 (`stop`/`claimOwnership`, ~:316/:665-694) are in code regions **entirely separate** from TASK-452's `callNlp` fix (~:819-839). No coordination blocker — TASK-452 is landed and its region is untouched here.

## File-ownership manifest (exclusive — binding)

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` | Delta carry-forward (C5-04); NX/fenced owner lock + durable-snapshot dedup (C5-06) |
| `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.service.test.ts` | Truncation + mutual-exclusion tests |

Do NOT touch `callNlp` (~:819-839, TASK-452's region), the DTO, or `redis-cache.service.ts` (extend its use via the existing `eval` method, don't change the service). Anything outside the manifest → STOP and report.

## Requirement Analysis

### C5-04 (Med) — long-transcript truncation drops the head permanently
In `flush` ([live-documentation.service.ts:444-467](packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts)): `flushUpTo` is the full current `transcriptParts.length` (:444); `delta` spans `[flushedTranscriptCount, flushUpTo)` (:445); when it exceeds `MAX_DELTA_CHARS=12000` (:37) it is truncated to the **last** 12k (`delta.slice(-MAX_DELTA_CHARS)`, :446) — **dropping the head**; on SMR success the cursor jumps to the full `flushUpTo` (:467), so the dropped head is marked flushed and **never re-sent** — no carry-forward. The `delta || transcript` fallback (:448) doesn't rescue it (delta is non-empty). Crucially, a delta only grows past 12k when the cursor is stuck because SMR was failing — so `priorNote` never absorbed that head either. Net: the oldest content (chief complaint / allergies stated early) is permanently absent from the live note.

### C5-06 (Med) — owner lock is claim-only → duplicate SMR spend + duplicate PRE_SUMMARY rows
`claimOwnership` ([:675-694]) does an **unconditional** `cacheService.set(lockKey, instanceId, LOCK_TTL)` (:677) — no NX/conditional (the `IRedisCacheService.set` has no NX option), called fire-and-forget from `start()` (:269), return ignored. The doc comment (:665-673) admits the gap. No renewal (LOCK_TTL=3600 set once, never refreshed), no fencing (`instanceId` written but never compared), and release is **unconditional** `del` (:316) — a non-owner `stop` deletes the real owner's lock. Consequences: (1) a 2nd instance's `start()` silently overwrites and runs its own watcher → two `callSmr` `/generate` calls per consultation; (2) `persistDurableSnapshot` (:734-760) dedups only via the **in-memory** `session.snapshotEntity` (:745) and never queries the repo, and `ContextItemFactory.CreatePreSummary` mints a fresh id with no dedup → **two persisted PRE_SUMMARY rows** for one consultation. The atomic primitive exists but is unused: `IRedisCacheService.eval(script, numKeys, …)` (`redis-cache.service.ts:171`) — the natural hook for a `SET NX` / Lua CAS lock (the test mock already stubs `eval`).

### Acceptance criteria

- [ ] **C5-04 (red first)**: a test drives a delta > `MAX_DELTA_CHARS` (with `priorNote` empty, the first-flush-backlog case) and asserts the head content is currently lost (absent from the note AND from any subsequent flush). Then the fix: on truncation, do NOT advance the cursor past the dropped region — carry the overflow forward (send the head in the next flush) OR keep the head instead of the tail — so no early clinical content is permanently dropped. Log a PHI-safe counter of truncation events.
- [ ] **C5-06 (red first)**: a test with two instances asserts the current code lets both run (duplicate SMR + two PRE_SUMMARY rows). Then: acquire the lock with `SET NX` (via `cacheService.eval` Lua or an NX option) and **bail out of `start()`** when a live foreign instance holds it; add fencing (compare `instanceId` on release — only the owner deletes) + periodic renewal within the session; make the durable-snapshot upsert deterministic (query/dedup by consultation+subType, not just in-memory) so a race can't create a second PRE_SUMMARY row.
- [ ] **AC-gate**: `pnpm --filter @arcaai/applications build test lint` green; output pasted.

### Non-goals

- The TASK-452 NER contract (done). The harness/durable NER (TASK-463, done).
- Re-pointing live NER at the transcript, or the SOTA warm-start (strategic track).
- Changing the debounce/throttle/min-interval flush cadence (only truncation carry-forward + the lock).

## Current State Evaluation (code-verified 2026-07-09 against `fix/2605-review`)

C5-04: `MAX_DELTA_CHARS=12000` [:37]; truncation [:446]; cursor advance [:467]; `flushedTranscriptCount` init [:253], read [:445]. C5-06: `claimOwnership`/`set` [:675-694/:677]; `LOCK_TTL=3600` [:117]; `instanceId` [:119]; unconditional release [:316]; `persistDurableSnapshot` in-memory dedup [:734-760/:745]; `eval` primitive [`redis-cache.service.ts:171`]. Redis keys: lock `consultation:live-summary:{id}:lock` [:851-853], snapshot `:last` [:855-857], channel [:841-843], control [:846-848].

Test gaps: no test drives >12k truncation (P0-B bounded-cost tests use tiny deltas, `…test.ts:424-468`); the P1-A "cross-instance" tests (`…test.ts:502-534`) cover only stop/release, NOT mutual exclusion on claim or duplicate PRE_SUMMARY. Cache mock stubs `eval`+`set` (`…test.ts:60-71`).

## Implementation Plan (TDD — strict order)

> Context pack: this README · TASK-449 §Architecture preamble (this is the **realtime live note** — ephemeral UX, but C5-04 loses early clinical content from what the clinician reads, and C5-06 doubles LLM cost + writes duplicate durable PRE_SUMMARY rows) · `.claude/rules/04-application-services.md`.

1. RED→GREEN C5-04 (carry-forward), then C5-06 (NX lock + fencing + dedup). Each failing test first.
2. Prefer the existing `cacheService.eval` for the atomic NX/CAS lock (no new infra).

### Verification gate

```bash
pnpm --filter @arcaai/applications build test lint
```

Adversarial review focus: (a) C5-04 — can any truncation sequence still permanently drop head content? does carry-forward risk unbounded delta growth? (b) C5-06 — is the NX acquire truly atomic (Lua/NX, not read-then-set)? does release only delete the owner's lock? can two instances still both create a PRE_SUMMARY row under a race? (c) is the flush cadence unchanged? (d) zero diff outside the manifest (esp. `callNlp` untouched).

## Implementation Summary

**Branch**: `fix/task-459-live-doc-durability` (2 commits) — merged to `fix/2605-review` (Wave 2 Batch 1).

**What shipped**: C5-04 head-first carry-forward — the delta accumulates HEAD-first up to `MAX_DELTA_CHARS`, the cursor advances only over sent segments, the overflow tail carries to the next flush, and `stop()` drains in a bounded loop until the cursor reaches the end (no head OR tail loss). C5-06 atomic NX owner lock via the existing `cacheService.eval` (Lua CAS), owner-fenced release/renew, `start()` bails when a live foreign instance holds the lock, renewal stands down on foreign takeover, and durable-snapshot dedup via a subType-aware `findPreSummaries` filter.

**Adversarial review**: no Critical — the NX lock atomicity/fencing and C5-04 head-retention verified correct. Two Important found: **I-1** the dedup used `findLatestPreSummary` (subType-blind) → a newer non-live `PRE_SUMMARY` caused a duplicate `LIVE_SOAP_SNAPSHOT` in normal single-instance operation → switched to the subType-aware `findPreSummaries` filter (+ corrected the masking test mock); **I-2** `stop()` dropped the tail on a >12k backlog → bounded drain loop. Both fixed.

**Gates**: `pnpm --filter @arcaai/applications build test lint` — build clean, **5900 tests passed**, zero new lint.

**Recorded limitation**: the Lua CAS/fence scripts are exercised only against the JS cache mock in unit tests — true atomicity needs a real-Redis integration test (out of unit scope). A simultaneous cross-instance dedup TOCTOU (both find-null then both create) would need a DB unique constraint (schema change, out of scope).

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-448 findings C5-04/C5-06; both re-verified against the post-Wave-1 tree by read-only scout, confirmed independent of TASK-452's `callNlp` fix. `eval` NX-lock hook identified. No implementation. |
