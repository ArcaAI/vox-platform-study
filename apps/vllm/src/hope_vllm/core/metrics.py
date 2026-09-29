"""Prometheus series of the vllm shell (TASK-1021 L2.5).

Labels NEVER carry a tenant id or any request content. ``model`` is the registered SLUG
of a model the gateway RESOLVED — never the raw ``model`` a client sent, so a caller
cannot mint series by naming models that do not exist.

The shell's own series:

* ``hope_vllm_requests_total{route,kind,model,status}`` · ``hope_vllm_request_seconds{route,kind}``
* ``hope_vllm_asr_rtf{model}`` — decode seconds per audio second (the ASR throughput signal)
* ``hope_vllm_inflight{model}`` — leases held (decoding) · ``hope_vllm_queue_depth{model}`` —
  requests waiting for their engine to load; together the HPA candidates
* ``hope_vllm_rejections_total{reason}`` — every refusal before a decode, by reason
* ``hope_vllm_engine_loads_total{result}`` · ``hope_vllm_engine_evictions_total``
* ``hope_vllm_resident_gib`` / ``hope_vllm_vram_budget_gib`` — the pool's GiB admission state
* ``hope_vllm_engine_queue_seconds`` — vLLM's scheduler wait, when reported
* ``hope_vllm_truncation_suspected_total{reason}`` — the vllm#53144 flag (D-9)

The MODEL-RESIDENCY contract (TASK-1005, ``packages/py-runtime-models/src/hope_runtime_models/
metrics.py``) — the same names, labels and buckets the gateway residency controller and the
"Model residency" screen read, copied because this service is outside the uv workspace:

* ``model_resident_bytes{service="vllm",model,device}`` — the engine's GPU claim
  (``engine.vramGiB``: vLLM preallocates exactly that share of the card); zeroed, never
  removed, when the engine leaves
* ``model_load_seconds{service="vllm",model}`` — histogram of successful builds

vLLM's own ``vllm:*`` series (``disable_log_stats=False``) register into the default
``prometheus_client`` registry in this process and are served from the same ``/metrics``.
"""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

#: The residency contract's service label for this process.
SERVICE = "vllm"
#: One engine per process sees one card (the device plugin hands the pod one GPU).
DEVICE = "cuda:0"

_LATENCY_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 7.5, 10.0, 15.0, 30.0, 60.0)
_RTF_BUCKETS = (0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 5.0)
#: `hope_runtime_models.metrics.MODEL_LOAD_SECONDS_BUCKETS`, verbatim.
MODEL_LOAD_SECONDS_BUCKETS = (0.5, 1.0, 2.5, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0, 300.0)

REQUESTS_TOTAL = Counter(
    "hope_vllm_requests_total",
    "Requests on the OpenAI surface by route, model kind, model slug and HTTP status",
    ["route", "kind", "model", "status"],
)
REQUEST_SECONDS = Histogram(
    "hope_vllm_request_seconds",
    "Request wall time on the OpenAI surface (resolve + lease + decode)",
    ["route", "kind"],
    buckets=_LATENCY_BUCKETS,
)
ASR_RTF = Histogram(
    "hope_vllm_asr_rtf",
    "Real-time factor of one transcription: decode seconds per audio second",
    ["model"],
    buckets=_RTF_BUCKETS,
)
INFLIGHT = Gauge("hope_vllm_inflight", "Leases held on an engine (decoding)", ["model"])
QUEUE_DEPTH = Gauge(
    "hope_vllm_queue_depth", "Requests waiting for their engine to be loaded", ["model"]
)
REJECTIONS_TOTAL = Counter(
    "hope_vllm_rejections_total", "Requests refused before a decode, by reason", ["reason"]
)
ENGINE_LOADS_TOTAL = Counter(
    "hope_vllm_engine_loads_total", "Engine builds by result (loaded | failed)", ["result"]
)
ENGINE_EVICTIONS_TOTAL = Counter(
    "hope_vllm_engine_evictions_total", "Idle engines evicted to admit another"
)
RESIDENT_GIB = Gauge(
    "hope_vllm_resident_gib", "GiB committed to resident and loading engines (vramGiB sum)"
)
VRAM_BUDGET_GIB = Gauge("hope_vllm_vram_budget_gib", "This pool's VRAM budget (vramBudgetGiB)")
ENGINE_QUEUE_SECONDS = Histogram(
    "hope_vllm_engine_queue_seconds",
    "vLLM scheduler wait per request, when reported by the engine",
    buckets=_LATENCY_BUCKETS,
)
TRUNCATION_SUSPECTED_TOTAL = Counter(
    "hope_vllm_truncation_suspected_total", "Transcripts flagged as possibly truncated", ["reason"]
)

# ── the model-residency contract (TASK-1005) ────────────────────────────────

MODEL_RESIDENT_BYTES = Gauge(
    "model_resident_bytes",
    "Measured (here: claimed) resident footprint of a model; 0 = not resident",
    ["service", "model", "device"],
)
MODEL_LOAD_SECONDS = Histogram(
    "model_load_seconds",
    "Successful model loads",
    ["service", "model"],
    buckets=MODEL_LOAD_SECONDS_BUCKETS,
)
