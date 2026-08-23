from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

import nlp.lifespan  # noqa: F401 — ensure module is importable before patching


class FakeService:
    """Lightweight stand-in for ML services that avoids model downloads."""

    is_initialized = True

    async def initialize(self) -> None:
        pass

    async def shutdown(self) -> None:
        pass


# Singleton slots in nlp.dependencies backing the get_* getters. Preset (not
# just patched) so code holding a direct reference to the ORIGINAL getters —
# router Depends defaults bound at import, monitoring's check table — also
# resolves to the fake, independent of module import order.
#
# The classifier singletons are GONE (TASK-799 C.2): every model is resolved per
# request from a caller-supplied selection through the model cache, so there is
# no process-wide instance left to preset. Only the two weightless singletons
# remain.
_DEP_SLOTS = (
    "_text_corrector_instance",
    "_websocket_manager_instance",
)


@pytest.fixture()
def mock_services():
    import nlp.dependencies as deps

    fake = FakeService()
    saved = {name: deps.__dict__.get(name) for name in _DEP_SLOTS}
    for name in _DEP_SLOTS:
        deps.__dict__[name] = fake
    patches = [
        patch("nlp.dependencies.get_text_corrector", return_value=fake),
        patch("nlp.dependencies.get_websocket_manager", return_value=fake),
        # lifespan no longer eager-loads the ML models; it only
        # initializes the (weightless) websocket manager.
        patch("nlp.lifespan.get_websocket_manager", return_value=fake),
        patch("nlp.core.observability.setup_opentelemetry"),
        patch("nlp.core.observability.setup_prometheus"),
        patch("nlp.app.setup_prometheus"),
        patch("nlp.core.observability.shutdown_opentelemetry"),
    ]
    for p in patches:
        p.start()
    yield fake
    for p in patches:
        p.stop()
    for name, value in saved.items():
        deps.__dict__[name] = value


@pytest.fixture()
def client(mock_services, monkeypatch):
    """A hermetic client with service auth OFF.

    These suites call protected routes WITHOUT an `X-Service-Token` header — they are about
    handler behaviour, not auth. `Settings.accepted_service_tokens` admits either the canonical
    shared `internal_access_token` or the legacy per-service `service_token`, both read from the
    environment, so any token present in the loaded `.env.test` turned every such call into a
    401 before the handler ran. Clearing BOTH restores the documented "empty everywhere = auth
    disabled" dev path. `test_auth_middleware.py` re-pins them per-test, so its cases are
    unaffected.
    """
    from nlp.core.config import settings as nlp_settings

    monkeypatch.setattr(nlp_settings.service, "service_token", SecretStr(""), raising=False)
    monkeypatch.setattr(nlp_settings.service, "internal_access_token", SecretStr(""), raising=False)

    from nlp.app import get_app

    app = get_app()
    with TestClient(app) as c:
        yield c
