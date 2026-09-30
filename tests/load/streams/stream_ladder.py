"""TASK-1007 — realtime STT stream concurrency ladder with resource sampling.

Drives N concurrent realtime transcription sessions through the gateway's
``/ws/stt/stream`` (the same wire path the console and SDKs use), for each N in a
ladder, while a background sampler records memory/CPU of every local HOPE
process and container. The question it answers is "does anything run out of
memory, and where does it degrade", not transcription quality.

Reuses the single-session pieces of
``apps/stt/tests/integration/test_streaming_loss_harness.py`` (feed / receive /
metrics) so the per-session numbers mean exactly what they mean there.

Run (arcaenv)::

    conda run -n arcaenv --no-capture-output python tests/load/streams/stream_ladder.py

Env:
    LADDER_LEVELS          comma list (default 1,2,4,8,10,12,15,20,24,32,64)
    LADDER_API_URL         gateway origin (default http://localhost:8868)
    LADDER_COOLDOWN_S      pause between steps (default 20)
    LADDER_SAMPLE_LOCAL    1 = sample local processes/containers (default 1)
    LADDER_OUT             output dir (default tests/load/results/streams)
    STREAM_*               forwarded to the harness helpers (WAV, MAX_SECONDS,
                           FRAME_MS, TIMEOUT_S, LOGIN_*, AGENT_SLUG)
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "apps/stt/tests/integration"))

import httpx  # noqa: E402
import test_streaming_loss_harness as h  # noqa: E402
import websockets  # noqa: E402

LEVELS = [int(x) for x in os.environ.get("LADDER_LEVELS", "1,2,4,8,10,12,15,20,24,32,64").split(",")]
API_URL = os.environ.get("LADDER_API_URL", "http://localhost:8868").rstrip("/")
COOLDOWN_S = float(os.environ.get("LADDER_COOLDOWN_S", "20"))
SAMPLE_LOCAL = os.environ.get("LADDER_SAMPLE_LOCAL", "1") == "1"
OUT = Path(os.environ.get("LADDER_OUT", str(REPO / "tests/load/results/streams")))
FRAME_MS = float(os.environ.get("STREAM_FRAME_MS", "80"))
TIMEOUT_S = float(os.environ.get("STREAM_TIMEOUT_S", "60"))

PID_DIR = Path(os.environ.get("HOPE_DEV_STATE_DIR", Path.home() / ".local/state/hope-dev")) / "pids/dev"
SERVICES = ["api", "stt", "stt-worker", "text", "guardrail", "nlp", "harness", "worker"]


# ---------------------------------------------------------------------------
# Resource sampler (local)
# ---------------------------------------------------------------------------


def _ps_table() -> dict[int, tuple[int, int, float]]:
    """pid -> (ppid, rss_kb, cpu%)."""
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,rss=,%cpu="], capture_output=True, text=True).stdout
    table: dict[int, tuple[int, int, float]] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 4:
            table[int(parts[0])] = (int(parts[1]), int(parts[2]), float(parts[3]))
    return table


def _footprints() -> dict[int, tuple[float, str]]:
    """pid -> (physical footprint MB, command) from `top` (MEM column).

    On Apple Silicon RSS misses Metal/MPS buffers; the footprint does not.
    """
    out = subprocess.run(
        ["top", "-l", "1", "-stats", "pid,mem,command"], capture_output=True, text=True
    ).stdout
    res: dict[int, tuple[float, str]] = {}
    mult = {"B": 1 / 2**20, "K": 1 / 1024, "M": 1.0, "G": 1024.0}
    started = False
    for line in out.splitlines():
        if line.startswith("PID"):
            started = True
            continue
        parts = line.split(None, 2)
        if not started or len(parts) < 2 or not parts[0].isdigit():
            continue
        mem = parts[1].rstrip("+-")
        try:
            res[int(parts[0])] = (float(mem[:-1]) * mult.get(mem[-1], 1.0), parts[2] if len(parts) > 2 else "")
        except ValueError:
            pass
    return res


def _tree(root: int, table: dict[int, tuple[int, int, float]]) -> list[int]:
    children: dict[int, list[int]] = {}
    for pid, (ppid, _, _) in table.items():
        children.setdefault(ppid, []).append(pid)
    stack, seen = [root], []
    while stack:
        p = stack.pop()
        if p in table:
            seen.append(p)
            stack.extend(children.get(p, []))
    return seen


def _service_roots() -> dict[str, int]:
    roots: dict[str, int] = {}
    for svc in SERVICES:
        pf = PID_DIR / f"{svc}.pid"
        try:
            roots[svc] = int(pf.read_text().split()[0])
        except (OSError, ValueError, IndexError):
            pass
    return roots


def _docker_stats() -> dict[str, float]:
    out = subprocess.run(
        ["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}"],
        capture_output=True,
        text=True,
    ).stdout
    res: dict[str, float] = {}
    units = {"B": 1 / 2**20, "KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "kB": 1 / 1000, "MB": 1, "GB": 1000}
    for line in out.splitlines():
        name, _, usage = line.partition("\t")
        used = usage.split("/")[0].strip()
        for u in sorted(units, key=len, reverse=True):
            if used.endswith(u):
                try:
                    res[name] = round(float(used[: -len(u)]) * units[u], 1)
                except ValueError:
                    pass
                break
    return res


def _system_mem() -> dict[str, Any]:
    swap = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
    used_mb = 0.0
    parts = swap.split()
    if "used" in parts:
        used_mb = float(parts[parts.index("used") + 2].rstrip("M"))
    level = subprocess.run(
        ["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], capture_output=True, text=True
    ).stdout.strip()
    vm = subprocess.run(["vm_stat"], capture_output=True, text=True).stdout
    page = 16384
    vals = {}
    for line in vm.splitlines()[1:]:
        k, _, v = line.partition(":")
        try:
            vals[k.strip()] = int(v.strip().rstrip("."))
        except ValueError:
            pass
    free_mb = (vals.get("Pages free", 0) + vals.get("Pages speculative", 0)) * page / 2**20
    compressed_mb = vals.get("Pages occupied by compressor", 0) * page / 2**20
    mp = subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True).stdout
    free_pct = None
    for line in mp.splitlines():
        if "free percentage" in line:
            free_pct = int(line.rsplit(":", 1)[1].strip().rstrip("%"))
    return {
        "free_pct": free_pct,
        "swap_used_mb": used_mb,
        "pressure_level": int(level or 0),  # 1 normal, 2 warn, 4 critical
        "free_mb": round(free_mb),
        "compressed_mb": round(compressed_mb),
    }


class Sampler:
    def __init__(self, interval_s: float = 2.0) -> None:
        self.interval_s = interval_s
        self.samples: list[dict[str, Any]] = []
        self.step = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self.roots = _service_roots()

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=10)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                table = _ps_table()
                fp = _footprints()
                procs: dict[str, dict[str, Any]] = {}
                for svc, root in self.roots.items():
                    pids = _tree(root, table)
                    procs[svc] = {
                        "alive": root in table,
                        "rss_mb": round(sum(fp.get(p, (table[p][1] / 1024, ""))[0] for p in pids), 1),
                        "cpu": round(sum(table[p][2] for p in pids), 1),
                    }
                # Outside the supervisor: LM Studio's llama-server, the Docker VM.
                for label, needle in (("lmstudio", "llama-server"), ("docker-vm", "OrbStack Helper")):
                    procs[label] = {
                        "alive": True,
                        "rss_mb": round(sum(m for m, c in fp.values() if needle in c), 1),
                        "cpu": 0.0,
                    }
                self.samples.append(
                    {
                        "t": time.time(),
                        "step": self.step,
                        "procs": procs,
                        "docker_mb": _docker_stats(),
                        "system": _system_mem(),
                    }
                )
            except Exception as exc:  # sampler must never kill the run
                self.samples.append({"t": time.time(), "step": self.step, "error": repr(exc)})
            self._stop.wait(self.interval_s)


# ---------------------------------------------------------------------------
# Streams
# ---------------------------------------------------------------------------


async def _one(http: httpx.AsyncClient, token: str, audio: h.ReplayAudio, idx: int) -> dict[str, Any]:
    ws_origin = h._ws_origin(API_URL)
    t_create = time.perf_counter()
    try:
        created = await h._create_session(http, API_URL, token)
    except Exception as exc:
        return {"idx": idx, "ok": False, "stage": "create", "error": repr(exc)[:200]}
    create_ms = round((time.perf_counter() - t_create) * 1000, 1)
    if isinstance(created, tuple):
        return {"idx": idx, "ok": False, "stage": "create", "status": created[0], "error": created[1]}
    sid = created["sessionId"]
    url = f"{ws_origin}/ws/stt/stream?sessionId={sid}&ticket={created['ticket']}"
    cap = h.Capture()
    frames: list[h.FrameRecord] = []
    err = None
    try:
        async with websockets.connect(url, max_size=None, open_timeout=20, close_timeout=5) as ws:
            t0 = time.perf_counter()
            recv = asyncio.create_task(h._receive(ws, cap, t0))
            frames = await h._feed(ws, audio, FRAME_MS, t0)
            await ws.send(json.dumps({"type": "stop"}))
            try:
                await asyncio.wait_for(cap.closed.wait(), timeout=TIMEOUT_S)
            except TimeoutError:
                pass
            recv.cancel()
    except Exception as exc:
        err = repr(exc)[:200]
    finally:
        await h._delete_session(http, API_URL, token, sid)
    errors = [e for e in cap.events if e.kind == "error"]
    try:
        m = h.compute_metrics(frames, cap.events, audio, FRAME_MS, session_create_ms=create_ms)
    except Exception as exc:
        m = {"metrics_error": repr(exc)[:200]}
    finals = [e for e in cap.events if e.kind == "transcript_final"]
    return {
        "idx": idx,
        # A stream only counts when the session closed AND its finals cover >= 90% of the
        # audio sent: "at least one final" hid a 0/20-closed backlog at N=20 locally.
        "ok": err is None
        and not errors
        and cap.closed.is_set()
        and ((m.get("loss") or {}).get("audio_coverage_ratio") or 0) >= 0.9,
        "stage": "stream" if err else "done",
        "error": err or (errors[0].text if errors else None),
        "create_ms": create_ms,
        "frames_sent": len(frames),
        "finals": len(finals),
        "closed": cap.closed.is_set(),
        "first_partial_ms": m.get("first_partial_ms"),
        "commit_latency_ms": m.get("commit_latency_ms"),
        "loss": m.get("loss"),
    }


def _pct(vals: list[float], q: float) -> float | None:
    vals = sorted(v for v in vals if v is not None)
    if not vals:
        return None
    return round(vals[min(len(vals) - 1, int(q * len(vals)))], 1)


async def _active_streams(http: httpx.AsyncClient) -> float | None:
    stt = os.environ.get("STREAM_STT_URL", "http://localhost:8861")
    try:
        r = await http.get(f"{stt}/metrics", timeout=5)
        for line in r.text.splitlines():
            if line.startswith("stt_streaming_sessions_active"):
                return float(line.split()[-1])
    except Exception:
        return None
    return None


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    audio = h.load_replay_audio()
    sampler = Sampler() if SAMPLE_LOCAL else None
    steps: list[dict[str, Any]] = []
    async with httpx.AsyncClient(limits=httpx.Limits(max_connections=200)) as http:
        token = await h._login(http, API_URL)
        if not token:
            raise SystemExit("login failed")
        print(f"audio {audio.duration_s:.1f}s  levels {LEVELS}", flush=True)
        if sampler:
            sampler.start()
        for n in LEVELS:
            if sampler:
                sampler.step = n
            t0 = time.time()
            results = await asyncio.gather(*(_one(http, token, audio, i) for i in range(n)))
            wall = round(time.time() - t0, 1)
            ok = [r for r in results if r["ok"]]
            fp = [r["first_partial_ms"] for r in ok]
            commit_p99 = [(r["commit_latency_ms"] or {}).get("p99") for r in ok]
            step = {
                "concurrency": n,
                "t_start": t0,
                "t_end": time.time(),
                "wall_s": wall,
                "ok": len(ok),
                "failed": n - len(ok),
                "failures": sorted({f"{r['stage']}:{r.get('status', '')}:{str(r.get('error'))[:80]}" for r in results if not r["ok"]}),
                "first_partial_ms_p50": _pct(fp, 0.5),
                "first_partial_ms_p95": _pct(fp, 0.95),
                "commit_p99_ms_worst": max((v for v in commit_p99 if v is not None), default=None),
                "results": results,
            }
            if sampler:
                win = [s for s in sampler.samples if s.get("step") == n and "procs" in s]
                step["peak_rss_mb"] = {
                    svc: max(s["procs"][svc]["rss_mb"] for s in win if svc in s["procs"])
                    for svc in win[-1]["procs"]
                } if win else {}
                step["dead"] = sorted({svc for s in win for svc, p in s["procs"].items() if not p["alive"]})
                step["peak_docker_mb"] = {
                    k: max(s["docker_mb"].get(k, 0) for s in win) for k in (win[-1]["docker_mb"] if win else {})
                }
                step["system_worst"] = {
                    "swap_used_mb": max((s["system"]["swap_used_mb"] for s in win), default=None),
                    "pressure_level": max((s["system"]["pressure_level"] for s in win), default=None),
                    "free_mb_min": min((s["system"]["free_mb"] for s in win), default=None),
                    "free_pct_min": min((s["system"]["free_pct"] for s in win if s["system"]["free_pct"] is not None), default=None),
                }
            steps.append(step)
            print(
                json.dumps({k: v for k, v in step.items() if k != "results"}, default=str),
                flush=True,
            )
            (OUT / f"ladder-{stamp}.json").write_text(
                json.dumps({"api": API_URL, "audio_s": audio.duration_s, "steps": steps,
                            "samples": sampler.samples if sampler else []}, default=str, indent=1)
            )
            if n != LEVELS[-1]:
                # drain: wait until STT reports no active sessions, then cool down
                for _ in range(60):
                    a = await _active_streams(http)
                    if not a:
                        break
                    await asyncio.sleep(2)
                await asyncio.sleep(COOLDOWN_S)
    if sampler:
        sampler.stop()
        (OUT / f"ladder-{stamp}.json").write_text(
            json.dumps({"api": API_URL, "audio_s": audio.duration_s, "steps": steps,
                        "samples": sampler.samples}, default=str, indent=1)
        )
    print(f"wrote {OUT / f'ladder-{stamp}.json'}")


if __name__ == "__main__":
    asyncio.run(main())
