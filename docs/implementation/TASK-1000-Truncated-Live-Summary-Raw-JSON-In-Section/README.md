# TASK-1000 — A truncated live-summary flush renders raw JSON into section 0

| | |
|---|---|
| **Status** | Review |
| **Type** | bugfix |
| **Branch** | `dev-2.2` |
| **Repos** | `arca/hope-v2` |
| **Reported by** | Tester, 2026-09-22 — "the JSON was displayed in a section in the final summary" |
| **Owner directives** | 2026-09-22 — the four fixes in §Implementation Plan, `maxTokens` floor 8192 |

---

## Requirement Analysis

A tester reported that a consultation's **final summary rendered a raw JSON blob inside one
of its sections**. Reproduced and root-caused end to end against `hope-v2-dev`.

Scope, per owner directive:

1. Raise `maxTokens` on the live-summary agents, scaled to the template's section count,
   **minimum 8192**.
2. Treat `stop_reason === 'length'` as a **failed flush, not a degrade**. Keep the prior
   note, publish a degrade event, retry with a larger budget or a smaller delta — never
   replace section 0 with the raw payload.
3. Raise the budget on the **repair** call.
4. Guard `wholeDocumentAsTurn` against the `RUNNING_SUMMARY_TITLE` sentinel.

Classification: `bugfix`. Clinical-surface severity — a clinician is shown a machine payload
in place of a clinical section, and the section it lands in is mislabelled as
`patient_demographics`.

## Current State Evaluation

### Evidence — dev cluster, `hope-v2-dev`, 2026-09-22

Five consultation tests ran in the 4-hour window, all on tenant
`50000000-…-0001` via service account `hope_svc_a4ca1a11ad3141b0c0de0001`:

| Consultation | Document template | Start (UTC) | Outcome |
|---|---|---|---|
| `01a0c751-3205…` | `arcaai-bren-soap-new-visit` | 04:13 | clean |
| `01a0c75e-0737…` | `arcaai-derm-soap-new-visit` | 04:27 | clean |
| **`01a0c77b-08c8…`** | `arcaai-bren-soap-new-visit` | 04:58 | **the reported defect** |
| `01a0c7a8-0053…` | `arcaai-gen-soap-new-visit` | 05:47 | clean — near-miss at 2019/2048 |
| `01a0c7ba-cd2b…` | `arcaai-heme-soap-new-visit` | 06:08 | clean |

`core."DocumentSection"` for the failing consultation — `patient_demographics` is a
**7,149-byte** ciphertext against 85–133 bytes for the same section on every other run,
written at `06:00:32`, an hour after that consultation's other sections:

```
01a0c77b-08c8 | arcaai-bren-soap-new-visit | patient_demographics | 0 | PROVISIONAL | 5 | 7149 | 06:00:32
01a0c77b-08c8 | arcaai-bren-soap-new-visit | risk_factors_exposures | 1 | PROVISIONAL | 2 |  297 | 05:00:06
```

Decrypted through Vault Transit (`hope-phi`, temporary decrypt-only token, since revoked) —
**5,324 characters of raw turn-contract JSON, truncated mid-string**:

```json
{
  "patient_demographics": { "addition": "Name: Not stated", "revision": null, "contradiction": null },
  "risk_factors_exposures": { "addition": "- Tobacco/Alcohol use: occasional ethanol …", … },
  …
  "revision": "- Surgical/Procedural: Advice for Total Thyroidectomy on 27th June
```

`json.loads` → `Unterminated string starting at: line 64 column 17 (char 5257)`.

### Root cause — four links

**1 — the output budget is too small.** All 22 `arcaai-*-summary-*` agents carry
`parameters.generation.maxTokens = 2048`. `core."AgentTrajectoryStep".stats` shows
`stop_reason: "length"` with `predicted_tokens: 2048` on four flushes of this consultation
(05:16:01, 05:17:11, 05:19:04, 05:59:53) as the prompt grew 17,345 → 21,706 tokens. Every
other consultation in the window finished `stop_reason: "stop"`.

**2 — the repair cannot fix truncation.** `shouldRepair` fires (structured + looks like JSON
+ does not parse) and `flush.repair` runs. But [`bounded-json-repair.ts`][bjr] only *appends*
`CORRECTIVE_RETRY_INSTRUCTION` and regenerates **at the same cap with a longer prompt**
(21,801 vs 21,706 tokens). All four repairs also returned `stop_reason: "length"`.
Truncation is a budget failure, not a syntax failure — this retry is structurally incapable
of succeeding, and it costs ~29 s of the clinician's live path each time.

**3 — the prose fallback collapses the blob into one section.** `parseTolerant` calls
`parseDocumentJson` (returns `null`, `JSON.parse` throws) then
[`parseDocumentSections`][dsp]. Its header matchers admit a heading preceded by
`#`, `-`, `*`, `>`, `**`, `__` — **but not by a `"`** — so none of the `  "presenting_complaints": {`
lines match. `collected.size` is 0, below the two-header floor, and
[`document-shape-parser.ts:134`][dsp134] returns exactly one section:
`[{ title: RUNNING_SUMMARY_TITLE, content: <the entire raw JSON> }]`.

**4 — that one section is written to slot 0.** [`wholeDocumentAsTurn`][wdat] pairs
positionally — `compiled.sectionKeys[idx] ?? slug(title)`. A single entry at `idx 0` resolves
`sectionKeys[0]`, which for this template is `patient_demographics`, with `mode: 'replace'`.
The row confirms it: revision 5, `updatedAt 06:00:32` — the `PHASE:publish` immediately
after the 05:59:53 / 06:00:00 flush+repair pair.

### Which code path — the graph lane, not the legacy flush

`consultation.realtime.graphExecutor.enabled = true` on SYSTEM, and the harness-worker logs
show the lane node set `n_asr,n_ner,n_presummary,n_summary_new,n_summary_revisit`. The
failing call site is therefore the `generateJsonWithRepair` inside
[`runGraphLane`][lds3522], not the `if (!graph)` legacy flush. **Both carry the identical
defect and both must be fixed.**

### Constraints measured on the cluster (these bound the fix)

| Constraint | Measured value | Consequence |
|---|---|---|
| `gemma-4-e2b-it-qat` loaded context | **65,536** (LM Studio `/api/v0/models`; catalogue `_metadata.contextLength` still claims 131,072) | prompt 21.7k + 8,192 out = ~30k — fits, with room |
| Observed throughput, live path | **57–70 tok/s** (`total_ms` 29,205–45,110 for 2,048 predicted) | 8,192 tokens ≈ **117–144 s** |
| `consultation.realtime.textTimeoutMs` | **60,000** (code default, no stored row) | **a full 8,192-token generation exceeds the live budget** |
| `consultation.realtime.textMaxTokens` | **8,192** (code default — already the owner's floor) | but see below: the agent value *overrides* it |
| `apps/text` `max_tokens` default | 16,384, `ge=1`, **no clamp** | nothing downstream caps us |

**The platform ceiling is already 8192 and is not what binds.**
[`live-documentation.service.ts:5811`][lds5811] resolves the budget as

```ts
max_tokens: numberOrUndefined(generation.maxTokens) ?? this.realtimeBudgets.textMaxTokens,
```

`??`, not `Math.min` — so the agent's declared 2048 **replaces** the 8192 platform default
rather than being bounded by it. This is the exact mechanism by which a per-agent value
silently defeats a platform budget, and it is a decision point (OD-3 below), not just a
number to change.

### Section counts — ground truth from the cluster

`jsonb_array_length(compiled->'checklist')` over the 22 ArcaAI document templates:

| Sections | Templates |
|---|---|
| 23 | `arcaai-sonc-soap-new-visit` |
| 16 | `arcaai-derm-soap-new-visit` |
| 14 | `arcaai-bren-soap-new-visit` *(the failing one)*, `arcaai-neur-soap-revisit` |
| 13 | `arcaai-heme-soap-revisit`, `arcaai-sonc-soap-revisit` |
| 12 | `arcaai-bren-soap-revisit`, `arcaai-rheum-soap-new-visit`, `arcaai-surg-soap-revisit` |
| 11 | `arcaai-gen-soap-revisit`, `arcaai-surg-soap-new-visit` |
| 10 | `arcaai-gen-soap-new-visit`, `arcaai-orth-soap-new-visit`, `arcaai-rheum-soap-revisit` |
| 8 | `arcaai-derm-soap-revisit`, `arcaai-neph-soap-*`, `arcaai-neur-soap-new-visit` |
| 7 | `arcaai-diet-soap-new-visit`, `arcaai-heme-soap-new-visit` |
| 6 | `arcaai-orth-soap-revisit` |
| 5 | `arcaai-diet-soap-revisit` |

`sonc-new-visit` at **23 sections** is 64% larger than the template that already fails, so it
is the worst case a scaling rule must cover.

### Three facts that make this worse than "a blob in one section"

**(a) The truncated flush ALSO silently discards that stretch of the encounter.** A truncated
generation returns HTTP 200 and the tolerant fallback produces a *non-empty* `sections` array,
so the graph node's outcome is `succeeded`, nothing throws, and
`cursorAdvanceTo = deltaEnd` executes ([:3075][lds] graph path, [:3164][lds] legacy). The
transcript that produced the garbage is marked flushed and **is never summarised again**. The
existing C5-04 carry-forward (`deltaEnd < flushUpTo`) protects only *input*-side truncation —
it does nothing for an output-side one.

**(b) No degrade signal reaches the clinician today.** Every existing mechanism is gated on
something a truncation never triggers:

| Mechanism | Gate | Fires on truncation? |
|---|---|---|
| `degradeCode()` | runs from a `catch` | **no** — nothing throws |
| `publishSectionDegrade` | `sections.length === 0` | **no** — the fallback yields sections |
| `publishDegradeEvents` / `lane.degraded` | a node outcome `!== 'succeeded'` | **no** — the node succeeded |
| `flushFailed` / `degradeReason` | `textFailed \|\| run.failed` | **no** |
| `turnDegraded` | set in `parseTolerant` | **yes**, but it is a boolean with no reason code, published only to the admin console |
| `noteChurnChars` | prefix test per section | **yes**, spikes — admin console only |

Separately, `lane.degraded` is published on the **control** channel, which
`subscribeToLiveSummary` does not relay and the vox-node SDK does not type — it is consumed
only by this service's own cross-instance `stop` handler, which ignores every other message
type. So a new degrade code needs a **new trigger and a live-facing route**, not just a new
enum member.

**(c) The durable finalize path has the same defect and is worse.**
`summary.service.ts:2090` drives the same `generateJsonWithRepair` with
`parseTolerant: (text) => text`, so a truncated finalize is persisted **verbatim as the whole
clinical note** — no section confinement at all. It already captures
`summaryMeta.stopReason` ([:580][ss], [:855][ss]) but nothing reads it. On this cluster that
field is **NULL on all six finalize runs** in the window, so even the passive audit record is
not being populated.

### Secondary findings (recorded, not necessarily in scope)

- The harness final generate for this consultation scored **`schema_validity: 0`** in
  `SENSOR:run_sensors` (05:02:33) and the draft was persisted anyway (`persist_draft` OK,
  contextItem `01a0c77e-8b12-…`). The sensor detected the malformed document; nothing acted
  on it.
- Independent path to the same *symptom*: [`parseDocumentJson`][dspjson] renders any
  object-valued section as `JSON.stringify(value, null, 2)`. Deliberate ("render it
  canonically rather than dropping it"), but it is a second way raw JSON reaches a clinician.
- **Un-merged work, flagged per `14-multi-agent-worktrees.md` §6:** TASK-995's commit
  `4567ab098` (`apps/harness` timeout nest + `seed/ai-models/llm.ts`) is on local branches
  `worktree-agent-abe699ec27a191636` / `worktree-agent-ac0a7534505bad728` and is **not on
  `dev-2.2`**. No file overlap with this ticket. Not touched here.

## Flush-cadence analysis (owner request, 2026-09-22)

Directive: `liveFlush.idleMs` 5000 → **10000**, `liveFlush.minIntervalMs` 4000 → **8000**,
`liveDelta.maxChars` 12000 → **24000**, "to prevent it calling text generation so frequently",
plus a review of the five tests for best practice.

**No stored rows exist for any `agentic.context.*` key** — every knob runs on its code default.
Because these resolve through `EffectiveSettingsService` on *every* flush, a
`PUT /admin/settings/registry/:key` takes effect on the next flush **with no redeploy**. That is
the fast remediation lane; changing the code defaults is what makes new environments inherit it.

### Measured — 5 consultations, 45 flushes, 745 s of TEXT generation

| Metric | Measured |
|---|---|
| **Duty cycle** (generation time ÷ recording wall-clock, per active burst) | **45%, 59%, 71%, 72%, 75%, 75%, 81%, 82%** |
| Mean generation time per flush | 6.4 – 34.7 s |
| **Minimum idle between generations** | **0.1 – 0.4 s** |
| Mean idle between generations | 0.6 – 4.8 s |
| **Flushes that changed nothing** (`turnSectionsAppended = 0` **and** `turnSectionsRewritten = 0`) | **14 / 45 = 31%** |
| GPU time spent on those no-op flushes | **135 s of 745 s = 18%** |
| `truncatedDeltaCount` | **0 on every flush — the 12,000-char cap was never reached** |

The live-summary model is generating for **45–82% of the wall clock of every recording
session**, on the same time-sliced GPUs Whisper is using. Consultation `01a0c7ba` shows three
consecutive flushes (generations 5, 6, 8) holding `summaryChars` at 1358 with
`noteChurnChars: 0` and 3–4 `turnRefusedRewrites` each — 18–22 s of GPU apiece for no change.

### Three structural findings — the directive's values are right, but two of the three knobs cannot bite as written

**F1 — `minIntervalMs` is measured start-to-start, so it cannot throttle a slow generation.**

```ts
const elapsed = Date.now() - session.lastFlushAt;
if (!opts?.force && elapsed < this.lastAgenticContext.minIntervalMs) { … }
session.lastFlushAt = Date.now();   // ← stamped at flush START, before the TEXT call
```

With a 4 s floor and a 6–35 s generation, the window has always reopened by the time the
generation returns — hence the measured **0.1 s** minimum idle. **Raising 4000 → 8000 changes
nothing for any generation longer than 8 s, which is the mean on all five consultations.** The
descriptor promises "raising it makes the note update less often and costs less"; today it does
not. Fix: stamp `lastFlushAt` at flush **completion** so the floor is end-to-start.

**F2 — `idleMs` only governs pauses, not active speech.**

```ts
if (session.pendingSegments >= this.lastAgenticContext.segmentThreshold) {
  this.clearTimer(session);   // ← discards the idle debounce
  void this.flush(consultationId);
} else { this.scheduleFlush(session); }
```

`segmentThreshold: 3` fires immediately and clears the debounce, so during continuous speech the
segment threshold always wins. Raising `idleMs` 5000 → 10000 changes only the tail after speech
stops. To slow the active-speech path, `segmentThreshold` has to move too.

**F3 — `liveDelta.maxChars` is not currently reached, and it pulls against the TASK-1000 fix.**
`truncatedDeltaCount` is 0 on every flush, so raising 12000 → 24000 is a no-op *today*. It
becomes necessary once F1/F2 genuinely slow the cadence and a backlog starts to build — so it is
correct as a **companion** to the throttling, not a lever on its own. **It must not land before
the raised `maxTokens`**: a larger delta means a larger prompt and a larger turn document, which
is exactly the pressure that caused this ticket's truncation.

### Recommended settings

| Key | Now | Directive | Recommended | Why |
|---|---|---|---|---|
| `liveFlush.minIntervalMs` | 4000 | 8000 | **8000 + the F1 semantic fix** | Without end-to-start the number is decorative |
| `liveFlush.idleMs` | 5000 | 10000 | **10000** | As directed; governs the post-speech tail |
| `liveFlush.segmentThreshold` | 3 | — | **6** | The only lever on the active-speech path (F2) |
| `liveDelta.maxChars` | 12000 | 24000 | **24000, sequenced after `maxTokens`** | Headroom for the backlog throttling creates (F3) |

Projected effect: with F1 fixed and an 8 s end-to-start floor, a 20 s generation moves from a
~20 s cycle to a ~28 s cycle — duty cycle ~75% → ~55%. It will **not** reach 50% until either
generation gets faster or the floor is raised further; re-measure after landing rather than
assuming. Also worth considering separately (not in this ticket): 31% of flushes produce no
change at all, so a cheap pre-check that skips generation when the delta carries no new clinical
content would cut more GPU than any cadence knob.

## Owner Decisions

**Answered 2026-09-22:** OD-4 raise `textTimeoutMs` together with the budget · OD-5 accepted as
recommended (delta-window halving) · OD-8 fix in the shared helper · OD-9 raise the pre-summary
budget, with best practice to keep it independent of the summary budget · plus the cadence
directive above.

**Taken as accepted on the stated recommendation** (owner did not object): OD-1, OD-2, OD-3,
OD-6, OD-7.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **OD-1** | **Scaling formula** for the live-summary `maxTokens`. | (a) `max(8192, sections × 512)` — sonc-23 → 11,776, everything ≤ 16 sections → 8,192 floor. (b) flat 8192 for all. (c) `max(8192, sections × 768)` — sonc → 17,664. | **(a)**. It honours the 8192 floor, and only the two templates that are genuinely larger than the one we measured failing get more. (c) puts sonc's worst case at 17.6k tokens ≈ 5 min of decode, which the live path cannot absorb. |
| **OD-2** | **How the new budget reaches the 22 EXISTING agent rows.** Three independent mechanisms block the obvious routes: `seedAgentSpecs` is **create-only** (skips an existing slug); the reference-set resync is **`missing-only`** and `refresh-locked` is *accepted but not implemented*; and a **DB trigger** ([`migration.sql:209-227`][trg]) raises `restrict_violation` on any `UPDATE` that changes `parameters` of a `PUBLISHED` agent. **A backfill `UPDATE` is impossible — the database refuses it.** | (a) **runtime clamp** at the resolve site — the only route that needs no data change at all. (b) branch + publish a **new version of each of the 22 agents** through `AgentService` (the sanctioned path the trigger's error message names). (c) **both**. | **(c), with (a) shipping first.** (a) fixes every existing and future tenant on deploy and is the only thing that lands inside this incident's timeframe. (b) then makes the stored row agree with what runs, so the admin console stops showing 2048 for a generation that uses more. |
| **OD-3** | `live-documentation.service.ts:5811` resolves `agent.maxTokens ?? platformCeiling` — **`??`, so a per-agent value defeats the platform budget entirely**. Is `consultation.realtime.textMaxTokens` a *ceiling* (its docstring says so) or a *default*? | (a) make it a true ceiling: `min(agent, ceiling)` — but that would have *kept* us at 2048 here, so it must pair with OD-2(a)'s floor: `clamp(agent, floor, ceiling)`. (b) leave as a default. | **(a) with the clamp.** The field is documented as a ceiling and does not behave as one; that mismatch is what let a content-tier value override a platform budget unnoticed. |
| **OD-4** ✅ **DECIDED — raise `textTimeoutMs` along with the budget.** | **Live budget vs. the raised cap.** `consultation.realtime.textTimeoutMs` is **60 s**; 8,192 tokens at the measured 57–70 tok/s is **117–144 s**. Without a change we convert truncation into timeout. | (a) raise the live budget to 180 s. (b) raise to 300 s, matching TASK-995's owner directive for the harness path. (c) leave 60 s and rely on the smaller-delta retry (OD-5). | **(a) 180 s.** A *live* summary that takes 5 minutes is not live; 180 s admits a full 8,192-token generation at the slow end while still failing fast enough to retry within the encounter. |
| **OD-5** ✅ **DECIDED — as recommended (b).** | **Retry strategy when the repair ALSO truncates.** Note the cursor correction in §(a) above: today the cursor *advances*, so the delta is lost. Making the flush fail keeps it — but then the next delta is strictly larger and truncates again. | (a) fail the flush, keep the prior note, let the next scheduled flush retry on the (larger) delta. (b) fail the flush **and halve the delta window** for the retry, re-sending the remainder after. (c) fail and summarise only the tail. | **(b)**. (a) is an infinite degrade loop. (b) reuses the C5-04 input-window machinery that already exists for the *input*-side truncation — `session.truncatedDeltaCount` and the `deltaEnd < flushUpTo` carry-forward — rather than inventing new cursor plumbing. |
| **OD-6** | **New degrade code, and how it reaches the clinician.** `LIVE_DEGRADE_CODES` is a frozen 6-member vocabulary with no truncation member (`context_overflow` means the *prompt* overflowed — a different fact). Per §(b) above, **no existing publisher fires on a truncation**. | (a) add `output_truncated` **and** route it through `flushDegradeReason` + relax `publishSectionDegrade`'s `sections.length === 0` gate. (b) enum member only (would be dead code). (c) reuse `generation_failed`. | **(a)**. (b) is the trap — adding the member without a trigger looks done and changes nothing. Note this makes `flushFailed: true` reach the SDK's `LiveSummaryEvent.textFailed`, which is a deliberate, visible behaviour change. |
| **OD-7** | **`wholeDocumentAsTurn` sentinel behaviour** when the parse collapses to the single `RUNNING_SUMMARY_TITLE` section. | (a) emit **zero section writes**, keep the text on the payload's `runningSummary` only. (b) drop it entirely. (c) write it to a dedicated non-clinical section. | **(a)**. It never mislabels a clinical section and preserves the case the degrade path exists for — a provider that ignores `response_format` (Ollama, by design) still shows the clinician its note in the running-summary view. (b) would regress that provider to a blank note. Mirrors the guard `buildStructuredSummary` already makes for the same sentinel. |
| **OD-8** ✅ **DECIDED — fix in the shared helper (a).** | **Where the truncation check lives.** The durable finalize (`summary.service.ts:2090`) drives the same helper and persists a truncated note verbatim as the **whole** clinical note. | (a) fix in the shared `generateJsonWithRepair` so both planes are covered. (b) fix at the two live-doc call sites only; file the finalize separately. | **(a)**. The helper's own docstring says both planes drive it; fixing one and not the other leaves the worse of the two defects live. Costs a signature change across 3 call sites. |
| **OD-9** ✅ | **`PRE_SUMMARY_PARAMETERS` is 3072 and `pre-summary-agent.task932.test.ts:132` pins the *relationship* `PRE_SUMMARY > SUMMARIZATION`.** Raising summarization to 8192 inverts it. | **DECIDED**: raise the pre-summary budget, and **decouple the two** — "pre-summary could have a different context length than the summary". | Raise `PRE_SUMMARY_PARAMETERS` to **12288**, and **replace the relational invariant with an absolute one**. The two agents have different jobs (whole case-note corpus vs. one turn's delta) and different templates; a test that pins `A > B` couples two budgets that should move independently and would silently block either from being tuned on its own evidence. New assertion: each budget ≥ its own documented floor. |

## Implementation Plan

Layer order: `packages/applications` (domain-free logic first, then the service), then
`packages/database` seed, then the backfill script. No Prisma schema change, no migration, no
API-surface change.

### Phase 0 — RED tests first

| # | Test file | Asserts (must fail before the fix) |
|---|---|---|
| T1 | extend `realtime/__tests__/turn-contract.task939.test.ts` | `wholeDocumentAsTurn([{ title: RUNNING_SUMMARY_TITLE, content: '{"a":1' }], compiled)` emits **zero writes** and never targets `sectionKeys[0]`. |
| T2 | extend `__tests__/document-shape-parser.test.ts` | `parseDocumentSections(<truncated JSON>)` returns the one-section sentinel — pins current behaviour so T1's guard is what's under test, not the parser. Its existing fallback cases use plain prose, never a cut-off `{`. |
| T3 | `__tests__/live-documentation.truncation.task1000.test.ts` (new) | `stop_reason: 'length'` on **both** calls ⇒ flush **fails**: prior sections unchanged, **no section write**, `flushedTranscriptCount` **not advanced**, `degradeReason: 'output_truncated'` on the payload and on `section.patch`. |
| T4 | same file | The repair call is issued with a **larger** `max_tokens` than the first call. |
| T5 | same file | `'length'` then `'stop'` ⇒ flush **succeeds** normally — the repair is a real second chance, not just a failure detector. |
| T6 | extend `shared/__tests__/bounded-json-repair.test.ts` | `generate` receives the retry descriptor (corrective + raised budget) on attempt 2, `undefined` on attempt 1; a both-truncated outcome is reported as **fatal**, not tolerantly parsed. |
| T7 | extend `summary/__tests__/summary.service.json-repair.test.ts` | OD-8: the durable finalize does **not** persist a truncated response verbatim. |
| T8 | `seed/__tests__/summarization-parameters.task1000.test.ts` (new) | Every `arcaai-*-summary-*` spec resolves `maxTokens ≥ 8192` and `≥ sections × 512` for its bound note shape. |
| T9 | `__tests__/live-documentation.budget-clamp.task1000.test.ts` (new) | OD-3 clamp: an agent declaring 2048 against a 14-section template resolves to 8192; one declaring 99999 is capped at the platform ceiling. |
| T10 | extend `__tests__/live-documentation.flush-failed.task946.test.ts` | OD-6: a degrade reason reaches `section.patch` **even though `sections.length > 0`** — the gate this fix relaxes. |

Cross-tenant/e2e: no new HTTP surface, so no new cross-tenant spec is required.
`task-930-agent-publish-gate.test.ts` runs the real publish gate over all 22 ArcaAI agents and
must stay green.

### Phase 1 — `wholeDocumentAsTurn` sentinel guard (OD-7) — greens T1, T2

`realtime/turn-contract.ts:255-259` — skip a section whose title is `RUNNING_SUMMARY_TITLE`
instead of resolving `sectionKeys[idx]` for it. Keep it on `sections` (so `runningSummary`
still renders) with **no** write.

Smallest, fully independent, and the only change that is safe to ship on its own — worth
landing first as defence-in-depth even though Phase 2 should mean the tolerant path is never
reached on truncation.

### Phase 2 — raise the repair budget (OD-5) — greens T4, T6

Must precede Phase 3: a repair that retries at the *same* cap is half the defect, and Phase 3
starts treating its failure as terminal.

1. `bounded-json-repair.ts:114` — widen `generate: (corrective: string | undefined)` to a
   retry descriptor `{ corrective, maxTokens }`, and widen
   `parseTolerant: (text: string) => T` to `parseTolerant: (call: C) => T` so the tolerant
   path can see `stats.stop_reason`. **Three call sites update** —
   `live-documentation.service.ts:3094` (legacy) and `:3629` (graph lane), plus
   `summary.service.ts:2090` (durable finalize).
2. Attempt 2 requests `min(ceiling, attempt1Budget × 2)`; `callText` threads it to
   `max_tokens` on the outbound body.

### Phase 3 — truncation is a failed flush (OD-5, OD-6, OD-8) — greens T3, T5, T7, T10

1. `degrade-codes.ts:40` — add `output_truncated` to `LIVE_DEGRADE_CODES`. It is already a
   bare code, so `degradeCode()` passes it through unchanged.
2. `bounded-json-repair.ts` — when the **final** call carries `stop_reason === 'length'`,
   surface it as fatal rather than tolerantly parsing. This is the OD-8 shared fix, so it
   covers the durable finalize in the same change.
3. Both live-doc call sites — the existing `catch` already sets `textFailed = true` and
   classifies via `degradeCode(error, LIVE_DEGRADE_FALLBACK)`, so a typed
   `TruncatedGenerationError` needs **no new control flow**, only the new code.
4. **Cursor** — with `textFailed = true` the graph path's
   `if (graph.sections.length > 0)` guard at `:3075` is not reached, so `cursorAdvanceTo`
   stays `null` and `:3373` skips the write. This is the *correction* to the current
   behaviour described in §(a): today the cursor advances and the transcript is lost.
5. **Degrade routing** — relax `publishSectionDegrade`'s `ctx.sections.length === 0` gate
   (`:3894`) so a reason publishes when one exists, and let `flushDegradeReason` carry
   `output_truncated`. Without this the new code is dead (OD-6 trap).
6. OD-5(b) delta-window halving on the retry, reusing the C5-04 input-window machinery.

### Phase 4 — budget scaling, clamp, timeout (OD-1..OD-4, OD-9) — greens T8, T9

1. `seed/25-agents.ts:367` — `SUMMARIZATION_PARAMETERS` becomes
   `summarizationParameters(shape)` → `max(8192, shape.sections.length × 512)`. The note shape
   is in hand at seed time (`headingList()` already maps over `shape.sections`), so no new
   lookup. **Not in scope:** `dna-writing-style-analyst` (`:654`) and `casenote-finalization`
   (`:626`), which are different tiers that happen to carry their own literals.
2. `live-documentation.service.ts:5811` — `agent.maxTokens ?? ceiling` becomes
   `clamp(agent.maxTokens, floorFor(template.compiled.checklist.length), ceiling)`. **This is
   the change that reaches the 22 live rows**, since the DB trigger forbids updating them
   (OD-2). Log once per session when the floor binds, so a stale stored value is visible
   rather than silently corrected.
3. `consultation-realtime.descriptors.ts` — `textTimeoutMs` 60000 → 180000 (OD-4), with the
   measurement recorded in the docstring the way the existing comment documents the 60000.
4. OD-9: `PRE_SUMMARY_PARAMETERS` 3072 → **12288**, and rewrite
   `pre-summary-agent.task932.test.ts:132` from the relational invariant
   (`PRE_SUMMARY > SUMMARIZATION`) to two independent absolute floors, so the two budgets can
   be tuned on their own evidence.
5. OD-2(b): branch + publish v2 of the 22 ArcaAI agents via `AgentService`. Separate,
   run-by-hand step against the cluster — **not** an Argo hook
   (`09-infrastructure-devops.md`).

### Phase 5 — flush cadence (owner directive) — greens T11, T12

**Sequenced after Phase 4**: `liveDelta.maxChars` raises the prompt and therefore the turn
document, so it must not land before the `maxTokens` floor (F3).

1. `agentic-context.descriptors.ts:29,33,39` — `liveDelta.maxChars` 12000 → **24000**,
   `liveFlush.idleMs` 5000 → **10000**, `liveFlush.minIntervalMs` 4000 → **8000**, and
   `liveFlush.segmentThreshold` 3 → **6** (F2 — the only lever on the active-speech path).
2. **F1 semantic fix** — `live-documentation.service.ts:2756`: stamp `session.lastFlushAt` at
   flush **completion** rather than at its start, so `minIntervalMs` is an end-to-start floor
   and the descriptor's promise ("raising it makes the note update less often and costs less")
   becomes true. `scheduleThrottledFlush`'s delay computation (`:4653`) reads the same field
   and needs no change. **Without this the directive's 8000 is decorative.**
3. Operational: set the four values as stored rows via `PUT /admin/settings/registry/:key`
   for immediate effect on the running cluster; the code-default change is what new
   environments inherit.

| # | Test | Asserts |
|---|---|---|
| T11 | `__tests__/live-documentation.cadence.task1000.test.ts` (new) | With `minIntervalMs = 8000` and a stubbed 20 s generation, the second flush starts **≥ 8 s after the first completes**, not 8 s after it started. |
| T12 | same file | `segmentThreshold = 6` — five queued segments debounce on `idleMs`; the sixth flushes immediately. |

### Phase 6 — verify

- `pnpm --filter @arcaai/applications test` + `build`, `pnpm --filter @arcaai/database test`,
  `pnpm lint` — actual output pasted here.
- Cluster re-proof: run a consultation on `arcaai-sonc-soap-new-visit` (23 sections, the worst
  case) long enough to exceed 2048 output tokens, then assert via Postgres that no
  `DocumentSection` holds parseable JSON and that `AgentTrajectoryStep.stats.stop_reason` is
  `stop`, not `length`.
- Re-check `01a0c77b-08c8…`'s `patient_demographics` is not re-corrupted by a replay.
- **Re-measure the cadence baseline** with the same queries used above and record the deltas
  against the table in §Flush-cadence analysis: duty cycle per burst (was 45–82%), minimum idle
  between generations (was 0.1–0.4 s), no-op flush rate (was 31%), and TEXT seconds spent on
  no-op flushes (was 18%). A duty cycle that has not moved means F1 did not land.

### Out of scope (recorded, not fixed here)

- `parseDocumentJson`'s deliberate `JSON.stringify(value, null, 2)` for object-valued
  sections — a second route to JSON-in-a-section, but by design and not what the tester hit.
- `SENSOR:run_sensors` scoring `schema_validity: 0` and the draft persisting anyway.
- **`SummaryMeta.stopReason` / `inputTokens` / `outputTokens` are NULL on every finalize run**
  on this cluster — the audit columns exist and are not populated. Adjacent to TASK-999.
- **The publish gate never checks `maxTokens ≤ contextLength`**
  (`agentic-contract.ts:285-309` only checks that the model *declares* the `maxTokens` key;
  the JSON-schema bound is 1,048,576). Nothing would stop an agent being published with a
  budget its model cannot serve.
- The reference-set resync's `refresh-locked` mode being accepted but unimplemented.
- The un-merged TASK-995 branches (`worktree-agent-abe699ec27a191636`,
  `worktree-agent-ac0a7534505bad728`).

## Implementation Summary

All six phases implemented on `dev-2.2`. **Not committed** — awaiting review.

### Files changed (17 modified, 5 added)

| Area | Change |
|---|---|
| `shared/bounded-json-repair.ts` | `generate` takes a `JsonRepairRetry` (`{ corrective, maxTokens }`); `parseTolerant` takes the CALL; new `TruncatedGenerationError` + `isTruncated`/`repairMaxTokens` options. Covers the live flush AND the durable finalize (OD-8). |
| `live-documentation/output-budget.ts` *(new)* | `outputBudgetFloor` / `resolveOutputBudget` / `repairOutputBudget` — `clamp(declared, max(8192, sections × 512), ceiling)`. |
| `live-documentation.service.ts` | Clamp replaces the `??` at the payload build; `liveOutputBudget()` with a de-duplicated warn when the floor binds; `isRepairAttempt` threaded through `callText` → `callTextCandidate`; truncation raises on both call sites; `deltaShrinkFactor` + `shrinkDelta` + `withDeltaShrinkOnTruncation`; `lastFlushAt` moved to the `finally` in `flush()`. |
| `realtime/turn-contract.ts` | `wholeDocumentAsTurn` skips the `RUNNING_SUMMARY_TITLE` sentinel (OD-7). |
| `degrade-codes.ts` | `output_truncated` added to the closed vocabulary, classified structurally off `error.code`. |
| `summary/summary.service.ts` | Finalize honours the raised retry budget and no longer persists a truncated structured response verbatim. |
| `consultation-realtime.descriptors.ts` | `textTimeoutMs` 60000 → **300000**; `textMaxTokens` 8192 → **16384**. |
| `agentic-context.descriptors.ts` | `liveDelta.maxChars` → **24000**, `liveFlush.idleMs` → **10000**, `liveFlush.minIntervalMs` → **8000**, `liveFlush.segmentThreshold` 3 → **6**. |
| `seed/25-agents.ts`, `seed/29-arcaai-*.ts` | `summarizationParameters(sectionCount)`; the 22 ArcaAI agents sized from their own note shape; `PRE_SUMMARY_PARAMETERS` 3072 → **12288**. |
| Tests *(5 new files)* | `output-budget.task1000`, `live-documentation.cadence.task1000`, `summarization-budget.task1000`, `tests/contracts/output-budget-parity.contract`, plus extensions to `turn-contract.task939` and `bounded-json-repair`. |

### Three findings that changed the plan during implementation

1. **The planned `publishSectionDegrade` relaxation was REVERTED as harmful.** OD-6 called for
   publishing a degrade reason whenever one exists. `publishSectionDegrade` emits
   `state: 'empty', content: ''` for *every* section — correct only when there is no note to
   show. With truncation now keeping the prior note, firing it would have **blanked a standing
   note on the clinician's screen** to report that an update failed. The gate stays
   `sections.length === 0`; the failure reaches the clinician on the whole-document payload's
   `flushFailed` + `degradeReason`, which carries it without destroying content.
2. **Truncation is fatal only for a STRUCTURED request.** The first implementation raised on any
   `stop_reason: 'length'`, which broke 5 finalize tests whose fixtures use `'length'` as an
   arbitrary stats value — and, more importantly, would have failed a truncated PROSE note that
   is still readable text a clinician can finish. The defect is a JSON document cut mid-token,
   so `isTruncated` now requires `structured`.
3. **`LIVE_DELTA_MIN_CHARS` was overriding configured caps.** The shrink floor was applied
   unconditionally (`max(1500, cap / factor)`), so a deployment or test setting a small
   `liveDelta.maxChars` silently got 1500. Caught by the windowed/agentic-context suites. The
   floor now bounds the division only and is itself capped by the configured value.

### Verification — actual output

```
pnpm --filter @arcaai/applications test
  Test Files  1 failed | 933 passed | 2 skipped (936)
       Tests  14831 passed | 10 skipped (14841)
```
Zero test failures. The one failing FILE is
`agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts`, which cannot
load: `Authentication failed against the database server, the provided database credentials for
'test' are not valid`. Pre-existing and environmental — it needs `pnpm setup:test` infra that is
not provisioned in this session, and a Prisma auth failure is unreachable from these changes.

```
pnpm --filter @arcaai/applications exec vitest run src/services/consultation src/services/settings-registry
  Test Files  298 passed (298)
       Tests  3768 passed (3768)

pnpm --filter @arcaai/database test
  Test Files   99 passed (99)
       Tests  1888 passed (1888)

npx vitest run tests/contracts/output-budget-parity.contract.test.ts
  Test Files  1 passed (1)
       Tests  3 passed (3)

pnpm --filter @arcaai/applications build        → tsc clean
pnpm --filter @arcaai/applications typecheck    → 0 errors
pnpm --filter @arcaai/database   typecheck      → 0 errors
pnpm --filter @arcaai/applications lint         → 0 errors, 197 warnings (was 236 before;
                                                   none in a file this ticket touched — the one
                                                   remaining `summary.service.ts` warning is at
                                                   line 741, pre-existing and untouched)
```

### Still to do (not code)

- **Cluster remediation is NOT automatic.** The 22 live agent rows keep `maxTokens: 2048`; the
  runtime clamp is what protects them on deploy. OD-2(b) — branching + publishing v2 of each via
  `AgentService` — is a separate run-by-hand step.
- The four cadence knobs can be applied to the RUNNING cluster immediately, with no redeploy,
  via `PUT /admin/settings/registry/:key` (they resolve per flush). The code defaults changed
  here are what new environments inherit.
- Phase 6 cluster re-proof on `arcaai-sonc-soap-new-visit` (23 sections) and the cadence
  re-measure against the §Flush-cadence analysis baseline.

## Change History

| Date | Change |
|---|---|
| 2026-09-22 | Ticket opened. Root-caused from Grafana/Loki + Rancher + cluster Postgres + a Vault Transit decrypt of the affected section. Four-link chain confirmed; constraints measured; awaiting owner decisions before implementation. |
| 2026-09-22 | Implemented phases 1-6. Three plan corrections found by the test suite, all recorded in the Implementation Summary: the `publishSectionDegrade` relaxation was reverted as harmful, truncation was narrowed to structured requests, and the delta shrink floor was overriding configured caps. Gates green; cluster remediation and re-proof outstanding. |
| 2026-09-22 | Owner decisions received: OD-4 (raise textTimeoutMs with the budget), OD-5 (delta halving), OD-8 (shared helper), OD-9 (raise pre-summary, decouple the budgets); OD-1/2/3/6/7 taken on recommendation. Cadence directive added and analysed against the five tests — measured 45-82% duty cycle, 0.1s minimum idle, 31% no-op flushes; found `minIntervalMs` is start-to-start (decorative for slow generations) and `idleMs` is bypassed by `segmentThreshold`. Phase 5 added. |
| 2026-09-22 | Codebase mapping corrected three assumptions made in the initial diagnosis: (i) a truncated flush **advances** the transcript cursor, so the encounter stretch is lost as well as mis-rendered; (ii) the 22 agent rows **cannot** be backfilled by `UPDATE` — a DB trigger forbids it, and both seed and reference-set resync are create-/missing-only; (iii) the durable finalize path shares the defect and persists a truncated note verbatim as the whole note. OD-8 and OD-9 added; plan rewritten accordingly. |

[bjr]: ../../../packages/applications/src/services/consultation/shared/bounded-json-repair.ts
[dsp]: ../../../packages/applications/src/services/consultation/live-documentation/document-shape-parser.ts
[dsp134]: ../../../packages/applications/src/services/consultation/live-documentation/document-shape-parser.ts
[dspjson]: ../../../packages/applications/src/services/consultation/live-documentation/document-shape-parser.ts
[wdat]: ../../../packages/applications/src/services/consultation/live-documentation/realtime/turn-contract.ts
[lds3522]: ../../../packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts
[lds5811]: ../../../packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts
[lds]: ../../../packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts
[ss]: ../../../packages/applications/src/services/consultation/summary/summary.service.ts
[trg]: ../../../packages/database/src/prisma/db_main/migrations/20260904120000_task_863_agent/migration.sql
