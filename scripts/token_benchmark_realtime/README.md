# HOPE Token-Based Latency & Stability Benchmark Suite

This directory contains the production-grade load testing, latency benchmarking, real-time bilingual translation, and stability evaluation suite for the HOPE Clinical Summarization Engine.

The suite benchmarks the full microservice pipeline across incremental token scales (from **500 to 10,000+ tokens**), multi-doctor parallel consultations, and batch clinical encounter datasets against deployed or local Kubernetes environments.

---

## Directory Structure

```
scripts/token_benchmark_realtime/
├── README.md                              # This comprehensive operation & architecture guide
├── parallel_transcript_benchmark.py       # Multi-worker parallel runner & multi-doctor simulator
├── batch_transcript_benchmark.py          # Sequential batch runner (1 encounter at a time)
├── token_latency_benchmark_realtime.py    # Bilingual (Malayalam+English) token-ladder scaling runner
├── token_latency_benchmark.py             # Baseline full-pipeline token-ladder benchmark
│
├── data/                                  # Benchmark input transcripts & clinical datasets
│   ├── web_validation_output.csv          # 48 authentic clinical consultation transcripts
│   ├── realtime_transcript.txt            # Real-time Malayalam+English transcript (~784 tokens)
│   ├── realtime_transcript_9000tok.txt    # Extended high-token consultation dialogue (~9,000 tokens)
│   └── realtime_transcript_sample.txt     # Clean reference copy of real-time consultation
│
├── reports/                               # Auto-generated Excel & Markdown evaluation metrics
│   ├── parallel_benchmark_results.xlsx    # Concurrency benchmark run results
│   ├── parallel_gpu_metrics.xlsx          # GPU utilization & VRAM allocation across workers
│   ├── parallel_benchmark_report.md       # Formatted Markdown report for parallel runs
│   ├── batch_validation_benchmark_results.xlsx # Sequential batch results
│   ├── batch_validation_gpu_metrics.xlsx  # Sequential batch GPU metrics
│   ├── batch_validation_report.md         # Sequential batch Markdown report
│   ├── token_benchmark_realtime_results.xlsx   # Token-ladder scaling results
│   ├── token_benchmark_realtime_gpu_metrics.xlsx
│   └── token_benchmark_realtime_report.md
│
├── summaries/                             # Generated clinical SOAP notes & structured JSONs
│   ├── <case_name>_summary.md             # Clinical summary output per encounter
│   └── latest_summary.md                  # Symlink / copy of the most recently generated note
│
└── docs/                                  # Architectural specifications & system diagrams
    ├── LLM_SERVICE_END_TO_END_ARCHITECTURE.md
    └── assets/
        └── pipeline_architecture.png
```

---

## Architecture & Dual-GPU Hardware Topology

The pipeline connects to the HOPE microservices ecosystem orchestrated via Temporal and dual hardware-pinned GPUs:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   KUBERNETES CLUSTER                                    │
│                                                                                         │
│  [API Gateway]             [Harness Worker]              [NLP Service]                  │
│  apps/api (:8866)          hope-harness-worker           apps/nlp (:8864)               │
│  Auth, Ingress, Routing    Temporal Orchestrator         Entity Extraction & NLI        │
│                                                                                         │
│  [Text Service]            [Guardrail Service]           [Context Vault DB]             │
│  apps/text (:8862)         apps/guardrail (:8863)        PostgreSQL + pgvector          │
│  LLM Gateway & Dispatcher  Safety & Policy Judge         Clinical Session State         │
└─────────────────────────────────────────┬───────────────────────────────────────────────┘
                                          │
                        ┌─────────────────┴─────────────────┐
                        │   LM STUDIO INFERENCE ENGINE      │
                        ├─────────────────┬─────────────────┤
                        │  GPU 0 (16 GB)  │  GPU 1 (16 GB)  │
                        │  ─────────────  │  ─────────────  │
                        │  gemma-4-e2b    │  granite-       │
                        │  (Note Gen &    │  guardian-4.1   │
                        │   Translation)  │  (Safety Judge) │
                        └─────────────────┴─────────────────┘
```

### Complete Hop Execution Flow

Each consultation benchmark measures end-to-end latency across these microservice boundaries:

- **Hop 1: Open Consultation Session** (`Client → API Gateway ↔ PostgreSQL`)  
  Initializes an authenticated clinical consultation session bound to the acting clinician and department.
- **Hop 2: Transcript Context Ingestion** (`Gateway ↔ Context Vault / Redis`)  
  Stores conversational transcript turns into the context vault for temporal assembly.
- **Hop 3: Dispatch Summary Workflow** (`Gateway ↔ Temporal Workflow Queue`)  
  Dispatches the asynchronous `HarnessDocWorkflow` job to the Temporal orchestration queue.
- **Hop 4: Pipeline Execution & Note Generation** (`Temporal ↔ apps/text ↔ LM Studio GPU`):
  - **Hop 4.1: NLP Entity Extraction** (`apps/nlp`): Extracts SNOMED-CT, ICD-10, and RxNorm clinical entities.
  - **Hop 4.2: Inbound Guardrail Screen** (`apps/guardrail ↔ GPU 1`): Pre-flight safety and clinical relevance screen using Granite Guardian.
  - **Hop 4.3: Prompt Assembly & DNA Matching** (`apps/api`): Assembles doctor preference DNA, specialty formatting, and context into a structured prompt.
  - **Hop 4.4: Primary SOAP Generation & Translation** (`apps/text ↔ GPU 0`): Autoregressive generation and native multilingual translation via `gemma-4-e2b-it-qat`.
  - **Hop 4.5: Outbound Guardrail & PII Screen** (`apps/guardrail ↔ apps/nlp`): Validates groundedness against source dialogue and screens outbound text.

---

## Configuration & Default Credentials

| Parameter | Default Value | Description |
| :--- | :--- | :--- |
| **Ingress Target** | `https://adminconsole-vox.arcaai.com` | Base URL of deployed API gateway / Admin Console |
| **Admin Username** | `admin` | Auto-authentication admin account |
| **Admin Password** | `56527cb5d1adad66bb21a662e55421b9` | Admin account secret |
| **Tenant Key** | `ARCAAI` (`50000000-0000-0000-0000-000000000001`) | Primary hospital tenant identifier |
| **Workflow Definition** | `arcaai-gen-consultation` | Consultation orchestrator workflow slug |
| **Summarization Agent** | `arcaai-gen-summary-new-visit` | Specialty clinical summarization agent slug |
| **Default Department** | `70000000-0000-0000-0001-000000000001` | General Medicine Department |

---

## Script Overview & CLI Usage

### 1. Parallel Batch & Multi-Doctor Benchmark (`parallel_transcript_benchmark.py`)

Simulates parallel clinical encounters across multiple concurrent doctors and exam rooms.

#### Key Features:
- **100% Real Production Workflow (Hops 1–5)**: Runs only the authentic clinical consultation pipeline (Open Session $\rightarrow$ Ingest Context $\rightarrow$ Dispatch Temporal Workflow $\rightarrow$ Poll Pipeline Execution $\rightarrow$ Fetch Clinical Note) with zero artificial sub-hop probes or simulated GPU metrics.
- **Multi-Doctor Concurrency Pool (`--doctors`)**: Assigns individual workers to distinct doctors (e.g., `--doctors test1,test2`). Each thread dynamically logs in, impersonates the clinician, and binds to their respective department.
- **Automated Concurrency Sweep (`--sweep` / `--concurrency-levels`)**: Sweeps throughput across levels (e.g., `1, 2, 4, 8, 16, 32`).
- **Custom Transcript Ingestion (`--transcript-file` / `--transcript-text`)**: Ingests custom real-time notes directly without modifying datasets.

#### Usage Examples:

```bash
# 1. Run 2 parallel doctors (test1, test2) on a real-time transcript:
python3 scripts/token_benchmark_realtime/parallel_transcript_benchmark.py \
  --transcript-file scripts/token_benchmark_realtime/data/realtime_transcript.txt \
  --tenant-key ARCAAI \
  --doctors test1,test2 \
  --concurrency 2

# 2. Stress test long consultation dialog (9,000 tokens) with 4 concurrent workers:
python3 scripts/token_benchmark_realtime/parallel_transcript_benchmark.py \
  --transcript-file scripts/token_benchmark_realtime/data/realtime_transcript_9000tok.txt \
  --tenant-key ARCAAI \
  --concurrency 4

# 3. Run automated concurrency sweep across [1, 2, 4, 8] on the authentic CSV dataset:
python3 scripts/token_benchmark_realtime/parallel_transcript_benchmark.py \
  --csv-file scripts/token_benchmark_realtime/data/web_validation_output.csv \
  --concurrency-levels 1,2,4,8 \
  --limit 8
```

---

### 2. Sequential Batch Benchmark (`batch_transcript_benchmark.py`)

Processes consultation encounters sequentially one-by-one from CSV datasets or specific row indices.

#### Key Features:
- Sequential execution ensures stable baseline measurements without worker contention.
- Supports row targeting (`--row N`), resumption (`--start-index N`), and case name filtering (`--file-filter`).

#### Usage Examples:

```bash
# 1. Run single encounter (Row 1 - George GERD):
python3 scripts/token_benchmark_realtime/batch_transcript_benchmark.py \
  --row 1 \
  --skip-subhops

# 2. Process first 5 encounters in sequence:
python3 scripts/token_benchmark_realtime/batch_transcript_benchmark.py \
  --limit 5 \
  --skip-subhops

# 3. Resume batch from Row 20 onwards:
python3 scripts/token_benchmark_realtime/batch_transcript_benchmark.py \
  --start-index 20 \
  --limit 10 \
  --skip-subhops
```

---

### 3. Bilingual Realtime Latency & Token Ladder (`token_latency_benchmark_realtime.py`)

Evaluates performance and native translation latency across expanding dialogue token scales (from 500 to 10,000 tokens).

#### Key Features:
- **Bilingual Audio-Text Handling**: Malayalam / Manglish source dialogue translated and structured into standard clinical English notes.
- **Token Tier Laddering (`--token-tiers`)**: Progressively tests increasing dialogue sizes (`500, 1000, 2000, 4000, 6000, 8000, 10000`).
- **Remote GPU Telemetry (`--enable-gpu-telemetry`, `--gpu-ssh`)**: Captures real-time VRAM allocation and compute load from remote GPU clusters via `nvidia-smi`.

#### Usage Examples:

```bash
# 1. Run single-pass benchmark on custom Malayalam transcript:
python3 scripts/token_benchmark_realtime/token_latency_benchmark_realtime.py \
  --transcript-file scripts/token_benchmark_realtime/data/realtime_transcript.txt \
  --single-run

# 2. Run full token ladder (500 to 8000 tokens) with remote GPU telemetry:
python3 scripts/token_benchmark_realtime/token_latency_benchmark_realtime.py \
  --transcript-file scripts/token_benchmark_realtime/data/realtime_transcript_9000tok.txt \
  --token-tiers 500,1000,2000,4000,8000 \
  --enable-gpu-telemetry \
  --gpu-ssh vidit@192.168.112.2
```

---

### 4. Full-Pipeline Token Benchmark (`token_latency_benchmark.py`)

Baseline token-ladder benchmark focused on English clinical dialogue scaling and microservice hop latency breakdown.

#### Usage Example:

```bash
python3 scripts/token_benchmark_realtime/token_latency_benchmark.py \
  --token-tiers 1000,2000,4000 \
  --skip-subhops
```

---

## Diagnostic Tips & Troubleshooting

### 1. Synthetic Sub-Hop Error: `[422] Content was blocked by the safety guardrail`
- **Cause**: Hops 4.1 to 4.5 are diagnostic benchmark probes that send sliced, raw transcript segments directly to `/text-generations/generate/assembled`. Without full clinical metadata, Granite Guardian heuristics can flag raw dialogue fragments.
- **Resolution**: Use `--skip-subhops`. This bypasses synthetic probes and benchmarks the true end-to-end production pipeline (Hops 1–4) which packages full clinical context.

### 2. Stage 4 Timeout: `ReasoningBudgetExhaustedError`
- **Cause**: In certain consultation agents (e.g. `arcaai-gen-summary-new-visit`), Gemma-4-e2b engages in extended internal chain-of-thought (`<thought>...</thought>`). If reasoning consumes several thousand tokens, the model can hit the output token limit before completing the full 10-section JSON schema.
- **Resolution**: Ensure model inference parameters use `temperature: 0` or enforce an explicit reasoning budget constraint on LM Studio GPU 0.

### 3. Multi-Doctor Impersonation & Permissions
- When passing `--doctors test1,test2`, the benchmark queries `/api/hope/admin/users`, resolves user IDs, and elevates session cookies via `/api/auth/impersonate`. Ensure the specified usernames exist in the target tenant and possess active departmental bindings.
