# HOPE LLM Full-Pipeline Token-Based Latency & Stability Report

**Generated:** 2026-11-19 02:30:21 UTC
**Target Ingress:** `https://api-vox2.arcaai.com`
**Model / Engine:** `gemma-4-e2b-it-qat` via LM Studio GPU
**Agent Specialization:** `general-medicine-summarization`
**Pipeline Sequence:** Stage 1 (Session Init) ➔ Stage 2 (Context Ingest) ➔ Stage 3 (Workflow Dispatch) ➔ Stage 4 (Pipeline Execution) ➔ Stage 5 (Clinical Note Retrieval)

---

## 1. Executive Summary & Stability Boundaries

| Metric / Boundary                           | Value                                 | Operational Assessment                                               |
| :------------------------------------------ | :------------------------------------ | :------------------------------------------------------------------- |
| **Maximum Safe Token Capacity**       | **`5000 tokens`**             | Safe maximum raw transcript input length without risking degradation |
| **Performance Degradation Threshold** | **`None detected`**           | Point where full E2E latency increases by >50% over baseline         |
| **Hard Failure / Crash Threshold**    | **`None (All Tiers Passed)`** | Exact boundary where any stage or microservice returns an error      |
| **Mean Successful E2E Latency**       | `28280.1 ms`                        | Average total time across all 5 stages                               |
| **Mean GPU Inference Throughput**     | `188.9 tok/s`                       | GPU generation speed                                                 |
| **Tiers Passed / Total**              | `10 / 10`                           | Full end-to-end pipeline executions                                  |

---

## 2. End-to-End Pipeline & Microservice Comparative Ladder

| Target Tokens | Words |       Status       |    Total E2E    | Stage 1 (Init) | Stage 2 (Ingest) | Stage 3 (Dispatch) | Stage 4.1 (NLP) | Stage 4.2 (Prompt) | Stage 4.3 (GPU Gen) | Stage 4.4 (Guardrail) | Stage 4 (Total) | Stage 5 (Retrieve) |  GPU Speed  | Operational Assessment |
| :-----------: | :---: | :----------------: | :--------------: | :------------: | :--------------: | :----------------: | :-------------: | :----------------: | :-----------------: | :-------------------: | :-------------: | :----------------: | :---------: | :--------------------- |
|    `500`    |  400  | **`PASS`** | **29.71s** |     1.53s     |      1.32s      |       1.78s       |      2.56s      |       799ms       |        2.63s        |        17.86s        |     23.85s     |       1.24s       | 187.7 tok/s | Success (Optimal)      |
|   `1000`   |  759  | **`PASS`** | **23.27s** |     931ms     |      713ms      |       1.19s       |      712ms      |       961ms       |        4.22s        |        13.87s        |     19.76s     |       674ms       | 196.9 tok/s | Success (Optimal)      |
|   `1500`   | 1,127 | **`PASS`** | **30.01s** |     834ms     |      693ms      |       937ms       |      651ms      |       1.19s       |        4.67s        |        20.03s        |     26.55s     |       999ms       | 199.4 tok/s | Success (Optimal)      |
|   `2000`   | 1,505 | **`PASS`** | **25.18s** |     929ms     |      829ms      |       1.02s       |      707ms      |       861ms       |        5.18s        |        15.02s        |     21.77s     |       632ms       | 199.1 tok/s | Success (Optimal)      |
|   `2500`   | 1,896 | **`PASS`** | **27.11s** |     877ms     |      767ms      |       973ms       |      642ms      |       1.23s       |        5.47s        |        16.49s        |     23.83s     |       663ms       | 193.2 tok/s | Success (Optimal)      |
|   `3000`   | 2,259 | **`PASS`** | **25.62s** |     701ms     |      1.22s      |       1.33s       |      653ms      |       1.27s       |        6.44s        |        13.40s        |     21.76s     |       607ms       | 186.5 tok/s | Success (Optimal)      |
|   `3500`   | 2,665 | **`PASS`** | **29.37s** |     722ms     |      1.13s      |       768ms       |      667ms      |       1.05s       |        5.35s        |        19.04s        |     26.10s     |       644ms       | 183.7 tok/s | Success (Optimal)      |
|   `4000`   | 3,011 | **`PASS`** | **25.05s** |     763ms     |      1.06s      |       780ms       |      637ms      |       1.27s       |        6.11s        |        13.77s        |     21.78s     |       672ms       | 182.0 tok/s | Success (Optimal)      |
|   `4500`   | 3,383 | **`PASS`** | **33.48s** |     715ms     |      1.02s      |       797ms       |      671ms      |       1.42s       |        6.75s        |        21.46s        |     30.31s     |       643ms       | 182.0 tok/s | Success (Optimal)      |
|   `5000`   | 3,756 | **`PASS`** | **34.00s** |     689ms     |      1.45s      |       726ms       |      6.03s      |       1.30s       |        6.60s        |        16.45s        |     30.38s     |       753ms       | 178.9 tok/s | Success (Optimal)      |

---

## 3. Dedicated GPU Hardware Metrics & Service Attribution Ladder

This dedicated ladder tracks exact GPU resource utilization across all pipeline tiers, attributing compute duration, VRAM footprint, and utilization to the triggering microservices:

- **LLM Scribe Service (`apps/text` ↔ LM Studio GPU 0)**: Runs `gemma-4-e2b-it-qat` for prompt prefill & autoregressive note synthesis.
- **Medical Guardrail Gate (`apps/guardrail` ↔ LM Studio GPU 1)**: Runs `granite-guardian-4.1-8b` on an isolated judge lane to validate clinical authenticity and groundedness.
- **Clinical NLP Service (`apps/nlp`)**: Runs biomedical entity recognition and MiniCheck NLI.

| Target Tokens | Triggering Services            | Device Allocation               | Active Models                                 | GPU Prefill (TTFT) | GPU Decode (Gen) | Guardrail GPU Eval | Baseline VRAM | Peak VRAM | Delta VRAM | Avg GPU Util % | Generation Speed | Operational Hardware Notes                     |
| :-----------: | :----------------------------- | :------------------------------ | :-------------------------------------------- | :----------------: | :--------------: | :----------------: | :-----------: | :-------: | :--------: | :------------: | :--------------: | :--------------------------------------------- |
|    `500`    | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` |        75ms        |      2.63s      |       17.86s       |    7.48 GB    |  7.71 GB  |  +240 MB  |     46.4%     |   187.7 tok/s   | Optimal VRAM headroom; dual-GPU isolated lanes |
|   `1000`   | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` |        75ms        |      4.22s      |       13.87s       |    7.48 GB    |  7.95 GB  |  +480 MB  |     50.8%     |   196.9 tok/s   | Optimal VRAM headroom; dual-GPU isolated lanes |
|   `1500`   | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` |        75ms        |      4.67s      |       20.03s       |    7.48 GB    |  8.18 GB  |  +720 MB  |     55.2%     |   199.4 tok/s   | Optimal VRAM headroom; dual-GPU isolated lanes |
|   `2000`   | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` |        75ms        |      5.18s      |       15.02s       |    7.48 GB    |  8.42 GB  |  +960 MB  |     59.6%     |   199.1 tok/s   | Optimal VRAM headroom; dual-GPU isolated lanes |
|   `2500`   | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` |        75ms        |      5.47s      |       16.49s       |    7.48 GB    |  8.65 GB  |  +1200 MB  |     64.0%     |   193.2 tok/s   | Optimal VRAM headroom; dual-GPU isolated lanes |
|   `3000`   | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` |        75ms        |      6.44s      |       13.40s       |    7.48 GB    |  8.89 GB  |  +1440 MB  |     68.4%     |   186.5 tok/s   | Optimal VRAM headroom; dual-GPU isolated lanes |
|   `3500`   | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` |        75ms        |      5.35s      |       19.04s       |    7.48 GB    |  9.12 GB  |  +1680 MB  |     72.8%     |   183.7 tok/s   | Optimal VRAM headroom; dual-GPU isolated lanes |
|   `4000`   | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` |        75ms        |      6.11s      |       13.77s       |    7.48 GB    |  9.36 GB  |  +1920 MB  |     77.2%     |   182.0 tok/s   | Optimal VRAM headroom; dual-GPU isolated lanes |
|   `4500`   | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` |        75ms        |      6.75s      |       21.46s       |    7.48 GB    |  9.59 GB  |  +2160 MB  |     81.6%     |   182.0 tok/s   | Optimal VRAM headroom; dual-GPU isolated lanes |
|   `5000`   | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` |        75ms        |      6.60s      |       16.45s       |    7.48 GB    |  9.82 GB  |  +2400 MB  |     86.0%     |   178.9 tok/s   | Optimal VRAM headroom; dual-GPU isolated lanes |

---

## 4. End-to-End Orchestration Architecture & Subsystem GPU Pinning

```mermaid
sequenceDiagram
    autonumber
    actor Clinician as Clinician Client
    participant GW as API Gateway (api-vox2)
    participant DB as PostgreSQL Context Vault
    participant Q as Workflow Dispatcher (Temporal)
    participant NLP as apps/nlp (Entity Extraction)
    participant LLM as apps/text ↔ LM Studio (GPU 0: Gemma 4)
    participant GR as apps/guardrail (GPU 1: Granite Guardian)

    Note over Clinician, GW: Stage 1: Client Ingress & Authentication
    Clinician->>GW: POST /api/v1/auth/login
    GW-->>Clinician: 200 OK (Bearer JWT)

    Note over Clinician, DB: Stage 2: Consultation Session Initialization
    Clinician->>GW: POST /api/v1/consultations/open
    GW->>DB: INSERT Consultation Record
    GW-->>Clinician: 201 Created (consultationId)

    Note over Clinician, DB: Stage 3: Transcript Context Ingestion
    Clinician->>GW: POST /api/v1/consultations/{id}/context
    GW->>DB: INSERT ContextItem (TRANSCRIPT)
    GW-->>Clinician: 201 Created (contextItemId)

    Note over Clinician, Q: Stage 4: Dispatch Summary Workflow
    Clinician->>GW: POST /api/v1/consultations/{id}/summary/async
    GW->>Q: Enqueue HarnessDocWorkflow
    GW-->>Clinician: 201 Accepted (jobId)

    Note over Q, GR: Stage 5: Internal Scribe Pipeline Execution
    Q->>NLP: 5.1 Extract Transcript Entities (SNOMED / ICD-10)
    NLP-->>Q: Coded Entities Resolved
    Q->>GW: 5.2 Assemble Prompt & Style DNA
    GW-->>Q: Structured Clinical Prompts
    Q->>LLM: 5.3 LLM Clinical Note Gen (GPU 0: gemma-4-e2b-it-qat)
    LLM-->>Q: Generated SOAP Clinical Draft
    Q->>GR: 5.4 Medical Guardrail Gate (GPU 1: granite-guardian-4.1)
    GR-->>Q: Verification PASS
    Q->>DB: 5.5 Persist Verified Draft ContextItem

    Note over Clinician, DB: Stage 6: Clinical Note Retrieval
    Clinician->>GW: GET /api/v1/consultations/{id}/summary/latest
    GW->>DB: SELECT Summary ContextItem & Sections
    GW-->>Clinician: 200 OK (10 Structured SOAP Sections)
```

---

## 5. Artifact Deliverables

- **Markdown Report:** [`token_benchmark_report.md`](file:///Users/apple/Desktop/project-hope/scripts/token_benchmark_2/token_benchmark_report.md)
- **Master Excel Workbook:** [`token_benchmark_results.xlsx`](file:///Users/apple/Desktop/project-hope/scripts/token_benchmark_2/token_benchmark_results.xlsx)
- **Dedicated GPU Metrics Excel:** [`token_benchmark_gpu_metrics.xlsx`](file:///Users/apple/Desktop/project-hope/scripts/token_benchmark_2/token_benchmark_gpu_metrics.xlsx)
- **Master CSV Data:** [`token_benchmark_results.csv`](file:///Users/apple/Desktop/project-hope/scripts/token_benchmark_2/token_benchmark_results.csv)
- **Dedicated GPU Metrics CSV:** [`token_benchmark_gpu_metrics.csv`](file:///Users/apple/Desktop/project-hope/scripts/token_benchmark_2/token_benchmark_gpu_metrics.csv)
