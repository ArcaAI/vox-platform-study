# Manual Logging & Diagnostics Runbook

This runbook provides copy-pasteable terminal commands to inspect, monitor, and save both **Docker container logs** and **NVIDIA GPU telemetry** from the remote GPU host (`192.168.112.2`).

> **Note**: Replace `nitik@192.168.112.2` with your GPU host if using a different server or IP address.

---

## 1. NVIDIA GPU Monitoring (`nvidia-smi`)

### A. View Current GPU Status (Point-in-Time)
Inspect GPU utilization %, VRAM usage, temperature, and active process PIDs:
```bash
ssh nitik@192.168.112.2 "nvidia-smi"
```

### B. Save Point-in-Time Snapshot to File
Captures both the formatted process table and the CSV machine-readable metrics into `logs/nvidia_smi.txt`:
```bash
ssh nitik@192.168.112.2 "nvidia-smi && echo '' && nvidia-smi --query-gpu=timestamp,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw --format=csv" > logs/nvidia_smi.txt
```

### C. Live Real-Time Dashboard (Interactive)
Watches GPU activity live in your terminal with a 1-second refresh rate:
```bash
ssh -t nitik@192.168.112.2 "watch -n 1 nvidia-smi"
```

### D. Record Continuous Time-Series GPU Telemetry to CSV
Samples GPU metrics every 50 ms directly into `logs/gpu.csv` (Press `Ctrl+C` to terminate recording):
```bash
ssh nitik@192.168.112.2 "nvidia-smi --query-gpu=timestamp,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw --format=csv -lms 50" > logs/gpu.csv
```

---

## 2. Docker Container Logs (`vllm-whisper`)

### A. Follow Live Logs in Real Time (`-f`)
Tail and follow incoming inference requests as audio chunks arrive:
```bash
ssh -t nitik@192.168.112.2 "docker logs -f --tail 100 vllm-whisper"
```

### B. View Recent Logs (Last N Lines)
Quick inspection of the last 200 lines without following:
```bash
ssh nitik@192.168.112.2 "docker logs --tail 200 vllm-whisper"
```

### C. Filter Logs by Time Window
Inspect only the logs produced during a recent test window:
```bash
# View logs from the last 5 minutes
ssh nitik@192.168.112.2 "docker logs --since 5m vllm-whisper"

# View logs since a specific ISO UTC timestamp
ssh nitik@192.168.112.2 "docker logs --since 2026-10-26T10:00:00Z vllm-whisper"
```

### D. Save vLLM Docker Logs to Local File

#### 1. Save Recent Runtime Logs Only (e.g. Last 500 Lines)
```bash
ssh nitik@192.168.112.2 "docker logs --tail 500 vllm-whisper" > logs/vllm_audio.log
```

#### 2. Save the Complete Container History (High-Speed Compressed Transfer)
Pipes the remote Docker log through `gzip` on the server and decompresses locally, transferring ~10 MB of text in under 2 seconds:
```bash
ssh nitik@192.168.112.2 "docker logs vllm-whisper 2>&1 | gzip -c" | gunzip > logs/vllm_audio.log
```

---

## 3. Pipeline Engine Logs (`hope-stt`)

To troubleshoot VAD evaluation, RNNoise suppression, or Redis pub/sub latency on the STT engine:

### A. Follow Live Engine Logs
```bash
ssh -t nitik@192.168.112.2 "docker logs -f --tail 100 hope-stt"
```

### B. Save Recent STT Logs to File
```bash
ssh nitik@192.168.112.2 "docker logs --tail 500 hope-stt" > logs/hope_stt.log
```

---

## 4. Quick Command Cheat-Sheet

| Task | Command |
| :--- | :--- |
| **Instant GPU Snapshot** | `ssh nitik@192.168.112.2 "nvidia-smi"` |
| **Save GPU Snapshot** | `ssh nitik@192.168.112.2 "nvidia-smi" > logs/nvidia_smi.txt` |
| **Record Continuous GPU CSV** | `ssh nitik@192.168.112.2 "nvidia-smi --query-gpu=timestamp,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw --format=csv -lms 50" > logs/gpu.csv` |
| **Stream Live vLLM Logs** | `ssh -t nitik@192.168.112.2 "docker logs -f --tail 100 vllm-whisper"` |
| **Save Recent vLLM Logs** | `ssh nitik@192.168.112.2 "docker logs --tail 500 vllm-whisper" > logs/vllm_audio.log` |
| **Save Complete vLLM Log (Fast)** | `ssh nitik@192.168.112.2 "docker logs vllm-whisper 2>&1 \| gzip -c" \| gunzip > logs/vllm_audio.log` |
| **Stream Live STT Engine Logs** | `ssh -t nitik@192.168.112.2 "docker logs -f --tail 100 hope-stt"` |
| **Save Recent STT Engine Logs** | `ssh nitik@192.168.112.2 "docker logs --tail 500 hope-stt" > logs/hope_stt.log` |
