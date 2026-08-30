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


---

# After Lane A (pooled egress clients) — 2026-08-30

Same command, same levels, same host, immediately after merging Lane A at
`061ad8d84`.

| Concurrency | AC-3 p50 / p95 / p99 — **baseline** | AC-3 p50 / p95 / p99 — **after Lane A** |
|---|---|---|
| 10 | 18.40 / 24.40 / 71.74 ms | 21.00 / 29.02 / 80.48 ms |
| 25 | 46.26 / 113.37 / 126.39 ms | 50.00 / 106.34 / 113.59 ms |

## The client cache did not move AC-3, and that is not a Lane A failure

**It is a harness limitation, and it was worth discovering now rather than after
three more lanes.** The cache's win is avoiding TLS handshakes, DNS and connection
setup on every request. The benchmark's mock upstream is **plain HTTP on
localhost** — no TLS, no DNS, negligible loopback TCP setup. There is essentially
nothing for connection reuse to save, so the harness **structurally cannot
observe the thing Lane A fixed**.

Do not read this table as "the client cache was pointless." Read it as "this
harness cannot price it." Against a real Azure or Bedrock endpoint over TLS, a
per-request client is a per-request handshake, and that is the case the cache
removes.

## What the ~20–50 ms actually is

Since it is not connection setup, it is what §3C.1 already identified: the
**Python tax** — JSON encode/decode and pydantic validation on both sides — plus
the **202-and-poll indirection** and its Redis round trips. That is Lane B's
scope, not Lane A's. **AC-3 movement should be expected from Lane B, and if Lane B
lands without moving it, the diagnosis in §3C.1 is wrong and should be reopened.**

## Harness gap — CLOSED (Lane H2, 2026-08-30)

Lane H's mock has gained a **TLS mode** (`--tls`, self-signed cert generated
fresh into a temp dir at start-up; loopback, not a non-loopback address — see
`bench/README.md`'s "TLS mode" section for why that's a real but not total
narrowing of the gap) and a **`--connections-per-request` diagnostic** that
counts new connections independent of latency. Full write-up:
`apps/text/tests/bench/README.md` §"TLS mode measurement (Lane H2, TASK-818)".

**The result is not the one this note originally hoped for.** With a real TLS
handshake now in the loop, connection reuse is directly measurable — and at
every concurrency tested (1, 10, 25), the real request path shows
**`1.000 conn/req`**: every single generation opens a new connection, exactly
as if the client cache were not in the path at all. Calling
`CLIENT_CACHE.get_or_create()` / `pooled_http_client()` by hand, with the
same key the bench sends, correctly returns the SAME objects every time — so
the cache and pool primitives are not broken in isolation (their own unit
tests already established this). Something between an incoming generation
request and that cached client is not resulting in end-to-end reuse. This is
a genuine, actionable finding, not a harness artifact: an isolated
`httpx2.AsyncClient` reused directly against the same TLS mock shows `0` new
connections across 6 sequential requests, proving the mock and the counter
are sound.

**Consequently: Lane A's value is still asserted only by its unit tests, not
by this benchmark** — but the reason has changed. It is no longer "the
harness cannot see TLS overhead" (fixed); it is "the harness now sees TLS
overhead on every call, which means whatever benefit the cache provides is
not reaching the request path in a way this end-to-end measurement can
observe." Root-causing which layer of `apps/text/src/**` fails to reuse the
cached client is out of Lane H2's `tests/bench/**` ownership and is flagged
as follow-up work, not fixed here.

No A/B (with-cache vs. without) comparison was possible: `providers/clients.py`
has no env-var kill switch for the cache (a bare module-level singleton), and
adding one would mean editing `apps/text/src/**`, which this lane does not
own. Given the `1.000 conn/req` result, a with/without comparison may not
have been very informative anyway — a cache that isn't observably reused
cannot be distinguished from no cache by this measurement.

## Also unmeasured

**HTTP/2 (A-3) was inert for both runs above.** `h2` was not installed, so
`httpx.AsyncClient(http2=True)` raised `ImportError` and the pool degraded to
HTTP/1.1. Fixed in `7311a82bc`; any future comparison against these two runs is
therefore not like-for-like on that axis.


---

# Root cause of `1.000 conn/req` — FOUND AND CLOSED (2026-08-30)

The follow-up flagged in "Harness gap — CLOSED" above is resolved. **Neither the
client cache nor the pooled transport was at fault** — both hit on every single
request, end to end, in the real request path. The connection was being destroyed
one layer below them, by the OpenAI SDK.

## What the instrumentation showed

`ClientCache.get_or_create`, `pooled_http_client`, `apply_pool_policy` and
`openai_compat._client_at` were instrumented and the harness re-run
(`--tls --connections-per-request`, `--levels 1`, 208 requests):

```
_client_at.result sdk_id=4727751440 http_id=4727761360 http_closed=False   # identical, all 208
clientcache.HIT × 207   ·   clientcache.MISS × 1   ·   pool.MISS × 1
pool.apply_pool_policy ok=False n_profiles=0                               # early-returns, every request
```

One `AsyncOpenAI`, one `httpx2.AsyncClient`, one adapter instance, for every
request — and still a fresh handshake per generation. This also **proves** the
`refresh_runtime_limits` reasoning that was previously only read, not measured:
the snapshot is negative-cached (`ok=False`), `apply_pool_policy` returns
immediately, and nothing is ever evicted.

## The actual cause: the SDK closes a streamed response before its body is at EOF

`openai/_streaming.py::AsyncStream.__stream__`:

```python
async for sse in iterator:
    if sse.data.startswith("[DONE]"):
        break            # <- leaves the body suspended, not at EOF
finally:
    await response.aclose()
```

No *application* bytes remain after `data: [DONE]` — measured, exactly `0` — but
the HTTP **end-of-body marker** (the chunked terminator) has not been read. httpcore
sees a partially-consumed response and tears the connection down instead of parking
it in the keepalive pool. The non-streaming path never had the problem, because it
reads its body to completion.

Isolated against the same TLS mock, five requests each:

| case | new connections |
|---|---|
| raw `httpx2`, default limits, streamed, drained to EOF | **1** |
| raw `httpx2`, **exact pool-floor limits** + `Timeout(300)`, drained | **1** — rules out the pool policy |
| raw `httpx2`, `break` on `[DONE]` then close | **5** — reproduces it with no SDK in the path |
| raw `httpx2`, `break` on `[DONE]` **then drain**, then close | **1** — the fix |
| `AsyncOpenAI` over the pooled client, `stream=True`, fully drained | **5** |
| `AsyncOpenAI` over the pooled client, **non-streaming** | **1** |

This is **not a mock artifact**: every OpenAI-wire engine (LM Studio, vLLM, OpenAI,
Azure) terminates its SSE the same way, and the behaviour is unchanged on
`openai-python` `main` (verified 2026-08-30). Raised upstream — see
`upstream-openai-python-stream-reuse.md`.

## The fix

`providers/pool.py` — a transport wrapper that reads a response to EOF, **bounded**
(64 KB / 250 ms), before closing it. It lives at the transport, not in
`openai_compat`, because the seam that leaks is `Response.aclose()`: by the time the
adapter's `async for` returns, the SDK's `finally` has already closed the socket.
Every adapter on a pooled client is covered for the same reason. A genuinely
aborted stream (consumer disconnected mid-generation) hits the bound and closes
exactly as before — the drain never becomes "read the rest of a generation nobody
is listening to".

Locked by `src/text/tests/unit/test_task818_stream_close_reuse.py`, which drives a
loopback HTTP/1.1 server counting **accepted connections** through the real
`pooled_http_client` + `AsyncOpenAI`. Confirmed RED first:
`expected one connection for five streamed generations, saw 5`.

## Measurements — both modes, as §4.8 requires

Same host, same session, interleaved before/after, three repetitions of the
zero-latency pair.

**Zero-latency mock** (isolates proxy overhead):

| c | conn/req before → after | AC-3 p50 before | AC-3 p50 after |
|---|---|---|---|
| 1 | 1.000 → **0.000** | 1.49 / 2.01 / 1.76 ms *(3 runs)* | 3.64 / 3.40 / 3.26 ms *(3 runs)* |
| 10 | 1.000 → **0.036** | 17.16 ms *(1 run)* | 29.15 ms *(1 run)* |
| 25 | 1.000 → **0.066–0.087** | 40.89 / 41.11 / 41.87 ms *(3 runs)* | 82.11 / 62.90 / 63.19 ms *(3 runs)* |

**Latency-injecting mock** (800 ms TTFT, ~30 tok/s — the mode §4.8 calls the
realistic one, and the one that exposes connection-hold behaviour):

| c | conn/req before → after | AC-3 p50/p95/p99 before | AC-3 p50/p95/p99 after |
|---|---|---|---|
| 10 | 1.020 → **0.200** | 4.96 / 11.67 / 14.16 ms | **3.97 / 8.86 / 9.42 ms** |
| 25 | 1.008 → **0.128** | 3.85 / 87.16 / 93.40 ms | **3.76 / 76.59 / 86.09 ms** |

**Read both numbers, and do not quote the zero-latency AC-3 row as a regression
caused by the wrapper.** A third configuration settles that: with the wrapper
INSTALLED but the drain disabled — so every per-chunk cost of the wrapper is
present and no reuse happens — AC-3 returns to **1.46 ms @ c=1 / 40.04 ms @ c=25**,
i.e. the "before" numbers exactly. **The wrapper itself costs nothing measurable.**
The zero-latency delta is the cost of *reuse* under that specific load shape.

Most likely explanation, consistent with both modes but **not independently
proven**: with 0 ms TTFT and 0 ms inter-token the harness issues back-to-back
requests with no think-time, so releasing the previous response (drain included)
lands on the *next* request's critical path on that same connection — whereas a
brand-new connection per request pushed the old one's teardown off the critical
path entirely. Give the client any real inter-request gap and the release finishes
during idle time, which is what the latency-injecting rows show.

## What this means for the harness caveat above

The harness gap has moved, not closed. It went from *"cannot see a TLS handshake"*
to *"sees the handshake, but a handshake to `127.0.0.1` is nearly free"*. A remote
provider's handshake is 2 RTTs plus certificate verification — orders of magnitude
above anything measurable here. **This harness still cannot price connection reuse;
it can now only prove that reuse HAPPENS.** That is what it is being used for, and
the claim should not be stretched further.

Standing consequence for A-3 (HTTP/2): HTTP/1.1 gives one in-flight request per
connection, so the release path is on the critical path whenever a client has no
think-time. HTTP/2 multiplexing removes that coupling on self-hosted engines. This
is an argument for measuring A-3, not for assuming it.
