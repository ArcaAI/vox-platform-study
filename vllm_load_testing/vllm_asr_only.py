#!/usr/bin/env python3
"""
vLLM STT Real-Time Streaming Server Load Test & Benchmark via API Gateway
Pure client-side streaming benchmark:
- Reads audio and streams raw PCM frames directly to API Gateway WebSocket
- No local audio modeling, no local VAD/denoise simulation (load test of the server)
- Measures actual Server Latencies:
  1. WebSocket Round-Trip Time (Audio Sent -> Transcript Returned)
  2. Server ASR Inference Latency (reported by server in `inferenceMs`)
  3. Gateway & Server Transit Overhead (Total WS RTT - Server ASR Inference)
- Supports single stream or multi-client concurrent load testing
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import sys
import time
import wave
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

import bisect
import httpx
import numpy as np
import redis
import requests
import websockets

# Default Gateway Configuration
DEFAULT_GATEWAY_HTTP = os.getenv("GATEWAY_HTTP_URL", "http://192.168.112.6:32458/api/v1")
DEFAULT_GATEWAY_WS = os.getenv("GATEWAY_WS_URL", "ws://192.168.112.6:32458/ws/stt/stream")
DEFAULT_TENANT_KEY = os.getenv("GATEWAY_TENANT_KEY", "ARCAAI")
DEFAULT_USERNAME = os.getenv("GATEWAY_USERNAME", "arcaai_admin")
DEFAULT_PASSWORD = os.getenv("GATEWAY_PASSWORD", "password123")
DEFAULT_AGENT_SLUG = os.getenv("GATEWAY_AGENT_SLUG", "whisper-turbo-v3-asr-only")
DEFAULT_OUTPUT_DIR = os.getenv("BENCHMARK_OUTPUT_DIR", "logs_without_vad_denoise")
DEFAULT_REDIS_URL = os.getenv("REDIS_URL", "redis://:5GX3kEti7iZHt69ZOUnUavkfEjsWGwgfD%2BGAcBK74Xc%3D@192.168.112.6:32522/0")


@dataclass
class StreamMetric:
    worker_id: int
    seq: int
    is_final: bool
    text: str
    speech_start_s: float
    speech_end_s: float
    ws_rtt_ms: float           # Time from audio sent to WebSocket -> transcript returned
    server_asr_ms: float       # Server reported ASR inference time (inferenceMs)
    gateway_overhead_ms: float # Server transit & gateway queueing overhead
    recv_wall_s: float = 0.0   # Wall-clock second into the test when received


@dataclass
class WorkerResult:
    worker_id: int
    success: bool = False
    status: str = "PENDING"              # "PASSED", "FAILED"
    error_message: Optional[str] = None
    session_id: Optional[str] = None
    session_create_ms: float = 0.0       # HTTP session creation latency
    ws_handshake_ms: float = 0.0         # WebSocket connection handshake latency
    current_active: int = 0              # STT worker CapacityGuard active count
    max_concurrent: int = 0              # STT worker CapacityGuard max limit
    ttft_ms: float = 0.0                 # End-to-end Time To First Transcript (from click/request)
    streaming_ttft_ms: float = 0.0       # Time To First Transcript (from first audio chunk)
    metrics: List[StreamMetric] = field(default_factory=list)
    final_text: str = ""
    wall_time_s: float = 0.0
    chunks_sent: int = 0
    responses_received: int = 0



class GatewayClient:
    """Manages authentication and streaming session creation with API Gateway."""

    def __init__(
        self,
        gateway_http: str = DEFAULT_GATEWAY_HTTP,
        gateway_ws: str = DEFAULT_GATEWAY_WS,
        tenant_key: str = DEFAULT_TENANT_KEY,
        username: str = DEFAULT_USERNAME,
        password: str = DEFAULT_PASSWORD,
        agent_slug: str = DEFAULT_AGENT_SLUG,
    ):
        self.gateway_http = gateway_http.rstrip("/")
        self.gateway_ws = gateway_ws
        self.tenant_key = tenant_key
        self.username = username
        self.password = password
        self.agent_slug = agent_slug
        self.token: Optional[str] = None
        self._async_client: Optional[httpx.AsyncClient] = None

    async def get_http_client(self) -> httpx.AsyncClient:
        if self._async_client is None or self._async_client.is_closed:
            self._async_client = httpx.AsyncClient(
                limits=httpx.Limits(max_connections=500, max_keepalive_connections=200),
                timeout=httpx.Timeout(30.0, connect=10.0),
            )
        return self._async_client

    async def close(self):
        if self._async_client and not self._async_client.is_closed:
            await self._async_client.aclose()

    async def authenticate_async(self) -> str:
        """Authenticate with Gateway asynchronously and acquire Bearer token."""
        client = await self.get_http_client()
        login_url = f"{self.gateway_http}/auth/login"
        payload = {
            "username": self.username,
            "password": self.password,
            "tenantKey": self.tenant_key,
        }
        resp = await client.post(login_url, json=payload)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Authentication failed ({resp.status_code}): {resp.text}")

        data = resp.json()
        token = data.get("accessToken") or data.get("token") or data.get("data", {}).get("accessToken")
        if not token:
            raise RuntimeError(f"Malformed auth response: {data}")
        self.token = token
        return token

    def authenticate(self) -> str:
        """Authenticate with Gateway and acquire Bearer token."""
        login_url = f"{self.gateway_http}/auth/login"
        payload = {
            "username": self.username,
            "password": self.password,
            "tenantKey": self.tenant_key,
        }
        resp = requests.post(login_url, json=payload, timeout=None)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Authentication failed ({resp.status_code}): {resp.text}")

        data = resp.json()
        token = data.get("accessToken") or data.get("token") or data.get("data", {}).get("accessToken")
        if not token:
            raise RuntimeError(f"Malformed auth response: {data}")
        self.token = token
        return token

    async def create_session_async(self, sample_rate: int = 16000) -> tuple[str, str, int, int]:
        """Request a real-time STT streaming session asynchronously with connection close to disperse workers."""
        if not self.token:
            await self.authenticate_async()

        client = await self.get_http_client()
        session_url = f"{self.gateway_http}/audio/transcription-jobs/stream/session"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Connection": "close",
        }
        payload = {
            "agentSlug": self.agent_slug,
            "sampleRate": sample_rate,
            "languageMode": "en",
        }

        resp = await client.post(session_url, headers=headers, json=payload)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Session creation failed ({resp.status_code}): {resp.text}")

        res = resp.json()
        data = res.get("data", res)
        session_id = data.get("sessionId") or data.get("id")
        ticket = data.get("ticket") or data.get("wsTicket")
        current_active = int(data.get("currentActive") or 0)
        max_concurrent = int(data.get("maxConcurrent") or 0)
        if not session_id or not ticket:
            raise RuntimeError(f"Missing sessionId or ticket in gateway response: {res}")

        return session_id, ticket, current_active, max_concurrent

    def create_session(self, sample_rate: int = 16000) -> tuple[str, str]:
        """Request a real-time STT streaming session from API Gateway."""
        if not self.token:
            self.authenticate()

        session_url = f"{self.gateway_http}/audio/transcription-jobs/stream/session"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Connection": "close",
        }
        payload = {
            "agentSlug": self.agent_slug,
            "sampleRate": sample_rate,
            "languageMode": "en",
        }

        resp = requests.post(session_url, headers=headers, json=payload, timeout=None)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Session creation failed ({resp.status_code}): {resp.text}")

        res = resp.json()
        data = res.get("data", res)
        session_id = data.get("sessionId") or data.get("id")
        ticket = data.get("ticket") or data.get("wsTicket")
        if not session_id or not ticket:
            raise RuntimeError(f"Missing sessionId or ticket in gateway response: {res}")

        return session_id, ticket

    async def close_session_async(self, session_id: str) -> bool:
        """Asynchronously teardown and release the streaming session on Gateway & STT."""
        if not self.token or not session_id:
            return False
        client = await self.get_http_client()
        url = f"{self.gateway_http}/audio/transcription-jobs/stream/session/{session_id}"
        headers = {"Authorization": f"Bearer {self.token}"}
        try:
            resp = await client.delete(url, headers=headers)
            return resp.status_code in (200, 204)
        except Exception:
            return False

    def close_session(self, session_id: str) -> bool:
        """Explicitly teardown and release the streaming session on Gateway & STT."""
        if not self.token or not session_id:
            return False
        url = f"{self.gateway_http}/audio/transcription-jobs/stream/session/{session_id}"
        headers = {"Authorization": f"Bearer {self.token}"}
        try:
            resp = requests.delete(url, headers=headers, timeout=None)
            return resp.status_code in (200, 204)
        except Exception:
            return False


def read_audio_pcm(audio_path: str) -> tuple[bytes, int, float]:
    """Read raw PCM frames and sample rate directly from WAV file."""
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    with wave.open(audio_path, "rb") as wf:
        sample_rate = wf.getframerate()
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        n_frames = wf.getnframes()
        raw_pcm = wf.readframes(n_frames)

    duration_s = n_frames / float(sample_rate)
    return raw_pcm, sample_rate, duration_s


async def run_single_stream(
    worker_id: int,
    client: GatewayClient,
    audio_pcm: bytes,
    sample_rate: int,
    chunk_ms: int = 250,
    stagger_ms: float = 50.0,
    realtime_pace: float = 1.0,
    verbose: bool = True,
) -> WorkerResult:
    """
    Stream raw audio to Gateway WebSocket and collect server response times.
    Captures complete session lifecycle, tracking passed/failed requests and server errors.
    """
    result = WorkerResult(worker_id=worker_id, status="PENDING")
    stream_start_t = time.perf_counter()
    session_id: Optional[str] = None

    try:
        # Stagger worker startup to avoid slamming Gateway with simultaneous HTTP handshakes
        if worker_id > 1 and stagger_ms > 0:
            await asyncio.sleep((worker_id - 1) * (stagger_ms / 1000.0))
        t_sess = time.perf_counter()
        
        # Transient retry for HTTP session creation (handles momentary gateway downstream spikes)
        ticket = None
        for attempt in range(3):
            try:
                session_id, ticket, current_active, max_concurrent = await client.create_session_async(sample_rate)
                break
            except Exception as e:
                if attempt == 2:
                    raise
                await asyncio.sleep(0.3 * (attempt + 1))

        result.session_create_ms = round((time.perf_counter() - t_sess) * 1000.0, 2)
        result.session_id = session_id
        result.current_active = current_active
        result.max_concurrent = max_concurrent
        if verbose:
            print(f"[{worker_id:>2}] 🔑 Session created: {session_id} in {result.session_create_ms}ms (Worker Active: {current_active}/{max_concurrent})", flush=True)
        ws_url = f"{client.gateway_ws}?sessionId={session_id}&ticket={ticket}"
    except Exception as exc:
        result.status = "FAILED"
        result.error_message = f"Session creation error: {exc}"
        result.wall_time_s = time.perf_counter() - stream_start_t
        if verbose:
            print(f"[{worker_id:>2}] ❌ Session creation failed: {exc}")
        return result

    # Calculate chunk size in bytes (16-bit mono = 2 bytes per sample)
    bytes_per_sample = 2
    bytes_per_sec = sample_rate * bytes_per_sample
    chunk_size = int((chunk_ms / 1000.0) * bytes_per_sec)
    chunk_duration_s = chunk_ms / 1000.0

    audio_sent_timeline: list[tuple[float, float]] = []
    final_texts: List[str] = []
    session_ready = asyncio.Event()
    session_closed = asyncio.Event()

    try:
        t_ws = time.perf_counter()
        if verbose:
            print(f"[{worker_id:>2}] 🔌 Connecting WebSocket -> {ws_url[:75]}...", flush=True)
        async with websockets.connect(
            ws_url,
            max_size=20 * 1024 * 1024,
            open_timeout=None,
            ping_interval=None,
            close_timeout=None,
        ) as ws:
            result.ws_handshake_ms = round((time.perf_counter() - t_ws) * 1000.0, 2)
            if verbose:
                print(f"[{worker_id:>2}] ✅ WebSocket connected in {result.ws_handshake_ms}ms", flush=True)
            stream_start_time: float = 0.0
            printed_debug = False

            # WebSocket Message Receiver
            async def receiver():
                nonlocal printed_debug
                try:
                    async for raw in ws:
                        recv_t = time.perf_counter()
                        try:
                            data = json.loads(raw)
                        except Exception as json_err:
                            if verbose:
                                print(f"[{worker_id:>2}] ⚠️ Non-JSON frame: {raw[:100]} ({json_err})", flush=True)
                            continue

                        msg_type = data.get("type")
                        if verbose and msg_type not in ("transcript",):
                            print(f"[{worker_id:>2}] 📥 Received frame type: '{msg_type}' -> {data}", flush=True)

                        if msg_type == "ready":
                            session_ready.set()

                        if msg_type == "status" and data.get("status") in ("closed", "cancelled"):
                            session_closed.set()
                            if verbose:
                                print(f"[{worker_id:>2}] 🔒 Server signaled status={data.get('status')}", flush=True)
                            break

                        if msg_type == "error":
                            err_msg = data.get("message") or data.get("error") or str(data)
                            result.error_message = f"Server error: {err_msg}"
                            if verbose:
                                print(f"[{worker_id:>2}] ❌ Server error frame: {err_msg}", flush=True)
                            break

                        if msg_type == "transcript":
                            text = data.get("text", "").strip()
                            if not text:
                                continue

                            if not printed_debug and worker_id == 1:
                                printed_debug = True
                                print(f"\n🔍 [SERVER PAYLOAD KEYS]: {list(data.keys())}", flush=True)
                                print(f"🔍 [SAMPLE PAYLOAD]: {json.dumps({k: v for k, v in data.items() if k != 'words' and k != 'word_timestamps_json'})}\n", flush=True)

                            result.responses_received += 1
                            is_final = bool(data.get("isFinal", False))
                            speech_start = float(data.get("startTime", 0.0))
                            speech_end = float(data.get("endTime", 0.0))
                            seq = int(data.get("seq", len(result.metrics) + 1))

                            # End-to-end Time To First Transcript (TTFT)
                            if result.ttft_ms == 0.0:
                                result.ttft_ms = round((recv_t - t_sess) * 1000.0, 2)
                                if stream_start_time > 0:
                                    result.streaming_ttft_ms = round((recv_t - stream_start_time) * 1000.0, 2)

                            # 1. Server-reported ASR Inference Time
                            server_asr_ms = float(data.get("inferenceMs") or data.get("inference_ms") or 0.0)

                            # 2. WebSocket Round-Trip Time
                            ref_time = stream_start_time if stream_start_time > 0 else stream_start_t
                            send_t = ref_time
                            if audio_sent_timeline:
                                for aud_s, t in audio_sent_timeline:
                                    if aud_s >= speech_end:
                                        send_t = t
                                        break
                                else:
                                    send_t = audio_sent_timeline[-1][1]

                            ws_rtt_ms = round(max(0.0, recv_t - send_t) * 1000.0, 2)

                            # 3. Gateway & Server Transit Overhead
                            gateway_overhead_ms = max(0.0, round(ws_rtt_ms - server_asr_ms, 2))
                            recv_wall_s = round(recv_t - ref_time, 2)

                            m = StreamMetric(
                                worker_id=worker_id,
                                seq=seq,
                                is_final=is_final,
                                text=text,
                                speech_start_s=round(speech_start, 2),
                                speech_end_s=round(speech_end, 2),
                                ws_rtt_ms=ws_rtt_ms,
                                server_asr_ms=server_asr_ms,
                                gateway_overhead_ms=gateway_overhead_ms,
                                recv_wall_s=recv_wall_s,
                            )
                            result.metrics.append(m)

                            if verbose:
                                tag = "✅ FINAL" if is_final else "⚡ PARTIAL"
                                print(
                                    f"[{worker_id:>2}] {tag} \"{text[:45]}\" | "
                                    f"WS RTT: {ws_rtt_ms:>6.1f}ms | "
                                    f"Server ASR: {server_asr_ms:>5.1f}ms | "
                                    f"Gateway Overhead: {gateway_overhead_ms:>5.1f}ms",
                                    flush=True
                                )

                            if is_final:
                                final_texts.append(text)
                except asyncio.CancelledError:
                    pass
                except Exception as r_err:
                    if not session_closed.is_set():
                        result.error_message = f"Receiver error: {r_err}"
                    if verbose:
                        print(f"[{worker_id:>2}] ⚠️ Receiver exception: {type(r_err).__name__}: {r_err}", flush=True)

            recv_task = asyncio.create_task(receiver())

            # Gating audio start on server 'ready' frame (official protocol contract)
            if verbose:
                print(f"[{worker_id:>2}] ⏳ Waiting for server 'ready' frame...", flush=True)
            try:
                await asyncio.wait_for(session_ready.wait(), timeout=30.0)
                if verbose:
                    print(f"[{worker_id:>2}] 🚀 Server ready received. Starting audio streaming...", flush=True)
            except asyncio.TimeoutError:
                if verbose:
                    print(f"[{worker_id:>2}] ⚠️ Timed out waiting for server ready frame; proceeding anyway", flush=True)

            # Drift-Free Audio Streamer: sends audio chunks over WebSocket
            offset = 0
            total_bytes = len(audio_pcm)
            audio_time_cursor = 0.0
            chunk_idx = 0
            stream_start_time = time.perf_counter()

            while offset < total_bytes:
                chunk = audio_pcm[offset : offset + chunk_size]
                audio_time_cursor += len(chunk) / float(bytes_per_sec)

                send_t = time.perf_counter()
                audio_sent_timeline.append((audio_time_cursor, send_t))

                await ws.send(chunk)
                result.chunks_sent += 1
                offset += chunk_size
                chunk_idx += 1

                # Drift-free real-time pacing based on absolute clock time
                if realtime_pace > 0:
                    target_wake = stream_start_time + (chunk_idx * chunk_duration_s * realtime_pace)
                    sleep_dur = target_wake - time.perf_counter()
                    if sleep_dur > 0:
                        await asyncio.sleep(sleep_dur)

            if verbose:
                print(f"[{worker_id:>2}] 🏁 Sent all {result.chunks_sent} audio chunks. Allowing socket drain...", flush=True)

            # Allow socket and gateway a brief drain grace (1.0s) so all audio chunks are ingested in Redis before finalize control frame
            await asyncio.sleep(1.0)

            if verbose:
                print(f"[{worker_id:>2}] 🛑 Sending stop control command...", flush=True)
            # Notify server audio stream is finished (stop control frame)
            await ws.send(json.dumps({"type": "stop"}))

            if verbose:
                print(f"[{worker_id:>2}] ⏳ Waiting for server to finalize transcripts...", flush=True)
            try:
                await asyncio.wait_for(session_closed.wait(), timeout=120.0)
            except Exception:
                if verbose:
                    print(f"[{worker_id:>2}] ⏱️ Drain timeout reached (120s)", flush=True)

            # Explicit close frame: finalize upstream immediately (bypasses 30s reconnection grace window)
            try:
                await ws.send(json.dumps({"type": "close"}))
                await asyncio.sleep(0.05)
            except Exception:
                pass

            recv_task.cancel()
            try:
                await recv_task
            except asyncio.CancelledError:
                pass

        result.wall_time_s = time.perf_counter() - stream_start_t
        result.final_text = " ".join(final_texts)

        # A session is marked PASSED if audio was sent and at least one transcript received without fatal error
        if result.chunks_sent > 0 and len(result.metrics) > 0 and not result.error_message:
            result.success = True
            result.status = "PASSED"
        else:
            result.success = False
            result.status = "FAILED"
            if not result.error_message:
                result.error_message = f"No transcripts returned by server before close (chunks_sent={result.chunks_sent}, responses_received={result.responses_received})"
            if verbose:
                print(f"[{worker_id:>2}] ❌ Session marked FAILED: {result.error_message}", flush=True)

    except Exception as exc:
        result.status = "FAILED"
        result.error_message = f"WebSocket error: {exc}"
        result.wall_time_s = time.perf_counter() - stream_start_t
        if verbose:
            print(f"[{worker_id:>2}] ❌ WebSocket failed: {type(exc).__name__}: {exc}", flush=True)
    finally:
        # Guarantee session is cleanly torn down on Gateway and STT CapacityGuard
        if session_id:
            await client.close_session_async(session_id)

    return result


def print_summary(
    results: List[WorkerResult],
    wall_time_s: float,
    audio_len_s: float,
    concurrency: int,
) -> str:
    """Print comprehensive benchmark summary with Passed/Failed statistics and latency percentiles."""
    total_sessions = len(results)
    passed_sessions = sum(1 for r in results if r.success)
    failed_sessions = total_sessions - passed_sessions
    success_rate = (passed_sessions / total_sessions * 100.0) if total_sessions > 0 else 0.0

    total_chunks = sum(r.chunks_sent for r in results)
    total_responses = sum(r.responses_received for r in results)

    # Flatten all metrics from all workers
    metrics: List[StreamMetric] = []
    for r in results:
        metrics.extend(r.metrics)

    lines = [
        "=" * 92,
        f"📊 SERVER LOAD TEST RUN SUMMARY - ASR ONLY (Concurrency: {concurrency})",
        "Agent Model / Pipeline    : whisper-turbo-v3-asr-only (VAD: OFF | Denoise: OFF)",
        "=" * 92,
        f"Total Requests / Sessions : {total_sessions}",
        f"Passed Requests           : {passed_sessions} ({success_rate:.1f}%)",
        f"Failed Requests           : {failed_sessions} ({100.0 - success_rate:.1f}%)",
        f"Total Audio Chunks Sent   : {total_chunks:,}",
        f"Total Transcripts Relayed : {total_responses:,}",
    ]

    # Show failed requests detail if any
    if failed_sessions > 0:
        lines.append("-" * 92)
        lines.append("⚠️ FAILED SESSIONS BREAKDOWN:")
        for r in results:
            if not r.success:
                lines.append(f"  • Worker {r.worker_id:>2} [Session: {r.session_id or 'none'}]: {r.error_message or 'Unknown failure'}")

    lines.append("-" * 92)

    def calc(arr):
        if not arr:
            return {"avg": 0.0, "p50": 0.0, "p95": 0.0, "min": 0.0, "max": 0.0}
        a = np.array(arr)
        return {
            "avg": float(np.mean(a)),
            "p50": float(np.percentile(a, 50)),
            "p95": float(np.percentile(a, 95)),
            "min": float(np.min(a)),
            "max": float(np.max(a)),
        }

    sess_times = [r.session_create_ms for r in results if r.session_create_ms > 0]
    ws_times = [r.ws_handshake_ms for r in results if r.ws_handshake_ms > 0]
    asr_vals = [m.server_asr_ms for m in metrics if m.server_asr_ms > 0]
    gw_vals = [m.gateway_overhead_ms for m in metrics if m.gateway_overhead_ms >= 0]

    # Combo of all 4: session creation + websocket connection + asr inference + gateway/transit overhead
    combo_vals = []
    for r in results:
        base_setup = r.session_create_ms + r.ws_handshake_ms
        for m in r.metrics:
            combo_vals.append(base_setup + m.ws_rtt_ms)

    s_combo = calc(combo_vals)
    s_sess = calc(sess_times)
    s_ws = calc(ws_times)
    s_asr = calc(asr_vals)
    s_gw = calc(gw_vals)

    lines.extend([
        f"{'Latency Metric':<42} {'Average':<12} {'P50 (Median)':<14} {'P95':<12} {'Min':<10} {'Max':<10}",
        "-" * 92,
        f"{'1. Full Latency':<42} {s_combo['avg']:>8.2f} ms  {s_combo['p50']:>10.2f} ms  {s_combo['p95']:>8.2f} ms  {s_combo['min']:>6.2f} ms  {s_combo['max']:>6.2f} ms",
        f"{'2. HTTP Session Creation Latency':<42} {s_sess['avg']:>8.2f} ms  {s_sess['p50']:>10.2f} ms  {s_sess['p95']:>8.2f} ms  {s_sess['min']:>6.2f} ms  {s_sess['max']:>6.2f} ms",
        f"{'3. WebSocket Connection Latency':<42} {s_ws['avg']:>8.2f} ms  {s_ws['p50']:>10.2f} ms  {s_ws['p95']:>8.2f} ms  {s_ws['min']:>6.2f} ms  {s_ws['max']:>6.2f} ms",
        f"{'4. Server ASR Inference Latency':<42} {s_asr['avg']:>8.2f} ms  {s_asr['p50']:>10.2f} ms  {s_asr['p95']:>8.2f} ms  {s_asr['min']:>6.2f} ms  {s_asr['max']:>6.2f} ms",
        f"{'5. Gateway & Transit Overhead':<42} {s_gw['avg']:>8.2f} ms  {s_gw['p50']:>10.2f} ms  {s_gw['p95']:>8.2f} ms  {s_gw['min']:>6.2f} ms  {s_gw['max']:>6.2f} ms",
        "=" * 92,
    ])

    summary_text = "\n".join(lines)
    print("\n" + summary_text + "\n")
    return summary_text


def save_output_txt(summary_text: str, concurrency: int, log_dir: str):
    """Save formatted breakdown text file partitioned by concurrency."""
    os.makedirs(log_dir, exist_ok=True)
    conc_txt_path = os.path.join(log_dir, f"vllm_test_output_{concurrency}.txt")

    with open(conc_txt_path, "w", encoding="utf-8") as f:
        f.write(summary_text + "\n")

    print(f"📄 Summary report saved to: {conc_txt_path}")


def save_csv(
    results: List[WorkerResult],
    csv_path: str,
    concurrency: int,
    log_dir: str,
):
    """Save streaming latency events CSV partitioned by concurrency."""
    os.makedirs(log_dir, exist_ok=True)

    all_metrics: List[StreamMetric] = []
    for r in results:
        all_metrics.extend(r.metrics)

    conc_csv_path = os.path.join(log_dir, f"vllm_load_test_{concurrency}.csv")

    with open(conc_csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "worker_id",
                "seq",
                "type",
                "speech_window",
                "ws_rtt_ms",
                "server_asr_ms",
                "gateway_overhead_ms",
                "wall_time_s",
                "transcript",
            ],
        )
        writer.writeheader()
        for m in all_metrics:
            writer.writerow({
                "worker_id": m.worker_id,
                "seq": m.seq,
                "type": "FINAL" if m.is_final else "PARTIAL",
                "speech_window": f"{m.speech_start_s:.2f}s - {m.speech_end_s:.2f}s",
                "ws_rtt_ms": m.ws_rtt_ms,
                "server_asr_ms": m.server_asr_ms,
                "gateway_overhead_ms": m.gateway_overhead_ms,
                "wall_time_s": m.recv_wall_s,
                "transcript": m.text.replace("\n", " ").strip(),
            })
    print(f"📁 Server latency metrics saved to: {conc_csv_path}")


def clear_redis_streams(redis_url: str = DEFAULT_REDIS_URL, patterns: list[str] = None):
    """Purge stale stt streaming keys from Redis before testing."""
    if patterns is None:
        patterns = [
            "stt:audio:*",
            "stt:result:*",
            "stt:control:*",
            "stt:session:*",
            "session:*",
            "stream-session-meta:*",
            "stream-session-tenant:*",
        ]
    try:
        r = redis.from_url(redis_url, protocol=2, socket_timeout=5, socket_connect_timeout=5)
        total_deleted = 0
        for pattern in patterns:
            cursor = 0
            while True:
                cursor, keys = r.scan(cursor=cursor, match=pattern, count=1000)
                if keys:
                    total_deleted += r.delete(*keys)
                if cursor == 0:
                    break
        if total_deleted > 0:
            print(f"🧹 Redis Stream Cleanup: Cleared {total_deleted} stale streaming keys before starting test", flush=True)
        else:
            print("🧹 Redis Stream Cleanup: Redis is clean (0 stale streaming keys)", flush=True)
    except Exception as exc:
        print(f"⚠️ Redis Stream Cleanup skipped ({exc})", flush=True)


def capture_remote_diagnostics(
    start_time_utc: str,
    concurrency: int,
    results: List[WorkerResult],
    log_dir: str,
    gpu_host: str = "192.168.112.2",
    gpu_user: str = "nitik",
) -> None:
    """
    Capture nvidia-smi dump and docker logs for vllm-whisper from GPU server.
    Saves solely under logs_without_vad_denoise/concurrency_{concurrency}/.
    """
    import subprocess
    os.makedirs(log_dir, exist_ok=True)

    print(f"🔍 Fetching remote GPU diagnostics & vllm-whisper logs from {gpu_host}...", flush=True)

    def _run_ssh(cmd: str) -> str:
        try:
            res = subprocess.run(
                ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", f"{gpu_user}@{gpu_host}", cmd],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if res.returncode == 0:
                return res.stdout
        except Exception:
            pass
        try:
            from scratch.ssh_cmd import run_ssh  # type: ignore
            return run_ssh(cmd, host=gpu_host)
        except Exception as e:
            return f"Error executing remote command: {e}"

    # 1. Capture nvidia-smi
    smi_cmd = "nvidia-smi && echo '' && nvidia-smi --query-gpu=timestamp,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw --format=csv"
    smi_out = _run_ssh(smi_cmd)

    # 2. Capture vllm-whisper logs (since start_time_utc, with tail fallback)
    vllm_cmd = f"docker logs --since {start_time_utc} vllm-whisper 2>&1"
    vllm_out = _run_ssh(vllm_cmd)
    if len(vllm_out.strip().splitlines()) < 5:
        vllm_out = _run_ssh("docker logs --tail 150 vllm-whisper 2>&1")

    # 3. Save diagnostic logs exclusively in concurrency dir
    run_smi_path = os.path.join(log_dir, f"nvidia_smi_{concurrency}.txt")
    with open(run_smi_path, "w", encoding="utf-8") as f:
        f.write(smi_out)

    run_vllm_path = os.path.join(log_dir, f"vllm_whisper_{concurrency}.log")
    with open(run_vllm_path, "w", encoding="utf-8") as f:
        f.write(vllm_out)

    print(f"📊 Run Diagnostics saved in {log_dir}:")
    print(f"   • nvidia-smi:   {run_smi_path}")
    print(f"   • vllm logs:    {run_vllm_path}")


async def main_async(args):
    # 0. Clear Redis Streams if requested
    if getattr(args, "clear_redis", True):
        clear_redis_streams(args.redis_url)

    # 1. Read Raw Audio (no local processing)
    audio_pcm, sample_rate, duration_s = read_audio_pcm(args.audio)
    print("=" * 80)
    print("🚀 vLLM STREAMING BENCHMARK - ASR ONLY (WITHOUT VAD & DENOISE)")
    print(f"Gateway HTTP : {args.gateway_http}")
    print(f"Gateway WS   : {args.gateway_ws}")
    print(f"Agent Slug   : {args.agent}")
    print(f"Tenant       : {args.tenant}")
    print(f"Audio File   : {args.audio} ({duration_s:.2f}s, {sample_rate}Hz)")
    print(f"Concurrency  : {args.concurrency} concurrent streaming worker(s)")
    print(f"Chunk Size   : {args.chunk_ms} ms (Pacing: {args.pace}x)")
    print("=" * 80 + "\n")

    # 2. Authenticate once
    client = GatewayClient(
        gateway_http=args.gateway_http,
        gateway_ws=args.gateway_ws,
        tenant_key=args.tenant,
        username=args.user,
        password=args.password,
        agent_slug=args.agent,
    )
    print("🔐 Authenticating with Gateway...")
    client.authenticate()
    print("✅ Authenticated. Starting streaming workload...\n")

    # Record UTC start time for logs filtering
    start_time_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 2))

    # 3. Launch Concurrent Streams
    t0 = time.perf_counter()
    try:
        tasks = [
            run_single_stream(
                worker_id=i + 1,
                client=client,
                audio_pcm=audio_pcm,
                sample_rate=sample_rate,
                chunk_ms=args.chunk_ms,
                stagger_ms=args.stagger_ms,
                realtime_pace=args.pace,
                verbose=(args.concurrency <= 2),
            )
            for i in range(args.concurrency)
        ]

        results: List[WorkerResult] = await asyncio.gather(*tasks)
    finally:
        await client.close()

    total_wall_time = time.perf_counter() - t0

    # Print sample transcript from Worker 1 if available
    if results and results[0].final_text:
        print(f"\n📝 Sample Final Transcript (Worker 1):\n   \"{results[0].final_text}\"")

    # 4. Destination directory partitioned by concurrency: <root_dir>/concurrency_{N}/
    root_log_dir = os.path.dirname(args.output_csv) or DEFAULT_OUTPUT_DIR
    conc_log_dir = os.path.join(root_log_dir, f"concurrency_{args.concurrency}")
    os.makedirs(conc_log_dir, exist_ok=True)

    # 5. Print & Save Summary Table with Passed/Failed statistics
    summary_text = print_summary(results, total_wall_time, duration_s, args.concurrency)
    save_output_txt(summary_text, args.concurrency, log_dir=conc_log_dir)

    # 6. Save Partitioned Latency CSV
    save_csv(results, args.output_csv, args.concurrency, log_dir=conc_log_dir)

    # 7. Capture Remote Server Diagnostics (vllm-whisper logs and nvidia-smi dump)
    if getattr(args, "remote_diagnostics", True):
        capture_remote_diagnostics(
            start_time_utc=start_time_utc,
            concurrency=args.concurrency,
            results=results,
            log_dir=conc_log_dir,
            gpu_host=args.gpu_host,
            gpu_user=args.gpu_user,
        )


def main():
    parser = argparse.ArgumentParser(description="vLLM STT Streaming Server Load Test via API Gateway - ASR Only")
    parser.add_argument("--audio", default="test_files/1_mono_16k.wav", help="Path to WAV audio file")
    parser.add_argument("--concurrency", type=int, default=1, help="Number of concurrent streaming sessions (default: 1)")
    parser.add_argument("--gateway-http", default=DEFAULT_GATEWAY_HTTP, help="Gateway HTTP base URL")
    parser.add_argument("--gateway-ws", default=DEFAULT_GATEWAY_WS, help="Gateway WebSocket base URL")
    parser.add_argument("--agent", default=DEFAULT_AGENT_SLUG, help="Agent slug (e.g. whisper-turbo-v3-asr-only)")
    parser.add_argument("--tenant", default=DEFAULT_TENANT_KEY, help="Tenant Key (e.g. ARCAAI)")
    parser.add_argument("--user", default=DEFAULT_USERNAME, help="Username")
    parser.add_argument("--password", default=DEFAULT_PASSWORD, help="Password")
    parser.add_argument("--chunk-ms", type=int, default=250, help="Audio frame chunk size in ms (default: 250)")
    parser.add_argument("--stagger-ms", type=float, default=50.0, help="Stagger delay between starting concurrent workers in ms (default: 50.0)")
    parser.add_argument("--pace", type=float, default=1.0, help="Pacing factor (1.0 = real-time pace, 0.0 = burst rate)")
    parser.add_argument("--output-csv", default=f"{DEFAULT_OUTPUT_DIR}/vllm_load_test.csv", help="Output CSV path")
    parser.add_argument("--clear-redis", action="store_true", default=True, help="Clear stale stt:audio and stt:session keys from Redis before test (default: True)")
    parser.add_argument("--no-clear-redis", dest="clear_redis", action="store_false", help="Skip clearing Redis keys before test")
    parser.add_argument("--redis-url", default=DEFAULT_REDIS_URL, help="Redis URL for cleanup")
    parser.add_argument("--remote-diagnostics", action="store_true", default=True, help="Capture vllm-whisper logs and nvidia-smi dump (default: True)")
    parser.add_argument("--no-remote-diagnostics", dest="remote_diagnostics", action="store_false", help="Disable remote diagnostics capture")
    parser.add_argument("--gpu-host", default="192.168.112.2", help="Remote GPU server host")
    parser.add_argument("--gpu-user", default="nitik", help="Remote GPU server SSH user")
    args = parser.parse_args()

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
