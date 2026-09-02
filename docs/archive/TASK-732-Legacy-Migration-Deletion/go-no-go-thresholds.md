# TASK-732 Phase 1 Task 2 — Go/No-Go Thresholds

**Written before any missing-note-rate or harm-proxy NUMBER was read**, per the ticket's own
instruction (§1.1, R-1): the schema, code, and CI config cited below were inspected to confirm
each input actually exists (the ticket requires this — "the executing agent must confirm each
input exists before adopting it") and to design the instrumentation, but no query in
`scripts/harness-migration-readiness-report.ts` was run against real traffic data before this
document's formulas, thresholds, comparison rule, inconclusive branch, and inversion path were
committed. The one run pasted in §5 (Instrumentation Evidence) returns an honest zero — this dev
database has no consultation-recording traffic yet — so it could not have informed the numbers
above it even if read first.

**This document defines the gate. It does not apply it.** Applying it (Phase 1 Task 3) is
HUMAN-GATED and out of this pass's scope — see the ticket's own R-1: *"the decision itself is the
user's."* Task 3 requires real traffic (staging, or a monitored dev cohort) to produce a
denominator large enough to mean anything; today's dev DB denominator is 0.

---

## 1. Missing-note rate (harness-availability side)

### 1.1 Definition actually adopted (verified against the live tree, corrects the ticket's proposal)

The ticket's own proposal (§1.1, README Task 2) defines the numerator/denominator around the
`RECORDING → DRAINING` transition "post-TASK-711." **That transition has zero non-test runtime
readers today** — `grep -rln "DRAINING" packages/applications/src apps/api/src` (excluding
`__tests__/**`) returns nothing. TASK-711's own README §7 confirms why: only Phase 0/1/2
(state-chart docs, the DB enum/migration, and the domain-layer scaffolding) have landed; Phases
3-7 — the application-service and API-surface wiring that would actually WRITE a consultation into
`DRAINING` — are explicitly **not done**, left for a later pass. There is no `DRAINING`-transition
timestamp to read from yet.

**The definition adopted instead** (the ticket's own documented fallback: *"pre-TASK-711,
`stopRecording`"*) uses the one persisted, per-event timestamp that DOES exist for "a consultation
reached capture-stop" today:

- `AuditLog` rows with `resourceType = 'Consultation'`, `action = 'UPDATE'`,
  `data.action = 'stopRecording'` — written by `ConsultationService.setRecordingStatus`
  (`packages/applications/src/services/consultation/consultation/consultation.service.ts:813-844`)
  via `broadcastSysEvent(SysEventType.ResourceUpdated, { resourceId: id, data: { action, status }
  })`, persisted by `SysEventService.handleResourceUpdatedEvent` (`AuditAction.UPDATE`).
  `AuditLog.resourceId` carries the consultation id (confirmed against real seed rows in the dev
  DB — see §5). `Consultation.status`/`updatedAt` were both confirmed NOT usable for this: `status`
  is mutable current-state only, and `updatedAt` is overwritten by every later transition, so
  neither can answer "when did THIS consultation stop recording" retrospectively once the
  consultation has moved on to `PENDING_REVIEW`/`SIGNED`/etc.

**Numerator** = capture-stop events (as defined above) with **no** `ContextItem` of
`type = 'RAW_SUMMARY'` created for that consultation within the SLA window
`[stopEvent.createdAt, stopEvent.createdAt + SLA_MINUTES]`.
**Denominator** = all capture-stop events in the measurement window.
**Proposed SLA = 15 minutes.** Justification: `SummaryMeta`'s two-phase optimistic-delivery design
(`consultation.prisma:255-262` comment) expects a draft to persist well inside a clinical visit's
own timescale — 15 minutes covers normal model latency plus at least one Temporal activity retry
under `RetryPolicy` without conflating "genuinely missing" with "still generating." This is a
proposal the human reviewing Task 3 may tighten or loosen.

**This rate is deliberately un-attributed to generator** (legacy vs. harness) in its top-line form
— the ticket's own formula denominator is "all consultations that reached capture-stop," not
"all harness-routed consultations." Attribution to a specific generator (needed for sub-counters
(a)/(b) below) requires cross-referencing the missing consultation ids against
`scripts/harness-availability-report.py`'s Temporal execution list (TASK-730 Task 4) or the
`PipelinePolicy` cascade value resolved at generation time — neither is persisted per-row, so this
is a manual (or future-scripted) join, not a single query. §5 documents the join method.

### 1.2 Sub-counters (per the ticket's own required breakdown)

| Sub-counter | Cause | How it is obtained | Status this pass |
|---|---|---|---|
| (a) Temporal unreachable at start | `HarnessGatewayService.start` throws before a workflow id is minted | Cross-reference a missing consultation id against `harness-availability-report.py`'s execution list: **zero** matching Temporal execution AND the consultation's resolved `harnessEnabled` was `true` at generation time | Requires the join described in §1.1; not computed by either script alone |
| (b) Workflow started but never completed | A `harness-doc-{id}` execution exists in Temporal but never reached a terminal state that persists `SummaryMeta` | Cross-reference: **non-zero** matching Temporal execution, but no `RAW_SUMMARY` within SLA | Same as (a) |
| (c) `harnessGatewayService?.start` silent-drop | TASK-704's fixed defect — optional-chaining on a required dependency swallowing a missing gateway | **Structurally eliminated, not measured.** Verified statically this pass: `note-generation.service.ts:82` calls `this.harnessGatewayService.start(` — NOT optional-chained — and the constructor injects `HarnessGatewayService` as a required (non-`@Optional()`) parameter (`:40`), so a missing gateway now THROWS at call time (surfacing as a `PipelineStepFailed` event) rather than silently no-op'ing. A recurrence would show up as sub-counter (a)/(b) traffic, not as a distinct silent-zero bucket, because there is no longer a code path that drops the call without an exception. | N/A — code-level guarantee, confirmed by reading, not a query |
| (d) SMR/model failure (shared failure mode) | The underlying text-generation call fails on EITHER generator | **Excluded from the harness-vs-legacy comparison per the ticket's own instruction** (it would double-count). Left in the top-line missing-note rate (§1.1) as-is — a shared-cause miss is still a miss from the clinician's point of view — but not attributed to either generator specifically. | Included in top-line rate, not separately broken out |

### 1.3 Data sources actually confirmed to exist (re-verified against the live tree this pass)

- `Consultation` (`packages/database/src/prisma/db_main/consultation.prisma:4-72`), `ContextItem`
  (`:78-...`, `type ContextItemType` including `RAW_SUMMARY`), `AuditLog`
  (`packages/database/src/prisma/db_main/audit.prisma:1-...`) — all live, plaintext-queryable for
  the fields this measurement needs (no PHI decryption required: `AuditLog.data`'s
  `{action, status}` shape and `ContextItem.type`/`createdAt` are non-PHI structural columns; the
  actual note **content** is never read).
- The Temporal list-executions query: `scripts/harness-availability-report.py` (TASK-730 Task 4,
  already shipped, re-run this pass — §5).
- The `http_*` Prometheus series: `infrastructure/docker/configs/prometheus/prometheus.yml`'s
  `harness` scrape job — re-confirmed present this pass (job block still exists, `http_*`-only
  relabeling comment unchanged).
- **New this pass:** `scripts/harness-migration-readiness-report.ts` — implements §1.1's top-line
  missing-note rate and §2's two harm-proxy halves as a single Postgres-only report. See its module
  docstring for exactly what it does and does not compute, and §5 below for a real run against the
  live dev DB.

---

## 2. Unverified-note harm rate (legacy side) — **explicitly labeled a PROXY, per R-7**

**None of the three measures below is "clinical harm."** Harm — a clinician acting on an
incorrect or incomplete note in a way that affects patient care — is not observable from this
platform's telemetry at all; nothing here has outcome data. Every measure below is a proxy for a
correlate of harm, and each is annotated with what it does NOT measure. **A clinical reviewer,
not this ticket, judges whether any proxy below is an adequate stand-in** — that judgment is
explicitly out of an engineering ticket's authority.

### 2.1 Primary proxy: `SummaryMeta.gateDecision === 'FLAG'` rate, plus groundedness (partial)

- **What it measures:** the fraction of generated notes where TASK-714's legacy floor (or the
  harness's own gate) computed a `FLAG` verdict — i.e., the floor's dosage-parity check or the
  groundedness advisory found something wrong with the note's content.
- **What it does NOT measure:** whether the flagged note was actually acted upon incorrectly, or
  whether an UNFLAGGED note was nonetheless wrong in a way neither the dosage-parity check nor the
  groundedness heuristic catches (TASK-714 §1 states outright it ports none of the harness's full
  sensor suite). A FLAG is evidence of a floor-check failure, not evidence of patient harm; a PASS
  is the absence of a floor-check failure, not a quality guarantee.
- **Computability, verified this pass:** `SummaryMeta.gateDecision` is a **plaintext** column
  (`consultation.prisma:340`) — cheap to query directly, implemented in
  `computeHarmProxy`/`gateDecisionFlag` in the new script. The OTHER half of "primary" per the
  ticket's proposal — a non-`grounded` **groundedness** verdict — lives inside
  `SummaryMeta.guardrailDecisions`, which is **Vault-Transit ciphertext only**
  (`consultation.prisma:330,348`: *"Plaintext citationsMap / guardrailDecisions JSONB columns
  DROPPED; persisted as Vault-Transit ciphertext only"*). Reading it per-row needs a live Vault
  Transit decrypt call this Prisma-only script does not carry (adding one is possible — a Vault
  round-trip per row is the same tradeoff `AuditLog`'s own comment names for its envelope-
  encryption design — but is out of this pass's scope). **This pass implements the `gateDecision`
  half only** and states the gap rather than silently narrowing the proxy's definition without
  saying so.
- **Generator attribution:** same caveat as §1 — `gateDecision` is written by BOTH the harness path
  and TASK-714's legacy floor (both call the identical write shape), so the raw rate this script
  reports is across all generators, not legacy-isolated. Isolating "legacy-generated notes only"
  needs the same Temporal-execution cross-reference described in §1.1.

### 2.2 Secondary proxy: `SIGNED_BEFORE_ASSURANCE` WORM annotation rate over signed notes

- **What it measures:** how often a clinician signed a note before its assurance pass had
  completed (`SummaryService.approveSummary`, `summary.service.ts:867,959` — the guard TASK-714
  made non-vacuous on the legacy path).
- **What it does NOT measure:** the CONTENT of the note signed early — this is a timing annotation,
  not a quality judgment. A note signed before assurance completed might have been perfectly
  correct; this proxy cannot distinguish that from a note that wasn't.
- **Computability, verified this pass:** both `HarnessAuditAction.ATTEST` (the sign event,
  denominator) and `HarnessAuditAction.SIGNED_BEFORE_ASSURANCE` (the annotation, numerator) are
  **plaintext enum values** on `HarnessAuditEvent.action` (`harness.prisma:19-36,246`) — no
  decryption needed. Cheapest of the three proxies to compute; implemented in
  `computeHarmProxy`/`signedBeforeAssurance`.

### 2.3 Strongest proxy (recommended, NOT built this pass): TASK-713 judge over a sample of signed notes

- **What it would measure:** actual note QUALITY against `EvalConfig`'s thresholds, using the same
  judge TASK-713 wired for CI (`apps/harness/src/harness/eval/`, a self-hosted local model reached
  over the `openai_compat` wire pattern — TASK-713 §7 Task 0). This is the only one of the three
  proxies about the note's content rather than about missing metadata or signing timing, and the
  one a clinical reviewer will actually ask for.
- **Cost, stated plainly rather than assumed:** TASK-713's CI job runs the judge inside a GitLab
  `services:` container (`ghcr.io/ggml-org/llama.cpp:server`, `-np 2` — two parallel decode slots)
  against a fixed golden set; running it against a random SAMPLE of already-signed legacy notes
  means standing up the same judge backend (or reusing a running one) and paying its per-case
  latency for however large a sample is chosen — not free, and not currently wired to run outside
  CI's own golden-set harness. **Recommended, not built**, exactly as the ticket instructs
  ("Recommend it; state its cost"). Building it is a Phase-1-adjacent follow-up, not part of this
  pass's instrumentation deliverable.

---

## 3. The comparison rule

These two rates are **not in the same units** — one counts consultations with zero note, the other
counts notes with a flagged/annotated verdict — and this document refuses to average or otherwise
combine them into one score. Stated as a **dominance test**, per the ticket's own suggested shape:

> **Proceed** (subject to Task 1's readiness-checklist gate, which is independent of this
> comparison and can veto a favorable result on its own) if the missing-note rate is **below X%**
> AND the legacy gateDecision-FLAG rate (§2.1) is **above Y%**.
> **Do not migrate** if the missing-note rate is **above X%**, regardless of Y — an unreliable
> harness is disqualifying on its own; a bad legacy number cannot offset it, because migrating to
> something worse-with-different-failure-modes is not a fix.
> If both numbers fall **inside the band** (missing-note rate ≤ X% but legacy-flag rate ≤ Y% too,
> i.e. neither side of the tradeoff is clearly worse), **the decision is a human clinical-risk
> judgement, not an arithmetic one** — Task 3 records that judgement explicitly rather than
> defaulting either way.

**Proposed X = 1%.** Reasoning: a missing note is a hard availability failure with no automatic
mitigation once legacy is fully retired (Phase 3) — every occurrence needs manual intervention.
Legacy's own structural missing-note rate today is close to zero by construction (a BullMQ job is
enqueued synchronously in the same request that stops recording; failures retry rather than
silently vanish), so 1% is a deliberately tight bar — asking harness-mandatory to be at least as
reliable as what it replaces, with a small allowance for the genuinely new Temporal-availability
failure mode legacy never had.

**Proposed Y = 10%.** Reasoning: a legacy flag rate at or above 10% means roughly 1 in 10
legacy-generated notes fails even the FLOOR's minimal, capped check (dosage-parity — a check
narrower than the harness's full sensor suite, per TASK-714 §1) — a rate high enough that even an
imperfectly-measured harness alternative is very likely a net improvement. Below 10%, the case for
migrating purely on the harm side weakens enough that it should not carry the decision alone.

**Both X and Y are explicitly the human's to accept or change** — nothing above is treated as
final. They are proposed with reasoning specifically so a reviewer can agree, or say why not,
rather than reverse-engineer a number from the data.

---

## 4. Inconclusive is a legal outcome

Per TASK-730's own acceptance criteria (*"inconclusive, re-measure after N more weeks of
traffic"*), this document defines:

- **Minimum sample size before ANY verdict is rendered:** the missing-note-rate denominator
  (capture-stop events in the window) must be **≥ 200**. Below that, a single-digit numerator swings
  the rate by multiple percentage points and the number is not decision-grade. Today's dev DB
  denominator is 0 (§5) — nowhere close.
- **N = 4 weeks.** If the window closes with a denominator below 200, extend the measurement
  window by 4 more weeks and re-run `scripts/harness-migration-readiness-report.ts` (and
  `scripts/harness-availability-report.py` for the Temporal side) rather than rendering a verdict
  off an underpowered sample.
- **Re-measurement trigger:** re-run both scripts once real traffic exists — staging
  (readiness-checklist.md row 3, currently unmet) or a monitored dev cohort, whichever exists
  first — and repeat until the ≥200 threshold is met or 3 consecutive 4-week windows all fall
  short, at which point the traffic-volume shortfall itself becomes a Task 3 finding to report
  (a platform with too little consultation volume to measure this is itself informative).

---

## 5. Instrumentation evidence (scripts run this pass, real output, zero fabricated)

**`scripts/harness-availability-report.py` (TASK-730 Task 4), re-run against live local Temporal:**

```
$ ~/miniconda3/envs/arcaenv/bin/python scripts/harness-availability-report.py --since-days 90
Generated: 2026-08-16T09:16:30.232085+00:00
Temporal:  localhost:7233 / namespace default
Window:    last 90 days

Total executions seen:               0
Distinct consultation workflow ids:  0
Workflow ids with >1 execution:      0
Duplicate rate:                      None
```

**`scripts/harness-migration-readiness-report.ts` (new this pass), run against the live dev
Postgres:**

```
$ NODE_ENV=development pnpm --filter @arcaai/database exec \
    tsx scripts/harness-migration-readiness-report.ts --since-days 365
===== TASK-732 migration readiness report =====
Generated:   2026-08-16T09:19:02.679Z
Window:      last 365 days (since 2025-08-16T09:19:02.508Z)
SLA:         15 minutes
Tenant:      (all tenants)

--- Missing-note rate (Task 2 formula, un-attributed to generator — see docstring) ---
capture-stop events (denominator): 0
missing within SLA (numerator):    0
rate:                              n/a (zero denominator)

--- Harm proxy, primary half: SummaryMeta.gateDecision FLAG rate (across all generators) ---
evaluated (denominator): 0
flagged (numerator):     0
rate:                    n/a (zero denominator)
(NOTE: the groundedness half of the primary proxy is NOT included — see docstring.)

--- Harm proxy, secondary: SIGNED_BEFORE_ASSURANCE annotation rate over signed notes ---
signed (denominator, ATTEST events):        0
SIGNED_BEFORE_ASSURANCE (numerator):        0
rate:                                       n/a (zero denominator)
```

Both zeros are honest: the dev DB was reset to current schema for this program's work and carries
no live consultation-recording traffic (its seed data creates `Consultation`/`AuditLog` rows
directly via `CREATE`, never through `stopRecording`, confirmed by direct query — see the
`psql` check in the Change History entry below). This is the same "genuinely no traffic yet"
finding TASK-730 §7 reported for its own script, not a bug in either instrument. **Neither report
has a non-zero sample to compute a real rate from — §4's minimum-sample-size rule is not met, and
no verdict is possible from this pass's data even if Task 3 were in scope here.**

**Script test coverage:** `packages/database/scripts/__tests__/harness-migration-readiness-report.test.ts`
— 11 tests over an in-memory fake client, covering `parseArgs` validation and both rate
computations (zero-denominator, fully-covered, fully-missing, and mixed-batch cases for the
missing-note rate; both harm-proxy halves). `pnpm --filter @arcaai/database test` — 52 files / 1255
tests passed (includes this file). `pnpm --filter @arcaai/database build` — clean.

---

## 6. The inversion path

If, once real data clears the §4 sample-size bar, the §3 comparison says **do not migrate** (or a
human reviewing an inside-the-band result decides the same): this ticket **stops after Phase 1**.
Phases 2-4 do not execute. The finding is recorded in this document's Task 3 verdict section (not
yet added — Task 3 is out of this pass) and a design-change proposal is raised against:

- `docs/programs/agentic-workflow-platform/design.md` — D1's decision log (the "entry-point
  seam now → capped legacy floor → harness-only, legacy deleted" staged plan) gets an amended
  final phase: permanent dual-generator support, not deletion.
- `docs/architecture/consultation-session-workflow/assessment/04-target-architecture.md` —
  §Recommendation, which currently assumes the harness-mandatory end state holds.

Per the ticket's own §1.1: **this is a complete, successful execution of the ticket, not a
failure of it.**

---

## 7. Task 3 — [HUMAN-GATED] Verdict

**Verdict: GO.**

**Decider:** Owner (product/platform owner, via the `remaining-open-tickets` program session).
**Date:** 2026-08-16.

**Basis — read this before treating it as the R-1 data-driven verdict it is not.** Both §5 runs
above return an honest zero: this dev database carries no live `stopRecording`/sign/generate
traffic, the §4 minimum-sample-size floor (≥200 capture-stop events) is nowhere close to met, and
no re-measurement window has been run. **This verdict is NOT the data-driven comparison R-1
envisaged** — the §3 dominance test was never evaluated against a real numerator/denominator
because none exists yet. It is a **pre-production owner call**: proceed with the harness-only
end state now, before real tenant traffic exists, rather than wait for a decision-grade sample
that a pre-production environment cannot produce. The distinction is recorded here explicitly so
it is not later mistaken for "the numbers said GO."

**Readiness-checklist rows.** Per Task 1, 5 of 10 rows (1, 3, 4, 7, 10) were **NOT VERIFIED** at
the time `readiness-checklist.md` was authored. Per Task 1's own rule ("Any row that is not
verified blocks Phase 2"), those unmet rows would ordinarily force NO-GO regardless of the rate
comparison. **The owner's GO explicitly overrides that block** for this pre-production execution —
recorded here as an explicit, named exception rather than silently ignored. The unmet rows
(staging promotion, availability measurement, dashboards/alerts on real traffic, a blocking
`harness-eval-gate`, the consultation palette) remain open operational risks for the eventual
production rollout and are not retroactively marked verified by this verdict.

**Scope of what "GO" authorizes in this pass.** Given there is no real tenant traffic and only the
two seeded tenants (both already `harnessEnabled: true` per `seed/14-pipeline-policy.ts:64,78`),
Phase 2's cohorted rollout with multi-week monitoring windows has no real population to cohort.
This verdict authorizes, for this pass: flipping the `SYSTEM_PIPELINE_POLICY_DEFAULTS.harnessEnabled`
default (Phase 2's stated exit criterion) as a pre-production configuration change, and executing
Phase 3's deletion **within the R-2 boundary recorded below** — not a claim that a multi-cohort,
multi-week production migration was actually run. See `docs/operations/consultation/harness-migration-runbook.md`
§"Pre-production execution note" for how the runbook's cohort/monitoring-window sections apply (or
don't) to this pass.

**R-2 boundary (Task 8), recorded by the same owner decision:** KEEP the v1-compat `pre-summary`
and `summary` surfaces — they are to be transformed into standalone features in a later ticket.
"Legacy deleted" is scoped to the **generator this ticket actually removed**: `summary.processor.ts`
(the async `SUMMARY_REGENERATE` BullMQ generator) and its NER companion `ner.processor.ts`, plus
TASK-714's now-throwaway legacy safety floor. `PreSummaryProcessor`, `ComprehensiveSummaryProcessor`,
and `SummaryService.generateSummary`'s sync legacy body (the "third generator,"
`summary.service.ts:402`, permanently excluded from ever routing to harness per TASK-704's own
decision — deletion-manifest.md §0.1) all **survive**, per option (b) of the ticket's own §2.6
decision table: kept, un-gated. **Correction (2026-08-20, see deletion-manifest.md §5 and
README.md §8 Change History):** "non-signable helper generators" does NOT describe all three —
only `PreSummaryProcessor`'s `PRE_SUMMARY` output is structurally excluded from
`approveSummary`'s `isFinalSummary` gate. `SummaryService.generateSummary` (by original design —
it produces the actual clinical note) and `ComprehensiveSummaryProcessor` (by original design,
matching its sync twin `ChainSummaryService.generateComprehensiveSummary`) both remain fully
signable; deleted `summary.processor.ts` was never the *sole* path capable of producing an
`isFinalSummary` draft, only the sole *legacy-BullMQ* one. The frozen
`@Controller('api/smr/api/v1')` wire route (`apps/api/src/modules/smr-compat/`) and its four
vox-node/admin-console consumers (§2.7) are untouched by this scope. This is the Task 8 decision —
recorded here and cross-referenced from `deletion-manifest.md` §5.

**Phases 2-4 proceed on this basis.** See `harness-migration-runbook.md` for the mechanism and
`deletion-manifest.md` §5 for Task 8's full record.
