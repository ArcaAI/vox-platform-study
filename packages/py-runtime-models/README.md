# hope-runtime-models — the shared model-lifecycle contract

Shared model-lifecycle contract for the HOPE in-process Python services (`stt`, `text`,
`guardrail`, `nlp`, `harness`, `tts`).

Before TASK-529 three structurally identical caches existed with zero code sharing
(stt/guardrail/nlp) and two services had no lifecycle management at all (harness held an immortal
module dict, tts loaded eagerly at boot and never unloaded). This package is the single
implementation of that policy.

It is a CONTRACT, not a framework: one policy engine plus the two optional hooks it needs (metrics
sink, VRAM probe). Service-specific concerns — the stt loader map, the tts pipeline handles, the
harness llama handle — stay in their own services and are passed in as `factory`/`unload`
callables.

## Layout

| Path | What it holds |
|---|---|
| `src/hope_runtime_models/cache.py` | `ModelCache` (asyncio) and `SyncModelCache` (threads), `CacheStats`, `ModelUnavailableError`, `clamp_cache_ttl_seconds` |
| `src/hope_runtime_models/metrics.py` | `MetricsSink`, `NullMetricsSink`, `PrometheusMetricsSink`, `EvictionCount` |
| `src/hope_runtime_models/vram.py` | `make_vram_probe`, `reset_nvml_detection` |
| `src/hope_runtime_models/resolvable.py` | `check_resolvable`/`check_resolvable_many` — network-free, filesystem-only readiness probes (see below) |
| `tests/test_cache_contract.py` | The parameterized conformance suite (both cache classes, all clauses) |
| `tests/test_resolvable_probes_task890.py` | Readiness-probe tests |

## Commands

```bash
conda run -n arcaenv pytest packages/py-runtime-models
```

No root `pnpm` alias exists for this package's own suite; each consuming service's own test run
(`pnpm <svc>:test`) exercises it indirectly too.

## How it works

### Two concurrency skins, one policy

`ModelCache` (asyncio) and `SyncModelCache` (threads) both derive from the same private policy
core, so the eviction order, pin semantics, clamp, `CacheStats`, and metric labels are shared code
— not parallel implementations that can drift. Use `SyncModelCache` only when the consumer is
genuinely synchronous and the load is a blocking CPU/GPU call rather than awaited I/O (the
harness MiniCheck entailer, whose sole call site is a plain `def`, is the motivating case).

```
ModelCache generic over T (factory, *, unload=None, max_size, max_bytes_estimate=None,
              ttl_seconds, time_func=time.monotonic, metrics=None,
              vram_probe=None, estimate_bytes=None, name="model_cache")
  .get(key) -> T          # single-flight per key; failure is NOT cached
  .pin(key) / .unpin(key) # refcounts; pins survive reload; last unpin restarts the idle clock
  .pin_many / .unpin_many
  .evict(key) -> bool     # refuses pinned
  .sweep() -> int         # evict all idle-expired unpinned entries (periodic task)
  .clear() -> int         # teardown; ignores pins
  .stats() -> CacheStats
  .configure(...)         # hot re-configuration from an effective-config refresh
clamp_cache_ttl_seconds(v)  # hard product clamp [60, 3600]

SyncModelCache generic over T, same args  # SAME constructor and SAME method names, all sync:
                            # threading.Lock + a per-key Event for single-flight.
                            # `factory` and `unload` are plain callables — an
                            # async unload hook cannot be honoured (no loop to
                            # await on) and is refused with a warning.
                            # No background task: sweeps lazily on get(), plus
                            # sweep() for the host's own periodic sweeper.
```

Clauses (each has a conformance test in `tests/test_cache_contract.py`, parameterized over BOTH
cache classes so the two cannot drift):

1. **Single-flight** — concurrent `get(k)` performs exactly one factory call; waiters share the result; a waiter's cancellation cannot cancel the shared load (`asyncio.shield`).
2. **Eviction order** — `ttl -> lru -> vram`; every eviction is labelled with its reason.
3. **Pinned entries are never evicted** by any path except `clear()`.
4. **Soft ceiling under all-pinned load** — the cache exceeds `max_size` rather than drop a model in use, and warns. Deliberate; matches prior behavior.
5. **Monotonic injectable clock** (`time_func`) — no wall clock, no sleeps in tests.
6. **Periodic sweep** — `sweep()` releases idle models whose key is never re-requested (the pre-TASK-529 caches leaked these forever).
7. **Hot reconfiguration** — `configure()` applies new clamped limits without dropping resident entries.
8. **Min-residency floor** — an entry is never TTL-evicted younger than `_TTL_MIN_SECONDS` (60s) idle, regardless of settings (anti-thrash).
9. **Every eviction path releases the weights, exactly once** — `unload` is called once per evicted key on ALL SIX paths (explicit `evict`, lazy TTL on `get`, TTL `sweep`, LRU overflow, VRAM pressure, `clear`) for BOTH cache classes.
10. **Identical stats surface** — `stats()` returns the same `CacheStats` field-for-field from both classes, so one Grafana dashboard reads both.

### Model readiness probes (`resolvable.py`, TASK-890)

The gateway used to measure a self-hosted model's usability from `AiModel.availability` alone — a
fact about the `hope-models` MinIO bucket. But nothing on the serving path reads that bucket for
rows resolved through `source_uri` (e.g. `apps/stt` through its HuggingFace cache, `apps/nlp`
through `HF_HOME`), so 21 of 33 catalogue rows reported "unusable" while the process serving them
already had the weights on disk. `check_resolvable`/`check_resolvable_many` answer the question the
bucket cannot: the SERVING PROCESS's own verdict, read-only and network-free. Rules it keeps:

- **Never fetch, and never call the hub.** Every branch is a bounded filesystem read; the
  HuggingFace branch resolves the cache layout by hand
  (`models--<org>--<name>/refs/<rev>` to a commit hash, then `snapshots/<sha>/`) rather than
  calling `snapshot_download` — a readiness probe that downloads multi-gigabyte weights is a denial
  of service wearing a health check.
- **Never guess.** An unrecognized scheme is `unsupported`, not "probably fine". A
  package-provided library (`PACKAGE_PROVIDED_LIBRARIES`) is resolvable only if the package
  actually imports.
- **Never walk.** No `scan_cache_dir`, no recursive descent.

The gateway asks each service by `servedBy`; the service answers about ITS OWN filesystem; the
readiness sweep folds the answer in. An unreachable service stays `unknown`, never guessed.

### Consuming it
The package is a `uv` workspace member. Add to a service `pyproject.toml`:

```toml
dependencies = ["hope-runtime-models"]

[tool.uv.sources]
hope-runtime-models = { workspace = true }
```

then run `uv lock` at the repo ROOT.

## Gotchas

- The package is deliberately DEPENDENCY-FREE (`dependencies = []` in `pyproject.toml`) — it is
  imported by every Python service, so any dependency it declared would be forced onto all of them
  and would have to co-resolve inside the single root `uv.lock`. Prometheus metrics and the NVML
  probe are injected by the host service (`metrics.py`/`vram.py`), never imported directly here;
  `pynvml` stays an optional extra, never a base dependency.
- Docker builds copy this package's source in build layer 1 (before `uv sync --no-install-project`)
  because `--no-install-project` skips only the TARGET package, not its workspace path
  dependencies — see `docs/operations/inference/model-retention.md`.
- A readiness-probe branch that calls a library function "just to check" instead of a bounded
  filesystem read reintroduces the exact denial-of-service failure mode TASK-890 fixed.

## Related

- [`06-python-services.md`](../../.claude/rules/06-python-services.md) — the six Python services this package's cache and probes serve
