"""Repeatable local load test for the guardrail policy plane (TASK-777 Lane B).

    PYTHONPATH=apps/guardrail/src python apps/guardrail/scripts/loadtest.py \
        --concurrency 100 --requests 2000

**What is real and what is stubbed — stated plainly.** Everything guardrail owns
runs for real: the ASGI app, routing, the mandatory-tenant precondition, the
admission gate, the screener, sanitization, containment, the per-check decision
record and the metrics. The two PEERS (`apps/text`, `apps/nlp`) are stubbed at the
analyzer seam with a configurable latency, because the number under test is
guardrail's own overhead and queueing behaviour — not how fast someone else's GPU
is. `--peer-latency-ms` is the knob for modelling a slower peer.

Reported: p50 / p95 / p99 / max end-to-end latency, throughput, and the split of
outcomes (allow / block / 503 backpressure). A 503 is a SUCCESSFUL outcome of the
design — declared backpressure — and is counted separately rather than as an error.
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import time
from types import SimpleNamespace


class _StubAnalyzer:
    """Stands in for the `apps/nlp`-backed analyzer, with settable latency."""

    def __init__(self, latency_s: float) -> None:
        self._latency_s = latency_s
        self.policy = SimpleNamespace(pii_labels=[], benign_labels=None)

    async def classify_tasks(self, task_names, text):
        if self._latency_s:
            await asyncio.sleep(self._latency_s)
        return dict.fromkeys(task_names, "benign")

    async def extract_pii_entities(self, text):
        return []

    def model_for(self, check: str) -> str:
        return "loadtest-stub"


NOTE = (
    "Patient presents with intermittent chest pain radiating to the left arm, "
    "onset three days ago. No prior cardiac history. BP 148/92, HR 96. "
    "Plan: ECG, troponin, cardiology referral."
)


async def _run(concurrency: int, total: int, peer_latency_ms: float) -> int:
    import logging

    from fastapi import HTTPException

    from guardrail.core.logging import setup_logging

    # Per-decision INFO logging is correct in production (every verdict is
    # attributable) and is pure noise at 2,000 requests — and its own bottleneck.
    setup_logging("warning")
    logging.disable(logging.INFO)

    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.api.endpoints.screen import InboundScreenRequest, screen_inbound
    from guardrail.core.config import Settings
    from guardrail.main import build_admission_gates
    from guardrail.services.screening import Screener

    settings = Settings()
    analyzer = _StubAnalyzer(peer_latency_ms / 1000.0)

    async def _build(app_state, tenant_id):
        return Screener(
            analyzer=analyzer,
            tenant_id=tenant_id,
            policy_source_tenant_id="00000000-0000-0000-0000-000000000000",
        )

    screen_mod.build_screener = _build  # the peer seam, and only the peer seam

    state = SimpleNamespace(admission_gates=build_admission_gates(settings))
    request = SimpleNamespace(
        app=SimpleNamespace(state=state),
        headers={"X-Tenant-Id": "11111111-1111-1111-1111-111111111111"},
    )

    latencies: list[float] = []
    outcomes = {"allow": 0, "block": 0, "backpressure_503": 0, "error": 0}
    sem = asyncio.Semaphore(concurrency)

    async def one() -> None:
        async with sem:
            started = time.perf_counter()
            try:
                result = await screen_inbound(
                    InboundScreenRequest(text=NOTE, kind="transcript"), request
                )
                outcomes[result.decision] += 1
            except HTTPException as exc:
                outcomes["backpressure_503" if exc.status_code == 503 else "error"] += 1
            except Exception:  # noqa: BLE001
                outcomes["error"] += 1
            latencies.append((time.perf_counter() - started) * 1000.0)

    wall_start = time.perf_counter()
    await asyncio.gather(*(one() for _ in range(total)))
    wall = time.perf_counter() - wall_start

    latencies.sort()

    def pct(p: float) -> float:
        return latencies[min(len(latencies) - 1, int(len(latencies) * p))]

    print(f"concurrency        : {concurrency}")
    print(f"requests           : {total}")
    print(f"peer latency (stub): {peer_latency_ms:.1f} ms")
    print(f"wall time          : {wall:.3f} s")
    print(f"throughput         : {total / wall:,.1f} req/s")
    print(f"p50 / p95 / p99    : {pct(0.50):.2f} / {pct(0.95):.2f} / {pct(0.99):.2f} ms")
    print(f"mean / max         : {statistics.fmean(latencies):.2f} / {latencies[-1]:.2f} ms")
    print(f"outcomes           : {outcomes}")

    return 1 if outcomes["error"] else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--concurrency", type=int, default=100)
    parser.add_argument("--requests", type=int, default=2000)
    parser.add_argument(
        "--peer-latency-ms",
        type=float,
        default=20.0,
        help="Simulated apps/nlp round-trip. 0 measures guardrail's own overhead.",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args.concurrency, args.requests, args.peer_latency_ms))


if __name__ == "__main__":
    raise SystemExit(main())
