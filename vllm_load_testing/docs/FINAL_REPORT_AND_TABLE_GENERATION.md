# Benchmark Report & Final Matrix Generation Guide

This guide covers how to generate, format, and interpret the consolidated multi-tier latency comparison tables and CSV reports from the benchmark logs located in `logs/` or custom log directories.

---

## 1. Overview of Reporting Tool

| Script | Primary Purpose | Outputs Generated |
| :--- | :--- | :--- |
| **`generate_final_table.py`** | Scans all `concurrency_*` subdirectories, parses individual `vllm_test_output_<N>.txt` reports, and aggregates the 10-step latency metrics across all concurrency tiers into a unified matrix. | `final_table.md`, `final_table.csv`, CLI Terminal Grid |

---

## 2. Generating the 10-Step Latency Comparison Matrix

### A. Quick Start Commands

#### 1. Generate Markdown Report (Default)
Generates P50, P95, and Average latency matrices in GitHub-flavored Markdown:
```bash
python generate_final_table.py --log-dir logs --output logs/final_table.md
```

#### 2. Generate Multi-Table CSV File
Generates a structured CSV with separate tables for each metric percentile, plus reliability stats:
```bash
python generate_final_table.py --log-dir logs --format csv --output logs/final_table.csv
```

#### 3. Display Directly in Terminal (Grid Format)
Pretty-prints borders and column-aligned tables directly in your terminal console without writing to a file:
```bash
python generate_final_table.py --log-dir logs --format grid
```

---

## 3. CLI Command Options & Flags

`generate_final_table.py` accepts the following arguments:

```bash
python generate_final_table.py [OPTIONS]
```

| Argument | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `--log-dir` | `string` | `logs` | Directory path containing `concurrency_*` folders (or standalone `vllm_test_output_*.txt` files). |
| `--stat` | `choice` | `all` | Specific percentile to display: `p50`, `p95`, `avg`, or `all`. |
| `--format` | `choice` | `markdown` | Output rendering style: `markdown` (pipes and hyphens), `grid` (box drawing), or `csv`. |
| `--output` | `string` | `logs/final_table.md` | Destination file path to save the generated report. If `--format csv`, defaults to `.csv`. |

### Advanced Examples

* **Only output P50 median latency to a custom Markdown file:**
  ```bash
  python generate_final_table.py --log-dir logs --stat p50 --output p50_report.md
  ```

* **Process a custom benchmark run (e.g. without VAD or Denoise):**
  ```bash
  python generate_final_table.py --log-dir logs_without_vad_denoise --output logs_without_vad_denoise/final_table.md
  ```

---

## 4. Structure of the Generated Output

### A. The 10 Pipeline Stages Captured

Each concurrency column ($C \in \{1, 2, 4, 8, 16, 32\}$) breaks down latency into 10 distinct operational stages:

```
[Client] ──(1. Session Creation HTTP)──► [API Gateway]
   │
   ├──(2. WebSocket Handshake)─────────► [API Gateway]
   │
   ├──(3. Audio Ingress & Redis)───────► [Redis Stream: stt:audio:raw]
   │                                            │
   │                                     [STT Audio Worker]
   │                                            ├── (4. RNNoise Denoising)
   │                                            ├── (5. Silero VAD Evaluation)
   │                                            └── (6. Server Queue Wait & Dispatch)
   │                                                         │
   │                                                  [vLLM Whisper Worker]
   │                                                         ├── (7. vLLM Whisper GPU ASR)
   │                                                         └── (8. Postprocessing & Redis Pub)
   │                                                                     │
[Client] ◄──(9. Gateway Redis Egress)──────────────────────────── [Redis Stream: stt:result]
   │
   └──────── (10. Full End-to-End Latency: Round-Trip Real-Time Delivery)
```

| # | Stage Name in Table | Physical Stage & Location | Health Benchmark |
| :-: | :--- | :--- | :--- |
| **1** | `1. Session Creation (HTTP)` | Gateway session ticket allocation and authentication | ~150 - 170 ms |
| **2** | `2. WebSocket Handshake` | Gateway TCP + WebSocket upgrade handshake | ~60 - 90 ms |
| **3** | `3. Ingress & Redis Queue` | Network transit + audio chunk serialization to Redis | < 30 ms (Healthy) |
| **4** | `4. RNNoise Denoising` | Audio worker CPU noise suppression per 1-second buffer | ~10 - 16 ms |
| **5** | `5. Silero VAD Evaluation` | Audio worker CPU voice activity evaluation | ~0.20 ms |
| **6** | `6. Server Queue Wait` | Dispatch delay from Audio Worker queue to vLLM Worker | ~0.12 - 0.15 ms |
| **7** | `7. vLLM Whisper ASR Inference` | **GPU ASR inference execution inside vLLM container** | **~57 - 65 ms** |
| **8** | `8. Postprocessing & Redis Pub` | Format transcription JSON and publish to Redis stream | ~1.40 ms |
| **9** | `9. Gateway Egress to Client` | Gateway reading from Redis stream and relaying to client | < 30 ms (Healthy) |
| **10** | `10. Full End-to-End Latency` | Complete client-side real-time round-trip latency | P50 < 450 ms |

---

### B. Sample Output Matrix (P50 Median Latency)

```markdown
### 📊 Final Latency Matrix: P50 (Median) Latency (ms)
| concurrency                   | 1      | 2      | 4      | 8      | 16     | 32      |
|:-----------------------------:|:------:|:------:|:------:|:------:|:------:|:-------:|
| 1. Session Creation (HTTP)    | 152.34 | 166.30 | 166.76 | 157.76 | 160.86 |  153.29 |
| 2. WebSocket Handshake        | 156.51 |  89.98 |  69.48 |  73.23 |  79.15 |   62.77 |
| 3. Ingress & Redis Queue      |  28.32 |  27.51 |  26.89 |  27.36 |  30.50 | 1322.21 |
| 4. RNNoise Denoising          |  15.90 |  15.93 |  15.61 |  15.54 |  14.19 |    8.77 |
| 5. Silero VAD Evaluation      |   0.21 |   0.21 |   0.20 |   0.20 |   0.20 |    0.21 |
| 6. Server Queue Wait          |   0.13 |   0.12 |   0.12 |   0.12 |   0.12 |    0.12 |
| 7. vLLM Whisper ASR Inference |  63.40 |  60.00 |  58.95 |  57.15 |  61.10 |   60.20 |
| 8. Postprocessing & Redis Pub |   1.40 |   1.40 |   1.40 |   1.40 |   1.40 |    1.40 |
| 9. Gateway Egress to Client   |  26.15 |  25.40 |  24.83 |  25.26 |  28.16 | 1220.51 |
| 10. Full End-to-End Latency   | 428.81 | 374.70 | 358.07 | 359.54 | 394.38 | 2827.55 |
| Pass Rate (%)                 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |  100.0% |
| Transcripts Relayed           |     37 |     73 |    154 |    266 |    495 |     961 |
```

---

### C. Structure of the CSV Export (`final_table.csv`)

When exporting to CSV via `--format csv`, the file formats data into **6 independent tables** separated by blank lines for spreadsheet tools like Excel, Google Sheets, or Apple Numbers:

* **TABLE 1: P50 (MEDIAN) LATENCY (ms)** — Typical user experience per concurrency.
* **TABLE 2: P95 TAIL LATENCY (ms)** — 95th-percentile worst-case delays.
* **TABLE 3: AVERAGE LATENCY (ms)** — Arithmetic mean across all frames.
* **TABLE 4: MINIMUM LATENCY (ms)** — Absolute best-case latency observed.
* **TABLE 5: MAXIMUM LATENCY (ms)** — Highest single outlier latency recorded.
* **TABLE 6: RELIABILITY & RUN VOLUME** — Requests sent, passed, failed, success percentage, audio chunks transmitted, and transcripts received.

---

## 5. Interpreting Key Bottlenecks from the Table

When reviewing the final table:

1. **vLLM GPU Decode Is Invariant to Concurrency:**
   * Notice that `vLLM Whisper ASR Inference` remains virtually flat (~57 ms to 63 ms) from Concurrency 1 up to Concurrency 32.
   * This proves the GPU and vLLM batching engine are operating efficiently without queuing or memory starvation.

2. **Redis Ingress & Egress Scale Point:**
   * At Concurrency 1 to 16, Redis ingress and egress latency stays between **20 ms and 30 ms**.
   * At Concurrency 32, `Audio Ingress & Redis Queue` rises to **1,322 ms** and `Gateway Egress` rises to **1,220 ms**.
   * **Root Cause:** A single Redis instance experiences I/O serialization contention when processing 32 simultaneous high-frequency binary chunk writes.
