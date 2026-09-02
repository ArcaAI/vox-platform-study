# TASK-726 Design Notes — STT Realtime Draining + TTS Control-Plane Shape

Phase A deliverable (§4 Task 1). Reviewed against §1 scope boundaries before Tasks
2–6 started: does not rebuild `stt`'s batch worker/engine registry/session manager
(only extends them — degrade-routing, admin introspection, draining), does not add a
TTS batch worker (no queue/async use case exists, §2.2), and creates no
`deployment/k8s/**` files in this repo.

## (a) STT realtime draining protocol

**Open question from §6 resolved:** the gateway (`SttWsGateway`) does NOT hold a
per-STT-pod routing table — verified by grep (`apps/api/src/modules/streaming/stt-ws.gateway.ts`):
every "instance" comment in that file (`refreshWorkerPresence`, the multi-instance
socket-count aggregate, cross-instance-reconnect handling) tracks *the gateway's own*
NestJS pod identity for open-socket bookkeeping — it never selects which `stt` pod a
`POST /internal/streaming/sessions` call lands on. That call goes through the k8s
`Service` in front of `stt`, which round-robins across ready pods. **Therefore the
correct draining signal is the standard k8s mechanism: readiness, not gateway-side
routing logic** — no `apps/api` change is needed or made by this ticket.

Protocol, entirely inside `apps/stt`:

1. An operator or a `preStop` hook calls `POST /internal/streaming/drain`
   (`streaming/api/routes.py`, new). This calls `SessionManager.begin_drain()` —
   idempotent, sets an in-process `self._draining` flag. Nothing is written to Redis;
   draining is a property of THIS process, not a cluster-wide fact (contrast the
   existing `stt:worker:{worker_id}` heartbeat, which crash-detection reads across
   workers — draining has exactly one reader, this same process's own probes).
2. `GET /health/ready` (`health/api/routes.py`) now also checks
   `session_manager.is_draining`; if true it returns 503. Kubernetes removes the pod
   from the `Service` Endpoints list on the next probe failure, so the gateway (via
   the Service, not a code change) stops receiving new `POST .../sessions` calls for
   this pod. This is the actual "stop routing new sessions here" mechanism — it needs
   no cross-language contract at all, unlike the Redis-key idea floated in §6's risk.
3. `SessionManager.create_session()` ALSO checks `self._draining` and raises
   `SessionManagerDrainingError` (new, `core/exceptions.py`) before touching the
   capacity guard. This is defense-in-depth for the (bounded, unlikely) race window
   between "readiness probe fails" and "pod actually removed from Endpoints" — a
   request that slips through in that window still gets a distinguishable 503
   (`detail: "Draining"`, not `"At capacity"`) rather than being silently admitted.
   `streaming/api/routes.py::create_streaming_session` catches this exception
   distinctly from the existing capacity/`None` path.
4. Existing sessions are UNTOUCHED by draining — `self._sessions` keeps being served
   exactly as before. A new `SessionManager.wait_for_drain(timeout_s)` polls until
   `self._sessions` is empty or the bound elapses; this is what the `preStop` hook
   (deployment repo) calls AFTER step 1, so the pod's terminationGracePeriod holds it
   alive until sessions finish naturally or the bound is hit — never before.
5. `GET /internal/streaming/status` (existing, `SessionManager.to_dict()`) gains a
   `"draining"` key for human/operator visibility — the same signal `/health/ready`
   consumes, exposed for debugging without needing to interpret an HTTP status code.

**Explicitly NOT reused for this:** the "recovery on startup" replay-last-2s
mechanism (§2.1 of the ticket, module docstring) — that fires on `SessionManager.start()`
for a FRESH process finding orphaned Redis session keys after a crash. Draining never
restarts a process and never touches that code path; the two are structurally
disjoint (one runs at startup scanning Redis, the other is a flag checked at
create-time and read-time) so there is no risk of conflation in the implementation,
only in written explanation — hence spelling it out here.

## (b) TTS device-model decision

**Verified correction to §2.2's claim** ("no existing CUDA/MPS/device config surfaced
… for Kokoro/Indic Parler/Indic F5"): `apps/tts/src/tts/core/config.py` already
declares `device: str = "cpu"` on `KokoroConfig` (:68), `IndicParlerConfig` (:81), and
`IndicF5Config` (:111), and `KokoroProvider.__init__`/`_load` already reads
`self._config.device` at model-load time and logs it (`kokoro.py:115`). TTS is NOT
starting from zero here, unlike the ticket's §2.2 summary suggested — it is starting
from "device is configurable and wired to the loader," not "device is absent."

**Decision: do NOT import `stt`'s `Capability`/`HardwareBinding` dataclasses.**
Extracting a two-consumer shared package (`stt.processors.base.Capability` +
`HardwareBinding`) into a new shared package for TTS's simpler need is the
karpathy §2 violation the ticket's own file list flags ("no speculative abstraction
for a single reuse"). `stt`'s model is richer than TTS needs: `Capability` tracks a
*resolved* device that can differ per-request-batch (multiple ASR engines, dynamic
`asr_max_batch_size`), whereas TTS's device is a single static per-provider
config value, already a field, already wired. The proportionate move for TTS is:

- Keep the existing `device: str` config fields as the informal source of truth
  (unchanged — no new shared package, no new file).
- Add a static classification constant colocated with the new admin endpoint
  (`api/endpoints/providers.py`, Task 4): `GPU_BOUND_PROVIDERS = frozenset({"kokoro",
  "indic_parler", "indic_f5"})` / `API_BOUND_PROVIDERS = frozenset({"azure", "sarvam"})`.
  This is the fact the deployment repo needs to pin node pools against — a STATIC
  per-engine classification, not a per-request routing decision, so a plain module
  constant is proportionate (mirrors how design.md phrases it: "GPU engines pin node
  pools" — an engine-level property).
  This is Task 5's whole deliverable; there is no separate Task 5 file beyond this.
- Best-effort surface the ACTUAL resolved `device` value per local provider in the
  same endpoint response (`resolved_device`, via `getattr(provider._config, "device",
  None)`, never raising) — real diagnostic value, no new abstraction, no Protocol
  change (`TTSEngine` stays as-is; cloud engines have no `_config.device` and report
  `None` correctly).

## (c) Current-state correction: TTS degrade-routing ALREADY EXISTS

Re-verified while implementing Task 4 (not assumed from the ticket's own §2.2, which
did not mention this): `apps/tts/src/tts/routing/router.py` already has a per-provider
`CircuitBreaker` (`routing/circuit_breaker.py`) wired into `TTSRouter.candidates()`
(`router.py:216`, `if self.breaker(name).is_open(): continue`) — a provider that has
tripped its breaker is ALREADY excluded from the failover chain before Task 4 touches
anything. TTS's "control-plane work" (§1) therefore does NOT need a Task-725-style
`PoolHealthTracker`/`pool_router.py` rebuild — that pattern already exists here under a
different name and is REUSED unchanged. Task 4 is scoped down accordingly: it adds
ONLY the admin introspection endpoint (`GET /api/v1/providers` — did not exist before
this ticket), which surfaces per-provider `healthy` (from the existing `TTSEngine.health()`,
already used by `/health/ready`), `is_configured`, `breaker_open` (from the existing
`CircuitBreaker.is_open()`), `gpu_bound` (§b), and `resolved_device` (§b) — read-only
observability over machinery that was already live, not new routing logic.

## (d) STT batch worker queue-depth metric — definition (Task 2)

`stt_worker_queue_depth{queue="stt_batch"}` (Gauge), computed lazily via
`prometheus_client.Gauge.set_function` reading `RedisBroker.do_qsize("stt_batch")` —
Dramatiq's own pending-message-count primitive (used internally by `broker.join()`),
not a hand-rolled Redis `LLEN` against internal key structure. Wired inside
`_add_prometheus_middleware` (`core/messaging/broker.py`) because that function
already runs, gated on `settings.metrics_enabled`, at the END of `configure_broker()` —
which BOTH the FastAPI app process (`main.py` lifespan → `initialize_redis()`) and the
worker process (`worker.py` → `configure_broker(...)`) call. Using `set_function`
means no periodic poller/background task is needed: the value is computed fresh on
every `/metrics` scrape, and errors (Redis down) are caught and reported as `0.0`
rather than crashing the scrape — consistent with `/metrics` never being allowed to
fail because a dependency hiccupped.

## (e) Reconciliation note

Same status as TASK-725 §6: TASK-717 (`async-contract`) does not exist yet. This
ticket's STT/TTS changes do not introduce a new async task envelope at all (§1 — no
TTS batch worker; STT's existing `stt_batch` Dramatiq actor is unchanged) — the only
cross-cutting artifact TASK-717 might eventually touch is the queue-depth metric
naming convention (§d), which already matches `stt`'s existing `stt_*` prefix
convention and needs no reconciliation on its own.
