# HOPE Token-Based Latency & Stability Benchmark Suite

This module provides systematic load testing, latency benchmarking, and stability evaluation for the HOPE Clinical Summarization Engine across incremental token scales (from **500 to 10,000 tokens**) and batch doctor consultations, matching the exact production clinical workflow.

---

## Directory Structure

```
scripts/token_benchmark_realtime/
├── README.md                              # Documentation & operation guide
├── token_latency_benchmark_realtime.py    # Bilingual single-transcript & token scaling runner
├── batch_transcript_benchmark.py          # Sequential batch runner (1 consultation at a time)
├── parallel_transcript_benchmark.py       # Parallel batch runner (2+ consultations concurrently)
├── token_latency_benchmark.py             # Baseline English token benchmark
│
├── data/                                  # Input transcripts & datasets
│   ├── web_validation_output.csv          # 48 Authentic doctor consultation transcripts
│   ├── realtime_transcript.txt            # Real-time Malayalam+English consultation (George GERD)
│   └── realtime_transcript_sample.txt     # Clean reference copy
│
├── reports/                               # Benchmark results & metrics (auto-generated)
│   ├── parallel_benchmark_results.xlsx       # Parallel run Excel results
│   ├── parallel_gpu_metrics.xlsx             # Parallel run GPU hardware metrics
│   ├── parallel_benchmark_report.md          # Parallel run Markdown report
│   ├── batch_validation_benchmark_results.xlsx # Sequential batch Excel results
│   ├── batch_validation_gpu_metrics.xlsx     # Sequential batch GPU metrics
│   ├── batch_validation_report.md            # Sequential batch Markdown report
│   ├── token_benchmark_realtime_results.xlsx # Token-ladder scaling results
│   ├── token_benchmark_realtime_gpu_metrics.xlsx
│   └── token_benchmark_realtime_report.md
│
├── summaries/                             # Generated clinical SOAP notes
│   ├── <case_name>_summary.md             # Individual clinical notes per patient
│   └── latest_summary.md                  # Most recent clinical SOAP note
│
└── docs/                                  # Architectural reference & assets
    ├── LLM_SERVICE_END_TO_END_ARCHITECTURE.md
    └── assets/
        └── pipeline_architecture.png
```

---

## Stage 4 Microservice Execution Breakdown

In accordance with HOPE's architectural flow, each consultation's Stage 4 pipeline measures:
1. **Hop 4.1: NLP Entity Extraction** (`Gateway ↔ apps/nlp`)
2. **Hop 4.2: Inbound Guardrail Screen & Medical Validation** (`Gateway ↔ apps/guardrail` via `POST /safety-checks` or `/guardrails/validate`)
3. **Hop 4.3: Prompt & Style DNA Assembly** (`Gateway ↔ apps/api`)
4. **Hop 4.4: Clinical LLM Note Generation & Translation** (`apps/text ↔ LM Studio GPU 0`)
5. **Hop 4.5: Outbound Guardrail Screen & PII Redaction** (`Gateway ↔ apps/guardrail` via `POST /guardrails/screen/outbound`)

---

## Default Platform Credentials

- **Target Ingress URL**: `https://adminconsole-vox.arcaai.com`
- **Username**: `admin`
- **Password**: `56527cb5d1adad66bb21a662e55421b9`
- **Tenant Key**: `ARCAAI`
- **BFF / Admin Console Ingress Prefix**: `/api/hope` (automatically resolved)

---

## How to Run

### 1. Parallel Batch Benchmark (`parallel_transcript_benchmark.py`)
Runs multiple consultations concurrently (default: 2 parallel workers):

```bash
# Run 2 consultations in parallel:
python3 scripts/token_benchmark_realtime/parallel_transcript_benchmark.py --limit 2

# Run first 6 consultations (2 at a time):
python3 scripts/token_benchmark_realtime/parallel_transcript_benchmark.py --limit 6

# Run all 48 consultations in parallel:
python3 scripts/token_benchmark_realtime/parallel_transcript_benchmark.py
```

### 2. Sequential Batch Benchmark (`batch_transcript_benchmark.py`)
Processes consultations one after another in order:

```bash
# Run first consultation only:
python3 scripts/token_benchmark_realtime/batch_transcript_benchmark.py --limit 1

# Run first 5 consultations sequentially:
python3 scripts/token_benchmark_realtime/batch_transcript_benchmark.py --limit 5

# Run all 48 consultations sequentially:
python3 scripts/token_benchmark_realtime/batch_transcript_benchmark.py
```

### 3. Token-Ladder Scaling Benchmark (`token_latency_benchmark_realtime.py`)
Scales dialogue across token tiers (500 to 10,000 tokens):
```bash
python3 scripts/token_benchmark_realtime/token_latency_benchmark_realtime.py
```
