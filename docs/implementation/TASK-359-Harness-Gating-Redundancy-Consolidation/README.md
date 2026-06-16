# TASK-359 — Consolidate Cross-Stack Gating Redundancies + Claim-Level Caching


|                    |                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ticket**         | TASK-359                                                                                                                                                                                                                                 |
| **Title**          | De-duplicate the gating layers and add claim-level caching across regen passes                                                                                                                                                           |
| **Created**        | 2026-06-14                                                                                                                                                                                                                               |
| **Updated**        | 2026-06-16 (rev 6 — sign-off)                                                                                                                                                                                                                       |
| **Status**         | **Completed** — user sign-off 2026-06-16; all four workstreams complete + verified (WS-1 §4.7, WS-2 §4.8, WS-3 → TASK-363 COMPLETED, WS-4 §4.9); full harness unit suite 634 passed/0 failed; L3 cross-run cache remains a default-OFF follow-up (§4.5)                              |
| **Type**           | refactor / efficiency                                                                                                                                                                                                                    |
| **Affected areas** | `apps/harness` inferential sensors + regen loop (`sensors/inferential/`*, `sensors/aggregator.py`, `temporal/workflows.py`, `temporal/activities.py`), cross-stack guardrail layers (`apps/smr` pre-gen gate + Bedrock native guardrail) |
| **Spawned from**   | TASK-355 §8 observation #3 + [TASK-355 Appendix 04 §4](../TASK-355-Harness-Latency-Optimization/04-gating-inventory.md) (redundancy findings + materiality ratings)                                                                      |
| **Related**        | [TASK-363](../TASK-363-Harness-Safety-Screening-Scoping/README.md) (WS-3 safety-screen scoping — **split out** of this ticket); TASK-356 (**COMPLETED** — model/criteria selection; see §3, no dependency); TASK-355 §7 (safety invariants this ticket must preserve)                                                                                                        |


> **All four workstreams are implemented and verified** (consolidated summary in §5): WS-1 (verdict-cache
> core, §4.7) + WS-2 (`citation_verify` reuse, §4.8) landed in TASK-359; WS-3 split to and **completed in
> [TASK-363](../TASK-363-Harness-Safety-Screening-Scoping/README.md)**; WS-4 is the cross-stack governance
> note (§4.9). Full harness unit suite **634 passed / 0 failed**; AC-1/AC-2/replay/ruff all green; mypy shows
> only pre-existing `workflows.py` findings. Status is **Completed** (user sign-off 2026-06-16). The
> only remaining item is the **default-OFF L3** cross-run cache follow-up (§4.5, gated on Redis + privacy review).

---

## 1. Requirement Analysis

### 1.1 Description

[TASK-355 Appendix 04 §4](../TASK-355-Harness-Latency-Optimization/04-gating-inventory.md) inventoried
the cross-stack gating layers and found **redundant / double-gating** work, with materiality ratings:


| # (App-04 §4) | Finding                                                                                                                                    | Materiality                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| 2             | **Full inferential re-run on every regen — no claim-level caching** (`sections_to_regen` computed but never used to scope re-verification) | **High** (when regens fire)      |
| 3             | **Groundedness + citation_verify double-judge the same claim** (same hypothesis, different premise)                                        | Medium (once RAG corpus is live) |
| 4             | **Safety re-screens the full note per criterion, every pass** (7 calls × whole note)                                                       | Medium                           |
| 1             | Two Granite deployments, overlapping intent (SMR pre-gen "is it medical?" vs harness safety harm-taxonomy)                                 | Low (Layer 1 off by default)     |
| 5             | Triple-stacking possible (Bedrock native + SMR gate + harness safety)                                                                      | Low (config-dependent)           |


This ticket **de-duplicates and coheres** the gating layers and adds **claim-level caching across
regen passes**, so identical work is not repeated — **without loosening any clinical-safety
invariant**. The headline win (Finding #2, HIGH) is claim-level caching/scoping so a regen that fixes
one SOAP section does not re-judge every unchanged claim.

### 1.2 Business context

- The inferential pass is **~71–88% of draft latency** (TASK-355 measured: 112.6s of a 159.2s E2E).
When the regen loop fires, that cost is paid **in full again** for the whole note even if only one
section changed — worst case `3 × (C + C_cited + 7)` LLM calls (Appendix 04 §3). Caching the
unchanged-claim verdicts is the largest remaining structural saving after TASK-355 Phase B.
- Double-judging the same claim and re-screening the whole note per criterion are **pure waste**
that scale with note size and (for citation-verify) with RAG adoption.
- This is an **efficiency/refactor** ticket: the goal is **fewer calls with identical verdicts**, not
a behaviour change. Any change that alters a verdict is out of scope (that would be a safety
regression, exactly like the batching path TASK-355 proved and kept OFF).

### 1.3 Acceptance criteria

- **AC-1 (measurable reduction)** — Redundant LLM calls are **measurably reduced** on a representative
fixture (e.g. a regen run re-judges only the changed claims; dually-checked claims are not judged
twice where consolidation is chosen).
- **AC-2 (identical verdicts)** — On a fixture set, the consolidated/cached path yields **byte-identical
gate verdicts** to the current path for the same inputs (verdict-parity gate, mirroring TASK-355's
golden tests).
- **AC-3 (claim-level caching)** — Across regen passes, an unchanged claim's verdict is **reused**
(keyed by a stable claim hash), and the regen re-verifies only `sections_to_regen` / changed claims;
a cache miss is **conservative** (re-judge, never assume grounded).
- **AC-4 (invariants preserved)** — All TASK-355 §7 invariants hold: never auto-PASS on
degraded/missing; safety FLAG never regenerated away; conservative-failure directions; workflow
changes ship `workflow.patched()` + replay fixtures; WORM truthfulness.
- **AC-5 (no cross-layer loosening)** — Any de-duplication across SMR/Bedrock/harness layers keeps the
**fail-closed** harness semantics (Layer 4) and does not rely on a **fail-open** layer (SMR/guardrail
service fail OPEN — Appendix 04 §1) to cover a removed harness check.

---

## 2. Current State Evaluation (grounded in live code)

### 2.1 Finding #2 (HIGH) — full inferential re-run on regen; no claim caching

- `sections_to_regen` **is computed** by the aggregator — `sensors/aggregator.py:84` (field),
`:135` (populated from failing regen-fixable sensors' `details["sections"]`) — and surfaced in
`eval/draft_eval.py`.
- **It is never consumed to scope re-verification.** A repo search shows `sections_to_regen` appears
only in `aggregator.py`, `eval/draft_eval.py`, and tests — **not** in `temporal/workflows.py` or
`temporal/activities.py`.
- The regen loop re-does **everything**: `temporal/workflows.py:564` `_regen_compute()`
(assemble → generate → extract → `run_sensors`, full note; invoked at `:734`), and
`run_inferential_sensors` is re-launched both on the legacy path (`workflows.py:482`) and inside the
optimistic assurance loop (`:669`). The activity `run_inferential_sensors` (`activities.py:493`)
rebuilds a **fresh** `SensorContext` (`:540`, from `payload.citations_map` `:543`) and re-judges
**all** claims every pass — there is no per-claim verdict cache keyed on claim content.

### 2.2 Finding #3 (Medium) — groundedness + citation_verify double-judge the same claim

Both sensors iterate `ctx.claims()` and entail the **same hypothesis** against a **different premise** —
this premise difference is **load-bearing**, not incidental (see WS-2 verdict-parity hazard, §4.1):

- `sensors/inferential/groundedness.py:91` `_premise()` — premise = transcript ∪ that claim's evidence
quotes (`arun` at `:155`).
- `sensors/inferential/citation_verify.py:50` `_premise()` — premise = the claim's **cited knowledge
chunk(s) only**; runs on the subset of claims carrying `knowledgeChunkIds` (`_cited_ids` `:43`;
`cited = [c for c in ctx.claims() if _cited_ids(c)]` `:82`; `arun` `:81`).
- Both are launched in the same pass: `activities.py:581-582` (`groundedness.arun` + `citation_verify.arun`).
A **cited** claim is therefore judged twice (2 calls/claim) — Appendix 04 §4 row 3 /
§5 "Merge groundedness+citation premises for dually-checked claims".

### 2.3 Finding #4 (Medium) — safety re-screens the full note per criterion

- `sensors/inferential/granite_client.py:102` `screen()` fans **one call per harm criterion**
(`:115-116` `asyncio.gather` over `self._criteria` `:97`), each posting the **full note**
(`_classify` `:120`). Criteria come from `SafetyGuardConfig.harm_criteria` (`core/config.py:73`).
Every inferential pass re-screens the whole note for all criteria, even when one section changed
(Appendix 04 §4 row 4). Output shape is `dict(zip(self._criteria, verdicts, strict=True))`
(`:118`) — an **ordered, per-criterion** verdict dict the aggregator depends on.

### 2.4 Findings #1 / #5 (Low) — cross-stack Granite stacking

- **Layer 1 (SMR pre-gen gate, OFF by default):** `apps/smr/src/smr_v2/services/external_guardrail.py:28`
`validate()` (returns early when `not self.settings.enabled`, `:34`). Config defaults
(`apps/smr/src/smr_v2/core/config.py`): `enabled=False` (`:80`), `fail_open=False` (`:83`),
`require_medical=True` (`:84`). **Nuance for AC-5:** the guardrail *service* fails OPEN, but this
SMR *client* defaults `fail_open=False` (fail-closed) — and the layer is OFF by default, so it is
not standing in for any harness check today.
- **Layer 5 (Bedrock native guardrail):** `apps/smr/src/smr_v2/providers/bedrock.py:78-82` injects
`guardrailConfig` only when `guardrail_id` is set (`core/config.py:59`, default `""`).
- **Layer 4 (harness safety):** the harness Granite screen above — **fail-closed**. With all enabled,
one consultation can be screened by three mechanisms (Appendix 04 §4 rows 1 & 5). Low materiality
today (Layer 1 off in dev/default; Layer 5 only with a guardrail id).

### 2.5 Dependencies & impact areas

- **Workflow-sequence sensitivity:** scoping regen / changing the call structure touches
`temporal/workflows.py` — **must** ship with a `workflow.patched()` marker + a captured replay
fixture (TASK-348/354/355 discipline; TASK-355 §7.4). Caching that lives **inside an activity**
(data-only) avoids a workflow-sequence change (cf. TASK-355 Slice 5d, which added activity *input*
fields with no new patch marker).
- **Claim identity:** caching needs a stable per-claim hash (claim text + premise inputs). Provenance
claim ids are positional (`provenance.py:309` `f"claim-{len(claims) + 1}"`) → **not** stable across a
regen; hashing must key on content, not id.
- **Cross-app (Findings #1/#5):** spans `apps/smr` config; mostly a config/governance cohering, not
code surgery. Low priority within this ticket.
- **No DB/UI change** anticipated for the core de-duplication/caching.

### 2.6 TASK-358 as-built deltas that affect this plan

> **Baseline correction.** TASK-358 ("Calibrate the deterministic sensors") is **committed** at HEAD
> (`8914209c`), not uncommitted — the working tree already reflects it. The plan and RED tests below are
> grounded against this as-built state. TASK-358 touched `sensors/base.py`, `sensors/config.py`,
> `services/provenance.py`, `services/sensor_runner.py`, `sensors/computational/schema_validity.py`
> (+ tests). It did **not** touch `sensors/aggregator.py`, the inferential sensors, or the temporal
> layer — so the WS-1/WS-2/WS-3 surfaces are intact.

Deltas that matter for TASK-359:

- **WS-1 cache key (must absorb NER/subword cleanup).** TASK-358 added subword/NER normalization:
`base.py` `SUBWORD_MARKER` + `normalize_text()` strips it; `provenance.py` `_clean_claim_text()`,
`_aggregate_subword_entities()`, and the public `clean_entities_for_sensors()`; `sensor_runner.py`
now calls `clean_entities_for_sensors`. **Implication:** the content-addressed key (WS-1) hashes the
**post-cleanup** claim text/premise **exactly as the judge receives it** (the cleaned `claim["text"]`
from `provenance._clean_claim_text` `:310`). We hash that **literal judge input** and — per §4.1 WS-1 —
do **NOT** apply a second lossy `base.normalize_text()` (lowercasing) to the key: TASK-358's cleaning
already strips ▁/whitespace noise (so it raises the HIT RATE — no false miss from a cosmetic tokenizer
difference), while hashing the literal input guarantees parity (no false hit from collapsing two
genuinely different judge inputs). T3 pins this by keying on claim text + premise + judge/model identity.
- **WS-3 threshold surface changed.** `sensors/config.py` gained `citation_verify_threshold` (0.8).
WS-3/WS-2 tests read thresholds from `SensorThresholds` rather than hard-coding them.
- **Positional claim-id scheme unchanged.** `provenance.py` still emits `claim-{n}` (`:309`, shifted
from the `:235` cited in earlier drafts) — confirming the WS-1 "hash on content, never on id" rule.
- **Aggregator `sections_to_regen` unchanged by 358** — WS-1's regen-scoping target is exactly as
documented in §2.1; no 358 interaction.

---

## 3. Relationship to TASK-356 (COMPLETED — no dependency)

[TASK-356 — Admin-Managed Models & Workflows](../TASK-356-Admin-Managed-Models-Workflows/README.md)
is **COMPLETED** (Phases 1–6). It OWNS *what runs and who configures it*: the `harm_criteria` set,
judge/safety-model selection, `HarnessPolicy`, `ConfigResolver`/`PipelinePolicy`, and the admin
controls. **TASK-359 does NOT depend on TASK-356 and does NOT defer anything to it.**

- **Clean boundary:** TASK-356 = selection/config (done); TASK-359 = **execution structure only**, with
  byte-identical verdicts. TASK-359 adds no admin config and waits on no 356 work.
- **Where they meet (a one-way read, not a dependency):** TASK-359's cache keys on the *effective*
  judge/safety **model identity** (`JudgeClient.model` / `GraniteGuardianClient.model`) that TASK-356's
  resolver already selects — so a 356-driven model swap **auto-invalidates** the cache (the model id is
  in the key, §4.1/§4.5). That reads an existing, completed surface; it neither changes 356 nor needs
  new 356 work.
- **WS-4 is self-contained in TASK-359** (a governance/config note owned here), **not** a deferral to
  356 — see §4.1 WS-4 (this is the decision-#4 re-scope).

**Scope guard:** TASK-359 must **not** weaken a clinical-safety invariant to gain efficiency, and must
**not** build admin config (that surface already exists in the completed TASK-356). This ticket does not
edit TASK-356's doc.

---

## 4. Implementation Plan (proposed — **await approval before coding**, Phase-3 gate)

> TDD Red-Green-Refactor; harness Python/pytest under the `arcaenv` conda env. **A verdict-parity
> gate is mandatory** — every change must produce identical verdicts on the fixture set (the TASK-355
> batching lesson: an efficiency change that shifts a verdict is rejected).

### 4.1 Prioritized workstreams

> **Decisions LOCKED** — the five §4.4 decisions are folded in below. WS-3 is **split out** to
> [TASK-363](../TASK-363-Harness-Safety-Screening-Scoping/README.md). Active TASK-359 scope = **WS-1,
> WS-2, WS-4** (+ the broader-cache design, §4.5).

1. **WS-1 (HIGH) — claim-level verdict cache + regen scoping (Finding #2).** *(IMPLEMENTED — T2/T3/T4 GREEN; as-built in §4.7)*
   **LOCKED (decision #1 — chosen for accuracy + speed under HARD parity & replay):**
   - **Caching site = WORKFLOW-THREADED, data-only (NOT activity-local-only).** The WS-1 win is
     *cross-pass* reuse (a regen that fixes one section must not re-judge unchanged claims). An
     activity-local dict dies with each `run_inferential_sensors` invocation → it dedupes only *within*
     one pass and gives **non-deterministic** cross-pass hits (only if Temporal reschedules the next
     pass on the same worker process). Threading a content-addressed verdict map through the activity's
     **input/output** makes cross-pass reuse **deterministic** (the map travels in the payload, not in
     worker memory) — higher hit rate (accuracy of the optimization) **and** deterministic speed.
   - **Replay-safe with NO patch marker.** Carry the map as **additive, optional, default-valued**
     fields: `RunInferentialSensorsInput.prior_verdicts: dict[str, bool] = {}` (in) and
     `InferentialRunOutput.verdict_cache: dict[str, bool] = {}` (out). This adds **no new workflow
     command** (the same single `ScheduleActivityTask`), so by the TASK-355 Slice-5d precedent **no
     `workflow.patched()`** is required and all 5 existing replay fixtures stay byte-identical (T8). On
     replay of an old history the missing fields default to `{}` → identical behaviour. (`extra="forbid"`
     on both models is preserved — we own them; the fields are additive.)
   - **Exact content key (decision #1, red-team-refined).**
     `verdict_cache.claim_verdict_key(claim_text, premise, judge_identity) -> hex sha256` hashes the
     **exact bytes the judge receives**: the post-TASK-358 cleaned `claim["text"]` (already produced by
     `provenance._clean_claim_text`, `:310`) as the hypothesis, the sensor's `_premise(...)` output, the
     sensor/prompt identity, and `judge.model`. **We deliberately do NOT additionally apply
     `base.normalize_text()` (lossy lowercasing) to the key** — that would map two *different* judge
     inputs onto one entry and risk a **false-hit parity violation**. TASK-358's upstream cleaning
     already strips ▁/whitespace noise, so it only raises the HIT RATE; parity comes from hashing the
     literal judge input. (This refines decision-#1's wording — see §4.4 #1.)
   - **Parity proof:** a `temperature=0.0` deterministic judge ⇒ identical `(messages, model)` ⇒
     identical raw ⇒ identical `_is_supported` ⇒ identical bool. A hit returns exactly the verdict a
     fresh call would produce; a **miss re-judges** (conservative — never assume grounded); an
     unparseable verdict stays ungrounded. The per-claim verdict still flows through the **unchanged**
     `_aggregate(...)`, so the `SensorResult` is byte-identical (T1 anchor; T2/T4 cache behaviour).
   - **Regen scoping:** with the prior verdict map in hand, the activity re-judges only claims whose
     content key is absent (changed text/premise) — i.e. the claims in the aggregator's
     `sections_to_regen` (`aggregator.py:84/:135`, unchanged by 358); unchanged claims are cache hits.
2. **WS-2 (Medium) — dually-checked cited claims (Finding #3).** *(IMPLEMENTED — T5 GREEN; as-built in §4.8)*
   **LOCKED (decision #2 — merge REJECTED; cache-reuse CHOSEN):**
   - **Red-team conclusion:** Finding #3 is **not true redundancy**. groundedness entails the claim vs
     *transcript ∪ evidence*; citation_verify entails the *same claim* vs the *cited chunk ONLY*
     (`citation_verify.py:50`). Two different clinical questions, neither derivable from the other. A
     **merged prompt** feeds both premises into one call → the transcript leaks into the citation
     judgement and can loosen a borderline citation verdict (the TASK-355 batching lesson) — an
     **AC-2/AC-5 violation**. A **verdict-preserving short-circuit** is unsound (no implication holds
     between the two premises). Both rejected under HARD parity.
   - **Chosen mechanism = extend the WS-1 cache to citation_verify.** `CitationVerifySensor.arun(...)`
     gains the same optional `verdict_cache=` kwarg, sharing ONE map with groundedness. Because the key
     includes the **sensor/prompt + premise**, a cited claim gets **two distinct entries** (one per
     premise) — so within a pass it is still two calls (correct, not redundant), but **across passes**
     (and across runs, §4.5) both verdicts are reused. Verdicts stay **separable** and byte-identical to
     the unconsolidated baseline (T5). **No `consolidated.py`, no merged prompt.**
   - **Net:** WS-2 collapses into "apply the WS-1 cache to citation_verify"; the only parity-safe saving
     for dually-checked claims is cross-pass/cross-run reuse, which WS-1 already provides.
3. **WS-3 (Medium) — safety-screen scoping (Finding #4) → SPLIT OUT to TASK-363.**
   Per decision #3, WS-3 is now its own ticket so a parallel agent can implement it:
   [TASK-363 — Scope Harness Safety Screening](../TASK-363-Harness-Safety-Screening-Scoping/README.md).
   It applies the **same content-addressed-cache pattern** to the Granite per-criterion screen,
   preserving the ordered per-criterion dict (`dict(zip(criteria, verdicts, strict=True))`, §2.3) and
   the fail-closed degrade. The GREEN contract guards (former T6) **moved** to
   `tests/unit/sensors/test_safety_scoping.py` (S1/S2) with a RED scoping anchor (S3). **No longer in
   TASK-359's active scope** — the shared cache primitive is coordinated in §4.6.
4. **WS-4 (Low) — cross-stack cohering (Findings #1/#5).** *(FINALIZED — governance note in §4.9; GREEN guard: T9)*
   **LOCKED (decision #4 — self-contained in 359; TASK-356 is COMPLETED, no dependency):**
   - A **standalone governance/config note owned by TASK-359** (no admin config, no 356 deferral). It
     records the invariant: the harness gate (Layer 4) is **fail-closed** and must never be replaced by
     a **fail-open** SMR pre-gen gate (Layer 1, OFF by default, `fail_open=False`) or the guardrail
     service. The model/criteria *selection* surface already exists in the completed TASK-356; WS-4 only
     reads/documents it.
   - **Minimal config-only assertion (owned here):** keep Layer 1 OFF for harness-originated generates
     and avoid redundant triple-stacking; documented default + the **T9** guard (`aggregate()` has no
     fail-open external input; degraded/missing → FLAG). No code change beyond the documented default;
     nothing waits on TASK-356.

### 4.2 TDD test list (written first; RED/GREEN as labelled)

**Files (tests only — no implementation).** TASK-359 owns
`tests/unit/sensors/test_gating_consolidation.py` (T1–T5, T7, T9) and
`tests/unit/temporal/test_gating_consolidation_replay.py` (T8). The WS-3 split (TASK-363) owns
`tests/unit/sensors/test_safety_scoping.py` (S1/S2 GREEN — former T6; S3 RED). RED tests use a
`_require(...)`/`_has_kwarg(...)` probe that calls `pytest.fail("…not implemented yet (TDD RED)…")` when
the not-yet-built API is absent — so they fail **for the right reason** (named missing API), never an
import/collection error. **Combined run as of 2026-06-16 rev 4 (`arcaenv` pytest, WS-1 + WS-2 landed): 17
GREEN, 1 RED** (TASK-359 files = 15 GREEN + 0 RED — T2/T3/T4/T5 now GREEN; TASK-363 file = 2 GREEN + 1 RED).
The 1 remaining RED is S3 (TASK-363 / Agent C), failing on its named not-yet-built `screen_cache` kwarg.
Full `sensors/` + `temporal/` suite: **272 passed, 1 failed (the intended RED)**. `ruff` clean.

| # | Test (class) | Asserts | Status | Why |
|---|---|---|---|---|
| T1 | `TestT1VerdictParityAnchor` — current inferential verdicts pinned on a fixture (aggregate decision, `sections_to_regen`, flagged claims, judge call-count) | AC-2 | **GREEN** | parity baseline WS-1/WS-2 must reproduce byte-identically |
| T2 | `TestT2RegenScopingReusesCache` — pass-2 unchanged claims reuse cache (0 new calls); one changed claim ⇒ exactly one re-judge | AC-1, AC-3 | **GREEN** | `GroundednessSensor.arun(..., verdict_cache=)` implemented (§4.7) |
| T3 | `TestT3CacheKeyContentAddressedAndModelInvalidated` — key is a deterministic **hex digest**; content-addressed + id-independent; **model/prompt change ⇒ different key** (cross-run reuse + invalidation, decision #5) | AC-3 | **GREEN** | `verdict_cache.claim_verdict_key` + `sensor_identity` implemented (§4.7) |
| T4 | `TestT4CacheMissIsConservative` — empty cache ⇒ judge called; unparseable ⇒ ungrounded | AC-3, AC-4 | **GREEN** | conservative miss via `cached_verdict` (§4.7) |
| T5 | `TestT5CitationVerifyCacheSeparableNoMerge` — shared cache covers citation_verify; cited claim = two distinct keys (2 calls/pass, **no merge**); pass-2 = 0 calls; verdicts **separable** & byte-identical | AC-1, AC-2, AC-5 | **GREEN** | `CitationVerifySensor.arun(..., verdict_cache=)` implemented (§4.8) |
| T7 | `TestT7SafetyFlagInvariants` — unsafe ⇒ FLAG & never regenerated; degraded inferential ⇒ never auto-PASS | AC-4 | **GREEN** | aggregator-invariant guard (TASK-355 §7) |
| T8 | `test_existing_replay_fixtures_stay_byte_identical` (5 fixtures) + `test_inferential_input_uses_additive_optional_fields` | AC-4 | **GREEN** | 5 histories replay byte-identical; `RunInferentialSensorsInput` additive-optional (anchors the workflow-threaded WS-1 carrier) |
| T9 | `TestT9HarnessGateFailsClosed` — `aggregate()` has no fail-open external input; degraded/missing ⇒ FLAG | AC-5 | **GREEN** | WS-4 fail-closed guard |
| ~~T6~~ → **S1/S2** | **Moved to TASK-363** `test_safety_scoping.py` — ordered per-criterion dict + fail-closed degrade (GREEN); **S3** RED = `SafetySensor.arun(..., screen_cache=)` scoping | AC-2, AC-4 | GREEN+RED | WS-3 split out (decision #3) |

> WS-1/WS-2 are now implemented: T2–T5 turned GREEN once `verdict_cache.py` + the `verdict_cache=` kwargs
> on groundedness (§4.7) and citation_verify (§4.8) landed — under the parity anchor T1 and the replay
> guard T8. The remaining RED, **S3 (TASK-363)**, turns GREEN when `SafetySensor.arun(..., screen_cache=)`
> exists (Agent C). **No `consolidated.py`** (WS-2 merge rejected).

### 4.3 Verification criteria

- **Call-count evidence:** before/after LLM call counts on a regen fixture showing the reduction (AC-1).
- **Verdict-parity evidence:** the parity gate green on the fixture set (AC-2).
- New + existing harness unit/temporal suites green; replay fixtures green (or a new fixture captured
if the workflow sequence changed); `ruff`/mypy clean.

### 4.4 LOCKED decisions (folded into §4.1/§4.5/§4.6; for final approval)

1. **WS-1 caching site — LOCKED: WORKFLOW-THREADED, data-only (best for accuracy + speed).**
   Activity-local-only rejected — it gives only intra-pass dedupe and **non-deterministic** cross-pass
   hits (worker-affinity-dependent). Workflow-threaded carries a content-addressed verdict map via
   **additive-optional** `RunInferentialSensorsInput.prior_verdicts` / `InferentialRunOutput.verdict_cache`
   → **deterministic** cross-pass reuse, **no `workflow.patched()`** (Slice-5d precedent), 5 fixtures stay
   green (T8). **No 6th fixture / no patch needed.** Key = exact-judge-input hash + `judge.model`
   (§4.1 WS-1). *Refinement:* hash the literal post-clean judge input; do **not** add lossy
   `normalize_text` to the key (false-hit parity risk).
2. **WS-2 mechanism — LOCKED: NO merged prompt; extend the WS-1 cache to citation_verify.** Merge and
   short-circuit are both parity-unsafe (§4.1 WS-2). Best practice = reuse the per-premise verdict via the
   shared content-addressed cache (separable, byte-identical). Drops the previously-proposed
   `consolidated.py`.
3. **WS-3 — LOCKED: SPLIT OUT to [TASK-363](../TASK-363-Harness-Safety-Screening-Scoping/README.md)** so a
   parallel agent owns it. Same cache pattern applied to the Granite per-criterion screen; preserves the
   ordered dict + fail-closed degrade. Removed from TASK-359 active scope (§4.1 WS-3, §4.6).
   **Confirm the auto-assigned number TASK-363** (360 unused; 361/362 exist).
4. **WS-4 — LOCKED: self-contained in TASK-359 (no TASK-356 dependency).** TASK-356 is COMPLETED; WS-4 is a
   governance/config note owned here that only *reads* 356's existing model/criteria selection to keep the
   cache model-keyed and to assert the fail-closed invariant (T9). "Aligned with admin config/controls" =
   it honours 356's selected models/criteria (cache auto-invalidates on a 356 model change) **without**
   adding or changing any admin config.
5. **Cache lifetime — LOCKED: tiered L1/L2/L3; ship L1+L2 now, design L3 (broader/cross-run) default-OFF
   with a safe PHI bound (§4.5).** Honours the "broader" intent (new-visit / same-day re-visit / amend /
   retry) while bounding PHI-at-rest: L3 stores only an **irreversible hash → boolean** (no raw clinical
   text), is **citation_verify-first** (where cross-*consultation* hits are real), and is gated behind a
   flag + privacy review.

### 4.5 Broader cache design (decision #5) — tiers, key, PHI bound, hit analysis

**Three tiers, one content key** (`claim_verdict_key`, §4.1 WS-1). Every tier is parity-safe by the same
proof: a hit returns the verdict a deterministic (`temperature=0.0`) judge call would produce for the
**identical** `(sensor/prompt, premise, hypothesis, model)`; a miss re-judges.

| Tier | Lives | Lifetime | Default | Purpose |
|---|---|---|---|---|
| **L1** | inside `run_inferential_sensors` (a dict) | one activity invocation | ON | dedupe identical `(premise,hypothesis)` within one pass |
| **L2** | workflow-threaded payload (`prior_verdicts`/`verdict_cache`) | one workflow run (all regen passes) | ON | deterministic cross-pass reuse (the WS-1 headline; replay-safe, no patch) |
| **L3** | external KV (Redis preferred; harness has **no** Redis wired today) | cross-run / persistent (TTL) | **OFF** | reuse across *separate* workflow runs (amend / retry / re-generate / cross-consultation) |

**Where cross-run hits actually are (the premise is in the key, so this is narrow):**
- **groundedness** premise = the consultation **transcript** (∪ evidence) — *unique per session*, so
  cross-*consultation* hit probability ≈ 0. But a **re-run of the SAME consultation** (amend / retry /
  manual re-generate, incl. a same-day re-visit that re-processes the same/edited note) has the **same
  transcript** → **high** L3 hit rate. This is L3's main, real win.
- **citation_verify** premise = the **cited knowledge chunk text** (shared institutional corpus) +
  hypothesis. Cross-*consultation* hits occur when two consultations assert the same normalized claim
  citing the same chunk — **realistic** for common/templated claims once RAG is live. L3 is
  **citation_verify-first**.
- **safety** (now TASK-363) screens whole-note text (unique) → like groundedness, ~0 cross-consultation
  hits; its cross-run value is the same-consultation re-run case.

**PHI / safety bound (the recommended safe limit).**
- **Store only** `sha256(KEY_SCHEMA_VERSION ‖ judge.model ‖ sensor/prompt ‖ premise ‖ hypothesis) → {bool,
  model, schema, ts}`. No raw transcript/claim/note text is ever persisted — only a one-way digest + a
  boolean → the store holds **no recoverable PHI** at rest. (Recommend an **HMAC** with a server-side
  secret so even theoretical recomputation/linkage is blocked.)
- **Automatic, content-driven invalidation:** the key includes the judge/safety **model id** + a
  **prompt-version** (hash of the sensor system prompt) + `KEY_SCHEMA_VERSION`, so a model swap (incl. a
  TASK-356-driven change) or a prompt edit yields a new key (old entries unreachable). A corpus edit
  changes the chunk **text** in the premise → new key. Add a **TTL** (recommend 30–90 d) + LRU/size cap.
- **Parity across runs:** identical inputs ⇒ identical key ⇒ identical deterministic verdict; a miss
  re-judges. TTL/version affect hit rate only, never correctness.
- **Egress:** L3 holds hashes+booleans, not text, so it adds no new PHI egress; the TASK-357 PHI-egress
  guard on the judge/Granite call is unchanged.

**Recommendation (the surfaced tension + safe bound).** Ship **L1 + L2** in TASK-359 (parity/replay-safe,
no PHI-at-rest, deterministic cross-pass win). **Design L3 now but ship it default-OFF**,
citation_verify-first, hash→bool-only, behind `HARNESS_VERDICT_CACHE_L3=none|redis`, pending (a) harness
Redis wiring and (b) a privacy review/DPIA. A truly *persistent* cache of clinical-judgement results is
acceptable **only** as irreversible hash→bool; persisting premises/claim text is not. This honours
"broader" without an unbounded PHI/staleness surface — flip L3 on once the bound is signed off.

### 4.6 Parallel-agent implementation decomposition + go/no-go

Four implementation agents with **disjoint file ownership** (no collisions):

| Agent | Owns (writes) | Depends on | Tests |
|---|---|---|---|
| **A — WS-1 core** | `sensors/inferential/verdict_cache.py` (new); `groundedness.py` (`verdict_cache=` kwarg); `temporal/models.py` (`prior_verdicts`/`verdict_cache` fields); `temporal/activities.py` + `temporal/workflows.py` (thread the map) | — | T2, T3, T4, T8 |
| **B — WS-2** | `sensors/inferential/citation_verify.py` (`verdict_cache=` kwarg) | **A** (key helper + shared map) | T5 |
| **C — WS-3 (TASK-363)** | `sensors/inferential/safety.py`, `granite_client.py`, `tests/unit/sensors/test_safety_scoping.py` | **A** (reuse key helper + carrier; add a `safety_screen_cache` field) | S1, S2, S3 |
| **D — WS-4** | docs only (§4.1 WS-4 governance note) — **T9 already green** | — | T9 |

**Shared-surface rule:** only **Agent A** edits `verdict_cache.py`, `temporal/models.py`, `activities.py`,
`workflows.py`. B and C **import** A's key helper and **add their own** carrier field + sensor kwarg; they
never edit A's files (avoids cache-primitive divergence).

**Go/no-go sequence:**
1. **Gate 0 (now):** plan approved → start **A** (WS-1 core), **D** (WS-4 note), and **C**'s S1/S2 guards in parallel.
2. **Gate 1:** A lands `claim_verdict_key` + carrier fields with T2/T3/T4/T8 green (anchor T1 still green) → unblocks **B** and **C**'s S3.
3. **Gate 2:** B (T5) and TASK-363 (S3) implement against the shared primitive; verdict-parity gate (T1 + golden fixtures) green for both.
4. **Gate 3:** AC-1 call-count evidence captured on a regen fixture; all suites + 5 replay fixtures green; ruff/mypy clean → ready for the **L3 default-OFF** follow-up (separate approval, §4.5).

> **Does L3 gate WS-1?** No. L1/L2 ship first and are independent of L3; L3 is a later, default-OFF,
> separately-approved layer reusing the same key.

---

### 4.7 WS-1 implementation summary (LANDED — Agent A; 2026-06-16)

WS-1 is implemented exactly as locked: a **workflow-threaded, data-only, content-addressed per-claim
verdict cache** with cross-pass reuse. **No new workflow command, no `workflow.patched()`** — the 5 replay
fixtures stay byte-identical.

**Public API — `sensors/inferential/verdict_cache.py` (stable; B and C import this):**

```python
VerdictCache = dict[str, bool]                       # the carrier type (key -> supported); L1 memo == L2 carrier
KEY_SCHEMA_VERSION = "v1"                             # bump invalidates all keys

def claim_verdict_key(claim_text: str, premise: str, judge_identity: str) -> str
    # hex digest (SHA-256, or HMAC-SHA256 if HARNESS_VERDICT_CACHE_HMAC_KEY is set) over the
    # EXACT judge input: post-clean claim text ‖ premise ‖ judge_identity. No lossy normalize_text.

def sensor_identity(sensor_name: str, system_prompt: str, model: str) -> str
    # composes the judge_identity arg above: sensor name ‖ sha256(system_prompt)[:16] ‖ model
    # (a prompt edit or model swap changes the key — auto-invalidation, §4.5).

async def cached_verdict(cache: VerdictCache | None, *, key: str,
                         compute: Callable[[], Awaitable[bool]]) -> bool
    # HIT -> cache[key]; MISS -> await compute() (must already be conservative) then populate.
    # cache is None -> straight passthrough. A miss NEVER assumes grounded.
```

**Carrier fields (`temporal/models.py`, additive-optional, `extra="forbid"` preserved):**
- `RunInferentialSensorsInput.prior_verdicts: dict[str, bool] = {}` — verdicts carried IN from prior passes.
- `InferentialRunOutput.verdict_cache: dict[str, bool] = {}` — verdicts this pass saw + populated, carried OUT.

**Files changed (Agent A only):**
| File | Change |
|---|---|
| `sensors/inferential/verdict_cache.py` | **NEW** — the API above (key helper + identity + `cached_verdict` + `VerdictCache`). |
| `sensors/inferential/groundedness.py` | `arun(..., verdict_cache=None)` + `_verdicts_per_claim(..., verdict_cache=None)`; per-claim key → `cached_verdict` (hit reuse / miss re-judge+populate). Batched path unchanged (cache not applied). |
| `temporal/models.py` | added `prior_verdicts` (in) + `verdict_cache` (out) additive-optional fields. |
| `temporal/activities.py` | seed `verdict_cache = dict(payload.prior_verdicts)`; pass to `groundedness.arun`; echo it on every output path (`_assemble_inferential_output(results, verdict_cache)`), incl. both degrade returns. |
| `temporal/workflows.py` | one `verdict_cache: dict[str, bool] = {}` local; threaded `prior_verdicts=verdict_cache` into **both** inferential call sites (legacy + optimistic-assurance) and captured `verdict_cache = inferential.verdict_cache` from each output across regen passes (DATA flow only). |

**Verdict-parity (AC-2) & conservative miss.** A `temperature=0.0` deterministic judge ⇒ identical
`(messages, model)` ⇒ identical raw ⇒ identical `_is_supported` ⇒ identical bool; a HIT returns exactly the
verdict a fresh call would produce, a MISS re-judges (never assumes grounded), unparseable stays ungrounded.
The verdict flows through the **unchanged** `_aggregate(...)`, so the `SensorResult` is byte-identical.

**Evidence (`arcaenv`):**
- **AC-1 call-count reduction (real `GroundednessSensor` + counting judge):** cold pass over 3 claims = **3**
  judge calls; a regen that changed **1** claim with the warm cache = **1** judge call (2/3 reused); the same
  regen set uncached = **3** calls → **3 → 1 (2 avoided)**.
- **AC-2 parity:** the cached regen pass `SensorResult` is **byte-identical** to a fresh uncached pass
  (`score=1.0`, `passed=True`, full `model_dump()` equal).
- **Tests:** T2/T3/T4 **GREEN**; T1/T7/T8/T9/S1/S2 **GREEN**; T5 + S3 **RED** (correctly — Agents B/C). Full
  `sensors/` + `temporal/` suite **271 passed, 2 failed (the intended RED)**; ruff clean.
- **Replay (AC-4):** all 5 frozen histories replay byte-identically on `test_gating_consolidation_replay.py`
  **and** `test_replay_compat.py` (11 replays GREEN); `RunInferentialSensorsInput` keeps only `note_text`
  required (T8).

**Unblocks B and C.** WS-2 (Agent B) calls `CitationVerifySensor.arun(..., verdict_cache=)` reusing the SAME
`claim_verdict_key`/`sensor_identity`/`cached_verdict`; TASK-363 (Agent C) reuses the key helper for its
`screen_cache`. L3 (cross-run/persistent) remains **default-OFF / unimplemented** (§4.5) and does not gate WS-1.

---

### 4.8 WS-2 as-built (LANDED — Agent B; 2026-06-16)

WS-2 extends the WS-1 cache to `citation_verify` by **reusing the exact WS-1 primitive** — **no merged
prompt, no new carrier, no workflow change**. A dually-checked cited claim is judged once **per premise**
and reused across passes; the groundedness and citation_verify verdicts stay **separable**.

**Files changed (Agent B only):**
| File | Change |
|---|---|
| `sensors/inferential/citation_verify.py` | `arun(..., verdict_cache: VerdictCache \| None = None)`; per cited claim, `claim_verdict_key(claim_text=hypothesis, premise=_premise(cited chunks), judge_identity=sensor_identity("citation_verify", _SYSTEM_PROMPT, judge.model))` → `cached_verdict(...)` (hit reuse / miss re-judge+populate). The unverifiable branch (no premise / empty hypothesis ⇒ `False`) is unchanged — structural, never judged, never cached. Scoring + aggregation untouched. |
| `temporal/activities.py` | citation_verify launch site now passes the **same** local `verdict_cache` dict already threaded to groundedness: `citation_verify.arun(ctx, judge=judge, verdict_cache=verdict_cache)`. No new carrier; `models.py`/`workflows.py` untouched. |

**Distinct, non-colliding key (decision #2).** The citation_verify key differs from the groundedness key for
the SAME claim on **two** independent axes: (a) **premise** — cited chunk(s) only vs transcript ∪ evidence;
(b) **sensor identity** — `sensor_identity("citation_verify", <citation_verify prompt>, model)` vs
`"groundedness"`. So a cited claim occupies **two** cache entries; within a pass it is still two judge calls
(correct — two different clinical questions, NOT a merge), and across passes both are reused.

**Verdict-parity (AC-2) & conservative miss.** `temperature=0.0` ⇒ identical `(messages, model)` per premise ⇒
identical raw ⇒ identical `_is_supported` ⇒ identical bool; a cached citation_verify verdict is byte-identical
to a fresh one; a miss re-judges (an unparseable/contradicted/unresolvable citation stays **not-confirmed** —
never auto-PASS a citation we cannot verify, AC-5).

**Evidence (`arcaenv`):**
- **Distinct keys:** for one cited claim, groundedness key `159dafae…` ≠ citation_verify key `f3e3b994…`; the
  shared cache holds **2** entries.
- **AC-1 (shared cache):** pass 1 cold = **2** judge calls (two premises, **no merge**); pass 2 warm =
  **0** calls (both sensors reuse).
- **Separability:** with a transcript that SUPPORTS but a cited chunk that CONTRADICTS the claim,
  `(groundedness.passed, citation_verify.passed) == (True, False)` both uncached and cached — the two verdicts
  never collapse.
- **AC-2 parity:** cited-claim citation_verify cached `(passed, score, claims_flagged) == fresh`; groundedness
  likewise.
- **Tests:** **T5 GREEN**; T1/T2/T3/T4/T7/T8/T9/S1/S2 GREEN; **S3 RED** (correct — Agent C). Full `sensors/` +
  `temporal/` suite **272 passed, 1 failed (the intended RED)**; ruff clean.
- **Replay (AC-4):** all 5 frozen histories byte-identical (11 replays GREEN); `models.py`/`workflows.py`
  untouched, **no `workflow.patched()`** added (the carrier was already threaded by WS-1).

**TASK-363 (Agent C) untouched & still unblocked at WS-2 landing.** `safety.py`, `granite_client.py`,
`test_safety_scoping.py`, and the TASK-363 README were not modified by WS-2; S3 was RED on its `screen_cache`
probe at that point. *(TASK-363 has since landed — see §4.9 / §5.)*

---

### 4.9 WS-4 — cross-stack governance note (FINAL; docs-only, owned by TASK-359)

WS-4 is a **self-contained governance/config note** — **no code, no admin config, no dependency on (and
nothing deferred to) the COMPLETED TASK-356**. It records the cross-stack cohering (Findings #1/#5) and the
fail-direction invariant the cache work must never erode.

**The four gating layers and their fail directions (Appendix 04 §1).**
| Layer | Where | Fail direction | Default for harness-originated generates |
|---|---|---|---|
| L1 — SMR pre-gen gate | `apps/smr` | **fail-OPEN** (`fail_open` → safe-on-error) | **OFF** (harness owns gating; not stacked ahead of L4) |
| L2/L3 — guardrail service / Bedrock native guardrail | `apps/smr` / Bedrock | **fail-OPEN** | advisory; never the gate of record |
| **L4 — harness gate** (`aggregate()` + regen loop) | `apps/harness` | **fail-CLOSED** (degraded/missing ⇒ FLAG) | **ON — the gate of record** |

**Assertions (the WS-4 contract):**
- **No redundant stacking.** L1 stays OFF for harness-originated generates; the layers are not triple-stacked.
  Harness gating is L4 only.
- **AC-5 — fail-closed is never replaced by fail-open.** A de-duplication/efficiency change must never let a
  fail-OPEN layer (L1 / guardrail service) stand in for the fail-CLOSED L4 harness check. This is enforced by
  **T9** (`TestT9HarnessGateFailsClosed`, GREEN): `aggregate()` takes **no** fail-open external input, and
  degraded/missing inputs ⇒ FLAG (never a silent auto-PASS). The verdict-cache work (WS-1/2/3) only changes
  *how often the judge/Granite runs*, never the aggregation inputs or fail direction — a cache **miss**
  re-judges/re-screens (conservative), a degraded backend is **never** cached.
- **TASK-356 coupling is a one-way read, not a runtime dependency.** Every cache key embeds the effective
  judge/safety **model identity** via `sensor_identity(...)` (`JudgeClient.model` / `GraniteGuardianClient.model`)
  plus the per-sensor prompt/criterion. So any model **or** harm-criteria swap — **including one configured
  through the now-COMPLETED TASK-356 admin surface** — produces different keys and **auto-invalidates** the
  cache (no stale cross-config reuse, AC-2 across configs). TASK-359 reads that completed surface; it neither
  changes it nor waits on it.
- **Nothing pending or deferred to TASK-356.** The model/criteria selection + admin controls already exist
  (TASK-356, Phases 1–6, COMPLETED). WS-4 adds no admin config and leaves no 356 follow-up.

---

## 5. Implementation Summary (consolidated — WS-1 + WS-2 + WS-3/TASK-363 + WS-4)

**Status: implementation complete + verified across all four workstreams; awaiting the user's final sign-off.**

| Workstream | Outcome | Where |
|---|---|---|
| **WS-1** — content-addressed per-claim verdict cache (core) + workflow-threaded carrier + regen scoping | **LANDED & GREEN** (T2/T3/T4) | §4.7 |
| **WS-2** — extend the cache to `citation_verify` (no merge; separable verdicts) | **LANDED & GREEN** (T5) | §4.8 |
| **WS-3** — content-addressed safety-screen scoping | **SPLIT OUT → [TASK-363](../TASK-363-Harness-Safety-Screening-Scoping/README.md), COMPLETED** (S1/S2/S3 GREEN) | TASK-363 |
| **WS-4** — cross-stack governance note (fail-closed L4 invariant; TASK-356 one-way read) | **FINALIZED** (docs-only; T9 GREEN) | §4.9 |

**All files changed across the three implementation agents (A=WS-1, B=WS-2, C=WS-3/TASK-363):**

| File | Agent(s) | Change |
|---|---|---|
| `sensors/inferential/verdict_cache.py` | A | **NEW** — `claim_verdict_key` / `sensor_identity` / `cached_verdict` / `VerdictCache` (the shared primitive B & C import). |
| `sensors/inferential/groundedness.py` | A | additive-optional `verdict_cache=` kwarg; per-claim hit-reuse / miss-rejudge+populate. |
| `sensors/inferential/citation_verify.py` | B | additive-optional `verdict_cache=` kwarg; keyed on its OWN premise (cited chunks) + identity ⇒ distinct from groundedness, separable. |
| `sensors/inferential/safety.py` | C | additive-optional `screen_cache=` kwarg; per-`(criterion, note text, granite model)` content-addressed screen reuse; degraded never cached. |
| `sensors/inferential/granite_client.py` | C | exposes a `criteria` property so the safety fast-path can rebuild the ordered per-criterion dict from cache without a Granite call. |
| `temporal/models.py` | A | additive-optional `RunInferentialSensorsInput.prior_verdicts` + `InferentialRunOutput.verdict_cache` (`extra="forbid"` preserved). |
| `temporal/activities.py` | A, B, C | seed the cache from `prior_verdicts`; thread the **same** dict to groundedness (`verdict_cache=`), citation_verify (`verdict_cache=`), and safety (`screen_cache=`); echo it on every output path. |
| `temporal/workflows.py` | A | one `verdict_cache` local threaded into both inferential call sites and carried across regen passes (DATA flow only; **no** new command / patch marker). |
| `tests/unit/sensors/test_gating_consolidation.py` | A, B | T1–T5, T7, T9 (WS-1/WS-2 acceptance contract + parity/fail-closed guards). |
| `tests/unit/temporal/test_gating_consolidation_replay.py` | A | T8 — replay byte-identity + additive-optional pin. |
| `tests/unit/sensors/test_safety_scoping.py` | C | S1/S2 (contract guards) + S3 (scoping) — all GREEN. |
| `docs/implementation/TASK-359-.../README.md` | A, B + this finishing pass | this doc (plan + §4.7/§4.8/§4.9 as-built + the §5 consolidated summary). |
| `docs/implementation/TASK-363-.../README.md` | C | the WS-3 ticket. |

**Consolidated verification evidence (`arcaenv`, 2026-06-16):**
- **Full harness unit suite** (`pytest apps/harness/src/harness/tests/unit/`): **634 passed, 0 failed** (2 pre-existing SWIG `DeprecationWarning`s only). The `sensors/` + `temporal/` subset is 274 passed.
- **AC-1 (integrated, shared cache):** cold pass = **3** judge calls (groundedness 2 + citation_verify 1) + **1** Granite screen; an **unchanged warm pass reuses ALL THREE sensors → 0 judge calls + 0 screens**; a single-changed-claim regen re-judges only the changed claim (groundedness **1**, citation_verify **0** — cited claim unchanged).
- **AC-2 parity:** cached == fresh **byte-identical `SensorResult`** for all three sensors (groundedness, citation_verify, safety).
- **Replay (AC-4):** the **5 frozen histories replay byte-identical** (11 replays GREEN across `test_gating_consolidation_replay.py` + `test_replay_compat.py`); `rg "task-359"/"task-363"` in `temporal/` shows **only data-flow comments — NO `workflow.patched("task-359/363")` and NO new workflow command**.
- **ruff:** clean (`ruff check apps/harness/src/`).
- **mypy (non-blocking):** the new `verdict_cache.py` + the four sensors + `temporal/models.py` typecheck clean; `temporal/workflows.py` reports **4 pre-existing errors** (untyped TASK-355 helpers `_deliver_early`/`_regen_compute`, a pre-existing `inferential_results` redef, a pre-existing `verdict` union-attr) — none introduced by TASK-359/363 (the WS-1 diff adds only an annotated `verdict_cache` local + `prior_verdicts=` kwargs + typed assignments).

**Remaining follow-up (out of scope here):** **L3 — cross-run/persistent verdict cache** (§4.5) is **designed but default-OFF / unimplemented**, gated on Redis wiring + a privacy review. It reuses the same content key (hash→bool only, no recoverable PHI; HMAC-ready) and does **not** gate WS-1/2/3; L1 (intra-pass) + L2 (workflow-run, threaded) ship now.

---

## 6. Risks & invariants

- **#1 risk — silent loosening:** any structural change risks shifting a verdict (TASK-355 proved
claim *batching* loosens borderline verdicts and kept it OFF). Mitigate with the **verdict-parity
gate** (AC-2) and conservative cache-miss behaviour.
- **Claim-identity correctness:** positional claim ids are unstable across regen (`provenance.py:309`);
the cache must key on **content** (post-TASK-358-cleanup normalized text + premise + judge identity,
§2.6), or a regenerated section could wrongly reuse a stale verdict (false hit) or needlessly re-judge
(false miss).
- **Replay safety:** LOCKED design threads the cache through **additive-optional activity I/O**
(`prior_verdicts`/`verdict_cache`), which adds no new workflow command → **no `workflow.patched()`** and
the 5 existing replay fixtures stay byte-identical (T8). The escalation path (only if a workflow-body
change ever proves necessary) is the usual `workflow.patched()` + a newly captured fixture (TASK-355 §7.4).
- **Broader (L3) cross-run cache (§4.5):** a persistent store of clinical-judgement results is a PHI /
staleness surface. Mitigation = store only an **irreversible hash → boolean** (no raw text), model+prompt
in the key (auto-invalidate), TTL, **default-OFF** pending privacy review. Never weakens parity (a miss
re-judges).
- **Cross-layer fail-open vs fail-closed:** the harness gate fails **closed**; SMR/guardrail-service
layers fail **open** (Appendix 04 §1). De-duplication must never let a fail-open layer stand in for
the removed fail-closed harness check (AC-5).
- **All TASK-355 §7 invariants** are preserved end-to-end (README §7: never auto-PASS; safety FLAG
never regenerated away; conservative directions; replay-safe; WORM truthfulness).

---

## 7. Change History


| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Files                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-06-14 | Planning ticket created (no code). Spawned from TASK-355 §8 observation #3 + Appendix 04 §4 (materiality-rated redundancies); grounded in live code (`sensors/aggregator.py` `sections_to_regen`, `temporal/workflows.py` regen loop, `sensors/inferential/{groundedness,citation_verify,granite_client}.py`, cross-stack `apps/smr` guardrail layers); prioritized claim-level caching (HIGH) + de-duplication workstreams with a mandatory verdict-parity gate; TASK-356 intersection (admin harm-criteria/judge config) scoped to avoid overlap; TASK-355 §7 invariants pinned. Status = Pending, awaiting plan approval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `docs/implementation/TASK-359-Harness-Gating-Redundancy-Consolidation/README.md`                                                                                                                                                                 |
| 2026-06-16 | **Phase-2/3 refresh + RED TDD tests (still Pending; no implementation).** Re-grounded §2 line refs against the current tree and **corrected the baseline**: TASK-358 is **committed** at HEAD (`8914209c`), not uncommitted, and did **not** touch `aggregator.py`/inferential/temporal — added §2.6 documenting TASK-358 as-built deltas (subword/NER cleanup ⇒ WS-1 must hash post-cleanup normalized text; `citation_verify_threshold` added; claim-id still positional `claim-{n}` at `:309`). Tightened §4.1 per-workstream (WS-1 default = **activity-local additive-optional** cache via `RunInferentialSensorsInput`, no patch marker; WS-2 explicitly **not** a merged prompt — separable parity verdicts; WS-3/WS-4 = GREEN guards), mapped §4.2 1:1 to the tests actually written (RED/GREEN labelled), added §4.4 open decisions for approval. Wrote tests only: `tests/unit/sensors/test_gating_consolidation.py` (T1–T7, T9) + `tests/unit/temporal/test_gating_consolidation_replay.py` (T8) → **13 GREEN, 4 RED** (T2–T5 RED for the right reason: cache/consolidation APIs absent). `ruff` clean. | `docs/implementation/TASK-359-Harness-Gating-Redundancy-Consolidation/README.md`, `apps/harness/src/harness/tests/unit/sensors/test_gating_consolidation.py`, `apps/harness/src/harness/tests/unit/temporal/test_gating_consolidation_replay.py` |
| 2026-06-16 (rev 2) | **Decision-locked Phase-2/3 plan (still Pending; no implementation).** Red-team re-verify of live surfaces (`groundedness`/`citation_verify` `_premise`, `aggregator` `sections_to_regen` `:84/:135`, `activities.run_inferential_sensors` `:493` + `SensorContext` `:540`, `RunInferentialSensorsInput`/`InferentialRunOutput` additive-optional, `JudgeClient.model`). **Locked 5 decisions:** WS-1 = **workflow-threaded** data-only cache (no patch; key = exact-judge-input hash + model, **no** lossy `normalize_text`); WS-2 = **reject merge**, extend cache to `citation_verify` (separable); WS-3 = **split out to TASK-363**; WS-4 = self-contained (TASK-356 **COMPLETED**, no dependency); cache lifetime = tiered **L1/L2 now + L3 broader default-OFF, hash→bool-only** (§4.5). Rewrote §3, §4.1/§4.2/§4.4; added §4.5 broader-cache design + §4.6 parallel-agent decomposition & go/no-go. Tests: reframed T5 (citation_verify cache, no merge), strengthened T3 (hex digest + model invalidation), **moved T6 → TASK-363**. Combined run **13 GREEN, 5 RED**; `ruff` clean. | `docs/implementation/TASK-359-Harness-Gating-Redundancy-Consolidation/README.md`, `docs/implementation/TASK-363-Harness-Safety-Screening-Scoping/README.md`, `apps/harness/src/harness/tests/unit/sensors/test_gating_consolidation.py`, `apps/harness/src/harness/tests/unit/sensors/test_safety_scoping.py` |
| 2026-06-16 (rev 5) | **WS-4 governance note + final consolidated verification + doc wrap-up (docs-only; no code changes).** Finalized **WS-4** as a self-contained cross-stack governance note (§4.9): the four gating layers + fail directions, **L1 SMR pre-gen gate stays OFF** for harness-originated generates (no triple-stacking), **AC-5** — the fail-CLOSED L4 harness gate is never replaced by a fail-OPEN layer (T9 GREEN) — and the cache key embeds judge/safety **model identity** via `sensor_identity`, so any model/criteria swap (incl. via the COMPLETED TASK-356 admin surface) **auto-invalidates** the cache; **nothing pending/deferred to TASK-356**. Added the consolidated **§5 Implementation Summary** (WS-1+WS-2 in 359; WS-3 → TASK-363 COMPLETED; WS-4 here) with the full cross-agent files-changed list and the **L3 default-OFF follow-up** (designed, gated on Redis + privacy review). **Verification:** full harness unit suite **634 passed / 0 failed**; integrated **AC-1** (unchanged warm pass reuses all three sensors → 0 judge + 0 Granite; single-claim regen = groundedness 1 / citation_verify 0); **AC-2** cached==fresh byte-identical for all three sensors; **5 replay fixtures byte-identical** (11 replays) with **no `workflow.patched("task-359/363")`** and no new workflow command; `ruff` clean; mypy = 4 **pre-existing** `workflows.py` findings (not introduced here). Renumbered Risks→§6, Change History→§7; **Status → Review** (awaiting user sign-off). | `docs/implementation/TASK-359-Harness-Gating-Redundancy-Consolidation/README.md` |
| 2026-06-16 (rev 6) | **User sign-off — TASK-359 Completed (docs-only; no code change).** User signed off on the four locked decisions and the delivered implementation: WS-1 (verdict-cache core, §4.7) + WS-2 (`citation_verify` reuse, §4.8) in TASK-359; WS-3 → **TASK-363 Completed**; WS-4 governance note (§4.9). Verification stands at full harness unit **634 passed / 0 failed**, AC-1/AC-2/replay/ruff green. The default-OFF **L3** cross-run cache (§4.5) is the only tracked follow-up. **Status Review → Completed.** Changes remain uncommitted pending an explicit commit request. | `docs/implementation/TASK-359-Harness-Gating-Redundancy-Consolidation/README.md` |
| 2026-06-16 (rev 4) | **WS-2 GREEN implementation (citation_verify cache reuse — Agent B only).** Extended the WS-1 content-addressed cache to `citation_verify` by **reusing the exact WS-1 primitive** (`claim_verdict_key`/`sensor_identity`/`cached_verdict` + the shared `verdict_cache` dict) — **NO merged prompt** (parity-unsafe: the transcript would leak into the citation premise), **no new carrier**, **no workflow change**. `CitationVerifySensor.arun(..., verdict_cache=None)` keys each cited claim on its OWN premise (cited chunk(s)) + its own sensor/prompt identity, so a dually-checked claim gets a citation_verify entry **distinct** from its groundedness entry → the two verdicts stay **separable** (groundedness vs citation_verify unchanged in aggregation); `temporal/activities.py` passes the same `verdict_cache` dict at the citation_verify launch site. **Evidence:** T5 GREEN; T1/T2/T3/T4/T7/T8/T9/S1/S2 GREEN; S3 still RED (Agent C); full `sensors/`+`temporal/` suite **272 passed, 1 failed (intended RED)**; distinct keys (`159dafae…` ≠ `f3e3b994…`); shared cache 2 cold calls → 0 warm; separability `(True, False)` cached==uncached; **AC-2** citation_verify cached==fresh; 5 replay fixtures byte-identical (11 replays); `models.py`/`workflows.py` untouched, no `workflow.patched()`; ruff clean. Updated header→In Progress (WS-1+WS-2), §4.1 WS-2, §4.2 table, added §4.8 as-built. **Agent C (TASK-363/S3) untouched & unblocked.** | `apps/harness/src/harness/sensors/inferential/citation_verify.py`, `apps/harness/src/harness/temporal/activities.py`, `docs/implementation/TASK-359-Harness-Gating-Redundancy-Consolidation/README.md` |
| 2026-06-16 (rev 3) | **WS-1 GREEN implementation (cache core — Agent A only).** Implemented the workflow-threaded, data-only, content-addressed per-claim verdict cache with cross-pass reuse (additive-optional fields; **no new workflow command, no `workflow.patched()`**). New `sensors/inferential/verdict_cache.py` exposes the stable API B/C import: `claim_verdict_key(claim_text, premise, judge_identity)` (SHA-256/optional HMAC over the exact judge input; **no** lossy `normalize_text`), `sensor_identity(sensor_name, system_prompt, model)`, `cached_verdict(cache, *, key, compute)` (conservative miss), `VerdictCache = dict[str, bool]`. `groundedness.arun(..., verdict_cache=)` does hit-reuse/miss-rejudge+populate (batched path untouched); `temporal/models.py` gained additive-optional `prior_verdicts`/`verdict_cache`; `activities.py` seeds + echoes the map on all paths; `workflows.py` threads it across both inferential call sites and all regen passes. **Evidence:** T2/T3/T4 GREEN; T1/T7/T8/T9/S1/S2 GREEN; T5+S3 still RED (Agents B/C); full `sensors/`+`temporal/` suite **271 passed, 2 failed (intended RED)**; 5 replay fixtures byte-identical (11 replays); **AC-1 3→1 judge calls on a 1-section regen**; **AC-2 cached==fresh `SensorResult` byte-identical**; ruff clean. Updated header→In Progress, §4.1 WS-1, §4.2 table, added §4.7 as-built. **B and C unblocked.** | `apps/harness/src/harness/sensors/inferential/verdict_cache.py` (new), `apps/harness/src/harness/sensors/inferential/groundedness.py`, `apps/harness/src/harness/temporal/models.py`, `apps/harness/src/harness/temporal/activities.py`, `apps/harness/src/harness/temporal/workflows.py`, `docs/implementation/TASK-359-Harness-Gating-Redundancy-Consolidation/README.md` |


