# TASK-818 — the "before" baseline

**Captured 2026-08-30**, on `dev-2.2` at merge commit `7ecfcc45c`, BEFORE Lane A
(egress client cache) and Lane B (resumable streaming) landed. Reproduced
independently by the orchestrator, not taken from the lane's report.

```bash
cd apps/text && uv run --extra test python tests/bench/harness.py \
  --mode zero-latency --levels 10,25 --duration 4 --warmup 5
```

## Zero-latency mock — isolates proxy overhead

| Concurrency | requests | errors | **AC-3 proxy delta** p50 / p95 / p99 | AC-4 inter-token p50 | AC-2 RSS/stream |
|---|---|---|---|---|---|
| 10 | 262 | 0 | **18.40 / 24.40 / 71.74 ms** | 1.47 ms | 1124.80 KB |
| 25 | 250 | 0 | **46.26 / 113.37 / 126.39 ms** | 3.98 ms | 316.16 KB |

Provider TTFT in this mode is p50 0.07–0.08 ms — effectively zero, so every
millisecond above it is ours. A longer sweep by Lane H on the same code reached
**p50 417.66 ms at concurrency 100**: a clear plateau-then-degrade curve.

## What this says

| AC | Target | Now | Gap |
|---|---|---|---|
| **AC-3** proxy-added TTFT p99 | **< 10 ms** | 71.74 ms @ c=10 · 126.39 ms @ c=25 | **7–12× over, and widening with concurrency** |
| **AC-2** RSS per stream | **< 50 KB** | 316 KB @ c=25 | ~6× over (provisional — caveat 2) |
| AC-1 concurrent streams | ≥ 100 | sweeps to 100 without error | shape only; the 10-minute soak has NOT been run |

**The degradation curve is the finding, not the point value.** Overhead roughly
doubles from concurrency 10 to 25 while the mock's own latency stays flat — the
signature of per-request SDK client construction (`providers/*.py` building a
fresh client and TLS pool per call, bottleneck B-2) compounded by the
202-and-poll indirection. Those are exactly what Lane A and Lane B target, which
is what makes their claims falsifiable rather than assertions.

## Caveats — read before quoting these numbers

1. **Not a production measurement.** One host, mock upstream, `fakeredis` for
   Redis. It measures the proxy, which is the point, but it is not end-to-end.
2. **AC-2 at the first swept level is a high-water-mark artifact** (1124 KB at
   c=10 vs 316 KB at c=25 — RSS has not plateaued). Treat per-stream RSS as
   indicative until a longer soak settles it.
3. **Short duration** — 4 s per level, not AC-1's 10-minute bar. Enough for the
   curve's shape and a comparison point; not enough for a soak claim.
4. **Against a real provider this is a small fraction of end-to-end latency.**
   The same harness in latency-injecting mode (800 ms TTFT, ~30 tok/s) shows the
   AC-3 delta falling to ~4.5 ms p50 at concurrency 10, because provider latency
   dominates. **Report both, always** — the zero-latency figure alone overstates
   the problem; the injected figure alone hides it.

## Not yet measurable

**AC-6, AC-15, AC-16, AC-17, AC-18** — resume-after-disconnect, gateway restart,
router restart, and "a dropped socket never cancels a generation" — all need Lane
B's producer/subscriber split and `GET /generations/{gid}/stream`, which do not
exist yet. Flagged, not skipped.
