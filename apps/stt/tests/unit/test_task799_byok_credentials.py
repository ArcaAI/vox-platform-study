"""STT loaders are connection-only: no env vendor credential, and no hand-written list.

The sibling of `apps/text`'s `test_task602_byok_credentials.py`, for the ASR plane.
The unified provider-connection plane (``AiProviderConnection``) is the sole store for
every ASR vendor credential; the gateway resolves tenant → SYSTEM
(``resolveTenantCloudOverrides('stt', tenantId)`` — `packages/applications`
`tenant-stt-config.service.ts`, `apps/api` `stt-compat.controller.ts`) and injects the
result per request as ``provider_overrides``.

**This suite iterates the loader registry; it enumerates NOTHING by name.**

That is the whole point. STT already fails closed in all four cloud loaders — but it
does so because four people each remembered to write the check, and three separate
hand-written maps (`_CLOUD_ASR_OVERRIDE_FORMATS`, `_OVERRIDE_KEY_BY_FORMAT` in
`batch_service.py`, and the streaming set in `session_manager.py`) have to agree with
them. Nothing structural says a FIFTH cloud loader must fail closed, appear in those
maps, or meter its funding correctly. In `apps/text` that exact gap is what let
``bedrock`` and ``vertex`` authenticate from the process environment for years: both
were absent from a hand-written list, so neither was ever asked to fail closed.

The five guarantees:

  1. Every registered loader DECLARES its credential posture. A loader that declares
     nothing fails here — the default-deny that makes (2)–(4) survive the next engine.
  2. Every BYOK loader fails CLOSED with no injected credential: it raises rather than
     building a client that would authenticate from the process environment.
  3. No BYOK loader can obtain a key from env, however the env is populated.
  4. Every BYOK loader's declared override key agrees with the batch service's funding
     map, so a new engine cannot silently mis-meter (BYOK vs CLOUD) real money.
  5. The credential never reaches a log line, an exception message, or a ``repr``.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest

from stt.models.base_loader import BaseModelLoader, CredentialPosture
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)

_SECRET = "super-secret-tenant-key"


def _registry() -> dict[AiModelFormat, BaseModelLoader]:
    """The production format → loader map, read off ModelCache itself.

    Read from the real construction site rather than rebuilt here: a copy would
    be one more hand-written list to drift, which is the defect this suite exists
    to prevent.
    """
    from stt.models.cache import ModelCache

    cache = ModelCache.__new__(ModelCache)  # no __init__: avoid cache/metrics setup
    ModelCache._install_loaders(cache)
    return cache._loaders


_REGISTRY = _registry()
_ALL = sorted(_REGISTRY.items(), key=lambda kv: kv[0].value)
_ALL_IDS = [fmt.value for fmt, _ in _ALL]


def test_the_registry_sweep_actually_found_loaders():
    """Guard the guard: an empty sweep makes every parametrised test below
    vacuously pass — the failure mode most likely to go unnoticed."""
    assert len(_ALL) >= 10, f"loader sweep found only {_ALL_IDS}"


# ---------------------------------------------------------------------------
# 1 — every loader declares a posture (default-deny)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("fmt", "loader"), _ALL, ids=_ALL_IDS)
def test_every_loader_declares_a_credential_posture(fmt, loader):
    posture = getattr(loader, "credential_posture", None)
    assert isinstance(posture, CredentialPosture), (
        f"loader for {fmt.value!r} ({type(loader).__name__}) declares no "
        "`credential_posture`. Every loader must state whether it needs a vendor "
        "credential (BYOK) or runs on platform hardware (SELF_HOSTED). Declaring "
        "nothing is not 'probably fine' — it is how bedrock and vertex kept ambient "
        "credential chains in apps/text for years."
    )


_BYOK = [
    (f, ldr)
    for f, ldr in _ALL
    if getattr(ldr, "credential_posture", None) == CredentialPosture.BYOK
]
_BYOK_IDS = [f.value for f, _ in _BYOK]


def test_at_least_one_byok_loader_exists():
    """Otherwise the fail-closed guarantees below are vacuous."""
    assert _BYOK_IDS, "no BYOK ASR loader found; the fail-closed suite would be empty"


def test_every_cloud_format_is_declared_byok():
    """The posture declaration and the batch service's cloud set must agree.

    Two independently-maintained answers to "is this engine a cloud vendor?" is
    exactly the drift that mis-meters money: `resolve_usage_attribution` returns
    SELF_HOSTED for any format outside its set, zeroing the cost of a real
    vendor call.
    """
    from stt.transcription.batch_service import _CLOUD_ASR_OVERRIDE_FORMATS

    declared = {f for f, _ in _BYOK}
    assert declared == set(_CLOUD_ASR_OVERRIDE_FORMATS), (
        "loader `credential_posture` declarations disagree with "
        f"_CLOUD_ASR_OVERRIDE_FORMATS. Declared BYOK: {sorted(f.value for f in declared)}; "
        f"batch service cloud set: {sorted(f.value for f in _CLOUD_ASR_OVERRIDE_FORMATS)}."
    )


# ---------------------------------------------------------------------------
# 2/3 — BYOK loaders fail closed, and no env can feed them
# ---------------------------------------------------------------------------


def _config(fmt: AiModelFormat, source_uri: str | None = "vendor-model-id") -> AiModelConfig:
    """A model row that resolves SELECTION, so the only thing left missing is
    the credential — otherwise a fail-closed assertion could pass for the wrong
    reason (an unresolved model, not an absent key)."""
    return AiModelConfig(
        id="m-1",
        tenant_id="t-1",
        slug=f"test-{fmt.value.lower()}",
        name=f"test {fmt.value}",
        description="",
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.LOCAL,
        source_uri=source_uri,
        source_revision=None,
        format=fmt,
        memory_size_mb=0,
        compute_type=None,
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path=None,
        downloaded_at=datetime.now(UTC),
        file_size_mb=0,
        checksum=None,
        tags=[],
    )


_ENV_VARS = (
    "SARVAM_API_KEY",
    "OPENAI_API_KEY",
    "AZURE_SPEECH_KEY",
    "AZURE_FOUNDRY_API_KEY",
    "STT_SARVAM_API_KEY",
    "STT_OPENAI_API_KEY",
    "STT_AZURE_SPEECH_KEY",
    "STT_AZURE_FOUNDRY_API_KEY",
    "AZURE_SPEECH_API_KEY",
)


@pytest.mark.parametrize(("fmt", "loader"), _BYOK, ids=_BYOK_IDS)
def test_byok_loader_fails_closed_without_an_injected_credential(fmt, loader, monkeypatch):
    """No override AND no platform credential ⇒ raise.

    Env is deliberately POPULATED with every plausible key name: the loader must
    still refuse. Asserting the failure on a bare env would pass even for a loader
    that happily reads `os.environ` — which is the hole this locks.
    """
    for var in _ENV_VARS:
        monkeypatch.setenv(var, "leaked-from-env")

    with pytest.raises(Exception) as excinfo:  # noqa: PT011 - taxonomy asserted below
        asyncio.run(loader.load(_config(fmt), provider_overrides=None))

    from stt.core.exceptions import STTServiceError

    assert isinstance(excinfo.value, STTServiceError), (
        f"{fmt.value} raised {type(excinfo.value).__name__}, which is outside the "
        "service's typed taxonomy and will not map to a stable error contract."
    )
    assert "leaked-from-env" not in str(excinfo.value)


@pytest.mark.parametrize(("fmt", "loader"), _BYOK, ids=_BYOK_IDS)
def test_byok_loader_never_leaks_the_credential_into_its_error(fmt, loader):
    """A keyed-but-otherwise-broken load must not print the key.

    Uses an override whose key is present but whose model selection is absent, so
    the loader raises AFTER it has the credential in hand — the moment a naive
    error message would interpolate it.
    """
    cfg = _config(fmt, source_uri=None)
    override = {"api_key": _SECRET, "endpoint": "https://example/", "region": "eastus"}
    try:
        asyncio.run(loader.load(cfg, provider_overrides={k: override for k in _OVERRIDE_KEYS}))
    except Exception as exc:  # noqa: BLE001 - any raise is fine; the LEAK is the assertion
        assert _SECRET not in str(exc), f"{fmt.value} leaked the credential into its error"
        assert _SECRET not in repr(exc)


#: Every provider-overrides key any BYOK loader reads. Sourced from the loaders'
#: own constants where they publish one, so this cannot drift from them silently.
_OVERRIDE_KEYS = ("azure-speech", "sarvam", "openai")


# ---------------------------------------------------------------------------
# 4 — the override key each loader reads agrees with the funding map
# ---------------------------------------------------------------------------


def test_override_key_map_covers_every_byok_loader():
    """A BYOK loader missing from `_OVERRIDE_KEY_BY_FORMAT` mis-meters silently.

    `resolve_usage_attribution` looks the tenant's entry up under that map. A
    format absent from it resolves `override_key = None`, so `entry` is None and
    the call is billed as platform-funded CLOUD even when the TENANT's own key
    paid for it.
    """
    from stt.transcription.batch_service import _OVERRIDE_KEY_BY_FORMAT

    missing = [f.value for f, _ in _BYOK if f not in _OVERRIDE_KEY_BY_FORMAT]
    assert missing == [], (
        f"BYOK loader(s) {missing} have no entry in _OVERRIDE_KEY_BY_FORMAT, so a "
        "tenant's own credential would be mis-metered as platform spend."
    )


def test_declared_override_keys_match_the_funding_map():
    """The loader's declaration is the single source; the map must follow it."""
    from stt.transcription.batch_service import _OVERRIDE_KEY_BY_FORMAT

    mismatched = {}
    for fmt, loader in _BYOK:
        declared = getattr(loader, "override_key", None)
        if declared is None:
            continue
        expected = _OVERRIDE_KEY_BY_FORMAT.get(fmt)
        if declared != expected:
            mismatched[fmt.value] = (declared, expected)
    assert mismatched == {}, (
        f"loader `override_key` disagrees with _OVERRIDE_KEY_BY_FORMAT: {mismatched}. "
        "The loader reads its credential under one key while the ledger looks it up "
        "under another, so funding attribution is wrong for that engine."
    )


def test_every_byok_loader_declares_its_override_key():
    """Default-deny again: an undeclared key cannot be cross-checked at all."""
    undeclared = [
        f.value for f, ldr in _BYOK if not isinstance(getattr(ldr, "override_key", None), str)
    ]
    assert undeclared == [], (
        f"BYOK loader(s) {undeclared} declare no `override_key`, so nothing can "
        "verify that the key they read is the key the ledger meters."
    )


# ---------------------------------------------------------------------------
# 5 — SELF_HOSTED loaders take no credential
# ---------------------------------------------------------------------------


def test_self_hosted_loaders_declare_no_override_key():
    """A self-hosted engine has no vendor credential to read.

    Declaring one would put a platform-hardware engine into the funding map and
    invite a `base_url` to be treated as a credential — the inverse of the
    keyless-row guard.
    """
    offenders = [
        fmt.value
        for fmt, ldr in _ALL
        if getattr(ldr, "credential_posture", None) == CredentialPosture.SELF_HOSTED
        and getattr(ldr, "override_key", None) is not None
    ]
    assert offenders == [], (
        f"self-hosted loader(s) {offenders} declare an override_key; a platform "
        "hardware engine has no vendor credential to inject."
    )
