"""The vllm knobs the CONTROL PLANE owns, and how a served value lands (TASK-1021 C-4).

Same contract as ``apps/stt`` / ``apps/tts`` ``core/control_plane.py`` — registry keys
delivered over ``GET /internal/effective-config?service=vllm``, an env path closed by a
dead ``validation_alias``, defaults transcribed verbatim so an empty control plane changes
nothing — copied rather than imported (every Python service owns its copy).

WHAT THE KEYS ARE
-----------------
Platform-only ``global-kv`` descriptors (``vllm.descriptors.ts``: ``consumedBy: ['vllm']``,
``failMode: 'open-to-default'``). Platform-only is the owner-approved exception to tenant →
platform resolution: they size a shared GPU pool that every tenant's requests batch
through, so no tenant can hold an opinion on them.

* ``vllm.pools`` — ``{ <pool name>: { acceptedKinds, pins, vramBudgetGiB,
  maxResidentEngines, inflightFactor? } }``; this process serves the entry ``VLLM_POOL``
  names. Read at every admission (``EnginePool``). Engine SIZING itself is not here: it is
  the model row's ``engine.vramGiB`` (D-11) — the retired ``asrVllm.engine.*`` knobs sized
  every engine alike as a fraction of the card.
* ``vllm.truncation.{minCharsPerVoicedSecond, voicedDbfs}`` — read per request.

WHAT IS REFUSED, AND WHY
------------------------
A served value is applied only when it has the field's own type and sits inside the SAME
bounds the descriptor declares. A ``vllm.pools`` map is applied WHOLE or not at all: one
malformed pool refuses the map, and so does a map that no longer declares this process's
own pool (``VLLM_POOL`` is fixed for the process lifetime; deleting it underneath a running
replica would leave it with no admission policy). Anything refused keeps the value already
in force and logs — a knob must never be coerced into a value nobody chose.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Literal

from hope_obs import get_logger
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from hope_vllm.engine.pool import DEFAULT_INFLIGHT_FACTOR, PoolConfig

if TYPE_CHECKING:  # pragma: no cover - typing only
    from hope_vllm.core.config import Settings

logger = get_logger(__name__)

#: Suffix that closes a field's env path. Verbose on purpose: an operator grepping for
#: ``VLLM_POOLS`` lands on something that says where the value went, not on a field that
#: merely looks settable.
MOVED_SUFFIX = "__MOVED_TO_CONTROL_PLANE"


def moved_alias(env_var: str) -> str:
    """The dead ``validation_alias`` for a control-plane field.

    Takes the FULL variable name (``VLLM_POOLS``), not the field name:
    ``validation_alias`` bypasses ``env_prefix``, so the alias must be spelled in full to
    stay greppable from the operator's side (the ``apps/tts`` form of the helper).
    """
    return f"{env_var}{MOVED_SUFFIX}"


# ``Settings`` field → settings-registry key. Asserted against the gateway descriptors'
# key names by ``tests/unit/test_control_plane.py``.
CONTROL_PLANE_KEYS: dict[str, str] = {
    "pools": "vllm.pools",
    "truncation_min_chars_per_voiced_second": "vllm.truncation.minCharsPerVoicedSecond",
    "truncation_voiced_dbfs": "vllm.truncation.voicedDbfs",
}

_FIELD_BY_KEY: dict[str, str] = {key: field for field, key in CONTROL_PLANE_KEYS.items()}

#: Inclusive (min, max) per numeric field — the descriptor bounds.
BOUNDS: dict[str, tuple[float | None, float | None]] = {
    "truncation_min_chars_per_voiced_second": (0.0, None),
    "truncation_voiced_dbfs": (-90.0, 0.0),
}

# ── vllm.pools ──────────────────────────────────────────────────────────────

#: `vllm.pools` default (C-4) — the descriptor default, verbatim.
DEFAULT_POOLS: dict[str, dict[str, Any]] = {
    "default": {
        "acceptedKinds": ["asr"],
        "pins": [],
        "vramBudgetGiB": 6,
        "maxResidentEngines": 1,
        "inflightFactor": 2,
    }
}


class PoolSpec(BaseModel):
    """One entry of ``vllm.pools``, validated exactly as the descriptor declares it."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    accepted_kinds: list[Literal["asr", "llm", "tts"]] = Field(alias="acceptedKinds", min_length=1)
    pins: list[str] = Field(alias="pins")
    vram_budget_gib: float = Field(alias="vramBudgetGiB", gt=0)
    max_resident_engines: int = Field(alias="maxResidentEngines", ge=1)
    inflight_factor: int = Field(alias="inflightFactor", ge=1, default=DEFAULT_INFLIGHT_FACTOR)

    def to_pool_config(self) -> PoolConfig:
        if any(not pin.strip() for pin in self.pins):
            raise ValueError("a pin must be a non-empty slug")
        return PoolConfig(
            accepted_kinds=frozenset(self.accepted_kinds),
            pins=tuple(self.pins),
            vram_budget_gib=float(self.vram_budget_gib),
            max_resident=self.max_resident_engines,
            inflight_factor=self.inflight_factor,
        )


_POOLS_ADAPTER: TypeAdapter[dict[str, PoolSpec]] = TypeAdapter(dict[str, PoolSpec])


def parse_pools(value: Any) -> dict[str, PoolConfig]:
    """A ``vllm.pools`` value (object, or its JSON text) → ``{name: PoolConfig}``.

    Raises ``ValueError`` (``ValidationError`` is one) when it is not a map of valid pools.
    """
    if isinstance(value, str):
        value = json.loads(value)
    pools = _POOLS_ADAPTER.validate_python(value)
    return {name: spec.to_pool_config() for name, spec in pools.items()}


# ── overlay ─────────────────────────────────────────────────────────────────


def _coerce_number(field: str, served: Any) -> float | None:
    """``served`` as a bounded float, or ``None``. ``bool`` is not a number here."""
    if isinstance(served, bool) or not isinstance(served, int | float):
        return None
    value = float(served)
    low, high = BOUNDS[field]
    if (low is not None and value < low) or (high is not None and value > high):
        return None
    return value


def _coerce_pools(settings: Settings, served: Any) -> Any | None:
    """``served`` if it is a valid pools map that still declares this process's pool."""
    try:
        pools = parse_pools(served)
    except (ValueError, ValidationError, TypeError):
        return None
    if settings.pool not in pools:
        logger.warning(
            "vllm.control_plane.pool_missing_refused",
            pool=settings.pool,
            declared=sorted(pools),
        )
        return None
    return json.loads(served) if isinstance(served, str) else served


def apply_control_plane(settings: Settings, payload: Any) -> list[str]:
    """Overlay one effective-config payload onto ``settings``. Returns the KEYS applied.

    ``payload`` is the raw body of ``GET /internal/effective-config?service=vllm``; only
    its generic ``settings`` map is read. NEVER raises: a malformed payload, a missing
    block, an unknown key or an unresolved (``value: null``) entry each contribute nothing
    — a request must not fail because the config plane is down.
    """
    if not isinstance(payload, dict):
        return []
    block = payload.get("settings")
    if not isinstance(block, dict):
        return []

    applied: list[str] = []
    for key, entry in block.items():
        field = _FIELD_BY_KEY.get(key)
        if field is None or not isinstance(entry, dict):
            continue
        served = entry.get("value")
        if served is None:  # unresolved on the gateway side — keep what is in force
            continue
        value = (
            _coerce_pools(settings, served) if field == "pools" else _coerce_number(field, served)
        )
        if value is None:
            logger.warning(
                "vllm.control_plane.value_refused",
                key=key,
                served_type=type(served).__name__,
            )
            continue
        if value != getattr(settings, field):
            setattr(settings, field, value)
            applied.append(key)
            logger.info("vllm.control_plane.applied", key=key)
    return applied
