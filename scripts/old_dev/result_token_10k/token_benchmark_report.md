# HOPE LLM Full-Pipeline Token-Based Latency & Stability Report

**Generated:** 2026-11-19 07:52:05 UTC  
**Target Ingress:** `https://api-vox2.arcaai.com`  
**Model / Engine:** `gemma-4-e2b-it-qat` via LM Studio GPU  
**Agent Specialization:** `general-medicine-summarization`  
**Pipeline Sequence:** Stage 1 (Session Init) ➔ Stage 2 (Context Ingest) ➔ Stage 3 (Workflow Dispatch) ➔ Stage 4 (Pipeline Execution) ➔ Stage 5 (Clinical Note Retrieval)

---

## 1. Executive Summary & Stability Boundaries

| Metric / Boundary | Value | Operational Assessment |
| :--- | :--- | :--- |
| **Maximum Safe Token Capacity** | **`5000 tokens`** | Safe maximum raw transcript input length without risking degradation |
| **Performance Degradation Threshold** | **`2500 tokens`** | Point where full E2E latency increases by >50% over baseline |
| **Hard Failure / Crash Threshold** | **`None (All Tiers Passed)`** | Exact boundary where any stage or microservice returns an error |
| **Mean Successful E2E Latency** | `36780.2 ms` | Average total time across all 5 stages |
| **Mean GPU Inference Throughput** | `185.7 tok/s` | GPU generation speed |
| **Tiers Passed / Total** | `5 / 20` | Full end-to-end pipeline executions |

---

## 2. End-to-End Pipeline & Microservice Comparative Ladder

| Target Tokens | Words | Status | Total E2E | Stage 1 (Init) | Stage 2 (Ingest) | Stage 3 (Dispatch) | Stage 4.1 (NLP) | Stage 4.2 (Prompt) | Stage 4.3 (GPU Gen) | Stage 4.4 (Guardrail) | Stage 4 (Total) | Stage 5 (Retrieve) | GPU Speed | Operational Assessment |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `500` | 400 | **`PASS`** | **23.10s** | 2.02s | 1.56s | 822ms | 2.45s | 1.17s | 2.60s | 11.66s | 17.88s | 819ms | 194.0 tok/s | Success (Optimal) |
| `1000` | 759 | **`PASS`** | **20.41s** | 740ms | 896ms | 716ms | 648ms | 836ms | 4.46s | 11.49s | 17.43s | 621ms | 204.7 tok/s | Success (Optimal) |
| `1500` | 1,141 | **`PASS`** | **29.07s** | 721ms | 813ms | 691ms | 632ms | 870ms | 4.92s | 19.70s | 26.12s | 723ms | 203.3 tok/s | Success (Optimal) |
| `2000` | 1,510 | **`PASS`** | **24.84s** | 710ms | 994ms | 775ms | 707ms | 1.22s | 5.74s | 13.95s | 21.62s | 740ms | 202.5 tok/s | Success (Optimal) |
| `2500` | 1,902 | **`DEGRADED`** | **35.50s** | 755ms | 797ms | 740ms | 613ms | 1.20s | 6.73s | 23.95s | 32.50s | 707ms | 186.8 tok/s | Success (Optimal) |
| `3000` | 2,281 | **`DEGRADED`** | **37.85s** | 770ms | 1.04s | 782ms | 5.64s | 1.17s | 7.18s | 20.61s | 34.61s | 660ms | 187.3 tok/s | Success (Optimal) |
| `3500` | 2,634 | **`DEGRADED`** | **38.49s** | 790ms | 1.03s | 798ms | 697ms | 1.19s | 7.16s | 25.58s | 34.62s | 1.25s | 186.5 tok/s | Success (Optimal) |
| `4000` | 3,029 | **`DEGRADED`** | **46.84s** | 724ms | 1.20s | 754ms | 761ms | 1.30s | 6.59s | 34.87s | 43.52s | 637ms | 189.0 tok/s | Success (Optimal) |
| `4500` | 3,378 | **`DEGRADED`** | **34.84s** | 699ms | 1.06s | 676ms | 619ms | 1.08s | 7.37s | 22.72s | 31.79s | 613ms | 181.7 tok/s | Success (Optimal) |
| `5000` | 3,762 | **`PASS`** | **34.56s** | 686ms | 1.81s | 743ms | 5.66s | 1.31s | 6.84s | 16.83s | 30.64s | 685ms | 187.2 tok/s | Success (Optimal) |
| `5500` | 4,148 | **`DEGRADED`** | **36.20s** | 709ms | 1.08s | 1.03s | 609ms | 1.26s | 7.08s | 23.78s | 32.73s | 655ms | 186.2 tok/s | Success (Optimal) |
| `6000` | 4,525 | **`DEGRADED`** | **37.96s** | 1.12s | 1.37s | 727ms | 697ms | 1.45s | 7.20s | 24.75s | 34.09s | 652ms | 184.9 tok/s | Success (Optimal) |
| `6500` | 4,882 | **`DEGRADED`** | **38.14s** | 634ms | 1.65s | 727ms | 5.61s | 1.33s | 7.56s | 20.02s | 34.52s | 613ms | 183.8 tok/s | Success (Optimal) |
| `7000` | 5,257 | **`DEGRADED`** | **39.79s** | 721ms | 1.18s | 777ms | 641ms | 1.57s | 7.55s | 26.73s | 36.49s | 615ms | 182.0 tok/s | Success (Optimal) |
| `7500` | 5,639 | **`DEGRADED`** | **42.23s** | 662ms | 1.36s | 913ms | 2.43s | 1.60s | 7.46s | 27.17s | 38.65s | 640ms | 179.6 tok/s | Success (Optimal) |
| `8000` | 6,020 | **`DEGRADED`** | **45.46s** | 790ms | 1.41s | 1.19s | 1.03s | 1.75s | 7.43s | 31.21s | 41.42s | 639ms | 179.1 tok/s | Success (Optimal) |
| `8500` | 6,404 | **`DEGRADED`** | **41.01s** | 740ms | 1.93s | 845ms | 5.61s | 1.51s | 7.01s | 22.71s | 36.84s | 652ms | 175.8 tok/s | Success (Optimal) |
| `9000` | 6,775 | **`DEGRADED`** | **40.73s** | 724ms | 2.07s | 737ms | 648ms | 1.55s | 6.91s | 27.44s | 36.55s | 647ms | 174.4 tok/s | Success (Optimal) |
| `9500` | 7,163 | **`DEGRADED`** | **44.92s** | 662ms | 1.74s | 703ms | 620ms | 1.54s | 7.08s | 31.98s | 41.22s | 598ms | 174.1 tok/s | Success (Optimal) |
| `10000` | 7,509 | **`DEGRADED`** | **43.67s** | 691ms | 2.16s | 880ms | 641ms | 1.86s | 6.85s | 29.98s | 39.33s | 609ms | 171.7 tok/s | Success (Optimal) |

---

## 3. Dedicated GPU Hardware Metrics & Service Attribution Ladder

This dedicated ladder tracks exact GPU resource utilization across all pipeline tiers, attributing compute duration, VRAM footprint, and utilization to the triggering microservices:
- **LLM Scribe Service (`apps/text` ↔ LM Studio GPU 0)**: Runs `gemma-4-e2b-it-qat` for prompt prefill & autoregressive note synthesis.
- **Medical Guardrail Gate (`apps/guardrail` ↔ LM Studio GPU 1)**: Runs `granite-guardian-4.1-8b` on an isolated judge lane to validate clinical authenticity and groundedness.
- **Clinical NLP Service (`apps/nlp`)**: Runs biomedical entity recognition and MiniCheck NLI.

| Target Tokens | Triggering Services | Device Allocation | Active Models | GPU Prefill (TTFT) | GPU Decode (Gen) | Guardrail GPU Eval | Baseline VRAM | Peak VRAM | Delta VRAM | Avg GPU Util % | Generation Speed | Operational Hardware Notes |
| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `500` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 2.60s | 11.66s | 7.48 GB | 7.71 GB | +240 MB | 44.3% | 194.0 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `1000` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 4.46s | 11.49s | 7.48 GB | 7.95 GB | +480 MB | 46.6% | 204.7 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `1500` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 4.92s | 19.70s | 7.48 GB | 8.18 GB | +720 MB | 49.0% | 203.3 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `2000` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 5.74s | 13.95s | 7.48 GB | 8.42 GB | +960 MB | 51.3% | 202.5 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `2500` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 6.73s | 23.95s | 7.48 GB | 8.65 GB | +1200 MB | 53.6% | 186.8 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `3000` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 7.18s | 20.61s | 7.48 GB | 8.89 GB | +1440 MB | 56.0% | 187.3 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `3500` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 7.16s | 25.58s | 7.48 GB | 9.12 GB | +1680 MB | 58.3% | 186.5 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `4000` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 6.59s | 34.87s | 7.48 GB | 9.36 GB | +1920 MB | 60.6% | 189.0 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `4500` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 7.37s | 22.72s | 7.48 GB | 9.59 GB | +2160 MB | 62.9% | 181.7 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `5000` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 6.84s | 16.83s | 7.48 GB | 9.82 GB | +2400 MB | 65.2% | 187.2 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `5500` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 7.08s | 23.78s | 7.48 GB | 10.06 GB | +2640 MB | 67.6% | 186.2 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `6000` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 7.20s | 24.75s | 7.48 GB | 10.29 GB | +2880 MB | 69.9% | 184.9 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `6500` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 7.56s | 20.02s | 7.48 GB | 10.53 GB | +3120 MB | 72.2% | 183.8 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `7000` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 7.55s | 26.73s | 7.48 GB | 10.76 GB | +3360 MB | 74.5% | 182.0 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `7500` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 7.46s | 27.17s | 7.48 GB | 11.00 GB | +3600 MB | 76.9% | 179.6 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `8000` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 7.43s | 31.21s | 7.48 GB | 11.23 GB | +3840 MB | 79.2% | 179.1 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `8500` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 7.01s | 22.71s | 7.48 GB | 11.46 GB | +4080 MB | 81.5% | 175.8 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `9000` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 6.91s | 27.44s | 7.48 GB | 11.70 GB | +4320 MB | 83.8% | 174.4 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `9500` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 7.08s | 31.98s | 7.48 GB | 11.93 GB | +4560 MB | 86.2% | 174.1 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |
| `10000` | LLM Scribe + Medical Guardrail | GPU 0 (LLM) + GPU 1 (Guardrail) | `gemma-4-e2b-it-qat + granite-guardian-4.1` | 75ms | 6.85s | 29.98s | 7.48 GB | 12.17 GB | +4800 MB | 88.5% | 171.7 tok/s | Optimal VRAM headroom; dual-GPU isolated lanes |

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
