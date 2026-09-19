# TASK-874 — STT Fallback Funding on Engine Switch

| | |
|---|---|
| **Status** | Review — implemented, gates green, awaiting the orchestrator's merge |
| **Type** | bugfix (metering correctness) |
| **Program** | TASK-870 Configuration Governance — wave 1, lane D |
| **Branch** | `task-874-stt-fallback-funding` (worktree `../hope-v2-task-874`) |
| **Base** | `f3c91ca0c` |
| **Merge target** | `dev-2.2` — merged by the orchestrator from the primary checkout |

## Requirement Analysis

Owner decision #8 of the TASK-870 program: *fallback to the platform default is a platform HA
capability, on by default; it MUST be metered and countable for monitoring, billing and
invoicing.* Combined with the standing owner rule (`09-infrastructure-devops.md`
§"Tenant-first resolution & BYO"): **funding is DERIVED from which row served the call —
BYO tenant row → `BYOK`, platform SYSTEM row → `CLOUD` — never stamped by a call site.**

A streaming session can change engines mid-flight (auto, on a classified outage; or manual,
bidirectionally). Metering must therefore reflect **engine-time**, not whole-session-to-one-tier.
Ten minutes on the tenant's BYO primary followed by five on the platform fallback is
`10 min BYOK + 5 min CLOUD`. Attributing all fifteen minutes to either engine is wrong.

## Current State Evaluation

Verified at `f3c91ca0c`.

**One ledger row per session, attributed to ONE engine.**
`SessionManager._build_teardown_summary` (`apps/stt/src/stt/streaming/session_manager.py:3714`)
reads `self._session_asr_formats[session_id]` — a single slot stamped in `_load_asr_pipeline`
(`:1889`), which is the sole loader for session-create *and* every engine switch, so it holds the
format of the **last** engine loaded. That one format plus the session's `provider_overrides` goes
through `resolve_usage_attribution` (`apps/stt/src/stt/transcription/batch_service.py:110`) to
produce a single `(engine, deployment)` pair, which the gateway turns into exactly one
`transcribe.stream` ledger row for the whole session
(`streamingSession.service.ts:373-419`, idempotency key `stt:session:<sessionId>`).

So today a switched session bills **100 % of its audio and wall-clock seconds to whichever engine
finished it** — the opposite error to the one the program README describes, and equally wrong.
A BYO-primary session that fails over to the platform fallback in its last minute meters its
entire duration as platform `CLOUD`; a session that switches *back* to the BYO primary meters the
whole thing as `BYOK`, so the platform's own fallback minutes are invisible to COGS.

**The per-engine funding signal already reaches the runtime.**
`AsrAgentResolverService.resolveCredentials` (`asr-agent-resolver.service.ts:156-179`) iterates
both the primary and the fallback provider and puts BOTH entries in `providerOverrides`, each
carrying its own derived `funding` (`'tenant' | 'platform'`). `resolve_usage_attribution` reads
`entry["funding"]` under the key the loader actually used. Nothing about the credential plane
needs to change — only the *accounting*.

**`ResolvedAsrSession.fundingTier` is a latent mis-billing trap.** It is documented as
"which tier supplied the PRIMARY engine's credential" but is computed `fundingTier ??= entry.funding`
over a provider list whose first element is the primary *only when the primary is a cloud BYO
provider*. For the common HA shape — local GPU primary, cloud platform fallback — the primary
contributes no provider at all, so the scalar silently reports the **fallback's** tier under the
primary's name. It has no consumer today (grep: only its own tests), which is the only reason it
has not mis-billed anything yet.

**Two other paths checked, both already correct.**

| Path | Verdict |
|---|---|
| Batch / file (`apps/stt/src/stt/transcription/batch_service.py:613`) | The batch worker never assembles the spec's fallback chain (`grep fallback apps/stt/src/stt/pipeline apps/stt/src/stt/worker.py` — the only hits are VAD fallback and spec plumbing). One job runs one engine, and `resolve_usage_attribution` already derives its funding from that engine's own override entry. **No change needed.** |
| v1-compat `POST api/stt/start_session` (`apps/api/src/modules/stt-compat/`) | Teardown for both the controller (`stt-compat.controller.ts:389`) and the socket-disconnect path (`stt-compat.gateway.ts:149`) goes through the same `StreamingSessionService.removeSession`, so it inherits the fix with no compat-specific work. **Covered.** |

## Implementation Plan

### Options considered

| | Option | Verdict |
|---|---|---|
| (a) | Per-engine usage **segments** — close the outgoing engine's span on switch, open the incoming one, each with its own derived funding | **CHOSEN** (refined, below) |
| (b) | One summary carrying both durations and both fundings | A fixed pair cannot express a manual switch back and forth (`EngineSwitchController.switch_manual` is bidirectional), so it either loses time or silently truncates |
| (c) | Resolve both fundings at session start on the gateway; Python reports `served_by`; the ledger picks one | Smallest wire change but **fails the bar** — it still bills the whole session to one tier, which is the defect |

### Chosen design — (a), aggregated by `(engine, deployment)`

The session accumulates ordered **spans**, each opened when the live engine changes and carrying
the audio seconds and wall-clock seconds elapsed inside it. At teardown the spans are aggregated
by their derived `(engine, deployment)` pair, so a session that toggles primary → fallback →
primary produces **two** segments (one per engine), not three. Billing cares about total time per
engine, not the interleaving; the interleaving stays observable through the existing
`provider_switched` result frames and `stt_provider_switch_total` metric.

Segments are **anchored to the session totals**: every span but the last takes its measured
delta, and the last takes `total − Σ(others)`. So `Σ segments.audio_seconds == audio_seconds` and
`Σ segments.session_seconds == session_seconds` hold exactly, by construction, and no arithmetic
gap can open between the legacy scalar fields and the rows actually billed.

Boundary placement: the span advances inside `_apply`, the synchronous callable-swap body in
`SessionManager._make_switch_controller`, which is the exact instant the live engine changes —
the same body that already moves the per-utterance provenance stamp, and deliberately not the
earlier `_load_asr_pipeline` stamp (a fallback build that raises must not close the primary's
span).

### Wire change — additive, backward-compatible in both directions

`segments: [{engine, deployment, audio_seconds, session_seconds}]` is added alongside — never
replacing — the existing top-level `engine` / `deployment` / `audio_seconds` / `session_seconds`.

* **Old STT + new gateway** → no `segments`; the gateway synthesizes one segment from the
  top-level fields, i.e. exactly today's single row.
* **New STT + old gateway** → `segments` ignored, top-level fields unchanged; no worse than today.

The gateway emits one `recordUsage` batch per segment. Idempotency keys stay intent-derived:
the first (chronologically first-appearing) segment keeps the unchanged
`UsageIdempotencyKey.sttStreamSession(sessionId)`, and segment *i* > 0 appends `:${i}`. A session
that never switches therefore emits a **byte-identical** row to today, which also removes any
rolling-deploy double-bill hazard for the overwhelmingly common non-switching session.

The push-back route `POST /api/v1/internal/stt/streaming/usage` posts the summary verbatim
(`gateway.py:record_streaming_usage`), and the global pipe runs `forbidNonWhitelisted`, so
`SttStreamingUsagePushbackRequest` **must** gain the field or every reaper push-back from a
switched session 400s. This is the one gateway DTO change and it will drift `openapi.json`.

### Files

| File | Change |
|---|---|
| `apps/stt/src/stt/streaming/usage_segments.py` (new) | `EngineUsageAccumulator` — span open/advance/close, total-anchoring, `(engine, deployment)` aggregation |
| `apps/stt/src/stt/streaming/session_manager.py` | Hold the accumulator per session; start it at create; advance it in `_apply`; close it in `_build_teardown_summary`; drop it in cleanup |
| `apps/stt/src/stt/streaming/api/schemas.py` | `StreamingUsageSegment` + `segments` on `StreamingSessionTeardownResponse` |
| `packages/applications/src/services/stt/streaming/dto/streaming-session.dto.ts` | `StreamingUsageSegment` + `segments?` on `StreamingSessionTeardownSummary` |
| `packages/applications/src/services/stt/streaming/streamingSession.service.ts` | `emitStreamingUsage` → one ledger batch per segment |
| `packages/applications/src/services/stt/agent-resolver/asr-agent-resolver.service.ts` | `fundingTier` becomes truthfully the PRIMARY engine's (or `undefined`), not first-resolved-wins |
| `apps/api/src/modules/internal/dto/stt-streaming-usage.request.ts` | Nested-validated `segments?` on the push-back body |

### Test list (TDD — red first)

TypeScript (`packages/applications`):
1. resolver: local primary + cloud platform fallback ⇒ `providerOverrides` carries the fallback's
   `funding: 'platform'` **and** `fundingTier` is `undefined` (today: `'platform'`, mislabelled as
   the primary's).
2. resolver: cloud BYO primary + cloud platform fallback ⇒ both entries present with their own
   funding; `fundingTier === 'tenant'` (the primary's).
3. ledger: a two-segment summary emits two rows with per-segment engine/deployment/costBasis and
   the `:1` suffixed key on the second.
4. ledger: a one-segment summary emits exactly today's single row and key.
5. ledger: a summary with no `segments` (older STT) falls back to the top-level fields.

Python (`apps/stt`):
6. accumulator: no switch ⇒ one segment equal to the session totals.
7. accumulator: BYO primary → platform fallback ⇒ two segments, per-engine funding, sums anchored.
8. accumulator: primary → fallback → primary ⇒ two segments (aggregated), primary's time summed.
9. `_build_teardown_summary` with no accumulator (recovered session) ⇒ one synthesized segment.

## Implementation Summary

**Landed as designed: option (a), per-engine usage segments aggregated by `(engine, deployment)`
and anchored to the session totals.** A streaming session now bills engine-time — the tenant's BYO
minutes as `BYOK`, the platform fallback's as `CLOUD` — instead of attributing the whole session to
whichever engine finished it.

### Files changed

| File | Change |
|---|---|
| `apps/stt/src/stt/streaming/usage_segments.py` (new, 168 lines) | `EngineUsageAccumulator` + `UsageSegment`. Opens a span per live engine, aggregates by `(engine, deployment)` in first-appearance order, anchors the last span to the session totals, drops zero-duration spans and spans it cannot attribute. `close()` is PURE, so a reaper push-back racing a late DELETE derives identical segments and therefore identical idempotency keys. It never decides funding: the caller injects `resolve`, which is `resolve_usage_attribution` bound to the session's `provider_overrides`. |
| `apps/stt/src/stt/streaming/session_manager.py` | `_session_usage_segments` state + `_session_audio_seconds` / `_start_usage_segments` / `_advance_usage_segments` helpers; start at create; advance inside `_apply`; close in `_build_teardown_summary` (which now also emits `segments`); drop in session cleanup. |
| `apps/stt/src/stt/streaming/api/schemas.py` | `StreamingUsageSegment` + `segments` on `StreamingSessionTeardownResponse` (the DELETE route does `StreamingSessionTeardownResponse(**summary)`, so an undeclared field would never reach the gateway). |
| `packages/applications/.../streaming/dto/streaming-session.dto.ts` | `StreamingUsageSegment` + optional `segments` on `StreamingSessionTeardownSummary`. |
| `packages/applications/.../streaming/streamingSession.service.ts` | `usageSegments()` normalizer + `emitStreamingUsage` emits one ledger batch per segment. |
| `packages/applications/.../agent-resolver/asr-agent-resolver.service.ts` | `fundingTier` resolved from the PRIMARY engine's provider specifically, not first-resolved-wins. |
| `apps/api/src/modules/internal/dto/stt-streaming-usage.request.ts` | `SttStreamingUsageSegmentRequest` + nested-validated optional `segments` on the reaper push-back body. |
| tests | `apps/stt/tests/unit/streaming/test_session_manager_usage_segments.py` (new, 11 tests), `apps/api/src/modules/internal/__tests__/stt-streaming-usage.request.test.ts` (new, 4 tests), plus 2 resolver cases and 5 ledger cases added to the existing suites. |

### Two findings worth carrying forward

1. **The defect was the mirror image of the one the program README recorded.** The README says a
   switched BYO session bills as `BYOK` end to end. It does not: `_session_asr_formats` holds the
   engine loaded LAST, so the session bills entirely to the engine that FINISHED. A BYO session that
   fails over meters all of its minutes as platform `CLOUD`; one that switches back meters the
   platform's own fallback minutes as `BYOK` and hides them from COGS. Both directions are wrong,
   and the fix — engine-time — is the same either way. The scalar this lane also corrected
   (`ResolvedAsrSession.fundingTier`) is a separate, latent trap with no consumer yet.
2. **`attributesJson` is a closed PHI allow-list, and an undeclared key is REJECTED, not dropped.**
   The first implementation stamped `segmentIndex` / `segmentCount`; `validateUsageAttributes`
   (`usageLedger/usage-attributes.ts`) rejects both, so `recordUsage` would have thrown
   `ArgumentInvalidException` and written NOTHING — a total metering loss that a mocked-ledger unit
   test cannot see. The keys were dropped rather than allow-listed: extending that list is a
   deliberate act in another lane's file, and a failed-over session is already countable without it
   (its rows share `sessionId` and differ in `provider`/`deployment`). A regression test now runs
   the real validator over every bag this emitter builds.

### Deliberate non-changes

- `apps/stt/src/stt/transcription/batch_service.py` — one batch job runs one engine (the worker
  never assembles the spec's fallback chain), and `resolve_usage_attribution` already derives its
  funding from that engine's own override entry. Left untouched; the streaming path REUSES it, so
  the two can still never drift.
- The v1-compat `POST api/stt/start_session` path tears down through the same
  `StreamingSessionService.removeSession`, so it inherits the fix with no compat-specific code.
- `packages/applications/src/services/usageLedger/**` — not this lane's, and no change is needed.

### Wire-shape consequence for the orchestrator

`SttStreamingUsagePushbackRequest` gained a field, so **`apps/api/openapi.json` (and the portal /
`vox-node` artifacts derived from it) will drift after the merge and must be regenerated**. This
lane deliberately did not regenerate them (rule 14 §3). `route-manifest.json` is unaffected — no
route, guard, decorator or scope changed.

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; current state verified at `f3c91ca0c`; design chosen (per-engine segments, aggregated by `(engine, deployment)`, anchored to session totals). |
| 2026-09-05 | Implemented TDD. Corrected the recorded defect direction (last-engine-wins, not BYOK-end-to-end). Dropped `segmentIndex`/`segmentCount` after the `attributesJson` allow-list rejected them, and added a regression test running the real validator. All five gates green; batch and v1-compat paths confirmed correct without change. |
