# HOPE Token-Based Latency & Stability Benchmark Suite

This module provides systematic load testing, latency benchmarking, and stability evaluation for the HOPE Clinical Summarization Engine across incremental token scales (from **500 to 10,000 tokens**) and batch doctor consultations, matching the exact production clinical workflow.

---

## Directory Structure

```
scripts/token_benchmark_2/
├── README.md                              # Documentation & operation guide
├── token_latency_benchmark_realtime.py    # Single-transcript & token scaling runner
├── batch_transcript_benchmark.py          # Sequential batch runner (1 consultation at a time)
├── parallel_transcript_benchmark.py       # Parallel batch runner (2+ consultations concurrently)
├── token_latency_benchmark.py             # Baseline English benchmark
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

## Benchmark Scripts Overview

| Script | Execution Mode | Purpose |
| :--- | :--- | :--- |
| **`parallel_transcript_benchmark.py`** | **Parallel (2 at a time by default)** | High-throughput concurrent execution of doctor consultations from CSV. |
| **`batch_transcript_benchmark.py`** | **Sequential (1 at a time)** | Step-by-step isolated processing of consultations from CSV. |
| **`token_latency_benchmark_realtime.py`** | **Single Transcript & Token Scaling** | Incremental token stress testing (500 to 10,000 tokens) on a specific dialogue. |

---

## How to Run

### 1. Parallel Batch Benchmark (`parallel_transcript_benchmark.py`)
Runs multiple consultations concurrently (default: 2 parallel workers):

```bash
# Run 2 consultations in parallel:
python3 parallel_transcript_benchmark.py --deployed-url https://api-vox2.arcaai.com --limit 2

# Run first 6 consultations (2 at a time):
python3 parallel_transcript_benchmark.py --deployed-url https://api-vox2.arcaai.com --limit 6

# Run all 48 consultations in parallel:
python3 parallel_transcript_benchmark.py --deployed-url https://api-vox2.arcaai.com
```

### 2. Sequential Batch Benchmark (`batch_transcript_benchmark.py`)
Processes consultations one after another in order:

```bash
# Run first consultation only:
python3 batch_transcript_benchmark.py --deployed-url https://api-vox2.arcaai.com --single-run

# Run first 5 consultations sequentially:
python3 batch_transcript_benchmark.py --deployed-url https://api-vox2.arcaai.com --limit 5

# Run all 48 consultations sequentially:
python3 batch_transcript_benchmark.py --deployed-url https://api-vox2.arcaai.com
```

### 3. Token-Ladder Scaling Benchmark (`token_latency_benchmark_realtime.py`)
Scales dialogue across token tiers (500 to 10,000 tokens):
```bash
python3 token_latency_benchmark_realtime.py --deployed-url https://api-vox2.arcaai.com
```
