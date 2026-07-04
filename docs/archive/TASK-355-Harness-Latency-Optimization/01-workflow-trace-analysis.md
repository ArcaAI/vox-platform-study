# TASK-355 · Appendix 01 — Forensic Trace Analysis of Run `019eb9f4…`

> Source: `docs/implementation/TASK-354-Harness-Replay-Safety-Sensor-Latency/019eb9f4-fd96-731e-9bb9-ae00b01ee20e_events.json`
> (Temporal history export, 115 events; workflow `harness-doc-14aa0a3a…`, consultation `019eb9ee-aff8-749f-bdfe-b5923f11fc55`, 2026-06-12 03:51–04:00 UTC).
> All numbers below are computed from the raw event timestamps and decoded activity payloads — not estimates.

## 1. Headline numbers

| Milestone | Wall-clock | Offset from start |
|---|---|---|
| Workflow started | 03:51:41.206 | 0 s |
| Draft persisted (`persist_draft` done) | 03:57:47.600 | **366.4 s (6 m 06 s)** |
| Clinician `approval` signal received | 04:00:40.798 | 539.6 s |
| Workflow completed | 04:00:40.898 | **539.7 s (9 m 00 s)** |

- **Pipeline time (machine)**: 366.4 s
- **Gate wait (human review)**: 173.2 s — outside the optimization scope
- 115 history events for **17 activity executions** (the rest are workflow-task bookkeeping triplets)

## 2. Per-activity timing (measured)

| # | Activity | Offset (s) | Duration (s) | Share of pipeline |
|---|---|---:|---:|---:|
| 1 | report_progress | 0.05 | 0.03 | — |
| 2 | fetch_policy | 0.10 | 0.02 | — |
| 3 | extract_entities (transcript) | 0.15 | 0.18 | — |
| 4 | persist_entities | 0.35 | 0.21 | — |
| 5 | report_progress | 0.59 | 0.02 | — |
| 6 | retrieve_context | 0.64 | 0.01 | — |
| 7 | report_progress | 0.66 | 0.02 | — |
| 8 | assemble_prompt | 0.71 | 0.03 | — |
| 9 | **generate** | 0.76 | **21.36** | **5.8 %** |
| 10 | extract_entities (note) | 22.16 | 0.25 | — |
| 11 | report_progress | 22.44 | 0.02 | — |
| 12 | run_sensors (deterministic) | 22.49 | 0.02 | — |
| 13 | **run_inferential_sensors** | 22.53 | **343.62** | **93.8 %** |
| 14 | report_progress | 366.22 | 0.11 | — |
| 15 | persist_draft | 366.34 | 0.05 | — |
| 16 | report_progress | 366.40 | 0.01 | — |
| — | TIMER_STARTED (gate SLA 86 400 s) | 366.43 | — | — |
| — | SIGNAL `approval` | 539.59 | — | — |
| 17 | record_gate_decision | 539.63 | 0.03 | — |

Aggregates: `run_inferential_sensors` 343.62 s (1×) · `generate` 21.36 s (1×) · everything else **< 1.5 s combined** across 15 executions (6× report_progress = 0.21 s total).

## 3. Decoded payload findings

### 3.1 Workflow input (ev1)
- `transcript_text`: **729 chars** (~150 words — a very short test consultation; production transcripts will be 10–50× longer)
- `gate`: `max_regen=2`, `gate_sla_seconds=86400`, `gate_escalation_seconds=43200`
- `template`, `dna_style_id`, `smr_provider/model`: all null (defaults)

### 3.2 Gate policy (ev15, `fetch_policy`)
`entity_faithfulness_threshold=1.0`, `coverage_threshold=0.8`, `citation_presence_threshold=1.0`, `numeric_dose_threshold=1.0`, `groundedness_threshold=0.8`, `safety_enabled=true`, `phi_enabled=true (fail_closed)`, `safety_provider=lm-studio`, `safety_model=granite-guardian-4.1-8b`.

### 3.3 NER (ev21, ev63)
- Transcript pass: **51 entities** in 0.18 s; note pass: **78 entities** in 0.25 s. NER is *not* a latency problem.
- Entity tokens carry SentencePiece artifacts (`▁One`, `▁45`) and the transcript's STT noise ("One, two, three…" mic check) becomes `B-DETAILED_DESCRIPTION` entities — noise inflates the deterministic `entity_faithfulness` denominator.

### 3.4 Retrieval + prompt (ev39, ev51)
- `retrieve_context` → **0 chunks**, empty `prompt_block` (knowledge retrieval found nothing; `degraded=false`).
- Assembled user prompt: **6 530 chars → 1 977 prompt tokens** for a 729-char transcript: the instruction template dominates the prompt ~8:1.

### 3.5 Generation (ev57)
- `provider=lm-studio`, `model=default`, `finish_reason=stop`
- 1 977 prompt + **1 057 completion tokens** in `latency_ms=21342` → **~49.5 tok/s decode**. The 21.4 s is decode-bound (completion length), not prefill-bound.
- Output note: 1 115 chars, markdown `**Subjective**…` SOAP format.

### 3.6 Deterministic sensors (ev75, `run_sensors`, 0.02 s)
| Sensor | Score | Passed (vs policy) |
|---|---:|---|
| entity_faithfulness | 0.474 (37/78 supported) | ❌ (threshold 1.0) |
| coverage_omission | 0.627 | ❌ (0.8) |
| **schema_validity** | **0.0** | ❌ — the markdown note failed schema validation entirely |
| citation_presence | 0.355 (11/31) | ❌ (1.0) |
| numeric_dose | 0.6 | ❌ (1.0) |

- `citations_map`: **31 claims**, every one `status="unverified"`, `confidence=0`, `evidence=[]`, `entityRefs=[]`, `knowledgeChunkIds=[]` — the claim extraction produces claims but **no evidence links**, so the expensive inferential pass starts from zero.

### 3.7 Inferential sensors (ev81 — the 343.6 s)
| Sensor | Result | Detail |
|---|---|---|
| groundedness | **0.387 → FAIL → decision `REGEN`** | 12/31 claims grounded; 19 ungrounded; sections A,O,P,S+ flagged |
| citation_verify | 1.0 → PASS | **trivially** — `total=0` citations to verify (no evidence links existed, §3.6) |
| safety | 1.0 → PASS | granite-guardian-4.1-8b; 7 dimensions all false (harm, social_bias, jailbreak, violence, profanity, sexual_content, unethical_behavior) |

- `rag_triad`: context_relevance 0.3548 (= 11/31, numerically identical to deterministic citation_presence), groundedness 0.3871, answer_relevance 1.0 → triad 0.5806. (Suggests context/answer relevance are derived, not separately judged — confirmed in Appendix 02.)
- **343.62 s ÷ 31 groundedness claims ≈ 11.1 s per serialized judge call** (plus the 7-dimension safety screen inside the same budget). Matches TASK-354's measured 344 s healthy baseline.

### 3.8 The REGEN that never ran
`guardrail_decisions.groundedness.decision = "REGEN"` with `max_regen=2` available, yet `generate` executed **once** — the persisted `gate_decision` is `"FLAG"`. Verified against `apps/harness/src/harness/sensors/aggregator.py` (lines 55–138): the per-sensor `REGEN` label only classifies groundedness as *regen-fixable*; the **aggregate** verdict checks `HIGHEST_HARM_SENSORS = (entity_faithfulness, numeric_dose, safety)` first — and this run failed two of them (0.474 < 1.0, 0.6 < 1.0) → **FLAG takes precedence, exits the loop, regen budget untouched** (highest-harm failures are "not safely auto-fixable", per TASK-330 D2/D4 policy).

⚠ Sizing consequence: the inferential pass sits **inside** the regen loop (`workflows.py` ~306–443; it re-runs after every inferential-triggered regen once computational sensors settle). A groundedness-only failure with `max_regen=2` would cost up to **3 × (21 s + 344 s) ≈ 18 min**. The regen loop multiplies whatever the single-pass cost is — crushing single-pass cost also bounds the tail.

### 3.9 Gate wait + sign-off
24 h SLA timer armed at +366 s; clinician signed (`decision=SIGNED`, attestation hash present) 173 s later; `record_gate_decision` 0.03 s; total run 9 m 00 s.

## 4. Answer to "it runs gating so many times"

The history shows gating ran **exactly once end-to-end**:
- 1× deterministic sensor pass (0.02 s), 1× inferential pass (343.6 s), 1× clinician gate (timer + signal + record), 0 regen iterations.

What *looks* like many gating runs:
1. **Inside** the single inferential pass there are **~38+ serialized LLM calls** (31 groundedness verdicts + 7 safety-dimension screens) — each visible as a separate slow request in LM Studio logs.
2. **6× `report_progress`** activities + ~17 workflow-task triplets inflate the Temporal UI event list (115 events for 17 activity executions).

So there is no redundant re-gating loop to delete in this path — the cost is the *internal fan-out* of one pass, serialized at concurrency 1 (~11 s/call). Cross-stack gating redundancy (guardrail during live vs harness at the end) is inventoried in Appendix 04.

## 5. Trace-derived optimization targets (ranked)

| Target | Evidence | Ceiling |
|---|---|---|
| 1. Per-call judge latency (reasoning emission, max_tokens) | 11.1 s for a binary verdict | ~3–5× per call |
| 2. Serialization (`HARNESS_LLM_MAX_CONCURRENCY=1`) | 38 calls strictly sequential | ÷N with N-way concurrency |
| 3. Call count (31 per-claim calls; 7 per-dimension calls) | one call per claim/dimension | ÷10–15 via batching |
| 4. `generate` decode length (1 057 tok @ 49.5 tok/s) | 21.4 s | warm-start/faster decode → 2–5× |
| 5. Claim quality: 31 claims with zero evidence links; STT noise becomes claims | §3.6 | fewer, better claims = less to verify |
| 6. Regen tail risk | §3.8 | bounded by everything above ×3 |

Non-targets (measured noise): NER (0.43 s), retrieval (0.01 s), persistence (0.26 s), progress feed (0.21 s), gate bookkeeping (0.03 s).
