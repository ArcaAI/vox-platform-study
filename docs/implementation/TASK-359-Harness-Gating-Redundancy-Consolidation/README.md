# TASK-359 — Consolidate Cross-Stack Gating Redundancies + Claim-Level Caching

| | |
|---|---|
| **Ticket** | TASK-359 |
| **Title** | De-duplicate the gating layers and add claim-level caching across regen passes |
| **Created** | 2026-06-14 |
| **Updated** | 2026-06-14 |
| **Status** | **Pending** — planning doc; awaiting plan approval (Phase-3 gate) before any code |
| **Type** | refactor / efficiency |
| **Affected areas** | `apps/harness` inferential sensors + regen loop (`sensors/inferential/*`, `sensors/aggregator.py`, `temporal/workflows.py`, `temporal/activities.py`), cross-stack guardrail layers (`apps/smr` pre-gen gate + Bedrock native guardrail) |
| **Spawned from** | TASK-355 §8 observation #3 + [TASK-355 Appendix 04 §4](../TASK-355-Harness-Latency-Optimization/04-gating-inventory.md) (redundancy findings + materiality ratings) |
| **Related** | TASK-356 (admin-managed guardrail/harm-criteria/judge config — see §3); TASK-355 §7 (safety invariants this ticket must preserve) |

> Planning document. **No code is changed by this ticket yet.** It documents the redundancies,
> grounds them in the live code, and proposes a TDD implementation plan for approval. Status stays
> **Pending** until the plan is approved.

---

## 1. Requirement Analysis

### 1.1 Description

[TASK-355 Appendix 04 §4](../TASK-355-Harness-Latency-Optimization/04-gating-inventory.md) inventoried
the cross-stack gating layers and found **redundant / double-gating** work, with materiality ratings:

| # (App-04 §4) | Finding | Materiality |
|---|---|---|
| 2 | **Full inferential re-run on every regen — no claim-level caching** (`sections_to_regen` computed but never used to scope re-verification) | **High** (when regens fire) |
| 3 | **Groundedness + citation_verify double-judge the same claim** (same hypothesis, different premise) | Medium (once RAG corpus is live) |
| 4 | **Safety re-screens the full note per criterion, every pass** (7 calls × whole note) | Medium |
| 1 | Two Granite deployments, overlapping intent (SMR pre-gen "is it medical?" vs harness safety harm-taxonomy) | Low (Layer 1 off by default) |
| 5 | Triple-stacking possible (Bedrock native + SMR gate + harness safety) | Low (config-dependent) |

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
  `:130-135` (populated from failing regen-fixable sensors' `details["sections"]`) — and surfaced in
  `eval/draft_eval.py:78,116`.
- **It is never consumed to scope re-verification.** A repo search shows `sections_to_regen` appears
  only in `aggregator.py`, `eval/draft_eval.py`, and tests — **not** in `temporal/workflows.py` or
  `temporal/activities.py`.
- The regen loop re-does **everything**: `temporal/workflows.py:547` `_regen_compute()`
  (assemble → generate → extract → `run_sensors`, full note), then the assurance loop re-runs
  `run_inferential_sensors` (`workflows.py:650`; legacy in-loop pass at `:466`, folded at `:495`,
  REGEN-continue at `:501-503`). `run_inferential_sensors` (`activities.py:442`) re-judges **all**
  claims every pass — there is no per-claim verdict cache keyed on claim identity.

### 2.2 Finding #3 (Medium) — groundedness + citation_verify double-judge the same claim

Both sensors iterate `ctx.claims()` and entail the **same hypothesis** against a **different premise**:

- `sensors/inferential/groundedness.py:91-104` — premise = transcript ∪ that claim's evidence quotes.
- `sensors/inferential/citation_verify.py:50-60` — premise = the claim's **cited knowledge chunk(s)**
  only; runs on claims carrying `knowledgeChunkIds` (`:43-47`, `:82`).
- Both are launched in the same pass: `activities.py:494-495` (`groundedness.arun` + `citation_verify.arun`).
  For a **cited** claim that is therefore judged twice (2 calls/claim) — Appendix 04 §4 row 3 /
  §5 "Merge groundedness+citation premises for dually-checked claims".

### 2.3 Finding #4 (Medium) — safety re-screens the full note per criterion

- `sensors/inferential/granite_client.py:102` `screen()` fans **one call per harm criterion**
  (`:115` `asyncio.gather` over `self._criteria`), each posting the **full note**
  (`_classify` `:120-126`). Criteria come from `SafetyGuardConfig.harm_criteria` (`core/config.py:38`).
  Every inferential pass re-screens the whole note for all criteria, even when one section changed
  (Appendix 04 §4 row 4).

### 2.4 Findings #1 / #5 (Low) — cross-stack Granite stacking

- **Layer 1 (SMR pre-gen gate, OFF by default):** `apps/smr/src/smr_v2/services/external_guardrail.py:54`
  (POST `/api/medical/validate`); `SMR_V2_EXTERNAL_GUARDRAIL_ENABLED=false` (`apps/smr/.env.example:39`);
  `require_medical` (`apps/smr/src/smr_v2/core/config.py:84`).
- **Layer 5 (Bedrock native guardrail):** `apps/smr/src/smr_v2/providers/bedrock.py:76` injects
  `guardrailConfig` when `SMR_V2_BEDROCK_GUARDRAIL_ID` is set (`apps/smr/.env.example:211`).
- **Layer 4 (harness safety):** the harness Granite screen above. With all enabled, one consultation
  can be screened by three mechanisms (Appendix 04 §4 rows 1 & 5). Low materiality today (Layer 1 off
  in dev/default; Layer 5 only with a guardrail id).

### 2.5 Dependencies & impact areas

- **Workflow-sequence sensitivity:** scoping regen / changing the call structure touches
  `temporal/workflows.py` — **must** ship with a `workflow.patched()` marker + a captured replay
  fixture (TASK-348/354/355 discipline; TASK-355 §7.4). Caching that lives **inside an activity**
  (data-only) avoids a workflow-sequence change (cf. TASK-355 Slice 5d, which added activity *input*
  fields with no new patch marker).
- **Claim identity:** caching needs a stable per-claim hash (claim text + premise inputs). Provenance
  claim ids are positional (`provenance.py:235` `claim-{n}`) → **not** stable across a regen; hashing
  must key on content, not id.
- **Cross-app (Findings #1/#5):** spans `apps/smr` config; mostly a config/governance cohering, not
  code surgery. Low priority within this ticket.
- **No DB/UI change** anticipated for the core de-duplication/caching.

---

## 3. Relationship to TASK-356

[TASK-356 — Admin-Managed Models & Workflows](../TASK-356-Admin-Managed-Models-Workflows/README.md)
keeps **gating / thresholds / safety model** in `HarnessPolicy` as **tenant+global** admin config
(§4.2, §4.6) and manages the **safety model / judge** selection (§2.3, §4.8b registers
granite-guardian). Intersections:

- **Harm-criteria / judge config:** if TASK-356 (or the parked TASK-355 R-10) makes the
  `harm_criteria` set or the judge admin-configurable, that is the **selection/config surface** —
  **TASK-356's** scope. TASK-359 changes only the **execution structure** (don't re-screen the whole
  note per criterion per pass; don't double-judge; cache across regens). No overlap: **TASK-356 =
  what runs and who configures it; TASK-359 = how efficiently it runs, with identical verdicts.**
- **Provider/model selection** that could enable the cross-stack stacking (Findings #1/#5) is also
  TASK-356's surface; TASK-359 only documents the redundancy and cohering policy, deferring the
  admin controls to TASK-356.

**Scope guard:** TASK-359 must **not** weaken a clinical-safety invariant to gain efficiency, and must
**not** build admin config (defer to TASK-356). Cross-reference both ways once numbers are known (this
ticket does not edit TASK-356's doc).

---

## 4. Implementation Plan (proposed — **await approval before coding**, Phase-3 gate)

> TDD Red-Green-Refactor; harness Python/pytest under the `arcaenv` conda env. **A verdict-parity
> gate is mandatory** — every change must produce identical verdicts on the fixture set (the TASK-355
> batching lesson: an efficiency change that shifts a verdict is rejected).

### 4.1 Prioritized workstreams

1. **WS-1 (HIGH) — claim-level caching + regen scoping (Finding #2).**
   - Introduce a content-addressed per-claim verdict cache (key = hash of claim text + premise
     inputs + judge/model identity), populated during `run_inferential_sensors`.
   - On a regen, re-verify only claims in `sections_to_regen` / whose content hash changed; reuse
     cached verdicts for unchanged claims. **Cache miss → re-judge (conservative).**
   - Prefer to keep the cache **inside the activity** (data-only) to avoid a workflow-sequence change;
     if the workflow must thread the cache, ship a `workflow.patched()` marker + replay fixture.
2. **WS-2 (Medium) — merge groundedness + citation premises for dually-checked claims (Finding #3).**
   - For a cited claim, judge once with a combined/clearly-separated premise (or short-circuit one
     sensor when the other already establishes support), **keeping the two verdicts separable** in
     output so the aggregator semantics (`groundedness` vs `citation_verify`) are unchanged.
3. **WS-3 (Medium) — scope safety screening (Finding #4).**
   - Avoid re-screening unchanged sections each pass (e.g. screen changed sections / cache per-criterion
     verdicts across passes), preserving the per-criterion result dict shape and the fail-closed
     degrade behaviour (`granite_client.py` contract unchanged).
4. **WS-4 (Low) — cross-stack cohering (Findings #1/#5).**
   - Document + (config-only) ensure Layer 1 stays off for harness-originated generates and the layers
     are not redundantly stacked; **no removal of the fail-closed harness check** (AC-5). Likely a
     governance/config note rather than code; coordinate with TASK-356.

### 4.2 TDD test list (write first; must see RED)

| # | Test (pytest) | Asserts |
|---|---|---|
| T1 | verdict-parity: cached/consolidated path == current path on a fixture note (byte-identical verdicts) | AC-2 |
| T2 | regen scoping: a regen that changes section P re-judges only P's claims; unchanged claims reuse cached verdicts | AC-1, AC-3 |
| T3 | cache key is content-addressed (changed claim text → cache miss → re-judge) | AC-3 |
| T4 | cache miss / ambiguous → re-judge, never assume grounded (conservative) | AC-3, AC-4 |
| T5 | dually-checked cited claim judged once but still yields separable groundedness + citation_verify verdicts | AC-1, AC-2 |
| T6 | safety scoping preserves the per-criterion result dict + fail-closed degrade on backend error | AC-2, AC-4 |
| T7 | safety FLAG still never auto-regenerated; degraded/missing still FLAG | AC-4 |
| T8 | if workflow sequence changes: flag-OFF / pre-change history replays byte-identical (patch marker + replay fixture) | AC-4 |
| T9 | cross-stack: harness fail-closed check is never replaced by a fail-open SMR/guardrail layer | AC-5 |

### 4.3 Verification criteria

- **Call-count evidence:** before/after LLM call counts on a regen fixture showing the reduction (AC-1).
- **Verdict-parity evidence:** the parity gate green on the fixture set (AC-2).
- New + existing harness unit/temporal suites green; replay fixtures green (or a new fixture captured
  if the workflow sequence changed); `ruff`/mypy clean.

---

## 5. Risks & invariants

- **#1 risk — silent loosening:** any structural change risks shifting a verdict (TASK-355 proved
  claim *batching* loosens borderline verdicts and kept it OFF). Mitigate with the **verdict-parity
  gate** (AC-2) and conservative cache-miss behaviour.
- **Claim-identity correctness:** positional claim ids are unstable across regen (`provenance.py:235`);
  the cache must key on **content**, or a regenerated section could wrongly reuse a stale verdict.
- **Replay safety:** workflow-sequence changes need `workflow.patched()` + replay fixtures
  (TASK-355 §7.4); prefer activity-local caching to avoid this.
- **Cross-layer fail-open vs fail-closed:** the harness gate fails **closed**; SMR/guardrail-service
  layers fail **open** (Appendix 04 §1). De-duplication must never let a fail-open layer stand in for
  the removed fail-closed harness check (AC-5).
- **All TASK-355 §7 invariants** are preserved end-to-end (README §7: never auto-PASS; safety FLAG
  never regenerated away; conservative directions; replay-safe; WORM truthfulness).

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-14 | Planning ticket created (no code). Spawned from TASK-355 §8 observation #3 + Appendix 04 §4 (materiality-rated redundancies); grounded in live code (`sensors/aggregator.py` `sections_to_regen`, `temporal/workflows.py` regen loop, `sensors/inferential/{groundedness,citation_verify,granite_client}.py`, cross-stack `apps/smr` guardrail layers); prioritized claim-level caching (HIGH) + de-duplication workstreams with a mandatory verdict-parity gate; TASK-356 intersection (admin harm-criteria/judge config) scoped to avoid overlap; TASK-355 §7 invariants pinned. Status = Pending, awaiting plan approval. | `docs/implementation/TASK-359-Harness-Gating-Redundancy-Consolidation/README.md` |
