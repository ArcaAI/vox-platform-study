# hope-runtime-models

Shared **model-lifecycle contract** for the HOPE in-process Python services
(`stt-v2`, `guardrail`, `nlp`, `harness`, `tts-v2`).

Before TASK-529 three structurally identical caches existed with zero code
sharing (stt-v2 / guardrail / nlp) and two services had no lifecycle management
at all (harness held an immortal module dict, tts-v2 loaded eagerly at boot and
never unloaded). This package is the single implementation of that policy.

It is a **contract, not a framework**: one policy engine plus the two optional
hooks it needs (metrics sink, VRAM probe). Service-specific concerns — the
stt-v2 loader map, the tts pipeline handles, the harness llama handle — stay in
their own services and are passed in as `factory` / `unload` callables.

**Two concurrency skins, one policy.** `ModelCache` (asyncio) and
`SyncModelCache` (threads) both derive from the same private policy core, so the
eviction order, pin semantics, clamp, `CacheStats` and metric labels are shared
code — not parallel implementations that can drift. Use `SyncModelCache` only
when the consumer is genuinely synchronous and the load is a blocking CPU/GPU
call rather than awaited I/O (TASK-530's motivating case: the harness MiniCheck
entailer, whose sole call site is a plain `def`).

## Contract

```
ModelCache[T](factory, *, unload=None, max_size, max_bytes_estimate=None,
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

SyncModelCache[T](...)      # SAME constructor and SAME method names, all sync:
                            # threading.Lock + a per-key Event for single-flight.
                            # `factory` and `unload` are plain callables — an
                            # async unload hook cannot be honoured (no loop to
                            # await on) and is refused with a warning.
                            # No background task: sweeps lazily on get(), plus
                            # sweep() for the host's own periodic sweeper.
```

Clauses (each has a conformance test in `tests/test_cache_contract.py`,
**parameterized over BOTH cache classes** so the two cannot drift):

1. **Single-flight** — concurrent `get(k)` performs exactly one factory call;
   waiters share the result; a waiter's cancellation cannot cancel the shared
   load (`asyncio.shield`).
2. **Eviction order** — `ttl → lru → vram`; every eviction is labelled with its
   reason.
3. **Pinned entries are never evicted** by any path except `clear()`.
4. **Soft ceiling under all-pinned load** — the cache exceeds `max_size` rather
   than drop a model in use, and warns. Deliberate; matches prior behaviour.
5. **Monotonic injectable clock** (`time_func`) — no wall clock, no sleeps in
   tests.
6. **Periodic sweep** — `sweep()` releases idle models whose key is never
   re-requested (the pre-TASK-529 caches leaked these forever).
7. **Hot reconfiguration** — `configure()` applies new clamped limits without
   dropping resident entries.
8. **Min-residency floor** — an entry is never TTL-evicted younger than
   `_TTL_MIN_SECONDS` (60 s) idle, regardless of settings (anti-thrash).
9. **Every eviction path releases the weights, exactly once** — `unload` is
   called once per evicted key on ALL SIX paths (explicit `evict`, lazy TTL on
   `get`, TTL `sweep`, LRU overflow, VRAM pressure, `clear`) for BOTH cache
   classes. TASK-529's TDD caught two real defects here (LRU-overflow and
   lazy-TTL eviction dropped entries *without* calling `unload`, so the cache
   reported an eviction, freed nothing, and its byte budget silently stopped
   meaning anything). TASK-530 generalized those spot fixes into this
   path-parameterized clause so a new eviction path cannot regress it.
10. **Identical stats surface** — `stats()` returns the same `CacheStats`
   field-for-field from both classes, so one Grafana dashboard reads both.

## Consuming it

The package is a `uv` workspace member. Add to a service `pyproject.toml`:

```toml
dependencies = ["hope-runtime-models"]

[tool.uv.sources]
hope-runtime-models = { workspace = true }
```

then run `uv lock` at the repo ROOT. Docker builds copy this package's source in
build layer 1 (before `uv sync --no-install-project`) because
`--no-install-project` skips only the *target* package, not its workspace path
dependencies — see `docs/operations/inference/model-retention.md`.
