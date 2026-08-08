# TASK-640 — BUG: a failed live-summary generation publishes a SILENT EMPTY note

| | |
|---|---|
| **Status** | Pending |
| **Classification** | bugfix (clinical safety / observability) |
| **Severity** | High — a clinician-facing surface cannot distinguish "generation failed" from "nothing said yet" |
| **Created** | 2026-08-08 |
| **Branch** | dev-2.1 |
| **Discovered by** | TASK-635 C6 e2e work (2026-08-08) — reproduced with a live stack, not by inspection |
| **Related** | TASK-635 (live-agent architecture; §7 "Third pass"), TASK-613 (live pipeline provenance) |
| **Ticket-number note** | Originally filed as TASK-638; **renumbered to 640** because a concurrent session had independently taken 638 (`TASK-638-Reference-Pricing-Model-Plans-And-Enforcement`) and 639 was also claimed. `docs/archive/` cannot be enumerated here (permission denied) — renumber again if an archived ticket ≥ 640 turns up. |

---

## 1. Summary

When the live running-note generation fails, `LiveDocumentationService.flush()` swallows the error, logs a **warning**, and **publishes the live-summary event anyway** with `runningSummary: ""` and `sections: []`. The SSE payload carries **no indication that anything went wrong**, so every consumer — the clinician's live note view included — sees a state that is byte-identical to the legitimate "the consultation just started, nothing summarized yet".

The failure IS recorded, but only on surfaces the clinician's client never reads.

## 2. Evidence (reproduced live, 2026-08-08)

Observed while bringing up a real stack for the TASK-635 e2e. SMR rejected the live loop's call; the live feed published an empty note four milliseconds later:

```
09:58:27.972  SMR   smr.auth.rejected  /api/v1/generate  reason: "invalid_or_missing_token"
09:58:27.976  SSE   {"consultationId":"019fe0ce-…","runningSummary":"","sections":[],"entities":[],
                     "lastSegmentId":"seg-3","metadata":{"agent":{…,"resolvedFrom":"default"}},
                     "updatedAt":"2026-08-08T09:58:27.976Z"}
```

`lastSegmentId: "seg-3"` proves this was NOT an idle session: three final transcript segments had been ingested and a flush ran to completion. The frame is indistinguishable from a healthy pre-first-generation frame.

(In the same SMR process, test-bench generations succeeded — `generation.audit … lm-studio / gemma-4-e2b-it-qat / 973 tokens / 4850ms` — so this was a genuine per-path auth failure, not a dead model. The auth misconfiguration itself was a harness artifact; the degradation it exposed is not.)

## 3. Root cause

`packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts`

```ts
} catch (error) {
  if (isStale()) return this.dropStale(session);
  smrFailed = true;
  this.logger.warn({ message: 'SMR running-summary call failed', consultationId, error: … });
}
```

Execution then falls through to NER, grounding, and publish. `runningSummary` keeps its initial `''` and `sections` its `[]`, and the event is published as normal.

**Where the failure IS visible — none of it reaches the SSE consumer:**

| Surface | Carries the failure? | Who reads it |
|---|---|---|
| `logger.warn('SMR running-summary call failed')` | yes | operators, if anyone is watching logs |
| `LiveDocSessionStatsResponse.smrFailed` (`publishStats`, ~:2192-2222) | yes | a separate session-stats surface |
| Agent trajectory step (`AgentStepStatus.ERROR`, ~:1332) | yes | trajectory/debug tooling |
| **`LiveSummaryEventDto` (the SSE payload)** | **NO** | **the clinician's live note** |

`LiveSummaryEventDto` (`dto/live-summary.dto.ts:256-295`) exposes `consultationId`, `runningSummary`, `sections`, `entities`, `lastSegmentId`, `groundedness`, `metadata`, `vitals`, `updatedAt`, `closed` — there is no degraded/error/stale member, and `metadata` carries only `agent` + `stats`.

## 4. Impact

| | |
|---|---|
| **Clinical** | A clinician watching the live note during a consultation sees an empty note and reasonably concludes nothing noteworthy has been captured yet. In reality the pipeline is down and the visit is being documented into a void. The longer the outage, the more consultation time is silently lost. |
| **Detection** | Failures are `warn`-level and split across three non-clinical surfaces. Nothing alerts, and the one surface the user actually watches is the one that hides it. |
| **Contrast with sibling degradations** | This is out of step with the service's own conventions: the groundedness gate is deliberately **fail-closed** to `unverified` (never silently `grounded`), and NER failure at least leaves the previously grounded entities in place. Only the SMR path degrades to a blank clinical note with no marker. |
| **Note** | The FINAL summary is unaffected — finalize is a separate call with its own error handling (and, post-TASK-635 A4, a fallback-provider retry). This is the live surface only. |

## 5. Proposed fix (needs a decision on the client contract)

1. **Surface the state on the event.** Add an additive, optional field to `LiveSummaryEventDto` — e.g. `degraded?: { stage: 'generation' | 'entities' | 'groundedness'; since: string }` — set whenever `smrFailed` (and, arguably, `nlpFailed`) is true. Additive-only keeps existing consumers working, consistent with how TASK-635 C3 added `metadata.agent`.
2. **Never publish a blank note over a good one.** On failure, prefer re-publishing the last successful `runningSummary`/`sections` (`session.lastPayload`) with the degraded marker, instead of an empty frame that erases what the clinician was reading. An empty publish should happen only when there has genuinely never been a summary.
3. **Raise the log level** for a generation failure from `warn` to `error`, and consider a metric/alert (a live consultation generating nothing is an incident, not noise).
4. **Client-side treatment** (SDK + admin console): render the degraded marker explicitly — "live note paused, reconnecting" — rather than an empty pane. Needs a design call; see §6.
5. **Regression test**: a unit test asserting that an SMR failure publishes a frame whose degraded marker is set and whose `runningSummary` is NOT silently blanked after a prior success.

## 6. Open decisions

| ID | Decision | Notes |
|---|---|---|
| **D-1** | Exact shape of the degraded signal — a dedicated `degraded` object vs. reusing `metadata.stats` (which already carries `smrFailed` on the stats surface). | A dedicated top-level field is harder to miss and does not conflate ops telemetry with clinical state. |
| **D-2** | Should a degraded frame retain the last good note (recommended) or publish empty? | Retaining is safer clinically but means the displayed note may lag reality; the marker must make the staleness explicit. |
| **D-3** | Does `nlpFailed` (entities/vitals) warrant the same treatment, or is a missing-highlights degradation acceptable silently? | Entities are an overlay; the note itself is the primary artifact. |
| **D-4** | UI treatment and copy — requires the design gate (rule 12) if it changes a shipped screen. | |

## 7. Verification criteria

- [ ] D-1..D-4 recorded before implementation
- [ ] Unit test: SMR failure → published frame carries the degraded marker
- [ ] Unit test: after a successful flush, a failing flush does NOT blank the previously published note
- [ ] Unaffected paths proven unchanged: groundedness fail-closed behavior, NER failure behavior, `closed` teardown frame
- [ ] SSE contract change is additive — existing consumers (SDK, admin console) keep parsing
- [ ] `pnpm --filter @arcaai/applications test build` green

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-08 | Ticket created from a live reproduction during TASK-635 C6 e2e work. Root cause, the three surfaces that DO record the failure versus the one that does not, and the proposed additive contract change captured. Status Pending — blocked on D-1..D-4. |
