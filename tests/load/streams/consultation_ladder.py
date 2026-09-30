"""TASK-1007 — full realtime consultation concurrency ladder.

One virtual user = one complete realtime consultation on the wire, exactly as
``@arcaai/vox-node`` drives it:

    POST consultations/open {patientId}            (distinct patient per user —
                                                    open is get-or-create on
                                                    patient+doctor+date)
    POST audio/transcription-jobs/stream/session {consultationId}
    POST consultations/:id/recording/start {sessionId}
    GET  consultations/:id/live-summary/stream     (SSE, held for the whole run)
    WS   /ws/stt/stream?sessionId&ticket            (real-time PCM replay)
    POST consultations/:id/recording/stop
    GET  consultations/:id/summary/latest           (poll until a note exists)

Sampling, ladder levels and output shape are shared with ``stream_ladder.py``.

Env (in addition to stream_ladder's):
    CONSULT_NOTE_TIMEOUT_S   how long to wait for the final note (default 300)
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
import stream_ladder as L
import websockets

h = L.h
API = L.API_URL
NOTE_TIMEOUT_S = float(os.environ.get("CONSULT_NOTE_TIMEOUT_S", "300"))
RUN = uuid.uuid4().hex[:6]


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _sse(http: httpx.AsyncClient, token: str, cid: str, stats: dict[str, Any], stop: asyncio.Event) -> None:
    url = f"{API}/api/v1/consultations/{cid}/live-summary/stream"
    try:
        async with http.stream("GET", url, headers={**_auth(token), "Accept": "text/event-stream"}, timeout=None) as r:
            stats["sse_status"] = r.status_code
            async for line in r.aiter_lines():
                if line.startswith("data:"):
                    stats["sse_events"] = stats.get("sse_events", 0) + 1
                if stop.is_set():
                    break
    except Exception as exc:
        if not stop.is_set():
            stats["sse_error"] = repr(exc)[:160]


async def _one(http: httpx.AsyncClient, token: str, audio: h.ReplayAudio, idx: int) -> dict[str, Any]:
    res: dict[str, Any] = {"idx": idx, "ok": False}
    hdr = _auth(token)
    t0 = time.perf_counter()

    def fail(stage: str, r: httpx.Response | None = None, err: str | None = None) -> dict[str, Any]:
        res.update(stage=stage, status=r.status_code if r is not None else None,
                   error=err or (r.text[:160] if r is not None else None))
        return res

    try:
        r = await http.post(f"{API}/api/v1/consultations/open", headers=hdr,
                            json={"patientId": str(uuid.uuid4())}, timeout=60)
        if r.status_code not in (200, 201):
            return fail("open", r)
        cid = r.json()["id"]
        res["consultationId"] = cid
        r = await http.post(f"{API}/api/v1/audio/transcription-jobs/stream/session", headers=hdr,
                            json={"consultationId": cid, "sampleRate": 16000}, timeout=60)
        if r.status_code != 201:
            return fail("stt-session", r)
        sess = r.json()
        r = await http.post(f"{API}/api/v1/consultations/{cid}/recording/start", headers=hdr,
                            json={"sessionId": sess["sessionId"]}, timeout=60)
        if r.status_code not in (200, 201):
            return fail("recording-start", r)
        res["setup_ms"] = round((time.perf_counter() - t0) * 1000)

        stop = asyncio.Event()
        sse_task = asyncio.create_task(_sse(http, token, cid, res, stop))
        cap = h.Capture()
        url = f"{h._ws_origin(API)}/ws/stt/stream?sessionId={sess['sessionId']}&ticket={sess['ticket']}"
        async with websockets.connect(url, max_size=None, open_timeout=20, close_timeout=5) as ws:
            tw = time.perf_counter()
            recv = asyncio.create_task(h._receive(ws, cap, tw))
            await h._feed(ws, audio, L.FRAME_MS, tw)
            await ws.send(json.dumps({"type": "stop"}))
            try:
                await asyncio.wait_for(cap.closed.wait(), timeout=L.TIMEOUT_S)
            except TimeoutError:
                pass
            recv.cancel()
        res["finals"] = sum(1 for e in cap.events if e.kind == "transcript_final")
        res["ws_errors"] = [e.text for e in cap.events if e.kind == "error"][:2]

        t_stop = time.perf_counter()
        r = await http.post(f"{API}/api/v1/consultations/{cid}/recording/stop", headers=hdr, json={}, timeout=120)
        if r.status_code not in (200, 201):
            stop.set()
            sse_task.cancel()
            return fail("recording-stop", r)
        deadline = t_stop + NOTE_TIMEOUT_S
        note = None
        while time.perf_counter() < deadline:
            r = await http.get(f"{API}/api/v1/consultations/{cid}/summary/latest", headers=hdr, timeout=30)
            if r.status_code == 200 and r.content and r.text not in ("null", "{}"):
                note = r.json()
                break
            # A governed run that ends without a clinical result closes the consultation
            # CLOSED_INCOMPLETE and never writes a summary — stop waiting on it.
            r = await http.get(f"{API}/api/v1/consultations/{cid}", headers=hdr, timeout=30)
            if r.status_code == 200 and str(r.json().get("status", "")).startswith("CLOSED"):
                res["final_status"] = r.json()["status"]
                break
            await asyncio.sleep(5)
        stop.set()
        sse_task.cancel()
        res["end_ms"] = round((time.perf_counter() - t_stop) * 1000)
        if note is None:
            return fail("note", err=f"no summary ({res.get('final_status') or f'timeout {NOTE_TIMEOUT_S:.0f}s'})")
        res["note_ms"] = round((time.perf_counter() - t_stop) * 1000)
        res["note_status"] = (note or {}).get("status")
        res.update(ok=res["finals"] > 0, stage="done")
        return res
    except Exception as exc:
        return fail("exception", err=repr(exc)[:160])


async def main() -> None:
    L.OUT.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    out = L.OUT / f"consult-ladder-{stamp}.json"
    audio = h.load_replay_audio()
    sampler = L.Sampler() if L.SAMPLE_LOCAL else None
    steps: list[dict[str, Any]] = []
    async with httpx.AsyncClient(limits=httpx.Limits(max_connections=400)) as http:
        token = await h._login(http, API)
        if not token:
            raise SystemExit("login failed")
        print(f"audio {audio.duration_s:.1f}s  levels {L.LEVELS}", flush=True)
        if sampler:
            sampler.start()
        for n in L.LEVELS:
            if sampler:
                sampler.step = n
            t0 = time.time()
            results = await asyncio.gather(*(_one(http, token, audio, i) for i in range(n)))
            ok = [r for r in results if r["ok"]]
            step: dict[str, Any] = {
                "concurrency": n,
                "t_start": t0,
                "t_end": time.time(),
                "wall_s": round(time.time() - t0, 1),
                "ok": len(ok),
                "failed": n - len(ok),
                "failures": sorted({f"{r.get('stage')}:{r.get('status')}:{str(r.get('error'))[:80]}" for r in results if not r["ok"]}),
                "first_partial_ms_p50": None,
                "commit_p99_ms_worst": None,
                "setup_ms_p50": L._pct([r.get("setup_ms") for r in ok], 0.5),
                "note_ms_p50": L._pct([r.get("note_ms") for r in ok], 0.5),
                "note_ms_max": max((r.get("note_ms") or 0 for r in ok), default=None),
                "sse_events_p50": L._pct([r.get("sse_events") for r in ok], 0.5),
                "end_ms_p50": L._pct([r.get("end_ms") for r in results], 0.5),
                "end_ms_max": max((r.get("end_ms") or 0 for r in results), default=None),
                "final_status": dict(__import__("collections").Counter(
                    r.get("final_status") or ("NOTE" if r["ok"] else r.get("stage")) for r in results)),
                "results": results,
            }
            if sampler:
                win = [s for s in sampler.samples if s.get("step") == n and "procs" in s]
                step["peak_rss_mb"] = {svc: max(s["procs"][svc]["rss_mb"] for s in win) for svc in win[-1]["procs"]} if win else {}
                step["dead"] = sorted({svc for s in win for svc, p in s["procs"].items() if not p["alive"]})
                step["system_worst"] = {
                    "swap_used_mb": max((s["system"]["swap_used_mb"] for s in win), default=None),
                    "pressure_level": max((s["system"]["pressure_level"] for s in win), default=None),
                    "free_pct_min": min((s["system"]["free_pct"] for s in win if s["system"]["free_pct"] is not None), default=None),
                }
            steps.append(step)
            print(json.dumps({k: v for k, v in step.items() if k != "results"}, default=str), flush=True)
            out.write_text(json.dumps({"api": API, "steps": steps, "samples": sampler.samples if sampler else []}, default=str, indent=1))
            if n != L.LEVELS[-1]:
                for _ in range(90):
                    if not await L._active_streams(http):
                        break
                    await asyncio.sleep(2)
                await asyncio.sleep(L.COOLDOWN_S)
    if sampler:
        sampler.stop()
    out.write_text(json.dumps({"api": API, "steps": steps, "samples": sampler.samples if sampler else []}, default=str, indent=1))
    print(f"wrote {out}")


if __name__ == "__main__":
    asyncio.run(main())
