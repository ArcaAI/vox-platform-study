"""Shared metering vocabulary for the compute and network usage units (TASK-959).

Two values ride every usage signal this service sends the gateway — on the batch
completion callback and on each streaming ``UsageSegment`` — and both are
BILLING decisions, so they live in one place rather than being spelled out at
each call site:

* ``device`` decides WHICH compute unit the gateway emits for the occupancy
  seconds it already receives: ``cuda``/``mps`` -> ``GPU_SECOND``, ``cpu`` ->
  ``CPU_SECOND`` (TASK-959 §2.1, §10.2). The wire alphabet is exactly those
  three strings.
* ``byte_source`` says whether a byte count is the real wire or an
  application-level proxy, so replacing a proxy with an exact figure later
  cannot silently change the meaning of rows already written (§4.2).

The occupancy seconds themselves are NOT physical GPU time: the streaming
scheduler batches utterances from many sessions onto one card and the cluster
time-slices two cards into six units, so per-request wall clock over-counts
physical time by a concurrency factor nothing records. It is what the tenant
OCCUPIED, which is the figure a rate can be attached to; physical truth for
COGS comes from a monthly DCGM reconciliation, not from here (§3.1).
"""

from __future__ import annotations

#: The three device values the ledger understands. Anything else is not a unit.
DEVICE_CUDA = "cuda"
DEVICE_MPS = "mps"
DEVICE_CPU = "cpu"

#: Counted off the actual HTTP request/response (the REST adapters).
BYTE_SOURCE_WIRE = "wire"
#: An application-level proxy — the PCM we handed a vendor SDK and the payload
#: it handed back — because the SDK's own encoded socket traffic is opaque to us.
BYTE_SOURCE_APP = "app"


def normalize_device(raw: object | None) -> str:
    """Map a loader/profile device string onto the ledger's three-value alphabet.

    ``"cuda:0"`` (what every CUDA execution profile and torch loader actually
    carries) becomes ``"cuda"``: an ordinal on the wire is a value the gateway
    cannot map to a unit, and an unmappable device bills nothing.

    Everything this service cannot resolve to a real accelerator — ``"cloud"``
    (stamped by every cloud ASR loader, whose hardware is not ours), ``"auto"``
    (whisper.cpp with GPU and parakeet.cpp never resolve a concrete device),
    an empty value, or a non-string — becomes ``"cpu"``. That is the ticket's
    declared rule: record the CHEAPER unit rather than nothing (§3.1). For a
    cloud engine it is also the honest one — what the request occupied HERE is
    the calling service's CPU while it waited on the vendor.

    Known under-report, stated rather than hidden: a ``whisper_cpp`` batch job
    running with ``use_gpu`` stamps ``"auto"`` and therefore meters as CPU. The
    fix belongs in the loaders (stamp the device they resolved), not here.
    """
    if not isinstance(raw, str):
        return DEVICE_CPU
    value = raw.strip().lower()
    if value.startswith(DEVICE_CUDA):
        return DEVICE_CUDA
    if value.startswith(DEVICE_MPS):
        return DEVICE_MPS
    return DEVICE_CPU
