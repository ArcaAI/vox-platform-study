"""The tts knobs the CONTROL PLANE owns, and how a served value lands.

lane C, the tts half. Structurally the same contract as
``apps/stt/src/stt/core/control_plane.py`` — registry keys delivered over the
effective-config pull route, an env path closed by a dead ``validation_alias``,
defaults transcribed verbatim so an empty control plane changes nothing — with
two differences that come from tts's own shape.

WHAT DIFFERS FROM THE stt CLIENT, AND WHY
------------------------------------------

**1. The fields are NESTED, so the alias must be spelled in full.** tts splits
its settings into per-provider ``BaseSettings`` classes with their own
``env_prefix`` (``TTS_AZURE_``, ``TTS_KOKORO_``, …). A ``validation_alias``
BYPASSES ``env_prefix`` — it is an absolute variable name — so deriving the dead
alias from the field name alone would produce ``ENABLED__MOVED…`` for five
different providers and tell an operator grepping for ``TTS_AZURE_ENABLED``
nothing at all. :func:`moved_alias` therefore takes the full variable name.

**2. This service stays STATELESS, and this module must not change that.**
``apps/tts`` opens no database connection, resolves no tenant locally, and fails
CLOSED when the gateway injects no routing chain — the assessment names it "a
genuine stateless, gateway-injected service … the pattern is proven and safe to
copy". Everything below is therefore PLATFORM scope (owner decision D-1): the
platform's own provider tuning, endpoints and local-engine model ids. A tenant's
credentials, voice bindings and provider chain continue to arrive per request in
the body, resolved by the gateway, and nothing here caches or resolves them.

WHAT IS DELIBERATELY ABSENT
----------------------------
* **The two BYOK credentials.** ``azure.api_key`` and ``sarvam.api_key`` keep
  their ``validation_alias="…__ENV_REMOVED_TASK_602"`` guard untouched, and they
  are NOT in the table below — a secret must never traverse a config READ
  surface, and the gateway's read service filters ``sensitivity: 'secret'`` off
  the route unconditionally anyway. They arrive per request and are applied by
  the router via ``model_copy``.
* **Per-provider VOICE names.** They are not config at all any more: the voice
  catalog is the single source (see ``catalog/voices.py``), and the router
  already passes the resolved binding as ``req.provider_voice``.
* **Seven knobs removed by TASK-872**, because a served value that reaches no
  reader is a control an operator can move with no effect: ``azure.timeout_s``
  and ``azure.max_concurrent`` (the Azure client builds neither),
  ``sarvam.sample_rate`` (the rate rides the request), ``sarvam.max_concurrent``
  (unread), ``sarvam.use_streaming`` (named an unimplemented phase-2 upgrade),
  ``kokoro.device`` (still a live FIELD read by the loader — only its
  control-plane path went, because ``providers/kokoro.py`` reads it at
  construction and the pull lands after) and ``default_format`` (the effective
  format is resolved by the GATEWAY from ``TenantTtsConfig`` and arrives per
  request). Their registry descriptors were deleted in the same change.

WHAT IS HALF-PRESENT, AND WHY THAT IS THE INTENDED STATE
---------------------------------------------------------
The five provider/engine ``*_ENABLED`` flags ARE served here now (lane H), but
their environment path stays OPEN — see :data:`ENV_BOOTSTRAP_KEYS`. Closing a
config path is three steps and only two of them are in this repository: seed the
rows (done), update the k8s manifests (``arca/hope-v2-deployment`` — not ours),
then close the env read. Doing the third before the second is a real outage, not
a tidiness question.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only
    from tts.core.config import Settings

logger = structlog.get_logger(__name__)

#: Suffix that closes a field's env path. Verbose and ticket-named on purpose:
#: an operator grepping for `TTS_SARVAM_MODEL` must land on something that
#: explains where the value went, not on a field that merely looks settable.
MOVED_SUFFIX = "__MOVED_TO_CONTROL_PLANE"


def moved_alias(env_var: str) -> str:
    """The dead ``validation_alias`` for a migrated field.

    Takes the FULL variable name (``TTS_AZURE_REGION``), not the field name:
    ``validation_alias`` bypasses ``env_prefix``, so a name derived from the
    field alone would be both ambiguous across the five provider sub-configs and
    un-greppable from the operator's side.
    """
    return f"{env_var}{MOVED_SUFFIX}"


#: Suffix that closes a field's env path because the value moved onto a DATABASE
#: ROW — the registry model, its provider connection, or the agent — rather than
#: onto the control plane. Distinct from :data:`MOVED_SUFFIX` on purpose: an
#: operator grepping for ``TTS_SARVAM_MODEL`` must land on something that says
#: WHERE the value went, and "the control plane" would send them to a settings
#: key that no longer exists.
MOVED_TO_ROW_SUFFIX = "__MOVED_TO_THE_REGISTRY_ROW"


def moved_to_row_alias(env_var: str) -> str:
    """The dead ``validation_alias`` for a field whose value moved onto a row.

    The field itself SURVIVES: it is the per-request carrier the router fills
    from the resolved spec (``from_spec``). What dies is the environment path, so
    the only way to populate it is the spec — which is what makes the row the
    single authority rather than one of two.
    """
    return f"{env_var}{MOVED_TO_ROW_SUFFIX}"


#Dotted ``Settings`` attribute path → settings-registry key.
#:
#: The path is dotted because tts nests its provider config; ``azure.region``
#: means ``settings.azure.region``. Asserted against the real model by
#: ``tests/unit/test_task799_control_plane.py``.
CONTROL_PLANE_KEYS: dict[str, str] = {
    # ── engine placement (a property of the POD, not of the model row) ───────
    "indic_parler.device": "tts.indicParler.device",
    "indic_f5.device": "tts.indicF5.device",
    # ── service-wide request ceiling and boot strategy ───────────────────────
    "max_input_chars": "tts.limits.maxInputChars",
    "warmup_enabled": "tts.warmupEnabled",
    "model_cache_ttl_seconds": "tts.modelCache.ttlSeconds",
}

_PATH_BY_KEY: dict[str, str] = {key: path for path, key in CONTROL_PLANE_KEYS.items()}

#: Keys whose ENVIRONMENT path is still open, so an unresolved control-plane
#: value must not overwrite what the environment supplied.
#:
#: EMPTY since TASK-879, and empty is the finished state rather than an omission.
#: It held the five ``tts.*.enabled`` flags, whose env path could not be closed
#: from this repository: the k8s ConfigMaps that set ``TTS_KOKORO_ENABLED`` live
#: in ``arca/hope-v2-deployment``, and closing the read while a manifest still
#: supplied the value would have left ``hope-tts`` answering 503 forever with no
#: Service endpoints — the outage ``test_keyless_readiness_task642`` exists for.
#:
#: TASK-879 dissolved that coupling instead of sequencing it. "May this engine
#: serve" is an ``AiProviderConnection`` row's three-state ``enabled``, resolved
#: per request into the pushed spec's ``connection`` block, so there is no key,
#: no environment variable and no manifest to wait for. A stale
#: ``TTS_KOKORO_ENABLED`` in a ConfigMap is now simply ignored.
#:
#: Keep the mechanism: a future half-migrated key belongs here, and must leave in
#: the SAME change that closes its env path with :func:`moved_alias`.
ENV_BOOTSTRAP_KEYS: frozenset[str] = frozenset()


def _resolve(settings: Settings, path: str) -> tuple[Any, str] | None:
    """(owner, attribute) for a dotted path, or None when it does not exist."""
    owner: Any = settings
    parts = path.split(".")
    for part in parts[:-1]:
        owner = getattr(owner, part, None)
        if owner is None:
            return None
    return (owner, parts[-1]) if hasattr(owner, parts[-1]) else None


def bootstrap_defaults(settings: Settings) -> dict[str, Any]:
    """Each migrated field's CURRENT value on a freshly constructed `Settings`.

    Exposed so a test can compare the two sides without retyping thirty
    literals — the step that would drift.
    """
    out: dict[str, Any] = {}
    for path in CONTROL_PLANE_KEYS:
        resolved = _resolve(settings, path)
        if resolved is not None:
            owner, attr = resolved
            out[path] = getattr(owner, attr)
    return out


def _acceptable(current: Any, served: Any) -> bool:
    """Is ``served`` usable in place of ``current``?

    Typed against the value ALREADY in the field rather than against an
    annotation: the bootstrap default is the authority on the shape the field
    holds, and matching against it needs no second copy of the type map.

    ``bool`` is excluded from the numeric branch deliberately — it is an ``int``
    subclass, so ``True`` would otherwise become the integer 1.
    """
    if served is None:
        return False
    if isinstance(current, bool):
        return isinstance(served, bool)
    if isinstance(current, (int, float)):
        return isinstance(served, (int, float)) and not isinstance(served, bool)
    if isinstance(current, str):
        return isinstance(served, str)
    return False


def apply_control_plane(settings: Settings, payload: Any) -> list[str]:
    """Overlay one effective-config payload onto ``settings``. Returns the paths set.

    ``payload`` is the raw body of ``GET /internal/effective-config?service=tts``.
    Only its generic ``settings`` map is read; the frozen ``retention`` view over
    the same resolved keys is still consumed by
    :func:`tts.core.effective_config.refresh_model_cache_retention`, which owns
    applying a new TTL to the ALREADY-CONSTRUCTED provider caches (a resident
    pipeline adopts it without being dropped).

    NEVER raises. A malformed payload, a missing block or an unknown key each
    contribute nothing: a synthesis request must not fail because the config
    plane is unavailable.
    """
    if not isinstance(payload, dict):
        return []
    block = payload.get("settings")
    if not isinstance(block, dict):
        return []

    applied: list[str] = []
    for key, entry in block.items():
        path = _PATH_BY_KEY.get(key)
        if path is None or not isinstance(entry, dict):
            continue
        resolved = _resolve(settings, path)
        if resolved is None:
            continue

        owner, attr = resolved
        current = getattr(owner, attr)
        served = entry.get("value")

        # A key whose env path is still open only yields to a real DATABASE
        # opinion; `env-fallback` there is the gateway reporting that no row
        # answered, and the environment is the live authority. See
        # `ENV_BOOTSTRAP_KEYS`.
        if key in ENV_BOOTSTRAP_KEYS and entry.get("source") != "db":
            logger.debug(
                "tts.control_plane.env_bootstrap_retained",
                key=key,
                path=path,
                source=entry.get("source"),
            )
            continue

        if not _acceptable(current, served):
            if served is not None:
                logger.warning(
                    "tts.control_plane.value_refused",
                    key=key,
                    path=path,
                    served_type=type(served).__name__,
                    current_type=type(current).__name__,
                )
            continue

        if served == current:
            continue

        setattr(owner, attr, served)
        applied.append(path)
        logger.info("tts.control_plane.applied", key=key, path=path, source=entry.get("source"))

    return applied
