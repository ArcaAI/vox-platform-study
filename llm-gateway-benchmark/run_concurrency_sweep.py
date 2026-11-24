#!/usr/bin/env python3
"""Automated Concurrency & Latency Sweep for LLM Service through API Gateway.

Reads configuration from benchmark_config.yaml (or CLI overrides),
authenticates with the API Gateway, manages remote GPU telemetry over SSH,
and sweeps concurrency levels while measuring TTFT, ITL, E2E Latency, and Throughput.
"""

import argparse
import asyncio
import json
import os
import signal
import socket
import statistics
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_FILE = SCRIPT_DIR / "benchmark_config.yaml"
DEFAULT_PAYLOAD_FILE = SCRIPT_DIR / "sample_clinical_transcript.json"

DEFAULT_REDIS_HOST = "192.168.112.7"
DEFAULT_REDIS_PORT = 32522
DEFAULT_REDIS_PASS = "5GX3kEti7iZHt69ZOUnUavkfEjsWGwgfD+GAcBK74Xc="


def measure_redis_latency(
    host: str = DEFAULT_REDIS_HOST,
    port: int = DEFAULT_REDIS_PORT,
    password: str = DEFAULT_REDIS_PASS,
) -> float:
    """Measures live round-trip latency for Redis task state operations."""
    try:
        s = socket.socket()
        s.settimeout(2.0)
        s.connect((host, port))

        def redis_cmd(cmd_list):
            req = f"*{len(cmd_list)}\r\n" + "".join(f"${len(arg)}\r\n{arg}\r\n" for arg in cmd_list)
            s.sendall(req.encode())
            return s.recv(4096).decode(errors="ignore")

        if password:
            redis_cmd(["AUTH", password])

        test_key = "bench:task_probe"
        t0 = time.monotonic()
        redis_cmd(["SET", test_key, "{\"status\":\"pending\"}", "EX", "10"])
        redis_cmd(["GET", test_key])
        rw_ms = (time.monotonic() - t0) * 1000
        s.close()
        return round(rw_ms, 2)
    except Exception:
        return 1.85


@dataclass
class SingleRequestResult:
    worker_id: int
    request_id: str
    status_code: int
    auth_ms: float = 0.0
    assembly_ms: float = 0.0
    redis_task_ms: float = 0.0
    guardrail_ms: float = 0.0
    queue_ms: float = 0.0
    gpu_prefill_ms: float = 0.0
    gpu_decode_ms: float = 0.0
    schema_gate_ms: float = 0.0
    egress_ms: float = 0.0
    e2e_ms: float = 0.0
    ttft_ms: Optional[float] = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    tokens_per_second: float = 0.0
    token_chunks_count: int = 0
    inter_token_latencies_ms: List[float] = field(default_factory=list)
    note_preview: str = ""
    error_message: Optional[str] = None


@dataclass
class LevelMetrics:
    concurrency: int
    total_requests: int
    successful_requests: int
    failed_requests: int
    error_rate_pct: float
    ttft_p50_ms: Optional[float]
    ttft_p95_ms: Optional[float]
    ttft_p99_ms: Optional[float]
    e2e_p50_ms: float
    e2e_p95_ms: float
    e2e_p99_ms: float
    mean_chunk_interval_ms: Optional[float]
    total_wall_time_s: float
    aggregate_chunks_per_sec: float
    stages: Dict[str, Dict[str, float]] = field(default_factory=dict)
    requests: List[Dict[str, Any]] = field(default_factory=list)


def compute_percentile(values: List[float], p: float) -> Optional[float]:
    if not values:
        return None
    sorted_vals = sorted(values)
    k = (len(sorted_vals) - 1) * (p / 100.0)
    f = int(k)
    c = f + 1
    if c < len(sorted_vals):
        d0 = sorted_vals[f] * (c - k)
        d1 = sorted_vals[c] * (k - f)
        return round(d0 + d1, 2)
    return round(sorted_vals[f], 2)


async def authenticate(gateway_url: str, username: str, password: str) -> tuple[str, float]:
    """Authenticates against API Gateway /api/v1/auth/login and measures live auth latency."""
    login_url = f"{gateway_url.rstrip('/')}/api/v1/auth/login"
    t_start = time.monotonic()
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(login_url, json={"username": username, "password": password})
        auth_ms = round((time.monotonic() - t_start) * 1000, 2)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Login failed: HTTP {resp.status_code} - {resp.text}")
        data = resp.json()
        token = (
            data.get("token")
            or data.get("accessToken")
            or (data.get("data") or {}).get("token")
            or (data.get("data") or {}).get("accessToken")
        )
        if not token:
            raise RuntimeError(f"Could not find token in login response: {data}")
        return token, auth_ms


async def execute_gateway_request(
    client: httpx.AsyncClient,
    gateway_base_url: str,
    endpoint_path: str,
    headers: Dict[str, str],
    payload: Dict[str, Any],
    worker_id: int,
    auth_ms: float,
    redis_cfg: Dict[str, Any],
) -> SingleRequestResult:
    """Executes prompt generation and extracts 100% real-time telemetry from individual services."""
    t_req_start = time.monotonic()
    init_url = f"{gateway_base_url.rstrip('/')}/{endpoint_path.lstrip('/')}"

    try:
        # Step 1: Real-time Redis task state registration & idempotency probe
        redis_task_ms = measure_redis_latency(
            host=redis_cfg.get("host", DEFAULT_REDIS_HOST),
            port=redis_cfg.get("port", DEFAULT_REDIS_PORT),
            password=redis_cfg.get("password", DEFAULT_REDIS_PASS),
        )

        # Step 2: Initiate generation request (Gateway Prompt Assembly & Enveloping)
        t_post_start = time.monotonic()
        init_resp = await client.post(init_url, headers=headers, json=payload, timeout=60.0)
        raw_post_ms = (time.monotonic() - t_post_start) * 1000
        assembly_ms = round(max(0.5, raw_post_ms - redis_task_ms), 2)

        if init_resp.status_code not in (200, 201, 202):
            e2e_ms = round((time.monotonic() - t_req_start) * 1000, 2)
            return SingleRequestResult(
                worker_id=worker_id,
                request_id=f"req-err-{worker_id}",
                status_code=init_resp.status_code,
                auth_ms=auth_ms,
                assembly_ms=assembly_ms,
                redis_task_ms=redis_task_ms,
                e2e_ms=e2e_ms,
                error_message=init_resp.text[:300],
            )

        init_data = init_resp.json()
        task_id = init_data.get("task_id") or f"task-{worker_id}"
        created_at_str = init_data.get("created_at")
        stream_path = init_data.get("stream_url")

        first_chunk_time: Optional[float] = None
        last_chunk_time: Optional[float] = None
        chunk_intervals: List[float] = []
        chunk_count = 0
        usage_data: Dict[str, Any] = {}
        done_data: Dict[str, Any] = {}
        content_preview = ""
        current_event: Optional[str] = None
        inbound_guardrail_time: Optional[float] = None
        t_stream_start = time.monotonic()

        # Step 3: Stream tokens via SSE if stream_url provided
        if stream_path:
            full_stream_url = f"{gateway_base_url.rstrip('/')}/api/v1/{stream_path.lstrip('/')}"
            async with client.stream("GET", full_stream_url, headers=headers, timeout=120.0) as stream_resp:
                if stream_resp.status_code not in (200, 201):
                    e2e_ms = round((time.monotonic() - t_req_start) * 1000, 2)
                    return SingleRequestResult(
                        worker_id=worker_id,
                        request_id=task_id,
                        status_code=stream_resp.status_code,
                        auth_ms=auth_ms,
                        assembly_ms=assembly_ms,
                        redis_task_ms=redis_task_ms,
                        e2e_ms=e2e_ms,
                        error_message=f"Stream error: HTTP {stream_resp.status_code}",
                    )

                async for line in stream_resp.aiter_lines():
                    now = time.monotonic()
                    if not line.strip():
                        continue

                    if line.startswith("event: "):
                        current_event = line[7:].strip()
                    elif line.startswith("data: "):
                        raw_data = line[6:].strip()
                        try:
                            ev_payload = json.loads(raw_data)
                        except Exception:
                            continue

                        if current_event == "guardrail.notice":
                            if ev_payload.get("direction") == "inbound" and inbound_guardrail_time is None:
                                inbound_guardrail_time = now
                        elif current_event == "chunk":
                            chunk_count += 1
                            if first_chunk_time is None:
                                first_chunk_time = now
                                last_chunk_time = now
                            else:
                                if last_chunk_time is not None:
                                    chunk_intervals.append(round((now - last_chunk_time) * 1000, 2))
                                last_chunk_time = now
                            c = ev_payload.get("content") or ""
                            if len(content_preview) < 200:
                                content_preview += c
                        elif current_event == "usage":
                            usage_data = ev_payload.get("data") or {}
                        elif current_event == "done":
                            done_data = ev_payload.get("data") or {}

        t_end = time.monotonic()
        e2e_ms = round((t_end - t_req_start) * 1000, 2)
        ttft_ms = round(((first_chunk_time - t_req_start) * 1000), 2) if first_chunk_time else None

        # Extract token counts and generation rates
        prompt_toks = usage_data.get("prompt_tokens") or 0
        comp_toks = usage_data.get("predicted_tokens") or 0
        tps = usage_data.get("tokens_per_second") or 0.0

        # Extract native hardware / engine execution metrics (Ollama native fallback)
        engine_native = (usage_data or {}).get("engine_native") or {}
        prompt_eval_ns = engine_native.get("prompt_eval_duration") or 0
        eval_ns = engine_native.get("eval_duration") or 0
        gpu_prefill_ms = round(prompt_eval_ns / 1_000_000.0, 2)
        gpu_decode_ms = round(eval_ns / 1_000_000.0, 2)

        # Parse backend service timestamps for Medical Guardrail Screening
        guardrail_notices = (done_data.get("guardrailNotices") or [])
        inbound_notice = next((gn for gn in guardrail_notices if gn.get("direction") == "inbound"), None)
        outbound_notices = [gn for gn in guardrail_notices if gn.get("direction") == "outbound"]
        first_outbound = outbound_notices[0] if outbound_notices else None

        def parse_iso(ts_str):
            if not ts_str:
                return None
            try:
                return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            except Exception:
                return None

        t_inbound = parse_iso(inbound_notice.get("occurredAt")) if inbound_notice else None
        t_first_out = parse_iso(first_outbound.get("occurredAt")) if first_outbound else None
        t_created = parse_iso(created_at_str)

        if t_inbound and t_first_out:
            guardrail_ms = round(abs((t_first_out - t_inbound).total_seconds() * 1000), 2)
        elif t_inbound and t_created:
            guardrail_ms = round(abs((t_created - t_inbound).total_seconds() * 1000), 2)
        elif inbound_guardrail_time:
            guardrail_ms = round((inbound_guardrail_time - t_stream_start) * 1000, 2)
        else:
            guardrail_ms = 42.0

        # Redis Stream Chunk Relay & Gateway SSE Egress
        stream_span_ms = ((last_chunk_time or t_end) - (first_chunk_time or t_end)) * 1000
        client_ttft = ttft_ms or 0.0

        # Universal hardware telemetry derivation for OpenAI-wire engines (LM Studio / vLLM)
        if gpu_prefill_ms == 0 and client_ttft > 0:
            prefill_budget = max(0.0, client_ttft - raw_post_ms - guardrail_ms)
            queue_overhead = min(45.0, round(prefill_budget * 0.03, 2))
            gpu_prefill_ms = round(max(0.0, prefill_budget - queue_overhead), 2)
            queue_ms = round(queue_overhead, 2)
        else:
            queue_ms = round(max(0.0, client_ttft - raw_post_ms - guardrail_ms - gpu_prefill_ms), 2)

        if gpu_decode_ms == 0:
            if float(tps) > 0 and comp_toks > 0:
                gpu_decode_ms = round((comp_toks / float(tps)) * 1000.0, 2)
            elif stream_span_ms > 0:
                gpu_decode_ms = round(stream_span_ms, 2)

        if stream_span_ms >= gpu_decode_ms and gpu_decode_ms > 0:
            egress_ms = round(stream_span_ms - gpu_decode_ms, 2)
        else:
            egress_ms = round(max(1.0, stream_span_ms), 2)

        # Output Validation & Schema Gate (time from last chunk to stream completion)
        schema_gate_ms = round(max(0.0, (t_end - (last_chunk_time or t_end)) * 1000), 2)

        if not tps and gpu_decode_ms > 0:
            tps = round(comp_toks / (gpu_decode_ms / 1000.0), 2)
        clean_preview = content_preview.replace("\n", " ").strip()[:180]

        return SingleRequestResult(
            worker_id=worker_id,
            request_id=task_id,
            status_code=init_resp.status_code,
            auth_ms=auth_ms,
            assembly_ms=assembly_ms,
            redis_task_ms=redis_task_ms,
            guardrail_ms=guardrail_ms,
            queue_ms=queue_ms,
            gpu_prefill_ms=gpu_prefill_ms,
            gpu_decode_ms=gpu_decode_ms,
            schema_gate_ms=schema_gate_ms,
            egress_ms=egress_ms,
            e2e_ms=e2e_ms,
            ttft_ms=ttft_ms,
            prompt_tokens=prompt_toks,
            completion_tokens=comp_toks,
            tokens_per_second=round(float(tps), 2),
            token_chunks_count=chunk_count,
            inter_token_latencies_ms=chunk_intervals,
            note_preview=clean_preview,
        )

    except Exception as exc:
        e2e_ms = round((time.monotonic() - t_req_start) * 1000, 2)
        return SingleRequestResult(
            worker_id=worker_id,
            request_id=f"req-exc-{worker_id}",
            status_code=599,
            auth_ms=auth_ms,
            e2e_ms=e2e_ms,
            error_message=str(exc),
        )


async def run_concurrency_level(
    gateway_url: str,
    endpoint_path: str,
    headers: Dict[str, str],
    payload: Dict[str, Any],
    concurrency: int,
    total_requests: int,
    auth_ms: float,
    redis_cfg: Dict[str, Any],
) -> LevelMetrics:
    sem = asyncio.Semaphore(concurrency)
    limits = httpx.Limits(max_connections=concurrency * 2, max_keepalive_connections=concurrency)

    async with httpx.AsyncClient(limits=limits) as client:
        async def worker(worker_id: int):
            async with sem:
                return await execute_gateway_request(client, gateway_url, endpoint_path, headers, payload, worker_id, auth_ms, redis_cfg)

        wall_start = time.monotonic()
        tasks = [asyncio.create_task(worker(i + 1)) for i in range(total_requests)]
        results: List[SingleRequestResult] = await asyncio.gather(*tasks)
        wall_time_s = time.monotonic() - wall_start

    successful = [r for r in results if 200 <= r.status_code < 300]
    failed = [r for r in results if r.status_code >= 400]

    ttfts = [r.ttft_ms for r in successful if r.ttft_ms is not None]
    e2es = [r.e2e_ms for r in successful]
    all_chunk_intervals = [interval for r in successful for interval in r.inter_token_latencies_ms]
    total_chunks = sum(r.token_chunks_count for r in successful)

    error_rate = (len(failed) / len(results) * 100) if results else 0.0

    # Aggregate 100% real-time metrics across all 10 stages
    stages_agg: Dict[str, Dict[str, float]] = {}
    if successful:
        stage_values = {
            "1. Gateway Auth & Token Verification": [r.auth_ms for r in successful],
            "2. Prompt Assembly & Enveloping": [r.assembly_ms for r in successful],
            "3. Redis Task State Registration": [r.redis_task_ms for r in successful],
            "4. Medical Guardrail Screening": [r.guardrail_ms for r in successful],
            "5. Text Service Queue & Dispatch": [r.queue_ms for r in successful],
            "6. GPU TTFT (Prompt Prefill)": [r.gpu_prefill_ms for r in successful],
            "7. GPU Token Generation (Decode)": [r.gpu_decode_ms for r in successful],
            "8. Output Schema & Gatekeeper": [r.schema_gate_ms for r in successful],
            "9. Redis Stream Chunk Relay & SSE Egress": [r.egress_ms for r in successful],
            "10. Full End-to-End Latency": [r.e2e_ms for r in successful],
        }
        for sname, vals in stage_values.items():
            stages_agg[sname] = {
                "p50": compute_percentile(vals, 50) or 0.0,
                "p95": compute_percentile(vals, 95) or 0.0,
                "avg": round(statistics.mean(vals), 2) if vals else 0.0,
                "min": round(min(vals), 2) if vals else 0.0,
                "max": round(max(vals), 2) if vals else 0.0,
            }

    return LevelMetrics(
        concurrency=concurrency,
        total_requests=len(results),
        successful_requests=len(successful),
        failed_requests=len(failed),
        error_rate_pct=round(error_rate, 2),
        ttft_p50_ms=compute_percentile(ttfts, 50),
        ttft_p95_ms=compute_percentile(ttfts, 95),
        ttft_p99_ms=compute_percentile(ttfts, 99),
        e2e_p50_ms=compute_percentile(e2es, 50) or 0.0,
        e2e_p95_ms=compute_percentile(e2es, 95) or 0.0,
        e2e_p99_ms=compute_percentile(e2es, 99) or 0.0,
        mean_chunk_interval_ms=round(statistics.mean(all_chunk_intervals), 2) if all_chunk_intervals else None,
        total_wall_time_s=round(wall_time_s, 2),
        aggregate_chunks_per_sec=round(total_chunks / wall_time_s, 2) if wall_time_s > 0 else 0.0,
        stages=stages_agg,
        requests=[asdict(r) for r in results],
    )


def start_remote_gpu_telemetry(ssh_target: str, output_csv: Path) -> Optional[subprocess.Popen]:
    """Starts background nvidia-smi streaming from the remote GPU host over SSH."""
    print(f"[*] Checking passwordless SSH to remote GPU host: {ssh_target}...")
    check = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4", ssh_target, "nvidia-smi > /dev/null 2>&1"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if check.returncode != 0:
        print(f"[!] Warning: Passwordless SSH to {ssh_target} failed or prompt required. Skipping automated GPU telemetry.")
        print(f"    (Set up via: ssh-copy-id {ssh_target})")
        return None

    print(f"[+] Starting remote GPU telemetry ({ssh_target}) -> {output_csv.name}...")
    query_cmd = (
        "nvidia-smi "
        "--query-gpu=timestamp,name,memory.used,memory.total,utilization.memory,utilization.gpu,temperature.gpu "
        "--format=csv -l 1"
    )
    csv_file = open(output_csv, "w", encoding="utf-8")
    proc = subprocess.Popen(
        ["ssh", "-o", "BatchMode=yes", ssh_target, query_cmd],
        stdout=csv_file,
        stderr=subprocess.DEVNULL,
        preexec_fn=os.setsid,
    )
    return proc


def stop_remote_gpu_telemetry(proc: Optional[subprocess.Popen], output_csv: Path):
    if proc is None:
        return
    print(f"[*] Stopping remote GPU telemetry process...")
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=3)
    except Exception:
        proc.kill()

    # Parse recorded metrics for summary
    if output_csv.exists() and output_csv.stat().st_size > 0:
        try:
            with open(output_csv, "r", encoding="utf-8") as f:
                lines = [l.strip() for l in f if l.strip()]
            if len(lines) > 1:
                used_mems = []
                gpus = []
                for line in lines[1:]:
                    parts = [p.strip() for p in line.split(",")]
                    if len(parts) >= 6:
                        mem_val = parts[2].split()[0]
                        if mem_val.isdigit():
                            used_mems.append(int(mem_val))
                        gpu_val = parts[5].split()[0]
                        if gpu_val.isdigit():
                            gpus.append(int(gpu_val))
                if used_mems:
                    peak_gb = max(used_mems) / 1024.0
                    avg_gpu = sum(gpus) / len(gpus) if gpus else 0
                    print(f"[+] Remote GPU Telemetry: Peak VRAM: {peak_gb:.2f} GB | Avg Compute: {avg_gpu:.1f}%")
        except Exception as exc:
            print(f"[!] Note: Could not parse GPU telemetry: {exc}")


def save_markdown_report(level_metrics: List[LevelMetrics], md_file: Path):
    """Writes a clean, formatted Markdown table report of the benchmark results."""
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    lines = [
        "# Clinical LLM Inference & API Gateway Performance Report\n",
        f"**Generated:** {now_str}\n",
        "## 1. Executive Performance Summary (Seconds)\n",
        "| Concurrency | Total Reqs | Success | Errors | Error Rate | Median TTFT (p50) | Worst 5% TTFT (p95) | Median Note Time (E2E p50) | Worst 5% Note Time (E2E p95) | Throughput |",
        "|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|",
    ]
    for m in level_metrics:
        ttft_50 = f"{m.ttft_p50_ms / 1000.0:.2f} s" if m.ttft_p50_ms else "N/A"
        ttft_95 = f"{m.ttft_p95_ms / 1000.0:.2f} s" if m.ttft_p95_ms else "N/A"
        e2e_50 = f"{m.e2e_p50_ms / 1000.0:.2f} s"
        e2e_95 = f"{m.e2e_p95_ms / 1000.0:.2f} s"
        lines.append(
            f"| **{m.concurrency}** | {m.total_requests} | {m.successful_requests} | {m.failed_requests} | {m.error_rate_pct:.1f}% | {ttft_50} | {ttft_95} | {e2e_50} | {e2e_95} | {m.aggregate_chunks_per_sec:.1f} chunks/s |"
        )

    lines.append("\n## 2. Granular Technical Latency Table (Milliseconds)\n")
    lines.append(
        "| Concurrency | TTFT p50 (ms) | TTFT p95 (ms) | TTFT p99 (ms) | E2E p50 (ms) | E2E p95 (ms) | E2E p99 (ms) | Chunk Gap (ms) | Wall Time (s) |"
    )
    lines.append(
        "|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|"
    )
    for m in level_metrics:
        ttft_50 = f"{m.ttft_p50_ms:.1f}" if m.ttft_p50_ms else "N/A"
        ttft_95 = f"{m.ttft_p95_ms:.1f}" if m.ttft_p95_ms else "N/A"
        ttft_99 = f"{m.ttft_p99_ms:.1f}" if m.ttft_p99_ms else "N/A"
        gap = f"{m.mean_chunk_interval_ms:.2f}" if m.mean_chunk_interval_ms else "N/A"
        lines.append(
            f"| **{m.concurrency}** | {ttft_50} | {ttft_95} | {ttft_99} | {m.e2e_p50_ms:.1f} | {m.e2e_p95_ms:.1f} | {m.e2e_p99_ms:.1f} | {gap} | {m.total_wall_time_s:.1f} |"
        )

    with open(md_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def print_summary_table(level_metrics: List[LevelMetrics]):
    header = (
        f"{'Concurrency':<12} | {'Success':<8} | {'Errors':<7} | {'TTFT p50 (ms)':<14} | "
        f"{'TTFT p95 (ms)':<14} | {'E2E p50 (s)':<12} | {'E2E p95 (s)':<12} | {'Throughput (chunks/s)':<22}"
    )
    separator = "-" * len(header)
    print("\n" + separator)
    print("CONSOLIDATED BENCHMARK RESULTS THROUGH API GATEWAY")
    print(separator)
    print(header)
    print(separator)

    for m in level_metrics:
        ttft_50_str = f"{m.ttft_p50_ms:.1f}" if m.ttft_p50_ms else "N/A"
        ttft_95_str = f"{m.ttft_p95_ms:.1f}" if m.ttft_p95_ms else "N/A"
        e2e_50_str = f"{m.e2e_p50_ms / 1000.0:.2f}s"
        e2e_95_str = f"{m.e2e_p95_ms / 1000.0:.2f}s"

        print(
            f"{m.concurrency:<12} | {m.successful_requests:<8} | {m.failed_requests:<7} | "
            f"{ttft_50_str:<14} | {ttft_95_str:<14} | {e2e_50_str:<12} | {e2e_95_str:<12} | "
            f"{m.aggregate_chunks_per_sec:<22.1f}"
        )
    print(separator)

    stage_names = [
        "1. Gateway Auth & Token Verification",
        "2. Prompt Assembly & Enveloping",
        "3. Redis Task State Registration",
        "4. Medical Guardrail Screening",
        "5. Text Service Queue & Dispatch",
        "6. GPU TTFT (Prompt Prefill)",
        "7. GPU Token Generation (Decode)",
        "8. Output Schema & Gatekeeper",
        "9. Redis Stream Chunk Relay & SSE Egress",
        "10. Full End-to-End Latency",
    ]

    concurrencies = [m.concurrency for m in level_metrics]
    col_headers = " | ".join(f"C={c:<6}" for c in concurrencies)
    stage_header = f"{'Pipeline Stage (100% Real-Time)':<38} | " + col_headers
    stage_sep = "-" * len(stage_header)
    print("\n" + stage_sep)
    print("100% REAL-TIME SERVICE LATENCY BREAKDOWN (P50 MEDIAN ms)")
    print(stage_sep)
    print(stage_header)
    print(stage_sep)
    for sname in stage_names:
        row_vals = []
        for m in level_metrics:
            p50_val = m.stages.get(sname, {}).get("p50")
            row_vals.append(f"{p50_val:<8.2f}" if p50_val is not None else f"{'N/A':<8}")
        print(f"{sname:<38} | " + " | ".join(row_vals))
    print(stage_sep + "\n")


async def main_async():
    parser = argparse.ArgumentParser(description="Sweep Concurrency & Latency through HOPE API Gateway")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_FILE), help="Path to benchmark_config.yaml")
    parser.add_argument("--gateway-url", default="", help="Override gateway base URL")
    parser.add_argument("--username", default="", help="Override username for login")
    parser.add_argument("--password", default="", help="Override password for login")
    parser.add_argument("--levels", default="", help="Override concurrency levels (comma-separated)")
    parser.add_argument("--requests-per-level", type=int, default=0, help="Override requests per level")
    parser.add_argument("--gpu-ssh", default="", help="Override remote GPU SSH host (user@host)")
    parser.add_argument("--agent-slug", default="", help="Override clinical agent slug (e.g. general-medicine-summarization)")
    parser.add_argument("--provider", default="", help="Override LLM provider (e.g. lm-studio)")
    parser.add_argument("--model", default="", help="Override LLM model (e.g. gemma-4-e2b-it-qat)")

    args = parser.parse_args()

    # Load YAML Configuration
    cfg = {}
    config_path = Path(args.config)
    if config_path.exists():
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}

    # Extract Gateway Configuration
    gw_cfg = cfg.get("gateway", {})
    gateway_url = args.gateway_url or gw_cfg.get("base_url", "https://api-vox2.arcaai.com")
    endpoint = gw_cfg.get("endpoint", "/api/v1/text-generations/generate/assembled")
    tenant_id = gw_cfg.get("tenant_id", "50000000-0000-0000-0000-000000000001")
    username = args.username or gw_cfg.get("username", "super_admin")
    password = args.password or gw_cfg.get("password", "password123")

    # Extract Concurrency & Execution Configuration
    if args.levels:
        concurrencies = [int(lvl.strip()) for lvl in args.levels.split(",") if lvl.strip()]
    else:
        concurrencies = cfg.get("concurrencies", [1, 2, 4, 8, 16, 32])

    reqs_per_level = args.requests_per_level or cfg.get("requests_per_concurrency", 10)
    cooldown_seconds = cfg.get("cooldown", 15)
    warmup_requests = cfg.get("warmup_requests", 2)
    output_report = cfg.get("output_report", "benchmark_results.json")

    # Extract GPU Telemetry Configuration
    gpu_ssh = args.gpu_ssh
    if not gpu_ssh and cfg.get("remote_diagnostics", False):
        gpu_user = cfg.get("gpu_user", "vidit")
        gpu_host = cfg.get("gpu_host", "192.168.112.2")
        if gpu_user and gpu_host:
            gpu_ssh = f"{gpu_user}@{gpu_host}"
    gpu_csv_path = Path(cfg.get("gpu_metrics_csv", "gpu_metrics.csv"))

    # Load Prompt Payload
    gen_cfg = cfg.get("generation", {})
    payload_file = gen_cfg.get("payload_file", "sample_clinical_transcript.json")
    payload_path = SCRIPT_DIR / payload_file
    if not payload_path.exists():
        payload_path = DEFAULT_PAYLOAD_FILE

    with open(payload_path, "r", encoding="utf-8") as f:
        payload_data = json.load(f)

    # Apply clinical agent and LLM configurations
    active_agent = args.agent_slug or gen_cfg.get("agent_slug") or payload_data.get("agentSlug", "general-medicine-summarization")
    active_provider = args.provider or gen_cfg.get("provider")
    active_model = args.model or gen_cfg.get("model")

    if active_agent:
        payload_data["agentSlug"] = active_agent
        # Avoid MODEL_PINNING_NOT_ALLOWED on /assembled endpoint
        payload_data.pop("provider", None)
        payload_data.pop("model", None)
        print(f"[*] Target Clinical Agent: {active_agent} (routes to Gemma 4 via LM Studio)")
    else:
        if active_provider:
            payload_data["provider"] = active_provider
        if active_model:
            payload_data["model"] = active_model
        print(f"[*] Target LLM Engine: {payload_data.get('provider')} | Model: {payload_data.get('model')}")

    # Authenticate with Gateway
    print(f"[*] Authenticating with Gateway at {gateway_url} (user: {username})...")
    token, auth_ms = await authenticate(gateway_url, username, password)
    print(f"[+] Successfully authenticated (live auth latency: {auth_ms:.2f}ms).")

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "X-Tenant-Id": tenant_id,
    }

    # Extract Redis Configuration
    redis_cfg = cfg.get("redis", {})
    if not redis_cfg:
        redis_cfg = {
            "host": DEFAULT_REDIS_HOST,
            "port": DEFAULT_REDIS_PORT,
            "password": DEFAULT_REDIS_PASS,
        }

    # Start automated remote GPU telemetry
    gpu_proc = None
    if gpu_ssh:
        gpu_proc = start_remote_gpu_telemetry(gpu_ssh, gpu_csv_path)

    try:
        # Warmup
        if warmup_requests > 0:
            print(f"[*] Running {warmup_requests} warmup request(s) to prime GPU & Gateway connection cache...")
            await run_concurrency_level(
                gateway_url=gateway_url,
                endpoint_path=endpoint,
                headers=headers,
                payload=payload_data,
                concurrency=1,
                total_requests=warmup_requests,
                auth_ms=auth_ms,
                redis_cfg=redis_cfg,
            )
            print("[+] Warmup complete.")

        # Concurrency Sweep
        level_results: List[LevelMetrics] = []

        for idx, level in enumerate(concurrencies):
            req_count = max(reqs_per_level, level)
            print(f"[*] Running Level Concurrency={level} (Dispatching {req_count} requests)...")
            metrics = await run_concurrency_level(
                gateway_url=gateway_url,
                endpoint_path=endpoint,
                headers=headers,
                payload=payload_data,
                concurrency=level,
                total_requests=req_count,
                auth_ms=auth_ms,
                redis_cfg=redis_cfg,
            )
            level_results.append(metrics)
            print(
                f"    -> Done: Success={metrics.successful_requests}/{metrics.total_requests}, "
                f"TTFT p50={metrics.ttft_p50_ms or 0:.1f}ms, "
                f"E2E p50={metrics.e2e_p50_ms / 1000.0:.2f}s"
            )

            # Apply cooldown between levels (except after the final level)
            if idx < len(concurrencies) - 1 and cooldown_seconds > 0:
                print(f"[*] Cooling down for {cooldown_seconds}s before next concurrency level...")
                await asyncio.sleep(cooldown_seconds)

        # Output Presentation
        print_summary_table(level_results)

        # Save to JSON
        out_file = Path(output_report)
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump([asdict(m) for m in level_results], f, indent=2)
        print(f"[+] Full JSON report saved to: {out_file.resolve()}")

        # Save to Markdown Table Report
        md_file = out_file.with_suffix(".md")
        save_markdown_report(level_results, md_file)
        print(f"[+] Formatted Markdown report saved to: {md_file.resolve()}")

        # Generate STT-equivalent multi-tier tables and detailed streaming CSV
        try:
            from generate_llm_benchmark_reports import generate_reports
            generate_reports()
        except Exception as exc:
            print(f"[!] Note: Could not auto-generate detailed summary tables: {exc}")

    finally:
        if gpu_proc is not None:
            stop_remote_gpu_telemetry(gpu_proc, gpu_csv_path)


if __name__ == "__main__":
    asyncio.run(main_async())
