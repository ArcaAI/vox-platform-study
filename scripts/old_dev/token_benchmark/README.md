# HOPE Token-Based Latency & Stability Benchmark Suite

This module provides systematic load testing and stability evaluation for the HOPE Clinical Summarization Engine across incremental token scales (from **500 to 5,000+ tokens**), matching the exact real clinician end-to-end workflow.

---

## Architecture Stages Measured

Every token tier executes the complete production workflow:
1. **Stage 1: Session Initialization** (`Client → API Gateway ↔ PostgreSQL`): Opens a consultation encounter session for the patient.
2. **Stage 2: Transcript Context Ingestion** (`Gateway ↔ Context Vault`): Persists the multi-turn doctor-patient transcript as an encrypted `ContextItem`.
3. **Stage 3: Summary Workflow Dispatch** (`Gateway ↔ Temporal Queue`): Enqueues the asynchronous documentation generation workflow.
4. **Stage 4: Scribe Pipeline Execution** (`Temporal Worker ↔ Microservices`):
   - **Stage 4.1: NLP Entity Extraction** (`apps/nlp`): Extracts clinical entities, symptoms, and ICD-10/SNOMED concepts.
   - **Stage 4.2: Prompt & Style DNA Assembly** (`apps/api`): Assembles doctor persona writing style DNA and SOAP structure.
   - **Stage 4.3: Clinical LLM Generation** (`apps/text ↔ LM Studio GPU`): Synthesizes the clinical summary using `gemma-4-e2b-it-qat`.
   - **Stage 4.4: Medical Guardrail Gate** (`apps/guardrail`): Validates clinical assertions, groundedness, and safety.
5. **Stage 5: Clinical Note Retrieval** (`Gateway ↔ PostgreSQL`): Fetches the verified 10-section SOAP clinical note.

---

## Directory Structure

```
scripts/token_benchmark/
├── README.md                          # Documentation & operation guide
├── token_latency_benchmark.py         # Main benchmarking execution script
├── token_benchmark_report.md          # Generated comparative Markdown report
├── token_benchmark_results.xlsx       # Generated Excel workbook (multi-column formatted)
└── token_benchmark_results.csv        # Raw metrics CSV export
```

---

## How to Run

### 1. Default Benchmark Sweep (500 to 5000 tokens in steps of 500)
```bash
python3 scripts/token_benchmark/token_latency_benchmark.py --deployed-url https://api-vox2.arcaai.com
```

### 2. Custom Token Tiers
```bash
python3 scripts/token_benchmark/token_latency_benchmark.py \
  --deployed-url https://api-vox2.arcaai.com \
  --token-tiers 500,1000,1500,2000
```

---

## Deliverables Generated

- **Interactive Markdown Report:** [`token_benchmark_report.md`](file:///Users/apple/Desktop/project-hope/scripts/token_benchmark/token_benchmark_report.md)
- **Formatted Excel Workbook:** [`token_benchmark_results.xlsx`](file:///Users/apple/Desktop/project-hope/scripts/token_benchmark/token_benchmark_results.xlsx)
- **Raw CSV Dataset:** [`token_benchmark_results.csv`](file:///Users/apple/Desktop/project-hope/scripts/token_benchmark/token_benchmark_results.csv)
