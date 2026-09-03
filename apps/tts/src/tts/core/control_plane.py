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


#Dotted ``Settings`` attribute path → settings-registry key.
#:
#: The path is dotted because tts nests its provider config; ``azure.region``
#: means ``settings.azure.region``. Asserted against the real model by
#: ``tests/unit/test_task799_control_plane.py``.
CONTROL_PLANE_KEYS: dict[str, str] = {
    # ── Azure Speech (managed cloud; BYOK key excluded by design) ────────────
    "azure.region": "tts.azure.region",
    "azure.timeout_s": "tts.azure.timeoutS",
    "azure.max_concurrent": "tts.azure.maxConcurrent",
    # ── Sarvam (cloud; BYOK key excluded by design) ──────────────────────────
    "sarvam.base_url": "tts.sarvam.baseUrl",
    "sarvam.model": "tts.sarvam.model",
    "sarvam.sample_rate": "tts.sarvam.sampleRate",
    "sarvam.timeout_s": "tts.sarvam.timeoutS",
    "sarvam.max_concurrent": "tts.sarvam.maxConcurrent",
    "sarvam.use_streaming": "tts.sarvam.useStreaming",
    # ── Kokoro (self-hosted, English) ────────────────────────────────────────
    "kokoro.device": "tts.kokoro.device",
    # ── Indic Parler (self-hosted, Malayalam) ────────────────────────────────
    "indic_parler.hf_model": "tts.indicParler.hfModel",
    "indic_parler.device": "tts.indicParler.device",
    "indic_parler.model_path": "tts.indicParler.modelPath",
    "indic_parler.desc_encoder_path": "tts.indicParler.descEncoderPath",
    # ── IndicF5 (self-hosted voice-clone; licensing-gated) ───────────────────
    "indic_f5.hf_model": "tts.indicF5.hfModel",
    "indic_f5.model_path": "tts.indicF5.modelPath",
    "indic_f5.device": "tts.indicF5.device",
    "indic_f5.ref_audio_path": "tts.indicF5.refAudioPath",
    "indic_f5.ref_text": "tts.indicF5.refText",
    # ── service-wide synthesis limits ────────────────────────────────────────
    "max_input_chars": "tts.limits.maxInputChars",
    "default_format": "tts.limits.defaultFormat",
    "sample_rate": "tts.limits.sampleRate",
    "warmup_enabled": "tts.warmupEnabled",
    # ── provider/engine enable flags ───────────────────────
    # HALF-MIGRATED ON PURPOSE, and the halves are named in `ENV_BOOTSTRAP_KEYS`
    # below: the control plane now SERVES these, but `TTS_*_ENABLED` is still a
    # live bootstrap fallback because the k8s manifests that set them live in a
    # SEPARATE repository (`arca/hope-v2-deployment`) and cannot be updated from
    # here. Closing the env path before those manifests stop supplying the value
    # reproduces the outage `test_keyless_readiness_task642` exists to pin.
    #
    # Note the two spellings that do NOT match their `global-kv` siblings
    # (`tts.parler.enabled` beside `tts.indicParler.*`; `tts.indicf5.enabled`
    # beside `tts.indicF5.*`). They are kept AS THEY WERE REGISTERED: the key is
    # the row's primary coordinate in `GlobalSetting`, so renaming one now would
    # orphan the seeded row rather than tidy anything.
    "azure.enabled": "tts.azure.enabled",
    "sarvam.enabled": "tts.sarvam.enabled",
    "kokoro.enabled": "tts.kokoro.enabled",
    "indic_parler.enabled": "tts.parler.enabled",
    "indic_f5.enabled": "tts.indicf5.enabled",
    # Already registered by `service-runtime.descriptors.ts` and already applied
    # at runtime through `refresh_model_cache_retention`. What changes here is
    # only that its env path closes: it was documented as a "BOOTSTRAP FALLBACK
    # ONLY" while remaining fully settable from `TTS_MODEL_CACHE_TTL_SECONDS`,
    # so an operator could set a value the next config pull silently replaced.
    "model_cache_ttl_seconds": "tts.modelCache.ttlSeconds",
}

_PATH_BY_KEY: dict[str, str] = {key: path for path, key in CONTROL_PLANE_KEYS.items()}

#: Keys whose ENVIRONMENT path is still open, so an unresolved control-plane
# value must not overwrite what the environment supplied.
#:
#: The gateway answers every declared key, even when no ``GlobalSetting`` row
#: exists — in that case it resolves ``descriptor.default`` and labels the entry
#: ``source: "env-fallback"``. For the ~24 knobs above that is exactly right:
#: their env path is DEAD (:func:`moved_alias`), the descriptor default is
#: transcribed verbatim from the Python field, and applying it is a no-op that
#: keeps one authority.
#:
#: For the five flags it is wrong, and dangerously so. ``env-fallback`` there
#: means "no row answered" — an ABSENCE of platform opinion — while the live
#: value sits in the container's environment. Applying the descriptor default
#: (``False``) over an operator's ``TTS_KOKORO_ENABLED=true`` would unregister
#: the only engine a keyless deployment has, and ``hope-tts`` would answer 503
#: forever with no Service endpoints. That is the exact regression
#: ``test_keyless_readiness_task642`` was written for.
#:
#: So the rule is narrow and stated once: for a key in this set, only a value
#: that a DATABASE ROW supplied (``source == "db"``) may override the
#: environment. Remove a key from this set in the SAME change that closes its
#: env path with :func:`moved_alias` — never before, never after.
ENV_BOOTSTRAP_KEYS: frozenset[str] = frozenset(
    {
        "tts.azure.enabled",
        "tts.sarvam.enabled",
        "tts.kokoro.enabled",
        "tts.parler.enabled",
        "tts.indicf5.enabled",
    }
)


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
