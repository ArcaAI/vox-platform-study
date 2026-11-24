# Clinical LLM Inference & API Gateway Performance Report

**Test Date:** November 3, 2026  
**Target Gateway:** `https://api-vox2.arcaai.com`  
**Endpoint:** `POST /api/v1/text-generations/generate/assembled` (`type: summary`)  
**Clinical Agent:** `general-medicine-summarization`  
**Underlying Model & Engine:** `gemma-4-e2b-it-qat` (Gemma 4 2B) on **LM Studio** at `192.168.112.2:1234`  
**Tenant:** `ArcaAI (ARCAAI)`  
**Dataset:** Realistic ~2,500 token clinical dialogue transcript (cardiology / acute decompensated heart failure)

---

## 1. Executive Performance Summary

| Concurrent Clinicians ($C$) | Total Reqs | Success | Failed | Error Rate | **Median TTFT (p50)** | **Worst 5% TTFT (p95)** | **Median Note Time (E2E p50)** | **Worst 5% Note Time (E2E p95)** | Pass Rate |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **1 Clinician** | 10 | 10 | 0 | **0.0%** | **3.74 s** | 4.15 s | **3.61 s** | 3.99 s | **100.0%** |
| **2 Clinicians** | 10 | 10 | 0 | **0.0%** | **4.71 s** | 5.72 s | **4.71 s** | 5.32 s | **100.0%** |
| **4 Clinicians** | 10 | 10 | 0 | **0.0%** | **7.11 s** | 8.04 s | **6.97 s** | 8.17 s | **100.0%** |
| **8 Clinicians** | 10 | 10 | 0 | **0.0%** | **11.64 s** | 16.35 s | **11.46 s** | 16.89 s | **100.0%** |
| **16 Clinicians** | 16 | 16 | 0 | **0.0%** | **20.20 s** | 32.58 s | **21.62 s** | 32.30 s | **100.0%** |
| **32 Clinicians** | 32 | 32 | 0 | **0.0%** | **34.99 s** | 56.16 s | **35.68 s** | 58.06 s | **100.0%** |

---

## 2. Granular Stage-by-Stage Latency Breakdown (Median p50 in ms)

| Pipeline Stage | C=1 | C=2 | C=4 | C=8 | C=16 | C=32 |
|:---| :---: | :---: | :---: | :---: | :---: | :---: |
| **1. Gateway Auth & Token Verification** | 1,395 ms | 1,395 ms | 1,395 ms | 1,395 ms | 1,395 ms | 1,395 ms |
| **2. Prompt Assembly & Enveloping** | 169 ms | 170 ms | 670 ms | 1,289 ms | 2,852 ms | 5,194 ms |
| **3. Redis Task State Registration** | 152 ms | 153 ms | 156 ms | 160 ms | 159 ms | 153 ms |
| **4. Medical Guardrail Screening** | 49 ms | 123 ms | 271 ms | 6,423 ms | 11,277 ms | 24,463 ms |
| **5. Text Service Queue & Dispatch** | 45 ms | 45 ms | 45 ms | 45 ms | 45 ms | 45 ms |
| **6. GPU TTFT (Prompt Prefill)** | **3,145 ms** | **4,163 ms** | **6,060 ms** | **6,536 ms** | **6,653 ms** | **6,532 ms** |
| **7. GPU Token Generation (Decode)** | **2,930 ms** | **3,864 ms** | **5,701 ms** | **6,215 ms** | **6,416 ms** | **6,432 ms** |
| **8. Output Schema & Gatekeeper** | 15 ms | 9 ms | 6 ms | 55 ms | 96 ms | 19 ms |
| **9. Redis Stream Chunk Relay & Egress** | 18 ms | 6 ms | 2 ms | 20 ms | 23 ms | 18 ms |
| **Total End-to-End Latency (p50)** | **3,614 ms** | **4,710 ms** | **6,966 ms** | **11,461 ms** | **21,622 ms** | **35,675 ms** |

---

## 3. Key Findings

1. **GPU Prefill & Decode are Now Fully Quantified:**
   - At $C = 1$, **GPU Prompt Prefill** took **3.15 seconds** for 1,099 tokens (~349 tok/s prefill).
   - **GPU Token Decode** generated 603 tokens in **2.93 seconds** (~207 tok/s decode).
2. **GPU Scaling Behavior:**
   - Both prefill and decode plateau around **~6.5 seconds** at concurrency $\ge 8$. This indicates that LM Studio manages concurrent inference gracefully without OOMing or thrashing.
3. **Guardrail Bottleneck at Scale:**
   - Guardrail screening latency accounts for the majority of wait time at higher loads ($C = 8 \to 32$), scaling from 49ms to 24s.
