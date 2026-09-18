"""DEPRECATED — thin re-export shim over ``hope_obs`` (TASK-987).

Harness's hand-rolled structlog chain (JSON output, ``_add_otel_context``,
uvicorn taming) is now ``hope_obs.logging`` — one implementation shared by all
six Python services instead of six hand-rolled copies (TASK-987 R-3). This
module is kept for ONE release only because ``from harness.core.logging
import get_logger`` is the import path used across the rest of this service
(``api/endpoints/*``, ``temporal/*``, ``tools/*``, ``sensors/*``,
``guides/*``, ``services/*``); rewriting every call site in the same change
that adopts ``hope_obs`` would balloon the diff for no behavioural gain.

New code should import ``hope_obs`` directly:

    from hope_obs import get_logger

``setup_logging`` is gone — logging is now configured once, in
``harness.main.create_app`` / ``harness.temporal.worker.run_worker``, via
``hope_obs.configure_observability`` / ``configure_worker_observability``.
Register this shim's removal in ``docs/operations/deprecation-register.md``.
"""

from __future__ import annotations

from hope_obs import get_logger

__all__ = ["get_logger"]
