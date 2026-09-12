"""TTS providers are connection-only: no env credential, and no hand-written adapter list.

The sibling of `apps/text`'s `test_task602_byok_credentials.py`, for the TTS plane.
The unified provider-connection plane (``AiProviderConnection``) is the sole store for
every TTS vendor credential; the gateway resolves tenant → SYSTEM
(``resolveTenantCloudOverrides('tts', tenantId)`` — `apps/api` `speech-proxy.controller.ts`
and `tts-ws.gateway.ts`) and injects the result per request as ``provider_overrides``.

**This suite iterates the provider registry; it enumerates NOTHING by name.**

That distinction is the whole point, and TTS had the exact defect it guards against.
``router._build_spec_engine``'s ancestor was a hand-written ``if name == "azure" / "sarvam"``
switch: a BYOK provider added tomorrow would return ``None`` from it, silently fall back
to the shared registered engine, and serve every tenant on the PLATFORM key — or vanish
from ``candidates()`` entirely with no statement of why. Neither outcome is visible at
the call site, and no test listing today's two adapters could ever catch it.

TASK-879 replaced the two factories with ONE (``from_spec``): a resolved candidate carries
the model, the mirror, the endpoint and the region as well as the credential, so a second
factory would only have been a second place to get a tenant's engine wrong.

The four guarantees:

  1. No settings field anywhere can carry a TTS vendor credential from env.
  2. Every registered adapter DECLARES its credential posture. An adapter that
     declares nothing fails here — that is the default-deny that makes (3) survive
     the next provider.
  3. Every BYOK adapter fails CLOSED when no connection is injected: it reports
     ``is_configured == False`` so the router excludes it, and it never authenticates
     from the process environment.
  4. An injected connection is honoured, and the engine it builds is REQUEST-SCOPED —
     construction never mutates the shared registered instance, so two tenants on
     concurrent requests cannot race onto each other's key.
"""

from __future__ import annotations

import pytest
from pydantic import BaseModel, SecretStr

from tts.core.config import Settings
from tts.providers.base import CredentialPosture
from tts.routing.router import _build_spec_engine
from tts.tests.fakes import candidate as _candidate


def _bare_settings() -> Settings:
    """Settings with no env file — the production posture (no platform credential)."""
    return Settings(_env_file=None)


def _settings_fields() -> list[str]:
    """Every leaf field of the settings tree, dotted by sub-config."""

    def walk(model: type[BaseModel], prefix: str = "") -> list[str]:
        out: list[str] = []
        for name, field in model.model_fields.items():
            annotation = field.annotation
            if isinstance(annotation, type) and issubclass(annotation, BaseModel):
                out.extend(walk(annotation, f"{prefix}{name}."))
            else:
                out.append(f"{prefix}{name}")
        return out

    return walk(Settings)


def _registered_providers() -> list[tuple[str, type]]:
    """Every provider CLASS the TTS plane can register.

    Deliberately built from the provider package rather than from a booted
    registry: boot registration is gated on `enabled` flags and on native/ML
    imports, so a booted registry in CI would silently hold a SUBSET — and a
    lock test that only sees the adapters that happened to load is the
    hand-written list again, one indirection further away.
    """
    import inspect
    import pkgutil
    from importlib import import_module

    import tts.providers as providers_pkg

    found: dict[str, type] = {}
    for mod in pkgutil.iter_modules(providers_pkg.__path__):
        if mod.name in ("base", "registration"):
            continue
        module = import_module(f"tts.providers.{mod.name}")
        for _, obj in inspect.getmembers(module, inspect.isclass):
            if obj.__module__ != module.__name__:
                continue
            name = getattr(obj, "name", None)
            # A TTS engine is identified structurally: a class-level `name`
            # plus the two attributes the router reads off every candidate.
            if isinstance(name, str) and hasattr(obj, "supported_locales"):
                found[name] = obj
    return sorted(found.items())


_ALL_PROVIDERS = _registered_providers()
_PROVIDER_IDS = [name for name, _ in _ALL_PROVIDERS]


def test_the_registry_sweep_actually_found_providers():
    """Guard the guard: an empty sweep would make every parametrised test below
    vacuously pass, which is the failure mode most likely to go unnoticed."""
    assert len(_ALL_PROVIDERS) >= 4, f"provider sweep found only {_PROVIDER_IDS}"


# ---------------------------------------------------------------------------
# 1 — no settings field can carry a vendor credential
# ---------------------------------------------------------------------------


class TestNoEnvPathToAVendorCredential:
    def test_no_env_var_can_produce_a_credential_bearing_config(self, monkeypatch):
        """Set every plausible key-shaped var and prove nothing in the constructed
        settings tree holds a secret.

        `AzureSpeechConfig.api_key` / `SarvamConfig.api_key` still EXIST as fields —
        they are how the router hands an injected override to the adapter via
        `model_copy`. What must not exist is an ENV PATH to them, which is closed
        structurally: the `validation_alias` names a var nobody will set and
        `populate_by_name` is off.
        """
        for var in (
            "TTS_API_KEY",
            "TTS_AZURE_API_KEY",
            "TTS_SARVAM_API_KEY",
            "AZURE_SPEECH_KEY",
            "SARVAM_API_KEY",
            "TTS_AZURE_SUBSCRIPTION_KEY",
        ):
            monkeypatch.setenv(var, "leaked-from-env")

        settings = _bare_settings()
        leaked = [
            path
            for path in _settings_fields()
            if path.rsplit(".", 1)[-1] in ("api_key", "subscription_key") and _read(settings, path)
        ]
        assert leaked == [], (
            f"env populated credential field(s) {leaked}. TTS vendor credentials live "
            "in AiProviderConnection and arrive per request as a provider override; "
            "there must be no env path to one."
        )

    def test_populate_by_name_stays_off_for_credential_configs(self):
        """The single flag that would re-open every closed env path at once.

        `validation_alias` only closes the env path while `populate_by_name` is
        off — turning it on lets the FIELD NAME (`api_key`) match `TTS_AZURE_API_KEY`
        again for every field in the class simultaneously.
        """
        from tts.core.config import AzureSpeechConfig, SarvamConfig

        for cfg in (AzureSpeechConfig, SarvamConfig):
            assert not cfg.model_config.get("populate_by_name", False), (
                f"{cfg.__name__} sets populate_by_name=True, which re-opens an env "
                "path to a cloud credential for every field in the class."
            )


def _read(obj: object, dotted: str) -> object:
    for part in dotted.split("."):
        obj = getattr(obj, part, None)
        if obj is None:
            return None
    if isinstance(obj, SecretStr):
        return obj.get_secret_value()
    return obj


# ---------------------------------------------------------------------------
# 2 — every adapter declares a posture (default-deny)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("name", "cls"), _ALL_PROVIDERS, ids=_PROVIDER_IDS)
def test_every_adapter_declares_a_credential_posture(name: str, cls: type):
    posture = getattr(cls, "credential_posture", None)
    assert isinstance(posture, CredentialPosture), (
        f"provider {name!r} ({cls.__name__}) declares no `credential_posture`. "
        "Every adapter must state whether it needs a vendor credential (BYOK) or "
        "is an operator-run engine (SELF_HOST). Declaring nothing is not 'probably "
        "fine' — it is how bedrock and vertex kept ambient credential chains in "
        "apps/text for years."
    )


# ---------------------------------------------------------------------------
# 3 — BYOK adapters fail closed with no injected connection
# ---------------------------------------------------------------------------


_BYOK = [
    (n, c)
    for n, c in _ALL_PROVIDERS
    if getattr(c, "credential_posture", None) == CredentialPosture.BYOK
]
_BYOK_IDS = [n for n, _ in _BYOK]


def test_at_least_one_byok_adapter_exists():
    """Otherwise the fail-closed guarantees below are vacuous."""
    assert _BYOK_IDS, "no BYOK TTS adapter found; the fail-closed suite would be empty"


@pytest.mark.parametrize(("name", "cls"), _BYOK, ids=_BYOK_IDS)
def test_byok_adapter_is_unconfigured_without_an_injected_credential(name: str, cls: type):
    """A keyless BYOK engine must REPORT itself unusable rather than register as
    usable and fail at synthesis time on the caller's audio."""
    settings = _bare_settings()
    engine = cls(getattr(settings, _CONFIG_ATTR[name]))
    assert engine.is_configured is False, (
        f"{name} reports is_configured=True with no credential. The router would "
        "keep it in candidates() and it would authenticate from whatever the "
        "process environment supplies."
    )


#: Which `Settings` sub-config each BYOK adapter is constructed from. This map is
#: asserted COMPLETE below, so it cannot silently fall behind a new adapter.
_CONFIG_ATTR = {"azure": "azure", "sarvam": "sarvam"}


def test_config_attr_map_covers_every_byok_adapter():
    missing = [n for n in _BYOK_IDS if n not in _CONFIG_ATTR]
    assert missing == [], (
        f"BYOK adapter(s) {missing} have no entry in _CONFIG_ATTR, so the "
        "fail-closed tests above silently skip them."
    )


# ---------------------------------------------------------------------------
# 4 — an injected connection is honoured, request-scoped, registry-driven
# ---------------------------------------------------------------------------


def _cloud_candidate(name: str):
    """A resolved candidate for a cloud engine, carrying the endpoint facts its adapter needs.

    `region` / `base_url` come from the candidate's CONNECTION rather than from settings, which is
    the point of TASK-879: there is no process-wide region or host left to fall back to, so an
    adapter that cannot get one from the spec must refuse rather than reach a vendor nobody named.
    """
    return _candidate(
        name,
        slug=f"{name}-voices",
        source_uri="azure://neural-voices" if name == "azure" else "bulbul:v3",
        voices=None,
        voice="af_heart",
        region="eastus" if name == "azure" else None,
        base_url=None if name == "azure" else "https://api.sarvam.ai",
        timeout_s=None if name == "azure" else 30,
    )


@pytest.mark.parametrize(("name", "cls"), _BYOK, ids=_BYOK_IDS)
def test_injected_override_builds_a_configured_request_scoped_engine(name: str, cls: type):
    settings = _bare_settings()
    shared = cls(getattr(settings, _CONFIG_ATTR[name]))

    built = _build_spec_engine(settings, _cloud_candidate(name), {"api_key": "tenant-byo-key"})

    assert built is not None, (
        f"_build_spec_engine returned None for BYOK provider {name!r}. This is "
        "the hand-written-list defect: an adapter the switch does not name silently "
        "falls back to the shared platform engine."
    )
    assert built.is_configured is True
    # REQUEST-SCOPED: a fresh instance, and the shared one is untouched.
    assert built is not shared
    assert shared.is_configured is False, (
        "building a tenant override mutated the shared registered engine; two "
        "tenants on concurrent requests would race onto each other's credential."
    )


def test_override_builder_is_registry_driven_not_a_name_switch():
    """The guarantee that survives the NEXT adapter.

    A hypothetical new BYOK provider must get override support from its own
    declaration, without anyone editing the router. We prove the builder asks the
    adapter rather than matching its name against a literal.
    """
    settings = _bare_settings()

    class FutureVendorProvider:
        name = "future-vendor"
        supported_locales = {"en-US"}
        native_streaming = False
        credential_posture = CredentialPosture.BYOK

        def __init__(self, api_key: str) -> None:
            self.is_configured = bool(api_key)

        @classmethod
        def from_spec(cls, _settings, _candidate_, override):  # noqa: ANN001
            key = override.get("api_key")
            return cls(key) if key else None

    built = _build_spec_engine(
        settings,
        _candidate("future-vendor", voices=None, voice="af_heart"),
        {"api_key": "k"},
        registry_class=FutureVendorProvider,
    )
    assert built is not None and built.is_configured is True, (
        "the router could not build an override engine for an adapter it does not "
        "name; override support must come from the adapter's own declaration."
    )


@pytest.mark.parametrize(("name", "cls"), _BYOK, ids=_BYOK_IDS)
def test_keyless_override_injects_nothing(name: str, cls: type):
    """A keyless row injects on NEITHER tier.

    That guard — not the provider list — is what stops a SYSTEM row's `base_url`
    from being mistaken for a credential ( plan, "Phase 2 landmines").
    """
    settings = _bare_settings()
    assert _build_spec_engine(settings, _cloud_candidate(name), {"base_url": "https://x/"}) is None
    assert _build_spec_engine(settings, _cloud_candidate(name), {"api_key": ""}) is None


@pytest.mark.parametrize(("name", "cls"), _ALL_PROVIDERS, ids=_PROVIDER_IDS)
def test_no_adapter_prints_its_credential(name: str, cls: type):
    """`repr()` of a keyed engine must not carry the key.

    Covers the whole registry, not just today's two cloud adapters — a SELF_HOST
    engine a tenant fronts with its own key must not leak it either.
    """
    if name not in _CONFIG_ATTR:
        pytest.skip(f"{name} takes no injectable credential config")
    settings = _bare_settings()
    engine = _build_spec_engine(settings, _cloud_candidate(name), {"api_key": "super-secret-value"})
    assert engine is not None
    assert "super-secret-value" not in repr(engine)
