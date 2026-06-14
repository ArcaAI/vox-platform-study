# TASK-355 · Appendix 02 — Harness Internals Deep Review (workflow, activities, sensors, config)

> Produced by the harness deep-review agent (code-level review of `apps/harness`), cross-checked against the
> measured run in [Appendix 01](./01-workflow-trace-analysis.md). Every claim carries a file path + line number.
> Line numbers reflect the 2026-06-12 working tree.

---

## 1. Temporal Workflow — `HarnessDocWorkflow`

**File:** `apps/harness/src/harness/temporal/workflows.py`

### 1.1 Activity Sequence (canonical execution order)

The workflow is a single entrypoint `_run()` that executes activities **strictly sequentially** (each `await workflow.execute_activity(...)` must complete before the next starts), except for the **one concurrent moment** in `run_inferential_sensors` which uses `asyncio.gather` internally.

```
Phase         Activity              L#    Sequential  Notes
────────────  ──────────────────    ────  ─────────── ──────────────────────────
POLICY        report_progress       219   seq         stage="extracting_information"
              fetch_policy          222   seq         timeout=150s, retry=3
EXTRACT       extract_entities      259   seq         NLP, timeout=150s, retry=2
              persist_entities      270   seq         API, timeout=150s, retry=3
RETRIEVE      report_progress       291   seq         stage="assembling_context"
              retrieve_context      293   seq         timeout=150s, retry=2
GENERATE      [LOOP START]          320
  (per iter)  report_progress       323   seq         stage="drafting_note"
              assemble_prompt       324   seq         API, timeout=150s, retry=3
              generate              343   seq         SMR LLM, timeout=150s, retry=2
              extract_entities      359   seq         NLP, timeout=150s, retry=2 (on note)
              report_progress       372   seq         stage="running_safety_sensors"
              run_sensors           373   seq         computational, timeout=150s, retry=3
              [comp aggregate]      391   deterministic in workflow body (no activity)
              [regen? → continue]   397   back to loop top if REGEN and budget
              run_inferential_sensors 406 seq         timeout=900s, retry=2 (heavy!)
PERSIST       report_progress       452   seq         stage="finalizing_draft"
              persist_draft         453   seq         API, timeout=150s, retry=3
              report_progress       482   seq         stage=TERMINAL
GATE          [wait_condition loop] 488   durable timer wait for approval signal
              escalate_gate         495   if SLA breached, timeout=30s, retry=3
RECORD        record_gate_decision  513   seq         timeout=150s, retry=3
```

### 1.2 Timeouts and retry policies

All defined at `workflows.py` lines 74–98:

```python
_ACTIVITY_TIMEOUT     = timedelta(seconds=150)     # all standard activities
_INFERENTIAL_TIMEOUT  = timedelta(seconds=900)     # run_inferential_sensors only
_ESCALATE_TIMEOUT     = timedelta(seconds=30)
_NLP_RETRY            = RetryPolicy(maximum_attempts=2)
_API_RETRY            = RetryPolicy(maximum_attempts=3)
_GENERATE_RETRY       = RetryPolicy(maximum_attempts=2)
_INFERENTIAL_RETRY    = RetryPolicy(maximum_attempts=2)   # 2 full 900s attempts = 1800s worst-case
_RETRIEVAL_RETRY      = RetryPolicy(maximum_attempts=2)
_PROGRESS_TIMEOUT     = timedelta(seconds=10)
_PROGRESS_RETRY       = RetryPolicy(maximum_attempts=1)
```

**Critical:** `run_inferential_sensors` has `start_to_close_timeout=900s` and `maximum_attempts=2`. If attempt 1 hangs for the full 900 s, attempt 2 starts after, meaning a worst-case inferential pass costs **1 800 s** before the activity fails. There is **no `heartbeat_timeout`** set on any activity call (TASK-354 Defect A addresses this).

### 1.3 The regen loop

The regen loop (lines 320–443) works as follows:

1. The loop runs indefinitely until `break`.
2. On each iteration: `assemble_prompt` → `generate` → `extract_entities` (on note) → `run_sensors` → `aggregate(comp only)`.
3. If `comp_verdict == REGEN` AND `regens_used < gate.max_regen`: increment `regens_used`, `continue` (restart the loop — **re-run generate + NER + sensors, WITHOUT paying for the inferential pass**).
4. Otherwise (comp settled or budget exhausted): run `run_inferential_sensors` (lines 406–418), fold its results into the final verdict, then possibly one more `continue` if the folded verdict == REGEN and budget remains (lines 440–442) — **the next iteration re-runs the full inferential pass on the new draft, no caching**.
5. `break` when `verdict.decision != REGEN` or budget is 0.

**Max iterations:** up to 3 `generate` calls with default `max_regen=2`; worst case **3 full inferential passes** when groundedness keeps failing. The inferential pass cost therefore multiplies 1:1 with regens.

### 1.4 Gate / approval signal / SLA timer

```python
# workflows.py lines 486–507
escalations = 0
deadline = gate.gate_sla_seconds   # default 86400 (24h)
while self._approval is None:
    try:
        await workflow.wait_condition(lambda: self._approval is not None,
                                      timeout=timedelta(seconds=deadline))
    except TimeoutError:
        await workflow.execute_activity(escalate_gate, ...)
        escalations += 1
        deadline = gate.gate_escalation_seconds  # default 43200 (12h re-escalation)
```

Infinite escalation loop: wait 24 h → escalate → wait 12 h → … until the clinician `approval` signal arrives.

### 1.5 Patch gates (replay safety)

Two `workflow.patched()` gates (lines 161, 208): `"task-345-harness-progress"` (progress emissions) and `"task-348-failure-terminal"` (failure-terminal event). Any future sequence change must ship with a new gate + replay fixture (TASK-348/354 discipline).

---

## 2. Activities — per-activity analysis

**File:** `apps/harness/src/harness/temporal/activities.py`

| Activity | External Service | Port | Latency Profile | Key Notes |
|---|---|---|---|---|
| `report_progress` | apps/api (internal HTTP) | 8868 | ~ms, fire-and-forget | Swallows ALL errors (line 479); dedicated 5 s HTTP timeout |
| `fetch_policy` | apps/api | 8868 | ~ms | Degrades to code defaults on failure |
| `extract_entities` | NLP service | 8864 | 0.2–3 s | Called **twice**: once on transcript, once on note (per iteration) |
| `persist_entities` | apps/api | 8868 | ~ms | Writes NER rows to Postgres |
| `assemble_prompt` | apps/api | 8868 | ~ms | Fetches prompt template, assembles SMR payload |
| `retrieve_context` | Qdrant :6333 + LM Studio :1234 + reranker :8870 | multiple | 1–10 s when enabled | Flag-gated; embeddings + BM25 + RRF + cross-encoder rerank; runs ONCE (outside loop) |
| `generate` | SMR service (:8862/:8872) → LLM | 8872 | **15–60 s** | SOAP generation; biggest single-LLM call outside inferential |
| `run_sensors` | none (pure computation) | — | <1 s | 5 deterministic sensors + provenance/citations-map building |
| `run_inferential_sensors` | LM Studio :1234 (judge + safety) | 1234 | **344 s measured** | The dominant hotspot — §3 |
| `persist_draft` | apps/api | 8868 | ~ms | Creates ContextItem + SummaryMeta + PENDING_REVIEW event |
| `record_gate_decision` | apps/api | 8868 | ~ms | WORM audit record |
| `escalate_gate` | apps/api | 8868 | ~ms | Only on 24 h SLA breach |

### `extract_entities` — why twice

First call (line 259) runs NER on `inp.transcript_text`; second (line 359, inside the loop) on `generated.content`:
- **Transcript entities** → coverage/omission sensor (are transcript entities represented in the note?)
- **Note entities** → entity-faithfulness sensor (are note entities actually from the transcript?)

Structurally different entity sets — the second call is necessary, and re-runs on each regen draft. The **transcript** NER never changes across iterations (cacheable, though it is already outside the loop and cheap: 0.18 s measured).

### `generate` — observed provider discrepancy (open question)

The activity passes `payload.provider` / `payload.model` straight through to SMR (line 234) with **no env fallback**; the workflow builds `GenerateInput` from workflow-input/policy overrides only. In the measured run both were `null` → SMR (:8872) resolved its **own** default → response reported `provider=lm-studio, model=default` at 49.5 tok/s — even though `apps/harness/.env:24–25` sets `HARNESS_SMR_PROVIDER=ollama` / `HARNESS_SMR_MODEL=gemma3:latest`. Two consequences:

1. The dev intent ("force local Ollama") is **not in effect** on the workflow path — the env knobs are dead unless policy/input carries them.
2. Generation ran on the **same LM Studio box (:1234 behind :8872's lm-studio provider) as the judges and Granite** — so any concurrency raise for judges contends with `generate` traffic in dev-shaped deployments.

---

## 3. Inferential sensors deep-dive

### 3.1 `run_inferential_sensors` entry point (`activities.py` lines 374–414)

```python
@activity.defn
async def run_inferential_sensors(payload: RunInferentialSensorsInput) -> InferentialRunOutput:
    settings = get_settings()
    ctx = SensorContext(...)
    judge = _build_runtime_judge()          # OpenAICompatJudgeClient (degrade-all on failure)
    thresholds = SensorThresholds()
    groundedness = GroundednessSensor(threshold=payload.groundedness_threshold)
    citation_verify = CitationVerifySensor(threshold=thresholds.citation_verify_threshold)
    tasks = [groundedness.arun(ctx, judge=judge), citation_verify.arun(ctx, judge=judge)]
    if payload.safety_enabled:
        tasks.append(SafetySensor(_granite_client(settings)).arun(ctx, judge=judge))
    results = list(await asyncio.gather(*tasks))    # line 413
    return _assemble_inferential_output(results)
```

The three sensors are dispatched via `asyncio.gather` — **concurrent coroutine dispatch** — but the concurrency governor (`HARNESS_LLM_MAX_CONCURRENCY=1`) serializes every LLM call through a single shared semaphore, making them effectively **sequential at the LLM level**.

### 3.2 GroundednessSensor (`sensors/inferential/groundedness.py`)

Per-claim serial loop (lines 141–161): for each claim in `citations_map.claims[]`, builds a premise (transcript + claim's evidence quotes) and a hypothesis (claim text), then one `judge.complete(messages, json_mode=True, temperature=0.0)` per claim with non-empty text. Parses `{"supported": true/false}`.

```python
for claim in claims:          # SEQUENTIAL for loop
    ref = _claim_ref(claim)
    hypothesis = str(claim.get("text") or "").strip()
    if not hypothesis:
        grounded.append(ref); continue
    messages = _entailment_messages(_premise(ctx, claim), hypothesis)
    raw = await judge.complete(messages, json_mode=True, temperature=0.0)  # 1 call/claim
```

Each call goes through `_create_with_retry` in `eval/judge/providers.py` (lines 61–91) → `limit_endpoint` (the semaphore governor) → OpenAI SDK → LM Studio.

### 3.3 CitationVerifySensor (`sensors/inferential/citation_verify.py`)

Per-cited-claim serial loop (lines 89–112): one `judge.complete()` per claim with non-empty `knowledgeChunkIds` AND non-empty cited chunk text. Claims with no cited chunk text are immediately failed without an LLM call. Effectively active only when `HARNESS_RETRIEVAL_ENABLED=true` AND retrieval returned chunks AND the note carries cited claims. **In the measured run: 0 calls (trivial PASS) because retrieval returned 0 chunks → no claim had citations.**

### 3.4 SafetySensor (`sensors/inferential/safety.py` + `granite_client.py`)

One Granite Guardian call **per harm dimension**, strictly serial (`granite_client.py` lines 100–108):

```python
async def screen(self, text: str) -> dict[str, bool]:
    async with httpx.AsyncClient(...) as client:
        for criterion in self._criteria:         # SEQUENTIAL for loop
            dimensions[criterion] = await self._classify(client, criterion, text)
```

Default `harm_criteria` (`core/config.py` lines 73–83): `harm, social_bias, jailbreak, violence, profanity, sexual_content, unethical_behavior` → **7 calls**. Each posts the full note as the `assistant` message + canonical IBM 4.1 BYOC `<guardian>` block (no-think mode, `<score>yes/no</score>` verdict). Calls run through `governed_request` (`llm_concurrency.py` line 265) → **same semaphore** as the judge.

### 3.5 Shared concurrency governor (`core/llm_concurrency.py`)

Global registry `_LIMITERS: dict[endpoint_key, (loop, asyncio.Semaphore)]` (line 113); `endpoint_key()` normalizes to `scheme://host:port` so the judge (`http://localhost:1234/v1`) and Granite (`http://localhost:1234/v1`) **share one semaphore** keyed `http://localhost:1234`. Config from env (line 81–88): `HARNESS_LLM_MAX_CONCURRENCY` default **1**; `HARNESS_LLM_MAX_ATTEMPTS` default 5; backoff base 0.5 s / max 20 s. The cap is fixed at first creation per endpoint/loop (line 116–129).

### 3.6 LLM call-count formula

Let `C` = claims with non-empty text, `C_cited` = cited claims with chunk text, `D` = harm dimensions (7 default, 0 if safety disabled):

```
calls_per_inferential_pass = C + C_cited + D
wall_clock ≈ calls × avg_per_call_latency   (at MAX_CONCURRENCY=1)
worst_case_workflow = (1 + regens_used) × calls × avg_call   (inferential-triggered regens)
```

**Measured instantiation (run `019eb9f4…`): C=31, C_cited=0, D=7 → 38 calls in 343.6 s ⇒ ~9.0 s avg per serialized call.** (The code comment in `eval/config.py:85–88` records per-call observations: ~90 s on gemma-4-e4b with reasoning enabled, ~340 s on qwen3.5-9b — i.e. per-call cost is extremely model/config sensitive.)

---

## 4. Settings — complete knob table

### Root (`HARNESS_`, `core/config.py`)

| Env Variable | Default (code) | Dev Value (`apps/harness/.env`) | Latency Relevance |
|---|---|---|---|
| `HARNESS_SMR_BASE_URL` | `http://localhost:8862` | `http://localhost:8872` | `generate` target |
| `HARNESS_NLP_BASE_URL` | `http://localhost:8864` | same | NER target |
| `HARNESS_API_BASE_URL` | `http://localhost:8868` | same | API calls |
| `HARNESS_SMR_TIMEOUT_S` | `120.0` | — | HTTP timeout for generate |
| `HARNESS_NLP_TIMEOUT_S` | `30.0` | — | HTTP timeout for NER |
| `HARNESS_API_TIMEOUT_S` | `30.0` | — | HTTP timeout for API |
| `HARNESS_MAX_REGEN` | `2` | `2` | Max regen iterations |
| `HARNESS_GATE_SLA_SECONDS` | `86400` | `86400` | 24 h clinician gate |
| `HARNESS_GATE_ESCALATION_SECONDS` | `43200` | `43200` | 12 h re-escalation |
| `HARNESS_SMR_PROVIDER` | `None` | `ollama` (**not in effect on workflow path — §2**) | LLM provider for generate |
| `HARNESS_SMR_MODEL` | `None` | `gemma3:latest` (same caveat) | LLM model for generate |
| `HARNESS_HTTPX_MAX_CONNECTIONS` | `200` | — | HTTP pool |
| `HARNESS_HTTPX_MAX_KEEPALIVE` | `100` | — | HTTP keepalive |

### LLM Governor (`HARNESS_LLM_`, `core/llm_concurrency.py`)

| Env Variable | Default | Dev | Latency Relevance |
|---|---|---|---|
| `HARNESS_LLM_MAX_CONCURRENCY` | `1` | `1` | **Most impactful** — serializes all judge+guardian calls |
| `HARNESS_LLM_MAX_ATTEMPTS` | `5` | `5` | Max retries per LLM call |
| `HARNESS_LLM_BACKOFF_BASE_S` | `0.5` | `0.5` | Retry backoff base |
| `HARNESS_LLM_BACKOFF_MAX_S` | `20.0` | `20.0` | Retry backoff ceiling |
| `HARNESS_LLM_BACKOFF_JITTER_S` | `0.25` | `0.25` | Jitter |

### Judge (`HARNESS_JUDGE_`, `eval/config.py`)

| Env Variable | Default | Dev | Latency Relevance |
|---|---|---|---|
| `HARNESS_JUDGE_PROVIDER` | `openai_compat` | same | Backend selector |
| `HARNESS_JUDGE_MODEL` | `google/gemma-4-e4b` | same | **Key**: model inference speed |
| `HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL` | `http://localhost:1234/v1` | same | LM Studio endpoint |
| `HARNESS_JUDGE_TEMPERATURE` | `0.0` | — | Deterministic decoding |
| `HARNESS_JUDGE_MAX_TOKENS` | **`8192`** | — | ~40× overprovisioned for a binary verdict; sized for the PDSQI eval judge, shared by the sensors |
| `HARNESS_JUDGE_TIMEOUT_S` | **`300.0`** | — | Per-call HTTP timeout (5 min!) — one hung call stalls 300 s |
| `HARNESS_JUDGE_MAX_RETRIES` | `2` | — | SDK-level retries |
| `HARNESS_JUDGE_TRANSIENT_RETRIES` | `3` | — | App-level retries |
| `HARNESS_JUDGE_TRANSIENT_RETRY_BACKOFF_S` | `12.0` | — | Backoff between app-level retries |
| `HARNESS_JUDGE_SELF_CONSISTENCY` | `1` | — | 1 = single pass |
| `HARNESS_JUDGE_SUPPRESS_REASONING` | **`False`** | — | `/no_think` suffix OFF → gemma emits full `<think>` trace per verdict |
| `HARNESS_JUDGE_OUTPUT_MODE` | `with_explanation` | — | Verbose judge output |
| `HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT` | `json_object` | `text` | LM Studio build requires `text` → output length unconstrained |

### Safety (`HARNESS_SAFETY_`, `core/config.py`)

| Env Variable | Default | Dev | Latency Relevance |
|---|---|---|---|
| `HARNESS_SAFETY_ENABLED` | `True` | — (→True) | Off = 0 Granite calls |
| `HARNESS_SAFETY_PROVIDER` | `lm-studio` | — | Granite backend |
| `HARNESS_SAFETY_BASE_URL` | `http://localhost:1234/v1` | — | **Same LM Studio box as the judge** |
| `HARNESS_SAFETY_MODEL` | `granite-guardian-4.1-8b` | — | Granite model |
| `HARNESS_SAFETY_NO_THINK` | `True` | — | Fast no-think mode (already on) |
| `HARNESS_SAFETY_TIMEOUT_S` | `60.0` | — | Per-call HTTP timeout |
| `HARNESS_SAFETY_HARM_CRITERIA` | 7 items | — | **7 serialized calls** |

### Sensor thresholds (`HARNESS_SENSOR_`, `sensors/config.py`)

`ENTITY_FAITHFULNESS=1.0` · `COVERAGE=0.8` · `CITATION_PRESENCE=1.0` · `NUMERIC_DOSE=1.0` · `GROUNDEDNESS=0.8` · `CITATION_VERIFY=0.8`

### Retrieval (`HARNESS_RETRIEVAL_`, `core/config.py`)

`ENABLED` default `False`, dev **`true`** · `TOP_K_RETRIEVAL=20` · `TOP_K_RERANK=5` · embeddings/reranker timeouts 30 s · qdrant 10 s.

---

## 5. Workflow inputs and outputs

**Input** (`temporal/models.py` lines 46–65): `consultation_id, tenant_id, user_id, job_id, context_item_id (TRANSCRIPT ContextItem), transcript_text (cold full text), conversation_language, dna_style_id, template, smr_provider, smr_model, gate{max_regen, gate_sla_seconds, gate_escalation_seconds}`.

**Outputs:** `persist_entities` → `NamedEntity` rows (transcript entities); `persist_draft` → new `ContextItem` (type `RAW_SUMMARY`) + `SummaryMeta` (sensor_scores, citations_map, guardrail_decisions, rag_triad_score, reduced_assurance, gate_decision) + `PENDING_REVIEW` event; `record_gate_decision` → WORM `GATE_DECISION` audit with clinician identity + attestation hash.

---

## 6. Caching / reuse analysis

**There is NO caching or memoization anywhere in the pipeline.** Per workflow execution:

- Transcript NER: recomputed via NLP service (lines 259–265) — live-session NER results are not carried in.
- Note NER: re-run on each iteration's fresh draft (lines 359–367).
- RAG retrieval: the **one** reuse case — runs once before the loop (lines 293–304), `knowledge_chunks` reused across iterations.
- Groundedness/citation/safety verdicts: recomputed in full on every inferential pass (regen iterations re-judge unchanged claims/sections).
- Provenance `citations_map`: rebuilt fresh each iteration by `run_computational_sensors` → `build_citations_map()`.
- The live `PRE_SUMMARY` snapshot: never read (see [Appendix 03](./03-live-pipeline-reuse-review.md)).

---

## 7. Latency hotspots — ranked

| Rank | Hotspot | Measured / Formula | Root Cause | Fix Lever |
|---|---|---|---|---|
| **#1** | Groundedness per-claim judge loop | 31 calls in measured run; `C × avg_judge_s` | Reasoning judge (`gemma-4-e4b`) with `max_tokens=8192`, `suppress_reasoning=False`, serialized by semaphore | Suppress reasoning, cap tokens, raise concurrency, batch claims, smaller verifier |
| **#2** | Granite Guardian 7-dimension serial loop | `7 × guardian_s` | 7 sequential HTTP calls, same semaphore as judge | Parallelize loop, trim criteria (governance), single-call multi-criteria if model supports |
| **#3** | Citation-verify loop (when retrieval ON + cited claims) | `C_cited × avg_judge_s`; 0 in measured run | Same judge/semaphore; duplicate hypothesis vs groundedness | Same as #1; merge with groundedness pass where premise identical |
| **#4** | No `heartbeat_timeout` on the 900 s activity | hung attempt = 900 s + retry = 1 800 s worst case | Missing heartbeat (TASK-354 Defect A) | heartbeat 60 s + per-call timeout |
| **#5** | `HARNESS_JUDGE_TIMEOUT_S=300` default | one hung HTTP call stalls 5 min | sized for slow reasoning judges | per-call `HARNESS_LLM_REQUEST_TIMEOUT_S` (TASK-354) |
| **#6** | `generate` 21.4 s | decode-bound: 1 057 tok @ 49.5 tok/s | cold full-note generation | warm-start from live snapshot; faster decode (speculative); shorter output |
| **#7** | `MAX_CONCURRENCY=1` | serializes ALL inferential calls | conservative default for old LM Studio | raise after LM Studio ≥0.4.0 parallel slots verified |
| #8 | Regen loop re-runs everything | ×(1+regens) | correctness requirement | per-section/delta re-verification, claim caching |
| #9 | `extract_entities` ×2/iteration | 0.43 s measured | necessary (different entity sets) | non-issue at current scale |
| #10 | Retrieval enabled in dev w/ empty corpus | 0.01 s measured (no chunks) | flag on, corpus empty | non-issue today; watch when corpus fills |

---

## Appendix: key file map

| File | Contents |
|---|---|
| `temporal/workflows.py` | `HarnessDocWorkflow` — sequence, timeouts, regen loop, gate |
| `temporal/activities.py` | All 12 activities; inferential fan-out |
| `temporal/models.py` | Typed payloads; progress stage catalog |
| `core/config.py` | `Settings`, `SafetyGuardConfig`, `RetrievalConfig`, `TemporalConfig` |
| `core/llm_concurrency.py` | Semaphore governor; `governed_request`; `LlmGovernorConfig` |
| `eval/config.py` | `JudgeConfig` — judge model/timeout/token defaults |
| `eval/judge/providers.py` | `OpenAICompatJudgeClient`; `_create_with_retry` |
| `eval/judge/prompts.py` | `NO_THINK_SUFFIX` reasoning-suppression machinery |
| `sensors/inferential/groundedness.py` | Per-claim sequential judge loop |
| `sensors/inferential/citation_verify.py` | Per-cited-claim sequential judge loop |
| `sensors/inferential/safety.py` / `granite_client.py` | Per-criterion sequential Granite calls |
| `sensors/registry.py` | 5 computational sensors |
| `sensors/aggregator.py` | Gate decision logic; `HIGHEST_HARM_SENSORS`; `REGEN_FIXABLE_SENSORS` |
| `services/sensor_runner.py` | `run_computational_sensors`; provenance + `SensorContext` |
| `sensors/config.py` | `SensorThresholds` env defaults |
| `apps/harness/.env` / `.env.example` | Dev runtime config / annotated reference |
