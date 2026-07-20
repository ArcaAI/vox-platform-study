"""a freshly booted NLP process holds ZERO ML weights.

The lifespan must not eager-load the text/token classifiers, spelling corrector
or medical suggester; only the (weightless) websocket manager is initialized.
Every ML model loads lazily on first request through the idle-TTL cache.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import nlp.dependencies as deps
from nlp.app import get_app

_MODEL_SLOTS = (
    "_text_classifier_instance",
    "_token_classifier_instance",
    "_text_corrector_instance",
    "_medical_suggester_instance",
    "_token_classifier_cache_instance",
    "_text_classifier_cache_instance",
    "_medical_suggester_cache_instance",
)


async def test_lifespan_loads_no_ml_models() -> None:
    saved = {name: deps.__dict__.get(name) for name in _MODEL_SLOTS}
    saved_ws = deps.__dict__.get("_websocket_manager_instance")
    for name in _MODEL_SLOTS:
        deps.__dict__[name] = None
    deps.__dict__["_websocket_manager_instance"] = None

    fake_ws = AsyncMock()

    try:
        with (
            patch("nlp.lifespan.get_websocket_manager", return_value=fake_ws),
            patch("nlp.core.observability.setup_opentelemetry"),
            patch("nlp.core.observability.setup_prometheus"),
            patch("nlp.core.observability.shutdown_opentelemetry"),
        ):
            app = get_app()
            async with app.router.lifespan_context(app):
                # Only the websocket manager was initialized …
                fake_ws.initialize.assert_awaited_once()
                # … and no ML model instance or per-model cache was created.
                for name in _MODEL_SLOTS:
                    assert deps.__dict__.get(name) is None, f"{name} was eagerly created"

        fake_ws.shutdown.assert_awaited_once()
    finally:
        for name, value in saved.items():
            deps.__dict__[name] = value
        deps.__dict__["_websocket_manager_instance"] = saved_ws
