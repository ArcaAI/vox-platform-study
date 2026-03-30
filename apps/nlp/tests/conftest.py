from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import nlp.lifespan  # noqa: F401 — ensure module is importable before patching


class FakeService:
    """Lightweight stand-in for ML services that avoids model downloads."""

    is_initialized = True

    async def initialize(self):
        pass

    async def shutdown(self):
        pass


@pytest.fixture()
def mock_services():
    fake = FakeService()
    patches = [
        patch("nlp.dependencies.get_text_classifier", return_value=fake),
        patch("nlp.dependencies.get_token_classifier", return_value=fake),
        patch("nlp.dependencies.get_text_corrector", return_value=fake),
        patch("nlp.dependencies.get_medical_suggester", return_value=fake),
        patch("nlp.dependencies.get_websocket_manager", return_value=fake),
        patch("nlp.lifespan.get_text_classifier", return_value=fake),
        patch("nlp.lifespan.get_token_classifier", return_value=fake),
        patch("nlp.lifespan.get_text_corrector", return_value=fake),
        patch("nlp.lifespan.get_medical_suggester", return_value=fake),
        patch("nlp.lifespan.get_websocket_manager", return_value=fake),
        patch("nlp.core.observability.setup_opentelemetry"),
        patch("nlp.core.observability.setup_prometheus"),
        patch("nlp.core.observability.shutdown_opentelemetry"),
    ]
    for p in patches:
        p.start()
    yield fake
    for p in patches:
        p.stop()


@pytest.fixture()
def client(mock_services):
    from nlp.app import get_app

    app = get_app()
    with TestClient(app) as c:
        yield c
