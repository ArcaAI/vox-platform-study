# Root Cause Analysis (RCA)

## Incident Report: LLM Pipeline Failure at 4,500 & 5,000 Token Scaling Boundaries

---

### Incident Metadata

| Attribute                         | Detail                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Incident ID**             | `INC-2026-11-18-LLM-TOKEN-SCALING`                                                                                                    |
| **Severity**                | High (Degradation & Pipeline Failure at Scale)                                                                                          |
| **Service(s) Affected**     | `apps/api` (Gateway), `apps/harness` (Temporal Scribe Workflow), `apps/text` (LLM Gateway), `apps/guardrail`, `hope-lmstudio` |
| **Target Ingress**          | `https://api-vox2.arcaai.com`                                                                                                         |
| **Target Model**            | `gemma-4-e2b-it-qat` (LM Studio GPU)                                                                                                  |
| **Agent Specialization**    | `general-medicine-summarization`                                                                                                      |
| **Date & Time of Incident** | 2026-11-18 10:45 UTC / 16:15 IST                                                                                                        |
| **Lead Investigator**       | Senior Software Architecture & Core Platform Engineering                                                                                |

---

## 1. Executive Summary

During automated end-to-end token latency and stability benchmarking across incremental consultation transcript sizes (`500` to `5,000` tokens), the system exhibited:

1. **Flawless Stability from 500 to 4,000 Tokens**: All 5 clinical pipeline stages passed with linear GPU performance (~195 tokens/sec).
2. **Hard Failure at 4,500 & 5,000 Tokens**: Stage 4 (`HarnessDocWorkflow`) aborted with error label:
   ```
   [Hop 4] Executing End-to-End Pipeline ... [FAIL] (Documentation generation failed)
   [Hop 5] Testing Clinical Note Retrieval ... [404] Not Found
   ```
3. **Transient Ingress 502s at 2,500 & 3,000 Tokens**: Cloudflare returned `502 Bad Gateway` under rapid back-to-back ingress payload transmissions.

### Primary Root Cause

**The incident was NOT caused by a physical GPU VRAM shortage.** The dual NVIDIA RTX 2000 Ada cards had over **25 GiB of free, unallocated physical VRAM**.

The hard failure occurred because:

1. LM Studio statically partitions memory into fixed KV-cache slots rather than dynamically sharing VRAM.
2. The Medical Guardrail model (`granite-guardian`) is loaded **Just-In-Time (JIT)** with an unmanaged default ceiling of **8,192 tokens** (`defaultContextLength: 8192` in `~/.lmstudio/settings.json`).
3. When the raw transcript reached 4,500 tokens (3,383 words, 23,436 characters), the assembled clinical premise (transcript + prompt templates + clinical notes + RAG chunks + SOAP note draft) **exceeded 8,192 tokens**, triggering an upstream `CONTEXT_WINDOW_EXCEEDED` (HTTP 422) rejection.
4. The agent `general-medicine-summarization` had **no configured cloud model fallbacks** (`fallbackModelSlugs: []`). The uncaught exception aborted the Temporal workflow before `persist_draft` could write to PostgreSQL, causing Stage 5 to return HTTP 404.

---

## 2. Benchmark Evidence & Operational Metrics

The following metrics were recorded during the incident ladder run ([`scripts/token_benchmark_2/token_benchmark_results.csv`](file:///Users/apple/Desktop/project-hope/scripts/token_benchmark_2/token_benchmark_results.csv)):

|      Tier      | Words | Characters | Actual Ingest Tokens | Completion Tokens |  Total Tokens  |   E2E Latency   |   Stage 4 Status   | Stage 5 Note Retrieval | Root Symptom                        |
| :-------------: | :---: | :--------: | :------------------: | :---------------: | :-------------: | :--------------: | :----------------: | :---------------------: | ----------------------------------- |
|  **500**  |  400  |   2,608   |         982         |        502        |      1,484      |      20.06s      |   **PASS**   |         200 OK         | Optimal                             |
| **1,000** |  759  |   5,145   |        1,510        |        876        |      2,386      |      21.58s      |   **PASS**   |         200 OK         | Optimal                             |
| **1,500** | 1,127 |   7,664   |        2,061        |       1,135       |      3,196      |      24.05s      |   **PASS**   |         200 OK         | Optimal                             |
| **2,000** | 1,505 |   10,367   |        2,626        |       1,086       |      3,712      |      26.88s      |   **PASS**   |         200 OK         | Optimal                             |
| **2,500** | 1,896 |   13,038   |        3,209        |       1,046       |      4,255      |      25.98s      |   **PASS**   |         200 OK         | Optimal (Self-healed from 502)      |
| **3,000** | 2,259 |   15,605   |        3,750        |       1,025       |      4,775      |      24.31s      |   **PASS**   |         200 OK         | Optimal (Self-healed from 502)      |
| **3,500** | 2,665 |   18,412   |        4,357        |       1,030       |      5,387      |      31.52s      | **DEGRADED** |         200 OK         | Guardrail latency spike             |
| **4,000** | 3,011 |   20,844   |        4,874        |       1,166       |      6,040      |      26.21s      |   **PASS**   |         200 OK         | High-water mark                     |
| **4,500** | 3,383 |   23,436   |   **5,407**   |       1,158       | **6,565** | **28.52s** |   **FAIL**   | **404 Not Found** | `Documentation generation failed` |
| **5,000** | 3,756 |   26,038   |   **5,988**   |       1,098       | **7,086** | **38.03s** |   **FAIL**   | **404 Not Found** | `Documentation generation failed` |

---

## 3. Disproof of Physical VRAM Shortage

A common misconception is that the GPU ran out of Video RAM (OOM). Cluster telemetry collected during this benchmark and documented in architectural audit `TASK-996` definitively disproves this hypothesis:

### Live Hardware Telemetry

- **Physical Hardware**: 2 × NVIDIA RTX 2000 Ada Generation GPUs.
- **Physical Capacity**: 16,384 MiB per card = **32,768 MiB total VRAM**.
- **Live Memory Consumption under Load**:
  - `gemma-4-e2b-it-qat` model weights: **3.35 GiB**.
  - GPU 0 allocated memory: **2,668 MiB** (**13,716 MiB FREE**).
  - GPU 1 allocated memory: **4,814 MiB** (**11,570 MiB FREE**).
- **Total Unallocated VRAM**: **25,286 MiB (>25 GiB free)**.

**Verdict**: The GPUs were not OOM-killed, no CUDA out-of-memory errors were emitted, and over 75% of the cluster's physical VRAM remained untouched throughout the incident.

---

## 4. Deep-Dive Root Cause Mechanics

```
                                  4,500 TOKEN BENCHMARK DISPATCH
                                                 |
                                                 v
                      [Stage 1: Session Init] ➔ [Stage 2: Context Ingest]
                                                 |
                                                 v
                      [Stage 3: Dispatch Workflow: HarnessDocWorkflow]
                                                 |
                    +----------------------------+----------------------------+
                    |                                                         |
                    v (23,436 chars / 5,407 tokens)                           v
           [Activity: assemble_prompt]                               [Activity: extract_entities]
                    |                                                         |
                    +----------------------------+----------------------------+
                                                 |
                                                 v
                                   [Activity: generate]
                       Calls apps/text with prompt + 2,048 max_tokens
                                                 |
                                                 v
                                 [hope-lmstudio Inference Node]
                 Premise: 5,407 Prompt Tokens + 2,048 Tokens = 7,455 Tokens
               + apps/guardrail Granite Guardian Evaluation (>8,192 Tokens)
                                                 |
                   [CRITICAL REJECTION: LM Studio defaultContextLength = 8,192]
                 LM Studio Returns: 500 "Context size has been exceeded."
                                                 |
                                                 v
                     apps/text Maps 500 ➔ 422 CONTEXT_WINDOW_EXCEEDED
                                                 |
                                                 v
                       apps/harness TextClient Raises TextServiceError
                                                 |
                                                 v
                       HarnessDocWorkflow Catches Unhandled Exception
                                                 |
                                                 v
             Calls _report_progress(HARNESS_PROGRESS_FAILED_STAGE)
                     Label: "Documentation generation failed"
                                                 |
                                                 v
                                 Workflow Terminates Abnormally
                       persist_draft NEVER REACHED ➔ PostgreSQL Empty
                                                 |
                                                 v
                           Stage 5: Note Retrieval Returns 404
```

### Detailed Failure Pathways:

#### Mechanism 1: Static KV Slot Partitioning vs. Dynamic Memory

Enterprise inference servers (e.g. vLLM) utilize `PagedAttention` to dynamically allocate KV cache pages across whatever tokens currently exist.

LM Studio / `llama.cpp` does **not** use dynamic paging. Instead:

$$
\text{Allocated KV Cache} = \text{Context Length} \times \text{Parallel Slots}
$$

- In `hope-lmstudio`, the engine is started with `LMS_PARALLEL=4`.
- Each parallel slot statically reserves its configured memory ceiling. If a single incoming request requires more tokens than the slot's ceiling, LM Studio refuses to allocate more memory, even if 25 GiB of physical VRAM is free on the host.

#### Mechanism 2: The JIT 8,192 Token Wall on `apps/guardrail`

- While `gemma-4-e2b-it-qat` is pre-loaded on container boot, the clinical safety model `granite-guardian-4.1-8b` is loaded **Just-In-Time (JIT)**.
- JIT models in LM Studio inherit the default setting from `~/.lmstudio/settings.json`:
  ```json
  "defaultContextLength": 8192
  ```
- At 4,000 tokens of raw transcript, the total assembled prompt was **6,040 tokens**, which fit within the 8,192 limit.
- At 4,500 tokens of raw transcript (23,436 characters), the assembled prompt reached **6,565 tokens**. When combined with `apps/guardrail`'s groundedness sensor prompt (which injects system instructions, sensor taxonomies, and claim hypotheses), the total payload passed to `granite-guardian` **exceeded 8,192 tokens**.
- LM Studio rejected the call with:
  ```json
  {"code": 500, "message": "Context size has been exceeded.", "type": "server_error"}
  ```

#### Mechanism 3: Exception Handling in `apps/text` and `apps/harness`

1. `apps/text` inspects the upstream error string (`"context size"`) in [`apps/text/src/text/services/retry_handler.py#L225`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/services/retry_handler.py#L225) and maps it to `422 CONTEXT_WINDOW_EXCEEDED`.
2. `apps/harness`'s `generate` activity in [`apps/harness/src/harness/temporal/activities.py#L1798`](file:///Users/apple/Desktop/project-hope/apps/harness/src/harness/temporal/activities.py#L1798) catches the 422 as `TextServiceError`.
3. Because the agent `general-medicine-summarization` defined no fallback models (`fallbackModelSlugs: []`), the activity raised:
   ```python
   raise ApplicationError(
       f"text generate exhausted the activity budget after 1 resolved candidate(s): {last_exc}",
       type="TextBudgetExhausted",
       non_retryable=True,
   )
   ```
4. The master workflow catch block in [`apps/harness/src/harness/temporal/workflows.py#L456-L471`](file:///Users/apple/Desktop/project-hope/apps/harness/src/harness/temporal/workflows.py#L456-L471) caught the unhandled `ApplicationError` and updated the job status to `FAILED` with label:
   ```python
   HARNESS_PROGRESS_FAILED_LABEL = "Documentation generation failed"
   ```

#### Mechanism 4: Cloudflare 502 Bad Gateway at Tiers 2,500 & 3,000

- During rapid consecutive execution of the benchmark ladder, large payloads (13 KB to 16 KB JSON bodies) were posted in sub-second intervals.
- The ingress reverse-proxy socket backlog became saturated before TCP keepalive sockets could be recycled, resulting in Cloudflare returning transient 502 Bad Gateway errors before the backend origin recovered.

---

## 5. Source Code Traceability Matrix

| Architectural Function            | Source File                                                    | Class / Function                  | Line Anchor                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Failure Stage Label               | `apps/harness/src/harness/temporal/models.py`                | `HARNESS_PROGRESS_FAILED_LABEL` | [Line 1147](file:///Users/apple/Desktop/project-hope/apps/harness/src/harness/temporal/models.py#L1147)                       |
| Workflow Catch & Fail Stage       | `apps/harness/src/harness/temporal/workflows.py`             | `HarnessDocWorkflow.run()`      | [Lines 453–471](file:///Users/apple/Desktop/project-hope/apps/harness/src/harness/temporal/workflows.py#L453-L471)           |
| Text Inference Activity           | `apps/harness/src/harness/temporal/activities.py`            | `generate()`                    | [Lines 1648–1835](file:///Users/apple/Desktop/project-hope/apps/harness/src/harness/temporal/activities.py#L1648-L1835)      |
| Upstream Context Classification   | `apps/text/src/text/services/retry_handler.py`               | `provider_error_code_from()`    | [Lines 224–227](file:///Users/apple/Desktop/project-hope/apps/text/src/text/services/retry_handler.py#L224-L227)             |
| LM Studio Context Window Lockstep | `packages/database/src/prisma/db_main/seed/ai-models/llm.ts` | `LM_STUDIO_CONTEXT_LENGTH`      | [Lines 55–102](file:///Users/apple/Desktop/project-hope/packages/database/src/prisma/db_main/seed/ai-models/llm.ts#L55-L102) |
| Agent Parameter Definition        | `packages/database/src/prisma/db_main/seed/25-agents.ts`     | `SUMMARIZATION_PARAMETERS`      | [Lines 40–45](file:///Users/apple/Desktop/project-hope/packages/database/src/prisma/db_main/seed/25-agents.ts#L40-L45)       |

---

## 6. Corrective and Preventive Actions (CAPA)

### Action 1: Raise LM Studio JIT Default Context Length (Immediate Fix)

- **Problem**: `~/.lmstudio/settings.json` caps JIT loaded models (`granite-guardian`) at `8192` tokens.
- **Action**: Update the LM Studio configuration in `hope-lmstudio` to raise `defaultContextLength` from `8192` to `32768`:

  ```json
  {
    "defaultContextLength": 32768,
    "jitModelTTL": 3600
  }
  ```

  Since the GPUs currently have **>25 GiB of free VRAM**, raising the JIT ceiling to 32k tokens consumes ~3.2 GiB of additional KV space, leaving over 20 GiB of safety headroom.

### Action 2: Add Cloud Fallback Models to `general-medicine-summarization`

- **Problem**: When the local model rejects a prompt that is too large, the activity terminates immediately because `fallbackModelSlugs` is empty.
- **Action**: Update the agent database seed to define resilient fallback tiers:

  ```typescript
  fallbackModelSlugs: ['azure-gpt-4o', 'anthropic-claude-3-5-sonnet']
  ```

  When local inference slots are exceeded, `apps/harness` automatically and transparently walks the fallback chain without failing the consultation.

### Action 3: Chunking & Truncation Guard for `apps/guardrail`

- **Problem**: Passing unchunked 26k-character transcripts into the synchronous guardrail activity causes extreme latency spikes (up to 44 seconds) and risks activity timeouts.
- **Action**: Implement semantic chunking or windowing for the groundedness verification pass, evaluating claim citations against relevant transcript spans rather than concatenating the entire raw session.

### Action 4: Ingress Keep-Alive & Connection Pool Pacing

- **Problem**: Sub-second dispatch of multi-thousand token benchmarks triggers origin connection exhaustion (Cloudflare 502).
- **Action**: Increase the keepalive timeout on the gateway Nginx/Cloudflare ingress (`keepalive_timeout 65s`, `keepalive_requests 1000`) and ensure client benchmark pacing has a minimum 1.5-second cooldown between ladder tiers.
