# TASK-355 · Phase B — Sensor Efficiency · File-Level TDD Implementation Plan

| | |
|---|---|
| **Ticket** | TASK-355 |
| **Phase** | B — sensor efficiency (R-3 full, R-4, R-5, R-11) |
| **Created** | 2026-06-13 |
| **Status** | **Implemented (2026-06-14)** — `R-4` (parallel Granite criteria) + per-claim `asyncio.gather` parallelism **SHIPPED + verified** (inferential 276s → 112.6s ≈ 2.45×, draft 311.8s → 159.2s ≈ 1.96×, **byte-identical verdicts**); `R-5` claim-batching **BUILT but DEFAULT-OFF** (`HARNESS_JUDGE_ENTAILMENT_BATCH_SIZE=1` — a live clinical verdict-parity gate proved batch ≥ 2 loosens borderline verdicts). **`R-3` (per-call `max_tokens` cap) and `R-11` (assemble-prompt hoist) were NOT shipped — DROPPED, superseded by the model-residency root cause** (confirmed: no `entailment_max_tokens` symbol and no `task-355-assemble-hoist` patch marker exist in source). See the **DROPPED** notes at the top of the R-3 and R-11 sections below; the original planning content is retained as a historical record. |
| **Service** | `apps/harness` (Python 3.11 / FastAPI + Temporal worker) |
| **Conda env** | `arcaenv` (confirmed: `apps/harness/README.md` lines 53/57/167, `_capture_replay_fixture.py` docstring, rule `06-python-services.mdc`) |
| **Depends on** | Phase A (R-1 suppress-reasoning, R-2 concurrency≥2, R-3-lite + TASK-354 per-call timeout) — see §Ordering |
| **Catalog ref** | README §5 (R-3/R-4/R-5/R-11), §6 Phase B, §7 invariants; Appendix 02 §3, Appendix 05 |

> **Scope discipline.** This document is the plan only. The catalog items in scope are **R-3 (full), R-4, R-5, R-11**. R-1/R-2 (Phase A, config) and R-6+ (Phase C/D) are out of scope here and only referenced as ordering dependencies.

---

## 0. Source-of-truth anchors (verified against the working tree, 2026-06-13)

The dossier line numbers held; the live shapes confirmed:

- Judge config (shared by eval **and** sensors):

```70:99:apps/harness/src/harness/eval/config.py
class JudgeConfig(BaseSettings):
    """Root, model-agnostic judge configuration."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_JUDGE_")
    ...
    max_tokens: int = 8192
    ...
```

- The judge protocol every backend implements (no `max_tokens` knob today):

```35:51:apps/harness/src/harness/eval/judge/base.py
    async def complete(
        self,
        messages: Messages,
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
```

- The three concrete backends each hardcode the per-call budget from config:

```138:143:apps/harness/src/harness/eval/judge/providers.py
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self._config.temperature if temperature is None else temperature,
            "max_tokens": self._config.max_tokens,
        }
```

(same at `providers.py:204` Azure, `providers.py:275` Bedrock `maxTokens`.)

- Groundedness per-claim serial loop + conservative unparseable handling:

```142:161:apps/harness/src/harness/sensors/inferential/groundedness.py
            for claim in claims:
                ref = _claim_ref(claim)
                hypothesis = str(claim.get("text") or "").strip()
                if not hypothesis:
                    grounded.append(ref)
                    continue
                messages = _entailment_messages(_premise(ctx, claim), hypothesis)
                raw = await judge.complete(messages, json_mode=True, temperature=0.0)
                try:
                    supported = _is_supported(raw)
                except ValueError:
                    supported = False  # unparseable -> not confirmed grounded (conservative)
```

- Granite Guardian serial criterion loop:

```100:108:apps/harness/src/harness/sensors/inferential/granite_client.py
    async def screen(self, text: str) -> dict[str, bool]:
        dimensions: dict[str, bool] = {}
        if not self._criteria:
            return dimensions
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            for criterion in self._criteria:
                dimensions[criterion] = await self._classify(client, criterion, text)
        return dimensions
```

- `assemble_prompt` is **inside** the regen `while True:` loop (R-11 target):

```320:336:apps/harness/src/harness/temporal/workflows.py
        while True:
            await self._report_progress(inp, "drafting_note")
            assembled = await workflow.execute_activity(
                assemble_prompt,
                AssembleInput(
                    consultation_id=inp.consultation_id,
                    ...
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_API_RETRY,
            )
```

- Two existing patch gates set the precedent for R-11: `workflow.patched("task-345-harness-progress")` (`workflows.py:161`) and `workflow.patched("task-348-failure-terminal")` (`workflows.py:208`); replay tests + fixtures live in `tests/unit/temporal/test_replay_compat.py` + `tests/unit/temporal/fixtures/`.

**R-3 scoping fact (decisive).** The only callers of `judge.complete(...)` that must be capped are the two **sensor/entailment** sites — `groundedness.py:150` and `citation_verify.py:96`. The **PDSQI eval judge** (`eval/judge/pdsqi.py:234,239`) and the eval metrics (`eval/metrics/faithfulness.py:64,86`, `deepeval_metrics.py:106`) call `complete()` **without** `max_tokens`, so an *opt-in* per-call override leaves the eval judge on its 8192 budget untouched. This is the mechanism that satisfies the "must NOT lower the eval judge" constraint.

---

## 1. Per-item implementation (file paths, functions, precise change, edit order)

### Edit order (respect the dependency chain — lowest layer first)

Harness is a single Python service; the internal dependency chain for Phase B is:

```
eval/config.py (judge knobs)
  → eval/judge/base.py + providers.py (complete(max_tokens=...))      [R-3]
    → sensors/inferential/entailment_batch.py (NEW helper)            [R-5]
      → sensors/inferential/groundedness.py (batch + cap)            [R-3+R-5]
  → sensors/inferential/granite_client.py (gather screen())          [R-4]
    → temporal/activities.py (wire config cap + sensor ctor)         [R-3+R-5]
      → temporal/workflows.py (patched assemble hoist)               [R-11]
        → tests/unit/temporal/fixtures/* (capture new replay fixture)[R-11]
```

Implement **R-3 → R-4 → R-5 → R-11** in that order. R-3 and R-4 are independent and low-risk; R-5 builds on R-3's `max_tokens` override; R-11 is last because it changes the durable workflow command sequence and must ship with the replay fixture captured against the already-landed Phase-B code.

---

### R-3 (full) — per-call `max_tokens` override scoped to the sensor/entailment judge calls

> **⚠ DROPPED (2026-06-14) — NOT shipped.** R-3 was superseded by the model-residency root-cause finding ("R-1/R-3 are moot"): once the judge model is resident and the per-claim path runs concurrently (R-4), the per-call `max_tokens` cap was no longer the lever. Confirmed in source — **no `entailment_max_tokens` symbol exists** and `HARNESS_JUDGE_ENTAILMENT_MAX_TOKENS` is never read. The plan below is retained as a historical record only.

**Goal.** Cap entailment verdicts at a small budget (~256 single-claim) **without** touching the PDSQI eval judge's 8192 budget. Truncation ⇒ parse failure ⇒ claim **ungrounded** (conservative; already the behavior of `_is_supported`'s `ValueError` branch).

**Files / functions / changes:**

1. `apps/harness/src/harness/eval/config.py` — `JudgeConfig`
   - Add env-driven knob (nothing hardcoded, per service convention):

```python
# Per-call cap for the *sensor* entailment judge calls (groundedness/citation-verify),
# NOT the PDSQI eval judge (which keeps `max_tokens`=8192 for its reasoning trace).
# A binary {"supported": bool} verdict needs only a few tokens; truncation here is
# SAFE — it surfaces as a parse failure → claim treated ungrounded (conservative).
entailment_max_tokens: int = 256
```

2. `apps/harness/src/harness/eval/judge/base.py` — `JudgeClient.complete`
   - Add an **optional** keyword `max_tokens: int | None = None` to the protocol signature (default `None` = "use the configured budget"). This keeps every existing caller source-compatible.

3. `apps/harness/src/harness/eval/judge/providers.py` — all three `complete` methods
   - `OpenAICompatJudgeClient.complete` / `AzureOpenAIJudgeClient.complete`: replace the hardcoded budget line with the override-aware value:

```python
"max_tokens": self._config.max_tokens if max_tokens is None else max_tokens,
```

   - `BedrockJudgeClient.complete`: same override applied to `inferenceConfig["maxTokens"]`.

4. `apps/harness/src/harness/sensors/inferential/groundedness.py` + `citation_verify.py`
   - Sensors take the cap at construction (mirrors how they take `threshold`) and pass it through:

```python
class GroundednessSensor:
    def __init__(self, threshold: float = 0.8, *, max_tokens: int | None = None) -> None:
        self.threshold = threshold
        self._max_tokens = max_tokens
    ...
    raw = await judge.complete(messages, json_mode=True, temperature=0.0, max_tokens=self._max_tokens)
```

   (Identical `max_tokens` plumbing in `CitationVerifySensor`.)

5. `apps/harness/src/harness/temporal/activities.py` — `run_inferential_sensors`
   - Read the cap from the **runtime judge config** and inject it into the sensors (the activity already builds the judge via `get_runtime_judge_config()`), e.g.:

```python
judge_cfg = get_runtime_judge_config()
judge = build_judge_client(judge_cfg)
...
groundedness = GroundednessSensor(threshold=payload.groundedness_threshold,
                                  max_tokens=judge_cfg.entailment_max_tokens)
citation_verify = CitationVerifySensor(threshold=thresholds.citation_verify_threshold,
                                       max_tokens=judge_cfg.entailment_max_tokens)
```

   - Keep `_build_runtime_judge()` working (either inline `get_runtime_judge_config()` here, or have it return the config too). Do **not** change the PDSQI/eval construction path.

**Why this is correctly scoped:** the eval judge call sites do not pass `max_tokens`, so `complete()` falls back to `self._config.max_tokens` (8192). Only the two sensor sites pass `entailment_max_tokens`.

---

### R-4 — parallelize the Granite `screen()` 7-criterion loop (byte-identical result dict)

**File / function:** `apps/harness/src/harness/sensors/inferential/granite_client.py` — `GraniteGuardianClient.screen`

**Change:** replace the serial `for criterion in self._criteria:` accumulation with an `asyncio.gather` over the same `_classify` calls, then rebuild the dict **in criteria order** so the mapping is byte-identical to the serial version:

```python
import asyncio
...
async def screen(self, text: str) -> dict[str, bool]:
    if not self._criteria:
        return {}
    async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
        verdicts = await asyncio.gather(
            *(self._classify(client, c, text) for c in self._criteria)
        )
    return {criterion: verdict for criterion, verdict in zip(self._criteria, verdicts)}
```

**Invariants preserved:**
- **Result identity:** keys inserted in `self._criteria` order, values are the same per-criterion booleans → `dict` equality *and* key order identical to serial.
- **Degrade direction:** `gather` (default `return_exceptions=False`) propagates the first `GraniteServiceError`/`GraniteParseError`; `SafetySensor.arun` still catches it and returns `degraded_result` (never auto-PASS). The shared per-endpoint governor (`governed_request`) still bounds concurrency, so this does **not** burst LM Studio.
- **Win = ~0 until `HARNESS_LLM_MAX_CONCURRENCY>1` (Phase A R-2)** — the code change is independent and lands now; the latency is unlocked by Phase A.

---

### R-5 — batch claims into JSON-array judge calls (label-each-item, strict JSON, temp 0)

**Highest single code-change win.** Groundedness goes from `C` calls (31 measured) to `ceil(C / batch_size)` calls.

**Scope decision:** apply batching to **`GroundednessSensor`** only. `CitationVerifySensor` stays per-claim in Phase B — its premise is *per-claim cited-chunk text* (not a shared transcript), it had **0 calls** in the measured run, and batching heterogeneous per-claim premises is a separate, lower-value change. (Recorded in §Risks as a follow-up.)

**New file:** `apps/harness/src/harness/sensors/inferential/entailment_batch.py`

Pure, dependency-light helper (reuses `harness.eval.jsonio.loads_json`):

- `chunk(items: list, size: int) -> list[list]` — group claims into runs of `size` (default sourced from config; see knob below). Keep groups **small (≈10–15)** to stay far below the ~100-item attention-overflow zone (Appendix 05 Topic 1).
- `batch_entailment_messages(premise: str, items: list[dict]) -> list[dict[str, str]]` — one system+user message that:
  - states the shared `PREMISE` (transcript) once;
  - enumerates each item as `{"id": <claim ref>, "hypothesis": <text>, "evidence": [<that claim's quotes>]}` (the per-claim evidence quotes that `_premise` used per-claim today are carried inline, preserving per-claim semantics);
  - instructs a **strict** `label-EACH-item` JSON array response: `[{"id": "...", "supported": true|false}, ...]`, **temperature 0**, "label every id, output ONLY the JSON array, no prose".
- `parse_batch_verdicts(raw: str, expected_ids: list[str]) -> dict[str, bool]` — **conservative** parser:
  - `loads_json(raw)`; if it is not a list, or raises `ValueError` (unparseable / truncated array) → return `{id: False for id in expected_ids}` (every claim in the group ungrounded).
  - Build `{str(item["id"]): bool(item["supported"])}` from **well-formed** entries only (`item` is a dict, `id` present, `supported` is a real bool — reuse the same truthy coercion as `_is_supported`).
  - For each `expected_id`: grounded **iff** the map has that id **and** its value is exactly `True`. A **missing** id → ungrounded. A non-bool / malformed `supported` → ungrounded. **Extra** ids (not in `expected_ids`) are ignored (they can never mark a real claim grounded). A duplicated id → conservative (treat as ungrounded unless all duplicates agree True — simplest: last-write-wins is unsafe, so treat any disagreement/duplication as ungrounded).

**Edit:** `apps/harness/src/harness/sensors/inferential/groundedness.py` — `GroundednessSensor.arun`
- Keep the existing front-matter intact: vacuous-pass on no claims, empty-hypothesis claims still counted grounded with no judge call, the same `try/except Exception → degraded_result` wrapper, the same RAG-triad math, the same `_section_code` flagging, the same `details` shape.
- Replace the inner per-claim loop with: split claims into groups via `chunk(...)`; for each group, `judge.complete(batch_entailment_messages(ctx.transcript_text, group), json_mode=True, temperature=0.0, max_tokens=self._batch_max_tokens)`; `parse_batch_verdicts(raw, [_claim_ref(c) for c in group])`; fold the per-id booleans into the existing `grounded` / `ungrounded` / `ungrounded_sections` accumulation **exactly as the serial loop did**.
- A `JudgeConnectionError` from any group call still bubbles to the `except Exception` → `degraded_result` (unchanged degrade path).

**R-3 ↔ R-5 interaction (critical correctness note).** The single-claim cap (`entailment_max_tokens=256`) is too small for a 12-item array → it would truncate → *all 12* claims ungrounded (a conservative but quality-destroying over-flag). So the batch path uses a **size-scaled** cap, added as a config knob:

```python
# eval/config.py JudgeConfig
entailment_batch_size: int = 12          # HARNESS_JUDGE_ENTAILMENT_BATCH_SIZE; keep 10–15
entailment_batch_base_tokens: int = 128  # framing/array overhead
entailment_batch_per_item_tokens: int = 48
```

Batch cap = `entailment_batch_base_tokens + entailment_batch_per_item_tokens * len(group)` (passed as `max_tokens` for that group). With Phase A's R-1 (`suppress_reasoning=true`) the judge emits only the array, so this cap is comfortable; **without** R-1 the judge may still emit a `<think>` trace and truncate → conservative ungrounding. This is the explicit Phase-A ordering dependency (see §Ordering / §Risks).

**Wire-through:** `run_inferential_sensors` passes `entailment_batch_size` + the batch cap knobs into `GroundednessSensor.__init__` (alongside the R-3 `max_tokens`). Keep the constructor backward-compatible (all new args keyword, defaulted) so existing unit tests that do `GroundednessSensor(threshold=0.8)` keep working in single-group form.

---

### R-11 — hoist `assemble_prompt` out of the regen loop (patch-gated + replay fixture)

> **⚠ DROPPED (2026-06-14) — NOT shipped.** R-11 (assemble-prompt hoist) was superseded by the model-residency root cause and never implemented. Confirmed in source — **no `task-355-assemble-hoist` patch marker exists** in `workflows.py`. The plan below is retained as a historical record only.

**File / function:** `apps/harness/src/harness/temporal/workflows.py` — `HarnessDocWorkflow._run`

**Why safe to hoist:** `assemble_prompt` inputs (`consultation_id`, `tenant_id`, `user_id`, `template`, `dna_style_id`, `conversation_language`) are loop-invariant; the result is deterministic across regens. It is currently re-fetched every iteration.

**Change (patch-gated, both eras kept during the deprecation window):**

```python
# New gate id; mirrors task-345 / task-348 precedent.
hoist_assemble = workflow.patched("task-355-assemble-hoist")
assembled = None
if hoist_assemble:
    assembled = await workflow.execute_activity(
        assemble_prompt, AssembleInput(...), start_to_close_timeout=_ACTIVITY_TIMEOUT,
        retry_policy=_API_RETRY,
    )
while True:
    await self._report_progress(inp, "drafting_note")
    if not hoist_assemble:                       # legacy path: assemble inside the loop
        assembled = await workflow.execute_activity(assemble_prompt, AssembleInput(...), ...)
    user_prompt = assembled.user_prompt
    ...
```

**Determinism contract:**
- **Old histories** (recorded before this deploy, with assemble-inside-loop): `workflow.patched("task-355-assemble-hoist")` returns **False** on replay → the legacy branch runs the identical command sequence → no non-determinism. The existing `doc_workflow_pre_task345_history` and `doc_workflow_task345_history` fixtures continue to replay green.
- **New executions:** `patched()` returns True, records the marker, assembles once before the loop.
- `persist_draft` still reads `assembled.prompt_template_id` / `assembled.prompt_version` — set once (hoisted) or last-iteration (legacy); equivalent because assemble is deterministic.

**New replay fixture (GREEN step, captured — not hand-written):**
`apps/harness/src/harness/tests/unit/temporal/fixtures/doc_workflow_task355_history.json`, captured with the existing tool against the **post-R-11** definition:

```bash
conda run -n arcaenv python -m harness.tests.unit.temporal._capture_replay_fixture \
  apps/harness/src/harness/tests/unit/temporal/fixtures/doc_workflow_task355_history.json
```

This is the forward-guard fixture (new era) so future workflow changes stay replay-compatible.

> **Out of scope for R-11:** R-12 (progress feed via query/heartbeat) shares the patch-gate caveat but is **not** part of Phase B — do not touch the progress emission sequence.

---

## 2. TDD test list (RED first)

Conventions: tests live under `apps/harness/src/harness/tests/`, `pytest`, `asyncio_mode=auto`, classes `Test*`. **Characterization/GOLDEN tests** for R-3/R-5 are written *first against current code* (they pass now) and must stay green after the change — they guard against verdict drift (refactor discipline). **New-behavior tests** (parse fallback, max_tokens passthrough, parallel screen) are **RED-first**: write, watch fail, implement, watch pass.

### (R-3) per-call `max_tokens` override + eval-judge isolation

File: `apps/harness/src/harness/tests/unit/eval/test_judge_config.py`
- `test_entailment_max_tokens_default_is_256` — `JudgeConfig().entailment_max_tokens == 256`.
- `test_entailment_max_tokens_env_override` — `HARNESS_JUDGE_ENTAILMENT_MAX_TOKENS=128` → `128`.
- `test_eval_judge_max_tokens_unchanged` — `JudgeConfig().max_tokens == 8192` (regression: the shared PDSQI budget is untouched).

File: `apps/harness/src/harness/tests/unit/eval/test_judge_transport.py` (extends the existing `_fake_create(captured, ...)` kwargs-capture pattern)
- `test_complete_sends_override_max_tokens` — `await client.complete(msgs, max_tokens=256)` → `captured["max_tokens"] == 256` (RED first).
- `test_complete_without_override_uses_config_budget` — `await client.complete(msgs)` → `captured["max_tokens"] == 8192` (proves the **eval/PDSQI** path is not lowered).

File: `apps/harness/src/harness/tests/unit/eval/test_pdsqi_judge.py`
- `test_pdsqi_judge_call_uses_full_budget_not_entailment_cap` — drive a PDSQI judge call through a kwargs-capturing fake client; assert `max_tokens == 8192` (explicit "eval judge not capped" guard).

File: `apps/harness/src/harness/tests/unit/sensors/test_groundedness.py`
- `test_sensor_passes_max_tokens_through_to_judge` — stub judge records `max_tokens`; `GroundednessSensor(max_tokens=256)` → recorded `max_tokens == 256` on each call (RED first). *(Requires updating the test stub `complete` signatures to accept `max_tokens=None`; same edit in `test_citation_verify.py` and `test_safety.py`/`test_inferential_base.py` stubs.)*
- `test_truncated_or_empty_verdict_is_ungrounded` — stub judge returns `""`/truncated `'{"suppo'` → `_is_supported`/`parse_batch_verdicts` ⇒ claim ungrounded, sensor `passed` reflects it (conservative; characterizes the existing `ValueError → False` contract under the cap).

### (R-3 + R-5) sensor-verdict GOLDEN tests — verdicts do NOT change *(mandatory coverage (a))*

File: `apps/harness/src/harness/tests/unit/sensors/test_groundedness_golden.py` (new)
- Fixture: one realistic SOAP note's `citationsMap` with **6 claims spanning S/O/A/P**, mixed grounded/ungrounded (e.g. 4 grounded, 2 ungrounded in `P` and `A`), some with `evidence` quotes. A deterministic judge stub whose verdict function is identical in **single-claim** and **array** call shapes ("supported unless hypothesis contains a marker").
- `test_golden_verdict_is_stable_single_vs_batch` — assert the full `SensorResult` (`score`, `passed`, `claims_flagged`, `details["sections"]`, `details["rag_triad"]`, `details["ungrounded"]`, `details["total"]`) is **byte-identical** whether `entailment_batch_size=1` (degenerates to per-claim) or `entailment_batch_size=3` (forces ≥2 groups). This proves R-5 grouping does not change verdicts.
- `test_golden_verdict_unaffected_by_max_tokens_cap` — same fixture/stub with `max_tokens=256` vs `max_tokens=None` (judge ignores it, returns same JSON) → identical `SensorResult`. Proves R-3 does not change verdicts when output is not truncated.
- *(Baseline note: author this file FIRST against current code — both assertions pass on the per-claim implementation with `batch_size=1` — then implement R-3/R-5 and keep it green.)*

### (R-5) conservative parse-fallback tests *(mandatory coverage (c))*

File: `apps/harness/src/harness/tests/unit/sensors/test_entailment_batch.py` (new — unit tests on the helper)
- `test_chunk_groups_in_runs_of_size` — `chunk([...6], 3)` → two groups of 3, order preserved.
- `test_batch_messages_label_each_item_and_strict_json` — message asserts: shared PREMISE present once; every claim id enumerated; instruction demands a JSON **array** labeling each id, ONLY JSON, no prose.
- `test_parse_malformed_array_all_ungrounded` — `raw="not json"` / `'{"supported": true}'` (object, not array) → all `expected_ids` map to `False`.
- `test_parse_truncated_array_all_ungrounded` — `raw='[{"id":"c1","supported":true},{"id":"c2","suppo'` → unparseable ⇒ **every** id in the group `False`.
- `test_parse_missing_item_is_ungrounded` — array labels `c1` only; `c2` absent ⇒ `c2` → `False`, `c1` honored.
- `test_parse_extra_item_does_not_ground_real_claims` — array contains only an extra `{"id":"c-bogus","supported":true}` ⇒ all real ids `False` (extra ignored, never grounds a real claim).
- `test_parse_nonbool_supported_is_ungrounded` — `{"id":"c1","supported":"maybe"}` ⇒ `c1` → `False` (only an exact bool `true` grounds).
- `test_parse_duplicate_id_conflict_is_ungrounded` — `c1` appears twice with conflicting values ⇒ `c1` → `False`.

File: `apps/harness/src/harness/tests/unit/sensors/test_groundedness.py` (extend — end-to-end through the sensor)
- `test_batched_truncation_marks_only_that_group_ungrounded` — 2 groups; the judge truncates group 1's response only ⇒ group-1 claims ungrounded, group-2 claims keep their verdicts; sensor `score`/`sections` reflect exactly that.
- `test_batched_judge_failure_degrades_never_raises` — judge raises `JudgeConnectionError` on a group call ⇒ `degraded_result` (unchanged degrade contract).

### (R-4) Granite result-dict equality (parallel == serial) *(mandatory coverage (b))*

File: `apps/harness/src/harness/tests/unit/sensors/test_granite_client.py` (extend; reuse `httpx.MockTransport`)
- `test_parallel_screen_result_dict_equals_expected_and_keeps_criteria_order` — 3 criteria `["harm","social_bias","violence"]`; mock returns `yes` only for `violence`; assert `dims == {"harm": False, "social_bias": False, "violence": True}` **and** `list(dims.keys()) == ["harm","social_bias","violence"]` (byte-identical mapping + order).
- `test_parallel_screen_order_independent_of_completion_order` — mock resolves out of arrival order (e.g. delays the first criterion) ⇒ result dict + key order still equal the serial expectation.
- `test_one_chat_call_per_criterion_parses_scores` (existing) — must still pass unchanged (the equality guarantee that parallelization is semantically transparent).
- `test_parallel_screen_propagates_failure_to_degrade` — one criterion returns 503 ⇒ `GraniteServiceError` propagates from `gather`; via `SafetySensor` it degrades (assert in `test_safety.py` below).

File: `apps/harness/src/harness/tests/unit/sensors/test_safety.py` (extend)
- `test_safety_degrades_when_one_parallel_criterion_fails` — `_StubGranite` whose `screen` raises after parallelization mimic ⇒ `degraded is True`, `passed is False` (FLAG-not-PASS direction intact). *(Existing `test_granite_backend_failure_degrades_never_raises` already covers the contract; this asserts it holds under the gather change.)*

### (R-11) captured workflow replay test with the patch gate *(mandatory coverage (d))*

File: `apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py` (extend)
- **RED proof (procedure, not a permanent test):** make the R-11 hoist edit **without** the `workflow.patched` gate and run the existing `test_pre_task345_history_replays_on_current_definition` + `test_task345_history_replays_on_current_definition` → they must **fail** with a non-determinism error (the new command sequence diverges from the recorded histories). Add the patch gate → both go green. This is exactly the defect class the file exists to catch.
- `test_task355_history_replays_on_current_definition` (new) — replays the newly captured `doc_workflow_task355_history.json` through `HarnessDocWorkflow`; forward guard that the hoisted (new-era) command sequence is itself replay-stable.

File: `apps/harness/src/harness/tests/unit/temporal/test_doc_workflow.py` (extend)
- `test_assemble_prompt_hoisted_called_once_across_regens` — drive a 2-regen scenario (`StubConfig(verdicts=["REGEN","REGEN","PASS"])`); assert `recorder.calls["assemble_prompt"] == 1` while `recorder.calls["generate"] == 3` and `recorder.calls["run_sensors"] == 3` (proves the hoist; generation/sensors still per-iteration). *(No existing test asserts the assemble count, so this is purely additive.)*
- `test_happy_path_assemble_called_once` — PASS path: `recorder.calls["assemble_prompt"] == 1` (sanity for the common case).

---

## 3. Verification commands (conda env `arcaenv`)

> Env confirmed as **`arcaenv`**. Run from the monorepo root `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`.

Per-item (fast RED/GREEN loops):

```bash
# R-3
conda run -n arcaenv pytest apps/harness/src/harness/tests/unit/eval/test_judge_config.py \
  apps/harness/src/harness/tests/unit/eval/test_judge_transport.py \
  apps/harness/src/harness/tests/unit/eval/test_pdsqi_judge.py -v --tb=short -p no:cov

# R-4
conda run -n arcaenv pytest apps/harness/src/harness/tests/unit/sensors/test_granite_client.py \
  apps/harness/src/harness/tests/unit/sensors/test_safety.py -v --tb=short -p no:cov

# R-5 (helper + sensor + golden)
conda run -n arcaenv pytest apps/harness/src/harness/tests/unit/sensors/test_entailment_batch.py \
  apps/harness/src/harness/tests/unit/sensors/test_groundedness.py \
  apps/harness/src/harness/tests/unit/sensors/test_groundedness_golden.py -v --tb=short -p no:cov

# R-11 — first capture the new-era fixture (GREEN step), then replay + workflow tests
conda run -n arcaenv python -m harness.tests.unit.temporal._capture_replay_fixture \
  apps/harness/src/harness/tests/unit/temporal/fixtures/doc_workflow_task355_history.json
conda run -n arcaenv pytest apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py \
  apps/harness/src/harness/tests/unit/temporal/test_doc_workflow.py -v --tb=short -p no:cov
```

Full gate (run before claiming Phase B done):

```bash
# Whole harness suite (coverage addopts come from pyproject; -m "not e2e" is default)
conda run -n arcaenv pytest apps/harness/src/harness/tests/ -v --tb=short

# Lint / format / types on touched files
conda run -n arcaenv ruff check apps/harness/src/harness
conda run -n arcaenv black --check apps/harness/src/harness
conda run -n arcaenv mypy apps/harness/src/harness
```

Equivalent monorepo aliases also exist: `pnpm py:harness:test`, `pnpm py:harness:lint`, `pnpm py:harness:format`, `pnpm py:harness:typecheck` (README §Testing).

> Note: `-p no:cov` disables the coverage plugin for fast iteration; drop it for the final full-suite run so the `--cov` addopts apply.

---

## 4. Safety invariants (README §7) — how Phase B preserves each

1. **Gate never auto-PASSes; degraded/missing ⇒ FLAG.**
   - R-3/R-5: a judge backend failure on any (batched) group still bubbles to `GroundednessSensor`'s `except Exception → degraded_result(passed=False, degraded=True)`; the aggregator FLAGs on degraded/missing. R-4: a Granite failure propagates from `gather` → `SafetySensor` returns `degraded_result`. No path turns a failure into PASS.

2. **Safety FLAG never regenerated away.**
   - R-4 only changes *how* the 7 criteria are dispatched (serial→gather), not the verdict mapping; `safety` remains in `HIGHEST_HARM_SENSORS` and a flagged dimension still forces FLAG. R-11 does not touch `run_inferential_sensors`/aggregation order. (Phase D's "never signed past" is out of scope here.)

3. **Conservative failure direction (truncation/parse/timeout ⇒ stricter).**
   - R-3: a too-small cap truncates → `_is_supported` raises `ValueError` → claim **ungrounded**. R-5: unparseable/truncated array, missing id, malformed/non-bool `supported`, duplicate-conflict, or extra-only response ⇒ those claims **ungrounded** (`parse_batch_verdicts` returns `False`). Never the looser direction. The size-scaled batch cap exists precisely so *legitimate* output is not truncated (avoids over-flagging) while *genuine* truncation still fails closed.

4. **Workflow-sequence changes ship with `workflow.patched()` + captured replay fixtures.**
   - R-11 adds `workflow.patched("task-355-assemble-hoist")`, keeps the legacy in-loop branch for old histories, and ships the captured `doc_workflow_task355_history.json` + a replay test (TASK-348/354 discipline). R-3/R-4/R-5 are *inside activities* (non-deterministic side-effect layer) and do **not** alter the workflow command sequence → no patch gate needed for them.

5. **WORM audit truthfulness.**
   - No change to `record_gate_decision`/`persist_draft` semantics; `gate_decision` is still recorded only when computed. R-11 keeps `assembled.prompt_template_id`/`prompt_version` provenance on `persist_draft` (set once, deterministic).

---

## 5. Risks, ordering dependencies, rollback

### Ordering dependencies on Phase A
- **R-4 win is ~0 without R-2** (`HARNESS_LLM_MAX_CONCURRENCY>1`): the gather dispatch is real, but the shared semaphore re-serializes at concurrency 1. Land the code now; latency arrives when Phase A raises the governor (and LM Studio ≥0.4.0 parallel slots are enabled).
- **R-5 batch cap safety depends on R-1** (`HARNESS_JUDGE_SUPPRESS_REASONING=true`): if the judge still emits a `<think>` trace, a size-scaled cap can truncate the array → conservative over-flagging. Mitigation: the per-item budget is configurable; if Phase B lands before R-1 is verified on `gemma-4-e4b`, set `entailment_batch_per_item_tokens` generously (and/or `entailment_batch_size` small) until R-1 is confirmed.
- **TASK-354 per-call timeout/heartbeat** (Phase A) bounds a hung judge call so a stuck batch can't hold the wider semaphore; Phase B assumes that is (or will be) in place.

### Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Batch cap truncates legitimate arrays → mass false-ungrounding (quality + spurious FLAG/REGEN churn) | Med (high if R-1 not landed) | size-scaled cap config knobs; golden test forces ≥2 groups; pilot `entailment_batch_size` small (10–12); re-measure verdict distribution vs the per-claim baseline on a fixture note |
| Over-batching → position bias / attention overflow (Appendix 05) | Low at 10–15/group | keep groups ≤15, far below the ~100-item zone; do not raise without re-validating verdicts |
| Adding `max_tokens` kwarg breaks test stubs that hardcode `complete()` signature | High (mechanical) | update stub `complete(...)` signatures to accept `max_tokens: int | None = None` (test_groundedness, test_citation_verify, test_safety, test_inferential_base, eval transport fakes) |
| R-11 hoist reorders the first-iteration command sequence | Med | patch-gated; old histories replay via the legacy branch; new-era fixture captured + replay-tested before merge |
| R-4 `gather` surfaces a different criterion's exception than serial would | Low | `SafetySensor` only cares about *type* (`GraniteServiceError`) → degrade; result dict on success is byte-identical (tested) |
| Captured replay fixture drifts if captured against pre-R-11 code | Low | capture the fixture **after** the R-11 edit lands; never hand-edit it |

### Rollback
- **R-3 / R-4 / R-5** are activity-layer (non-durable) changes — fully reversible by reverting the commit; no workflow history implications. R-3/R-5 also self-disable via config: set `HARNESS_JUDGE_ENTAILMENT_BATCH_SIZE=1` (degenerates batching back to per-claim) and leave `max_tokens` override off to restore the 8192 budget on sensor calls.
- **R-11** is durable: the `workflow.patched("task-355-assemble-hoist")` gate makes the deploy forward-and-backward safe by construction. To roll back the *behavior* without a non-determinism storm, prefer rolling forward (a follow-up `deprecate_patch` once no pre-355 runs are in flight) over reverting the gated code while runs carry the marker. Reverting the entire commit before any new-era run reaches the gate is safe; reverting after is not (it would orphan the recorded marker) — treat like TASK-348/354.

---

## 6. Definition of done (Phase B)
- [ ] R-3/R-4/R-5/R-11 implemented in the edit order of §1.
- [ ] All new RED-first tests fail before, pass after; GOLDEN tests green before and after (verdict stability).
- [ ] New replay fixture `doc_workflow_task355_history.json` captured (conda `arcaenv`) and `test_task355_history_replays_on_current_definition` green; pre-345/345 fixtures still green.
- [ ] Full `conda run -n arcaenv pytest apps/harness/src/harness/tests/` green; ruff/black/mypy clean on touched files (paste output as evidence).
- [ ] README.md §10 Change History updated with the Phase-B implementation summary (files changed, new patch gate id, new env knobs).
