# vLLM STT Streaming Load Test & Concurrency Benchmark

High-concurrency, real-time audio streaming load tester and diagnostic benchmark for **vLLM Whisper ASR** deployed behind the **API Gateway** and **Hope STT streaming engine**.

It simulates concurrent clients streaming raw 16 kHz mono PCM frames via WebSockets, parses real-time transcript responses, measures the 10-stage end-to-end latency pipeline, records remote GPU telemetry, and audits container health.

---

## 1. Prerequisites & Installation

### Python Environment
Requires **Python 3.10+**.

```bash
# Optional: create or activate your virtual environment
conda activate vox
# or
python3 -m venv .venv && source .venv/bin/activate

# Install required packages
pip install -r requirements.txt
```

### Remote GPU Server Access & Passwordless SSH
The benchmark automatically launches remote `nvidia-smi` sampling and retrieves container execution logs from the GPU host (`192.168.112.2`).

#### Why is Passwordless SSH Required?
Because `vllm.py` runs non-interactively in the background, it cannot pause to prompt for a password. Passwordless SSH (public-key authentication) allows the benchmark to start background telemetry and fetch diagnostic logs without hanging.

#### How to Set Up (One-Time Setup):
1. **Generate an SSH key pair on your machine** (if you don't already have one):
   ```bash
   ssh-keygen -t ed25519 -C "vllm-benchmark-client"
   ```
2. **Copy your public key to the remote GPU server**:
   ```bash
   ssh-copy-id nitik@192.168.112.2
   ```
   *(Enter the server password **once**. This copies your public key into `/home/nitik/.ssh/authorized_keys`)*
3. **Verify passwordless access**:
   ```bash
   ssh -o BatchMode=yes nitik@192.168.112.2 "nvidia-smi"
   ```
   If this prints the GPU status table without asking for a password, your machine is configured!

> For full technical details and troubleshooting, see [docs/REMOTE_GPU_DIAGNOSTICS_SETUP.md](docs/REMOTE_GPU_DIAGNOSTICS_SETUP.md).

---

## 2. Configuration (`benchmark_config.yaml`)

All benchmark parameters (endpoints, credentials, audio settings, concurrency sweeps, and diagnostics) are configured in `benchmark_config.yaml`:

```yaml
# Concurrency sweep levels to execute sequentially in an automated loop:
concurrencies:
  - 1
  - 2
  - 4
  - 8
  - 16
  - 32

# Cooldown delay in seconds between consecutive concurrency runs
cooldown: 15

# Audio input configuration
audio_dir: "testfiles"
chunk_ms: 250
stagger_ms: 50.0
pace: 1.0

# API Gateway & Network Configuration
gateway_http: "http://192.168.112.6:32458/api/v1"
gateway_ws: "ws://192.168.112.6:32458/ws/stt/stream"
agent: "whisper-v3-turbo"
tenant: "ARCAAI"
user: "arcaai_admin"
password: "password123"

# Remote GPU Server Monitoring & Diagnostics (192.168.112.2)
remote_diagnostics: true
gpu_host: "192.168.112.2"
gpu_user: "nitik"
gpu_sample_ms: 50

# Redis Queue & Stream Management
clear_redis: true
redis_url: "redis://:5GX3kEti7iZHt69ZOUnUavkfEjsWGwgfD%2BGAcBK74Xc%3D@192.168.112.6:32522/0"
```

---

## 3. How to Run

### Option A: Automated Concurrency Loop (Sweep: 1 → 2 → 4 → 8 → 16 → 32)
Runs all concurrency tiers sequentially from `benchmark_config.yaml` with a 15-second cooldown between stages:

```bash
python vllm.py --config benchmark_config.yaml
```

### Option B: Run a Single Concurrency Level
Override the config file to run a single concurrency tier (e.g. concurrency 1 or 32):

```bash
# Run single stream (concurrency 1)
python vllm.py --config benchmark_config.yaml --concurrency 1

# Run 32 concurrent streams
python vllm.py --config benchmark_config.yaml --concurrency 32
```

### Option C: Custom Concurrency Sweep via CLI
Override the sweep list directly from the command line:

```bash
python vllm.py --config benchmark_config.yaml --concurrencies 1,2,4,8,16,32 --cooldown 10
```

---

## 4. Generated Output Artifacts

### A. Root Logs (`logs/`) — Full Benchmark Session
Captures cumulative, continuous data from when the command started to when it finished:

| File | Description |
| :--- | :--- |
| `logs/gpu.csv` | **Full continuous GPU telemetry** (50 ms intervals) spanning the entire benchmark run (all concurrencies + cooldowns). |
| `logs/vllm_audio.log` | **Full Docker container log** (untruncated container startup history + all runtime activity). |
| `logs/nvidia_smi.txt` | **Suite GPU snapshots** taken at command start and benchmark completion. |
| `logs/sweep_summary.txt` | Formatted ASCII comparison table comparing RTF, P50, and P95 latency across all concurrency levels. |
| `logs/sweep_summary.csv` | Machine-readable CSV comparing throughput and latency across all concurrency levels. |

### B. Isolated Concurrency Folders (`logs/concurrency_<N>/`)
Each concurrency tier $N$ saves exactly 6 artifacts isolated strictly to that run:

| File | Description |
| :--- | :--- |
| `logs/concurrency_<N>/vllm_test_output_<N>.txt` | Formatted summary table, pass/fail counts, 10-stage latency breakdown, and automated bottleneck diagnostic. |
| `logs/concurrency_<N>/vllm_load_test_<N>.csv` | Frame-by-frame latency breakdown with the 10 pipeline steps as CSV column headers. |
| `logs/concurrency_<N>/vllm_session_audit_<N>.csv` | Audit proof mapping every worker to its Session ID, WebSocket URL, ticket, audio file, and chunk counts. |
| `logs/concurrency_<N>/gpu_<N>.csv` | 50 ms time-series GPU telemetry recorded **only** during concurrency $N$. |
| `logs/concurrency_<N>/nvidia_smi_<N>.txt` | GPU snapshot recorded specifically for concurrency $N$. |
| `logs/concurrency_<N>/vllm_whisper_<N>.log` | Runtime Docker logs recorded **only** during concurrency $N$ (no bloated startup logs). |

---

## 5. How to Generate Final Output Reports (Markdown & CSV)

After running the benchmark sweep, you can generate multi-tier comparison tables and CSV matrices from the `logs/` artifacts:

Parses all concurrency logs in `logs/` and outputs a cross-concurrency matrix (Average, P50, and P95 latency across all 10 stages):

```bash
# Generate Markdown matrix (saved to logs/final_table.md)
python generate_final_table.py --log-dir logs

# Generate multi-section CSV report (saved to logs/final_table.csv)
python generate_final_table.py --log-dir logs --format csv
```

---

## 6. Documentation

For detailed architecture analysis, setup guides, and latency decomposition formulas, refer to the documentation in `docs/`:
* [FINAL_REPORT_AND_TABLE_GENERATION.md](docs/FINAL_REPORT_AND_TABLE_GENERATION.md) — Guide on generating 10-step cross-concurrency latency matrices (Markdown and CSV formats).
* [MANUAL_LOGGING_AND_DIAGNOSTICS.md](docs/MANUAL_LOGGING_AND_DIAGNOSTICS.md) — Manual terminal commands to check, stream, and save Docker logs and NVIDIA GPU metrics.
* [REMOTE_GPU_DIAGNOSTICS_SETUP.md](docs/REMOTE_GPU_DIAGNOSTICS_SETUP.md) — Comprehensive guide on passwordless SSH, remote telemetry sampling, and security troubleshooting.
* [VLLM_CONCURRENCY_TESTING_GUIDE.md](docs/VLLM_CONCURRENCY_TESTING_GUIDE.md) — Architecture, 10-step request lifecycle, and testing runbooks.
* [STT_PIPELINE_LATENCY_DECOMPOSITION.md](docs/STT_PIPELINE_LATENCY_DECOMPOSITION.md) — 10-step latency mathematical formulation and bottleneck analysis.
* [VLLM_STREAMING_OPTIMIZATION_REPORT.md](docs/VLLM_STREAMING_OPTIMIZATION_REPORT.md) — Optimization report and recommendations.