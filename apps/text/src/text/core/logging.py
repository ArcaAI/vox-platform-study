"""Compatibility shim — logging now lives in ``hope_obs`` (TASK-987).

Text used to own its own structlog chain, uvicorn taming and OTel trace-context
injection (``_add_otel_context`` / ``_configure_uvicorn_logging`` /
``setup_logging``). All of that moved to ``hope_obs.logging`` — one chain for
every HOPE Python service — and is now wired in ``text.main.create_app`` via
``hope_obs.configure_observability``.

``get_logger`` is re-exported here because roughly a dozen call sites across
``api/``, ``routing/`` and ``services/`` still import it from
``text.core.logging``; repointing every one of them at ``hope_obs`` directly is
a separate, purely mechanical cleanup with no behavioural difference, so it is
deferred rather than bundled into this diff.
"""

from __future__ import annotations

from hope_obs import get_logger

__all__ = ["get_logger"]
