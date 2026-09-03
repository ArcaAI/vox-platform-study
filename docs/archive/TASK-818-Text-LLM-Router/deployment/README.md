# TASK-818 Lane G — runtime and deploy shape

**Measured 2026-08-30** on `dev-2.2` at `75cb04a2d`, in a worktree, against a REAL
shared Redis (`redis://localhost:6379/9`, the `hope-redis` dev container) and the
Lane H bench mock upstream. No production code was modified; the probes drive
`uvicorn text.main:app` unchanged.

---

## ⛔ STOP — multi-worker breaks resumability. G-1 is BLOCKED, not deferred.

Lane C's conclusion was that the service is CPU-bound on one core and *"the
remaining lever is more event loops — uvicorn `--workers`, which is G-1 and Lane
G's."* **That lever exists and it works. It is also unusable today**, because
turning it on silently truncates clinical generations.

### The mechanism

`GenerationHub` (`apps/text/src/text/routing/hub.py`) is **process-local** — its
own docstring says so: *"Deliberately not a distributed structure."* With
`--workers N` there are N independent hubs in N processes, and a resume request
is load-balanced to an arbitrary one by the kernel.

§3C.3(5) anticipated exactly this and specified the fallback: read the backlog
with `XRANGE`, *"then tail live from the in-process producer (**or `XREAD BLOCK`
if the producer is on another pod**)"*.

**The `XREAD BLOCK` half was never implemented.** `stream_generation` in
`apps/text/src/text/api/endpoints/stream.py`:

```python
if producer is None:
    # Nothing live here — a finished generation, or one whose producer is on
    # another pod. Either way the durable buffer is the whole story.
    backlog, _ = dedupe_by_seq(await task_manager.read_events(generation_id), after_seq)
    for event in backlog:
        yield _frame(generation_id, event)
        if event.is_terminal:
            return
    return          # <-- closes the stream. No live tail. Ever.
```

The comment *"the durable buffer is the whole story"* is true only for a
**finished** generation. For one still running on another process it is false,
and nothing distinguishes the two cases.

`TaskManager` does have `XREAD BLOCK` helpers (`read_chunks_blocking`,
`read_chunk_entries_blocking`), but they decode the **old per-chunk format**
(`_decode_chunk_data`), not the batched `GenerationEvent` format the hub writes.
So the primitive exists and is not wired, rather than being absent.

### The measurement

`uvicorn text.main:app --workers 4`, real shared Redis, 8 sequential trials. Each
trial: start a 60-token generation (~6 s), abandon the POST response, wait 0.6 s,
then `GET /generations/{gid}/stream`.

| trial | HTTP | events delivered | terminal frame | stream duration |
|---|---|---|---|---|
| 0 | 200 | meta + 60 chunk + usage + done | `done` | 5.76 s |
| 1 | 200 | meta + 60 chunk + usage + done | `done` | 5.58 s |
| **2** | **200** | **meta + 3 chunk** | **none** | **0.001 s** |
| 3 | 200 | meta + 60 chunk + usage + done | `done` | 5.61 s |
| **4** | **200** | **meta + 4 chunk** | **none** | **0.001 s** |
| **5** | **200** | **meta + 4 chunk** | **none** | **0.003 s** |
| **6** | **200** | **meta + 4 chunk** | **none** | **0.002 s** |
| 7 | 200 | meta + 60 chunk + usage + done | `done` | 5.60 s |

**4 of 8 resumes landed on a non-owner worker.** Each returned **HTTP 200** with
**3–4 of 60 chunks**, **no terminal frame**, and closed in **~2 ms**. The
generation itself continued to completion on the owning worker — the data was
never lost from Redis, it was simply never delivered on that connection, and the
client's SSE reader sees a clean end-of-stream rather than an error.

Single-worker control on the identical setup: 3/3 trials delivered all 60 chunks
+ `usage` + `done` in ~5.6 s. **The truncation is caused by the second process,
not by the probe.**

### Why this is bigger than `--workers`

**The defect is in running a second PROCESS, not in `--workers` specifically.**
The same `producer is None` branch is what a second *pod* hits. So:

- `replicas > 1` has this defect today, with or without `--workers`.
- **Every rolling restart has it**, at 1 replica. Measured separately (below):
  SIGTERM drops the client's SSE connection immediately with no terminal frame,
  so the client MUST reconnect — and during a rolling restart the terminating pod
  is out of Service endpoints, so it reconnects to a new pod that never held the
  producer. **AC-17 ("router pod restart") cannot be satisfied until this is
  fixed**, and §3C.8's claim that a router restart recovers "all flushed tokens"
  is not what the code delivers: it delivers the flushed prefix and then hangs up.

Consequently the `hope-text` HPA staged in `text-lane-g.patch.yaml` is pinned
`min == max == 1` for **two** reasons, not one: CPU is the wrong signal *and* a
second replica is a silent data-loss path.

### What is NOT broken — cross-worker cancel

`POST /generations/{gid}/cancel` was the other thing the brief asked me to prove
rather than assume, and **it works correctly across workers.** It rides a
persisted Redis flag (`text:gen:cancel:{gid}`) polled by the producer every
`_CONTROL_POLL_INTERVAL_S = 0.5 s` (`routing/streaming.py`), so it does not depend
on reaching the owning process.

Verified twice under `--workers 4`. A status flip is not proof a producer
stopped, so the second probe measured the durable buffer's length after the
cancel and again 5 s later:

| trial | cancel HTTP | deltas at cancel | +1 s | +5 s | grew after settle? |
|---|---|---|---|---|---|
| 0 | 200 | 11 | 13 | 13 | no |
| 1 | 200 | 11 | 14 | 14 | no |
| 2 | 200 | 13 | 15 | 15 | no |
| 3 | 200 | 13 | 15 | 15 | no |
| 4 | 200 | 13 | 15 | 15 | no |
| 5 | 200 | 13 | 15 | 15 | no |

`stopped_cleanly = 6/6`, each frozen at 13–15 of 120 tokens. With 4 workers the
chance all 6 cancels happened to hit the owning worker is `(1/4)^6 ≈ 0.02%`.
**No silent no-op.**

---

## Worker sweep — both modes, with the host load

Host: 16 cores. **Load average 2.26–3.12 throughout** — much quieter than the 9.5
Lane C warned about, but percentiles from this box are still not a reliable
instrument. **CPU per request and `cores_busy` are the load-insensitive numbers
and are the ones to trust.**

The sweep drives the real Lane H harness (`tests/bench/harness.py`) unmodified,
with `start_text` monkeypatched to launch `uvicorn text_service_process:app
--workers N` and `sample_rss` widened to the whole process tree. `--workers`
requires an import string, which is why the harness's own `uvicorn.run(app)` call
cannot do it.

### Zero-latency mode (isolates proxy overhead) — `--duration 4 --warmup 5`

| workers | c | requests | AC-3 p50 | AC-3 p99 | **CPU ms/req** | **cores busy** |
|---|---|---|---|---|---|---|
| 1 | 10 | 821 | 17.26 | 48.85 | 4.70 | **0.95** |
| 1 | 25 | 793 | 27.68 | 78.76 | 4.96 | **0.94** |
| 2 | 10 | 1340 | 6.68 | 47.37 | 5.14 | 1.66 |
| 2 | 25 | 1430 | 15.14 | 63.79 | 5.15 | 1.75 |
| 4 | 10 | **1829** | **3.88** | 43.47 | 5.54 | **2.41** |
| 4 | 25 | 1440 | 7.89 | 39.25 | 5.67 | 1.92 |
| 8 | 10 | 1863 | 5.84 | 41.35 | 5.46 | 2.40 |
| 8 | 25 | **1275** | 8.54 | 40.32 | **6.05** | 1.78 |

Four things this establishes:

1. **Lane C's single-core bound is independently confirmed** — `cores_busy` 0.95
   and 0.94 at 1 worker. That was the premise of this lane and it holds.
2. **Workers lift the ceiling.** Throughput +123% at c=10 (821 → 1829), AC-3 p50
   17.26 → 3.88 ms.
3. **8 workers is WORSE than 4** — throughput falls at c=25 (1440 → 1275) and CPU
   per request rises (5.67 → 6.05 ms). Past 4 the returns are negative. Note the
   harness client is co-resident on the same 16 cores and is itself a load source.
4. **Workers do not make the service more efficient, they make more of the
   machine usable.** CPU per request *rises* 4.70 → 5.67 ms (+21%) going 1 → 4.
   That is the cost of more interpreters and more scheduling; it buys ~2.2×
   throughput, which is a good trade, but it is not free.

**AC-3's p99 < 10 ms is still NOT met in zero-latency mode** — best observed is
39.25 ms at 4 workers / c=25, ~4× over. Workers moved p50 a lot and p99 a little.

### Latency-injecting mode (800 ms TTFT, ~30 tok/s — the realistic one)

Short runs first (`--duration 8`, matching Lane C's command). **These samples are
too small to read a trend from** — 40–100 completed requests means p99 is one or
two observations:

| workers | c | requests | AC-3 p50 | AC-3 p99 | CPU ms/req | cores busy |
|---|---|---|---|---|---|---|
| 1 | 10 | 40 | 1.70 | 17.83 | 19.0 | 0.09 |
| 1 | 25 | 100 | 1.96 | 33.87 | 15.2 | 0.17 |
| 2 | 10 | 40 | 1.66 | 12.31 | 31.0 | 0.14 |
| 2 | 25 | 100 | 2.04 | 43.87 | 18.3 | 0.21 |
| 4 | 10 | 40 | 3.45 | 29.73 | 36.5 | 0.16 |
| 4 | 25 | 100 | 0.60 | 30.85 | 16.8 | 0.19 |

⚠️ Lane C recorded AC-3 p99 of 8.33 / 7.21 ms in this mode and declared AC-3 MET.
My 1-worker run on the same command reproduced **17.83 / 33.87 ms**. That is not a
regression — it is the run-to-run spread of a p99 computed from 40 samples. **AC-3
"met in latency-injecting mode" should not be quoted off an 8-second run.**

So I ran it properly, at AC-1's actual bar (`--duration 30`, c=50 and c=100):

| workers | c | requests | AC-3 p50 | AC-3 p95 | AC-3 p99 | CPU ms/req | **cores busy** |
|---|---|---|---|---|---|---|---|
| 1 | 50 | 700 | 1.23 | 20.77 | 33.07 | 12.17 | 0.27 |
| 1 | 100 | **1400** | 1.81 | 26.84 | 39.68 | **11.52** | **0.51** |
| 4 | 50 | 700 | 1.28 | 31.53 | 47.85 | 16.70 | 0.38 |
| 4 | 100 | **1400** | 1.20 | 36.14 | 47.18 | **13.06** | 0.59 |

**This is the result that decides the lane.**

- **Throughput is IDENTICAL (1400 both).** In this mode the rate is pinned by the
  mock's injected latency, not by the service: 100 concurrent × 30 s ÷ 2.17 s ≈
  1382. The run is provider-paced by construction.
- **At AC-1's full bar of 100 concurrent streams, ONE worker sits at 0.51 cores.**
  There is no CPU headroom problem in the realistic mode. The bottleneck workers
  fix is not active.
- Four workers therefore bought **nothing** — same throughput, ~13% more CPU per
  request, 2–3× the memory footprint, and p99 no better.

**Honest summary: multi-worker is a real win against a fast local engine
(zero-latency shape: vLLM/LM Studio on-box, sub-10 ms TTFT, high token rate) and
is worth nothing against a cloud provider at 800 ms TTFT.** The zero-latency
figure alone overstates the case for workers; the injected figure alone hides it.
Both are above.

### AC-2 caveat introduced by multi-worker

`rss_per_stream_kb` reported 7803 KB at 8 workers vs 1905 KB at 1 (c=10). This is
mostly an artifact — a fixed per-process interpreter cost divided by concurrency,
and RSS has not plateaued at these durations (baseline caveat 2). But the
underlying fact is real and matters for sizing: **N workers multiply the fixed
memory footprint N×.** A memory request tuned for one process will not hold.

---

## G-2 — graceful shutdown: the k8s knob alone cannot deliver it

Measured with SIGTERM sent mid-stream at chunk 5, single worker, real Redis.

| generation length | client outcome | process exited after SIGTERM |
|---|---|---|
| 12 s | connection CUT at 6/60 chunks, `RemoteProtocolError`, no terminal frame | 11.20 s |
| 12 s, `--timeout-graceful-shutdown=2` | identical | 11.20 s |
| 60 s | cut at 5/60 | 55.13 s (generation completed) |
| 90 s | cut at 5/90 | **60.16 s (generation ABANDONED)** |

Three findings:

1. **uvicorn drops the SSE response immediately on SIGTERM.** It does not hold the
   connection open for an in-flight stream. The client always has to reconnect —
   which, per the STOP above, is exactly the path that is broken across processes.
2. **`--timeout-graceful-shutdown` is inert here.** Unset and `=2` gave byte-identical
   11.20 s. The delay is not uvicorn waiting on connections; it is the lifespan
   drain. **I therefore did NOT add the flag to the Dockerfile** — it would have
   been a plausible-looking change that the measurement says does nothing.
3. **The real bound is ~60 s, in `main.py`, not in k8s.** `generation_hub.drain(
   timeout=30.0)` then `shutdown_manager.wait_for_shutdown(timeout=30.0)`, run
   sequentially, and **neither cancels the producer** — `asyncio.wait(...,
   timeout=)` just stops waiting. The 60 s / 90 s pair brackets it exactly.

**So `terminationGracePeriodSeconds` > max stream duration is necessary but NOT
sufficient.** Even at a 30-minute grace period the app gives up at ~60 s while
`GenerationPolicy.max_generation_seconds` floors at **1800 s**. The two halves of
G-2's contract disagree by 30×, and nothing enforces their relationship.

`main.py` is orchestrator-only, so the fix is in REGISTRATIONS below rather than
applied here.

---

## G-5 — the SSE ingress config DOES NOT APPLY to this cluster

The brief asked me to check rather than ship annotations nothing reads. **It does
not apply, and I have written none.**

- Traffic reaches pods via **Cloudflare Tunnel → k3s NodePort on `10.10.1.10`**.
  Traefik is bypassed entirely; the cluster's only `Ingress` is `grafana` on host
  `grafana.local`, which no tunnel route targets — it is dead
  (`docs/implementation/TASK-828-Edge-Security-Findings/README.md:12-17`).
- There is **no nginx ingress controller at all**. `proxy_buffering off`,
  `proxy_http_version 1.1` and `nginx.ingress.kubernetes.io/*` annotations would
  be inert twice over: no controller to read them, and no live Ingress to carry
  them.
- The `X-Accel-Buffering: no` header the app already sets
  (`stream.py:_SSE_HEADERS`) is harmless and should stay — it costs nothing and
  is correct if an nginx ever appears — but its comment's *"the ingress half of
  this is Lane G's"* refers to a controller that does not exist here.

**What actually governs the edge for SSE is the Cloudflare Tunnel config, and it
is ungoverned**: `config_src: "cloudflare"`, so all 38 hostname→origin routes live
only in the Cloudflare dashboard — outside both Git repos, outside CI, outside
Argo (TASK-828 §178-179). Lane G cannot patch it and should not pretend to.

The one edge fact that IS load-bearing is already handled in code: sse-starlette
`ping=15` (`stream.py:_PING_SECONDS`) stays under Cloudflare's ~100 s idle
timeout. **Do not raise it.** Confirming the tunnel's actual configured idle
timeout is an out-of-band task against the Cloudflare dashboard — it is not
readable from either repo, so this lane records it as unverified rather than
claiming the 100 s figure applies.

---

## Runtime recommendation — uvicorn, and do NOT trial Granian

**Stay on uvicorn. Single worker, today. `--workers 2` once resume is fixed —
not 4, not 8.**

- 4 workers was the zero-latency optimum, but 2 captures most of it (throughput
  +63% at c=10) at meaningfully lower memory and CPU-per-request cost, and the
  realistic mode says the extra workers are idle anyway. Size to the pod's CPU
  limit and stop at 2 until a measurement on real traffic says otherwise.
- **Granian: NOT worth trialling, on these numbers.** The cited ~35% advantage is
  a claim about request-path throughput on low-logic services — i.e. about the
  zero-latency regime. My measurement says that regime is not where this service
  spends its life: at AC-1's bar in realistic mode it uses **0.51 of one core**.
  Swapping the HTTP runtime to optimise a dimension with 16× headroom is risk
  without return, and Granian would inherit the **same** multi-process
  resumability defect, because that defect is in `GenerationHub`'s process
  locality, not in uvicorn. Revisit only if the platform commits to a fast
  on-box engine AND the cross-process tail is implemented.
- `uvicorn[standard]` already supplies uvloop and httptools, so the fast event
  loop is in use. There is no free loop-level win left to claim.

---

## Files delivered

| Path | What |
|---|---|
| `apps/text/Dockerfile` | **Comment only.** Documents why the ENTRYPOINT is single-worker, with the measurement and the exact 3-step order to enable workers later. No functional change — the diff adds zero non-comment lines. |
| `docs/implementation/TASK-818-Text-LLM-Router/deployment/text-lane-g.patch.yaml` | Field-level patch for `base/text.yaml` in `arca/hope-v2-deployment` — G-2, G-3, G-4. Staged only; nothing in this repo applies it. |
| this file | The measurements and the verdicts. |

`scripts/dev-service.sh` is **unchanged, deliberately.** Local dev runs one
developer against one process, `--reload` is incompatible with `--workers`
anyway, and adding workers there would reproduce the resume truncation on a
developer's machine — worse than useless, because it would look like a Lane B bug.

---

## REGISTRATIONS — changes needed in files this lane does not own

### R-1 (BLOCKER for G-1) — implement the cross-process live tail

`apps/text/src/text/api/endpoints/stream.py`, the `producer is None` branch of
`stream_generation`. Owner: whoever owns Lane B's surface.

It must distinguish "finished" from "running elsewhere" and, for the latter, tail
the replay buffer with `XREAD BLOCK` until a terminal event. The task record's
status is the natural discriminator (`task_manager.get_task(gid).status`), and
`TaskManager` already has blocking-read plumbing — it just decodes the old
per-chunk format and needs a `GenerationEvent`/batch-aware sibling of
`read_chunk_entries_blocking`.

The existing `dedupe_by_seq` cursor makes the XRANGE→XREAD handover safe, so the
sequencing work is already done.

Acceptance: re-run the Lane G resume probe at `--workers 4`; **every** trial must
end in a terminal frame. Until that passes, `--workers` and `replicas > 1` both
stay off.

### R-2 (G-2) — make the drain budget match the shutdown contract

`apps/text/src/text/main.py:296-306` — orchestrator-only per EXECUTION-PLAN §4.

Both timeouts are hardcoded `30.0` and run sequentially, giving a ~60 s ceiling
that no k8s setting can extend:

```python
            await generation_hub.drain(timeout=30.0)
...
        timed_out = await shutdown_mgr.wait_for_shutdown(timeout=30.0)
```

The drain budget must be derived from the same value as
`terminationGracePeriodSeconds`, minus a margin for the rest of lifespan
shutdown. Concretely, with the staged `terminationGracePeriodSeconds: 600`, the
two waits should total ≲ 540 s rather than 60 s.

This is a genuine config surface, not a constant: it is the deployment's
shutdown budget. Per `.claude/rules/09` §Configuration Tiers it is arguably
`env` (process/topology identity, must be known at boot, immutable for the
process lifetime) — but it MUST agree with `maxGenerationSeconds`
(`db-config`, tenant→SYSTEM, floor 1800 s), and today it does not, by 30×.
**Reconciling those two is an owner decision, not a code change**, because it
answers "how long may one clinical generation run?" in two places that currently
give different answers.

### R-3 (G-4) — confirm how `hope-text` is scraped before applying

The staged `publishNotReadyAddresses: true` assumes a separate metrics Service
exists in `base/text.yaml`. Lane G could not read that repo. If Prometheus
scrapes `hope-text` pod-to-pod via pod annotations (which is what TASK-823's
NetworkPolicy comment says this repo does), endpoint membership does not gate the
scrape and **G-4 is a no-op** — record it as not applicable rather than adding the
field to the traffic Service, where it would route new generations to a pod that
is shutting down.

---

## Reproducing

Probes live in the session scratchpad (not committed — they drive unmodified
production code and depend on a live Redis):

```
resume_probe.py    <workers> <tokens> <token_interval_ms>   # cross-worker resume + cancel
cancel_depth.py                                             # does cancel STOP the producer?
shutdown_probe.py                                           # SIGTERM vs in-flight SSE
worker_sweep.py    <mode> <levels> <duration> <warmup> <workers,...>
```

All require `BENCH_DIR=$PWD/tests/bench` and run under
`cd apps/text && uv run --extra test python <script>`. They use Redis DB **9** to
avoid colliding with dev data, and they start/stop their own uvicorn and mock
upstream. They do not touch shared infrastructure.
