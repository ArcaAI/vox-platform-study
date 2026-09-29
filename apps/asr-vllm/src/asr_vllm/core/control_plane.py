"""The asr-vllm knobs the CONTROL PLANE owns, and how a served value lands (TASK-1010 OD-6).

Same contract as ``apps/stt`` / ``apps/tts`` ``core/control_plane.py`` — registry keys
delivered over ``GET /internal/effective-config?service=asr-vllm``, an env path closed by a
dead ``validation_alias``, defaults transcribed verbatim so an empty control plane changes
nothing — copied rather than imported (every Python service owns its copy).

WHAT THE SIX KEYS ARE
---------------------
Platform-only ``global-kv`` descriptors (``asr-vllm.descriptors.ts``: ``maxScope:
'system'``, ``globalOnly: true``, ``failMode: 'open-to-default'``). Platform-only is the
owner-approved exception to tenant → platform resolution: they size ONE shared GPU pool
that every tenant's windows batch through, so no tenant can hold an opinion on them.

WHEN EACH ONE BITES
-------------------
* ``asrVllm.engine.{gpuMemoryUtilization, maxNumSeqs, enforceEager}`` — read when an
  engine is BUILT (``VllmEngineFactory``); a resident engine keeps the shape it was built
  with, because vLLM cannot resize a running engine.
* ``asrVllm.engine.maxResidentEngines`` — read at every eviction check (``EnginePool``).
* ``asrVllm.truncation.{minCharsPerVoicedSecond, voicedDbfs}`` — read per request.

WHAT IS REFUSED, AND WHY
------------------------
A served value is applied only when it has the field's own type and sits inside the SAME
bounds the descriptor declares (mirrored in :data:`BOUNDS`). Anything else keeps the value
already in force and logs — a knob must never be coerced into a number nobody chose.
``gpuMemoryUtilization`` × ``maxResidentEngines`` must also fit one card; a pair that does
not is refused AS A PAIR, judged against the values already in force.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from hope_obs import get_logger

if TYPE_CHECKING:  # pragma: no cover - typing only
    from asr_vllm.core.config import Settings

logger = get_logger(__name__)

#: Suffix that closes a field's env path. Verbose on purpose: an operator grepping for
#: ``ASR_VLLM_MAX_NUM_SEQS`` lands on something that says where the value went, not on a
#: field that merely looks settable.
MOVED_SUFFIX = "__MOVED_TO_CONTROL_PLANE"


def moved_alias(env_var: str) -> str:
    """The dead ``validation_alias`` for a migrated field.

    Takes the FULL variable name (``ASR_VLLM_MAX_NUM_SEQS``), not the field name:
    ``validation_alias`` bypasses ``env_prefix``, so the alias must be spelled in full to
    stay greppable from the operator's side (the ``apps/tts`` form of the helper).
    """
    return f"{env_var}{MOVED_SUFFIX}"


# ``Settings`` field → settings-registry key. Asserted against the gateway descriptors'
# key names by ``tests/unit/test_control_plane.py``.
CONTROL_PLANE_KEYS: dict[str, str] = {
    "gpu_memory_utilization": "asrVllm.engine.gpuMemoryUtilization",
    "max_num_seqs": "asrVllm.engine.maxNumSeqs",
    "enforce_eager": "asrVllm.engine.enforceEager",
    "max_resident_engines": "asrVllm.engine.maxResidentEngines",
    "truncation_min_chars_per_voiced_second": "asrVllm.truncation.minCharsPerVoicedSecond",
    "truncation_voiced_dbfs": "asrVllm.truncation.voicedDbfs",
}

_FIELD_BY_KEY: dict[str, str] = {key: field for field, key in CONTROL_PLANE_KEYS.items()}

#: Inclusive (min, max) per numeric field — the descriptor bounds (ticket plan, OD-6).
BOUNDS: dict[str, tuple[float | None, float | None]] = {
    "gpu_memory_utilization": (0.05, 0.95),
    "max_num_seqs": (1, 1024),
    "max_resident_engines": (1, 4),
    "truncation_min_chars_per_voiced_second": (0.0, None),
    "truncation_voiced_dbfs": (-90.0, 0.0),
}

_INT_FIELDS = frozenset({"max_num_seqs", "max_resident_engines"})
_BOOL_FIELDS = frozenset({"enforce_eager"})


def gpu_budget_fits(max_resident_engines: int, gpu_memory_utilization: float) -> bool:
    """Every resident engine claims its fraction of the WHOLE card; together ≤ one card."""
    return max_resident_engines * gpu_memory_utilization <= 1.0


def _coerce(field: str, served: Any) -> int | float | bool | None:
    """``served`` as the field's type, or ``None`` when it is not acceptable.

    ``bool`` is excluded from the numeric branch deliberately — it is an ``int``
    subclass, so ``True`` would otherwise become the integer 1.
    """
    if field in _BOOL_FIELDS:
        return served if isinstance(served, bool) else None
    if isinstance(served, bool) or not isinstance(served, int | float):
        return None
    if field in _INT_FIELDS:
        if isinstance(served, float) and not served.is_integer():
            return None
        value: int | float = int(served)
    else:
        value = float(served)
    low, high = BOUNDS[field]
    if (low is not None and value < low) or (high is not None and value > high):
        return None
    return value


def apply_control_plane(settings: Settings, payload: Any) -> list[str]:
    """Overlay one effective-config payload onto ``settings``. Returns the KEYS applied.

    ``payload`` is the raw body of ``GET /internal/effective-config?service=asr-vllm``;
    only its generic ``settings`` map is read. NEVER raises: a malformed payload, a
    missing block, an unknown key or an unresolved (``value: null``) entry each
    contribute nothing — a decode window must not fail because the config plane is down.
    """
    if not isinstance(payload, dict):
        return []
    block = payload.get("settings")
    if not isinstance(block, dict):
        return []

    candidates: dict[str, int | float | bool] = {}
    for key, entry in block.items():
        field = _FIELD_BY_KEY.get(key)
        if field is None or not isinstance(entry, dict):
            continue
        served = entry.get("value")
        if served is None:  # unresolved on the gateway side — keep what is in force
            continue
        value = _coerce(field, served)
        if value is None:
            logger.warning(
                "asr_vllm.control_plane.value_refused",
                key=key,
                served_type=type(served).__name__,
            )
            continue
        if value != getattr(settings, field):
            candidates[field] = value

    budget = ("max_resident_engines", "gpu_memory_utilization")
    if any(field in candidates for field in budget):
        resident = int(candidates.get("max_resident_engines", settings.max_resident_engines))
        fraction = float(candidates.get("gpu_memory_utilization", settings.gpu_memory_utilization))
        if not gpu_budget_fits(resident, fraction):
            logger.warning(
                "asr_vllm.control_plane.gpu_budget_refused",
                max_resident_engines=resident,
                gpu_memory_utilization=fraction,
            )
            for field in budget:
                candidates.pop(field, None)

    applied: list[str] = []
    for field, value in candidates.items():
        setattr(settings, field, value)
        applied.append(CONTROL_PLANE_KEYS[field])
        logger.info("asr_vllm.control_plane.applied", key=CONTROL_PLANE_KEYS[field])
    return applied
