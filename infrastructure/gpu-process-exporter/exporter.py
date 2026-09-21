#!/usr/bin/env python3
"""hope-gpu-process-exporter — per-PROCESS GPU memory, as Prometheus metrics.

Why this exists
---------------
dcgm-exporter (the exporter the NVIDIA GPU Operator already ships) publishes
DEVICE-level fields only — `DCGM_FI_DEV_FB_USED` and friends are per-card. Its
`pod` label comes from the kubelet pod-resources API, i.e. from a device -> pod
mapping, so it can never answer "which PROCESS is holding this memory", and under
GPU time-slicing it attributes a whole card to whichever sharing pod it resolved.

NVML does know, and `nvidia-smi --query-compute-apps` reports it. This exporter is
that query on a loop, with the PID resolved back to a Kubernetes pod.

PID namespace is the whole trick
--------------------------------
NVML translates PIDs into the caller's PID namespace and HIDES processes it cannot
translate. Measured on hope-v2-dev (2026-09-21): inside `hope-stt`, nvidia-smi
listed exactly one process (its own PID 1, 1904 MiB); inside `hope-lmstudio`, only
llama-server (PID 552, 4996 MiB on GPU0 + 8908 MiB on GPU1). Neither saw the other.
So this process MUST run with `hostPID: true` to see every GPU process on the node.

Pod attribution carries no Kubernetes client. It reads `/proc/<pid>/cgroup` (cgroup
v2 on this node) and emits `pod_uid` / `container_id` labels; the pod NAME is joined
in PromQL against kube-state-metrics' `kube_pod_info{uid=...}`, which is already
scraped. A PID whose cgroup does not parse is emitted with `pod_uid=""` rather than
guessed — an unattributed process is a fact, not a gap to paper over.

Usage:  exporter.py [--port 9401] [--interval 15]
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# cgroup v2 + containerd: .../kubepods-besteffort-pod<UID>.slice/cri-containerd-<ID>.scope
# systemd escapes the UID's hyphens to underscores, so accept both.
_POD_UID = re.compile(
    r"pod([0-9a-fA-F]{8}[-_][0-9a-fA-F]{4}[-_][0-9a-fA-F]{4}"
    r"[-_][0-9a-fA-F]{4}[-_][0-9a-fA-F]{12})"
)
_CONTAINER_ID = re.compile(r"(?:cri-containerd-|crio-|docker-|/)([0-9a-f]{64})")

_PROC = os.environ.get("HOST_PROC", "/proc")


def _nvidia_smi(query: str, entity: str) -> list[list[str]]:
    out = subprocess.run(
        ["nvidia-smi", f"--query-{entity}={query}", "--format=csv,noheader,nounits"],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    ).stdout
    return [[c.strip() for c in line.split(",")] for line in out.splitlines() if line.strip()]


def _pod_of(pid: str) -> tuple[str, str]:
    """(pod_uid, container_id) for a PID, or ("", "") when it is not in a pod."""
    try:
        with open(f"{_PROC}/{pid}/cgroup", "r") as fh:
            blob = fh.read()
    except OSError:
        return "", ""
    uid = _POD_UID.search(blob)
    cid = _CONTAINER_ID.search(blob)
    return (uid.group(1).replace("_", "-") if uid else "", cid.group(1) if cid else "")


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def collect() -> str:
    started = time.monotonic()
    lines: list[str] = [
        "# HELP hope_gpu_process_memory_bytes GPU framebuffer memory held by one process "
        "on one device, from nvidia-smi --query-compute-apps. Measured, not estimated.",
        "# TYPE hope_gpu_process_memory_bytes gauge",
    ]
    samples: list[str] = []
    ok = 1
    try:
        uuid_to_index = {row[1]: row[0] for row in _nvidia_smi("index,uuid", "gpu")}
        for pid, name, used_mib, uuid in _nvidia_smi(
            "pid,process_name,used_gpu_memory,gpu_uuid", "compute-apps"
        ):
            pod_uid, container_id = _pod_of(pid)
            labels = (
                f'gpu="{_escape(uuid_to_index.get(uuid, ""))}",'
                f'uuid="{_escape(uuid)}",'
                f'pid="{_escape(pid)}",'
                f'process_name="{_escape(os.path.basename(name))}",'
                f'pod_uid="{_escape(pod_uid)}",'
                f'container_id="{_escape(container_id)}"'
            )
            samples.append(
                f"hope_gpu_process_memory_bytes{{{labels}}} {int(used_mib) * 1024 * 1024}"
            )
    except (subprocess.SubprocessError, OSError, ValueError, IndexError) as exc:
        ok = 0
        print(f"gpu_process_exporter: scrape failed: {exc}", file=sys.stderr, flush=True)

    lines.extend(samples)
    lines += [
        "# HELP hope_gpu_process_count Number of GPU compute processes visible to this exporter.",
        "# TYPE hope_gpu_process_count gauge",
        f"hope_gpu_process_count {len(samples)}",
        "# HELP hope_gpu_process_scrape_success 1 if the last nvidia-smi scrape succeeded.",
        "# TYPE hope_gpu_process_scrape_success gauge",
        f"hope_gpu_process_scrape_success {ok}",
        "# HELP hope_gpu_process_scrape_duration_seconds Duration of the last nvidia-smi scrape.",
        "# TYPE hope_gpu_process_scrape_duration_seconds gauge",
        f"hope_gpu_process_scrape_duration_seconds {time.monotonic() - started:.6f}",
        "",
    ]
    return "\n".join(lines)


class _Cache:
    def __init__(self, interval: float) -> None:
        self._interval = interval
        self._lock = threading.Lock()
        self._body = collect()
        self._at = time.monotonic()

    def body(self) -> bytes:
        with self._lock:
            if time.monotonic() - self._at >= self._interval:
                self._body = collect()
                self._at = time.monotonic()
            return self._body.encode()


def main() -> int:
    parser = argparse.ArgumentParser(description="Per-process GPU memory exporter.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("EXPORTER_PORT", 9401)))
    parser.add_argument(
        "--interval",
        type=float,
        default=float(os.environ.get("EXPORTER_INTERVAL_SECONDS", 15)),
        help=(
            "Minimum seconds between nvidia-smi invocations; /metrics serves a cached "
            "body in between."
        ),
    )
    args = parser.parse_args()

    if shutil.which("nvidia-smi") is None:
        print(
            "gpu_process_exporter: nvidia-smi not found — the pod needs the nvidia "
            "runtime class and NVIDIA_VISIBLE_DEVICES set. Refusing to serve.",
            file=sys.stderr,
        )
        return 1

    cache = _Cache(args.interval)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path.split("?")[0] not in ("/metrics", "/"):
                self.send_error(404)
                return
            body = cache.body()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_: object) -> None:
            return

    print(f"gpu_process_exporter: listening on :{args.port}/metrics", flush=True)
    ThreadingHTTPServer(("", args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
