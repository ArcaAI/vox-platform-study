from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

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
_DEP_SLOTS = (
    "_text_classifier_instance",
    "_token_classifier_instance",
    "_text_corrector_instance",
    "_medical_suggester_instance",
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
        patch("nlp.dependencies.get_text_classifier", return_value=fake),
        patch("nlp.dependencies.get_token_classifier", return_value=fake),
        patch("nlp.dependencies.get_text_corrector", return_value=fake),
        patch("nlp.dependencies.get_medical_suggester", return_value=fake),
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
def client(mock_services):
    from nlp.app import get_app

    app = get_app()
    with TestClient(app) as c:
        yield c
