# TASK-363 — Scope Harness Safety Screening Across Regen Passes

| | |
|---|---|
| **Ticket** | TASK-363 *(confirmed by user 2026-06-16)* |
| **Title** | Stop re-screening unchanged note content per harm criterion on every inferential pass |
| **Created** | 2026-06-16 |
| **Updated** | 2026-06-16 |
| **Status** | **Completed** — user sign-off 2026-06-16; WS-3 implemented; S3 GREEN, full harness `sensors/` + `temporal/` suite green, ruff clean |
| **Type** | refactor / efficiency |
| **Affected areas** | `apps/harness` safety sensor (`sensors/inferential/safety.py`, `sensors/inferential/granite_client.py`), the inferential activity call site (`temporal/activities.py`) |
| **Split from** | [TASK-359 §4.1 WS-3](../TASK-359-Harness-Gating-Redundancy-Consolidation/README.md) — carved out so it can be implemented by a parallel agent. TASK-359 retains WS-1/WS-2/WS-4. |
| **Related** | TASK-359 (claim-level verdict cache — same content-addressed-cache pattern, applied to the safety screen); TASK-355 §7 (safety invariants); TASK-358 (note/claim normalization) |

> Implemented 2026-06-16 — see **§7 Implementation Summary**. The content-addressed safety-screen cache reuses the TASK-359 WS-1 verdict-cache primitive (key helpers + the shared carrier dict) with **no** new Temporal carrier field, **no** new workflow command, and **no** `workflow.patched()` marker.

---

## 1. Requirement Analysis

### 1.1 Description

This is **WS-3 of TASK-359 ([App-04 §4](../TASK-355-Harness-Latency-Optimization/04-gating-inventory.md) Finding #4)**, split into its own ticket. The Granite Guardian safety screen fans **one model call per harm criterion** over the **whole note**, and it does so **on every inferential pass** — so a regen that fixes a single SOAP section re-screens the entire note for **all** criteria again. With 7 default criteria and up to 3 passes that is up to `3 × 7 = 21` whole-note safety calls.

The goal: **don't re-screen note content that did not change** since the last pass, while preserving the safety contract **byte-for-byte** (the ordered per-criterion result dict + the fail-closed degrade + "unsafe is never auto-regenerated").

### 1.2 Business context

- Safety is part of the inferential pass that dominates draft latency (TASK-355). Each criterion is an independent whole-note model call; re-screening unchanged content every regen is pure waste.
- Like the rest of TASK-359, this is **efficiency with identical verdicts**: a change that flips a safety verdict is rejected (TASK-355 batching lesson).

### 1.3 Acceptance criteria

- **AC-1 (reduction)** — On a regen fixture, the number of Granite criterion-calls is measurably reduced (unchanged note content is not re-screened for a criterion already screened in a prior pass).
- **AC-2 (identical verdicts)** — The per-criterion `{dimension: is_unsafe}` map and the resulting `SensorResult` (score, `passed`, `flagged_dimensions`, `claims_flagged`) are **byte-identical** to today's unscoped screen for the same content.
- **AC-3 (contract preserved)** — The result dict shape + **ordering** (criteria order, `dict(zip(criteria, verdicts, strict=True))`) and the **fail-closed degrade** (`degraded_result` on `GraniteServiceError`, never auto-PASS) are unchanged.
- **AC-4 (safety invariants)** — Unsafe ⇒ FLAG and **never** auto-regenerated; degraded ⇒ FLAG (TASK-355 §7).
- **AC-5 (conservative miss)** — A cache miss / any ambiguity **re-screens** (never assumes safe).

---

## 2. Current State Evaluation (grounded in live code)

- `sensors/inferential/safety.py` — `SafetySensor.arun(ctx, *, judge)` (`:35`) screens `ctx.note_blob()` (the **whole** note, `base.py:98`) via `self._client.screen(...)` (`:37`). The `judge` arg is accepted for a uniform call site but **unused** (safety screens via Granite, not the judge).
- Output (`:44-55`): `SensorResult` with `score = (total − len(flagged)) / total`, `passed = not flagged`, `claims_flagged = flagged`, and `details = {unsafe, flagged_dimensions, dimensions, model}`. `dimensions` is the **ordered per-criterion** dict.
- `sensors/inferential/granite_client.py` — `screen(text)` (`:102`) fans `asyncio.gather` (`:115-116`) **one `_classify` call per criterion** (`:120`) over `self._criteria` (`:97`), each posting the full `text`; returns `dict(zip(self._criteria, verdicts, strict=True))` (`:118`).
- Criteria come from `SafetyGuardConfig.harm_criteria` (`core/config.py:73`; 7 defaults) — **owned by TASK-356** (admin-configurable selection). This ticket changes only **how often** a criterion is screened, never the criteria set.
- Call site: `temporal/activities.py:584-585` constructs `SafetySensor(_granite_client(settings)).arun(ctx, judge=judge)` inside `run_inferential_sensors`, every pass.

**Why content-addressed (not section-diff):** the safety screen runs on `note_blob()` (the whole note), not per section. The robust, parity-safe scoping is a **content-addressed per-(criterion, screened-text) cache** — identical to TASK-359 WS-1's verdict cache, but keyed on `(criterion, normalized screened text, granite model identity)`. When the note text a criterion would screen is unchanged across passes, it is a cache **hit** (no call); when it changes, it is a **miss** (re-screen). This guarantees AC-2 (same text + same model ⇒ same Granite call ⇒ same verdict).

> **Note on TASK-358:** the note text is already normalized upstream (TASK-358 `normalize_text` / `_clean_claim_text`), so cosmetic tokenizer noise will not cause false cache misses. The cache key hashes the **exact text the Granite client receives**, plus the criterion and `client.model`.

---

## 3. Implementation Plan (proposed — await approval)

> TDD Red-Green-Refactor; harness Python/pytest under the `arcaenv` conda env. **Verdict-parity gate is mandatory.**

### 3.1 Design (content-addressed safety-screen cache)

- Add an **optional** `screen_cache: dict[str, bool] | None = None` to `SafetySensor.arun(...)` (and a thin pass-through on the granite client) — a `{key: is_unsafe}` map mutated in place, so the activity/workflow can thread it across passes exactly like TASK-359 WS-1's `verdict_cache`.
- **Key** = `safety_screen_key(criterion, screened_text, model_identity)` → a SHA-256 of the **exact** text the Granite client receives + the criterion name + `client.model` (+ a `KEY_SCHEMA_VERSION`/prompt-hash so a model or prompt change auto-invalidates). Reuse / mirror TASK-359's `verdict_cache` key helper.
- **Threading**: prefer the same **workflow-threaded, data-only, additive-optional** carrier TASK-359 WS-1 uses (`RunInferentialSensorsInput` / `InferentialRunOutput`) so it stays replay-safe with **no** `workflow.patched()` marker (TASK-355 Slice-5d precedent). Coordinate the carrier shape with the TASK-359 WS-1 agent (shared surface — see §5).
- **Conservative miss / degrade**: a miss re-screens; a `GraniteServiceError` still returns `degraded_result` (fail-closed). Caching never converts a degrade into a pass.
- **No change** to criteria selection (TASK-356), to the result dict shape/order, or to the aggregator.

### 3.2 TDD test list (write first)

Tests live in `apps/harness/src/harness/tests/unit/sensors/test_safety_scoping.py` (created by this ticket; the GREEN guards were moved here from TASK-359's `test_gating_consolidation.py`).

| # | Test (class) | Asserts | Status (scaffold) |
|---|---|---|---|
| S1 | `TestSafetyContractPreserved::test_per_criterion_dict_shape_and_order_preserved` | ordered `{dimension: is_unsafe}` dict + score/flagged (AC-2/AC-3) | **GREEN** guard |
| S2 | `TestSafetyContractPreserved::test_backend_error_degrades_fail_closed` | `GraniteServiceError` ⇒ degraded, fail-closed (AC-3/AC-4) | **GREEN** guard |
| S3 | `TestSafetyScreenScopingReusesCache::test_unchanged_note_content_not_rescreened` | `SafetySensor.arun(..., screen_cache=)` reuses prior-pass verdicts for unchanged content; changed content re-screens; miss is conservative (AC-1/AC-2/AC-5) | **GREEN** (implemented) |
| S4 | `TestSafetyScreenScopingReusesCache::test_degraded_screen_is_never_cached_as_safe` | a degraded screen with a cache provided degrades fail-closed AND writes nothing to the cache; the same content re-screens next pass (AC-4/AC-5) | **GREEN** (added by this ticket) |

### 3.3 Verification criteria

- Before/after Granite criterion-call counts on a regen fixture (AC-1); per-criterion parity on a fixture set (AC-2); existing harness suites + replay fixtures green; `ruff`/mypy clean.

---

## 4. Risks & invariants

- **Verdict-parity (AC-2)** is the #1 rail (TASK-355 batching lesson). The content-addressed key guarantees same-text+same-model ⇒ same call ⇒ same verdict.
- **Fail-closed**: a degrade must never become a pass; a miss must re-screen (AC-5).
- **Replay safety**: prefer the activity-local/workflow-threaded data-only carrier (no patch marker); if the workflow body changes, ship `workflow.patched(...)` + a new fixture and keep the existing 5 green.
- **Shared surface with TASK-359 WS-1** — see §5; coordinate the carrier fields/key helper to avoid a collision.

---

## 5. Coordination with TASK-359 (parallel implementation)

This ticket and TASK-359 WS-1 share the **content-addressed-cache pattern** and (if workflow-threaded) the **same activity I/O carrier**. To let both proceed in parallel without collision:

- **TASK-359 WS-1 owns** the cache key helper module (`sensors/inferential/verdict_cache.py`) and the `RunInferentialSensorsInput` / `InferentialRunOutput` additive fields. It lands **first** and exposes `claim_verdict_key(...)` + the carrier fields.
- **TASK-363 (this ticket) reuses** that helper (`safety_screen_key` can wrap it or live beside it) and adds a `safety_screen_cache`-shaped field to the same carrier. It owns `safety.py` / `granite_client.py` and `test_safety_scoping.py` only.
- **Go/no-go:** start S1/S2 (GREEN guards) immediately (independent). Gate S3 (the `screen_cache` threading) on TASK-359 WS-1's key-helper + carrier landing, to avoid two divergent cache primitives.

---

## 6. Implementation Summary

**What was built.** A content-addressed, per-criterion safety-screen cache that reuses the
TASK-359 WS-1 verdict-cache primitive, so unchanged note content is not re-screened for every
harm criterion on every inferential pass. The per-criterion result dict (order + values) and the
fail-closed degrade are preserved **byte-for-byte**.

### 6.1 Design

- `SafetySensor.arun(...)` gained an **additive-optional** `screen_cache: VerdictCache | None = None`.
  When `None` (the legacy / S1-S2 path) the sensor issues exactly today's single `screen()` call.
- A private `SafetySensor._screen(text, cache)` does the scoping:
  - The screen key is `claim_verdict_key(claim_text=<screened text>, premise=<criterion>, judge_identity=sensor_identity("safety", _SCREEN_PROMPT, client.model))`.
    It includes **criterion + screened text + model** (plus the `"safety"` sensor name + a prompt
    version + `KEY_SCHEMA_VERSION` baked into the WS-1 helpers), so a model swap / prompt change /
    criterion change / text change is a **MISS** and the `"safety"` namespace means a safety key can
    **never collide** with a groundedness/citation key on the shared dict.
  - **Full HIT** (every criterion for this exact text+model already cached) → the ordered
    `{dimension: is_unsafe}` dict is rebuilt from the cache and Granite is **not** called.
  - **MISS** (any criterion absent) → `screen()` runs once and every verdict is populated.
  - **All-or-nothing** is correct here because the real `screen()` is atomic over all criteria
    (one `asyncio.gather`, raise-on-any-failure) — a per-criterion `cached_verdict` get-or-compute
    would fan out N redundant whole-note screens on a miss, so it is deliberately **not** used.
  - The scoping activates only when the client can enumerate its criteria (a new read-only
    `GraniteGuardianClient.criteria`); a client that cannot (a minimal duck-typed double) is
    screened directly — i.e. the exact pre-cache behaviour.
- A `GraniteServiceError` propagates to `arun` → `degraded_result` (fail-closed) and is **never**
  cached — a degraded/unverifiable screen is never recorded as safe.
- `temporal/activities.py` threads the **same** local `verdict_cache` dict WS-1 already seeds from
  `prior_verdicts`: `SafetySensor(...).arun(ctx, judge=judge, screen_cache=verdict_cache)`. No new
  carrier field, no new workflow command, no `workflow.patched()`.

### 6.2 Files changed

| File | Change |
|---|---|
| `apps/harness/src/harness/sensors/inferential/safety.py` | Added `screen_cache` kwarg + `_screen` per-criterion content-addressed cache (HIT-reconstruct / MISS-rescreen-and-populate); imports the WS-1 key helpers; degrade never cached. |
| `apps/harness/src/harness/sensors/inferential/granite_client.py` | Added read-only `GraniteGuardianClient.criteria` property (screen-order) so the sensor can detect a full cache HIT without issuing the screen. `screen()` unchanged. |
| `apps/harness/src/harness/temporal/activities.py` | At the safety launch site, passed `screen_cache=verdict_cache` (the existing shared dict). No carrier/workflow change. |
| `apps/harness/src/harness/tests/unit/sensors/test_safety_scoping.py` | Added `criteria` to `_StubGranite` (mirrors the real client surface); added **S4** (`test_degraded_screen_is_never_cached_as_safe`). S1/S2/S3 unchanged. |

### 6.3 Verification evidence (`conda run -n arcaenv`, ruff clean)

- **Full suite green** — `pytest src/harness/tests/unit/sensors src/harness/tests/unit/temporal` → **273 passed, 0 failed** (was 272 passed + S3 RED). S1/S2/S3/S4 green; T1–T9 (incl. `test_gating_consolidation*`) green; all pre-existing green.
- **AC-1 call-count reduction** (real `GraniteGuardianClient` + `httpx.MockTransport`, 7 criteria): cold pass = **7** Granite criterion-calls; unchanged-content pass = **0** calls.
- **AC-2 / AC-3 parity** — the cached `{dimension: is_unsafe}` dict, its **key order**, and the resulting `(score, passed, flagged_dimensions)` are **byte-identical** to a fresh, uncached screen of the same content.
- **Fail-closed not cached** — a `503` screen → `degraded=True, passed=False, score=0.0` and the cache is left **empty (`{}`)**; the same content re-screens on the next pass.
- **Replay (T8)** — the **5** frozen histories (`doc_workflow_pre_task345` / `task345` / `post_task348` / `post_task355` / `post_task355_regen`) replay **byte-identical** on the current `HarnessDocWorkflow`; `RunInferentialSensorsInput` still requires only `note_text` (no new required field). No `workflow.patched()` added.

---

## 7. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-16 | Ticket created by splitting **WS-3** out of TASK-359 (per user decision #3) so it can be implemented by a parallel agent. Scoped to content-addressed safety-screen caching with byte-identical per-criterion verdicts + fail-closed degrade; grounded in live code (`safety.py`, `granite_client.py`, `activities.py`); TDD list S1–S3 (S1/S2 GREEN guards moved from TASK-359's test file, S3 RED). Number **TASK-363 auto-assigned — confirm/rename.** Status = Pending. | `docs/implementation/TASK-363-Harness-Safety-Screening-Scoping/README.md`, `apps/harness/src/harness/tests/unit/sensors/test_safety_scoping.py` |
| 2026-06-16 | **WS-3 implemented (S3 GREEN).** Added `SafetySensor.arun(..., screen_cache=)` + `_screen` content-addressed per-(criterion, screened-text, model) cache reusing the WS-1 `claim_verdict_key`/`sensor_identity` helpers + the shared `verdict_cache` carrier dict; added read-only `GraniteGuardianClient.criteria`; threaded `screen_cache=verdict_cache` at the inferential activity safety launch site. Added S4 (degrade-never-cached). Full `sensors/`+`temporal/` suite **273 passed**; AC-1 reduction 7→0 criterion-calls on an unchanged pass; AC-2/AC-3 cached==fresh byte-identical; fail-closed degrade never cached; 5 replay fixtures byte-identical (no new carrier field / workflow command / patch marker); ruff clean. Status = **Completed**. | `apps/harness/src/harness/sensors/inferential/safety.py`, `apps/harness/src/harness/sensors/inferential/granite_client.py`, `apps/harness/src/harness/temporal/activities.py`, `apps/harness/src/harness/tests/unit/sensors/test_safety_scoping.py`, `docs/implementation/TASK-363-Harness-Safety-Screening-Scoping/README.md` |
| 2026-06-16 | **User sign-off (docs-only).** User confirmed the **TASK-363** ticket number and signed off on the WS-3 safety-screen scoping implementation (split from TASK-359 §4.1 per decision #3). No code change; changes remain uncommitted pending an explicit commit request. | `docs/implementation/TASK-363-Harness-Safety-Screening-Scoping/README.md` |
