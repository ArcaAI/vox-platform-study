"""Logging for Guardrail V2 — thin re-export shim onto ``hope_obs`` (TASK-987 R-3).

Superseded by ``hope_obs.logging``: the real structlog + stdlib bridge, JSON
renderer, idempotence guard and OTel trace-id stamping all live there now
(``packages/py-obs/src/hope_obs/logging.py``). This module is kept, unchanged
in its public names, for two reasons rather than rewritten in place at every
call site:

* ``get_logger`` is imported from ``guardrail.core.logging`` in 15+ modules
  across this service — rewriting every one of them would balloon this
  ticket's diff for no behavioural gain.
* ``setup_logging`` is still called directly by ``scripts/loadtest.py``, a
  standalone dev script that never goes through ``guardrail.main.create_app``
  (and therefore never through ``hope_obs.configure_observability`` either).

This is a one-release migration aid — see
``docs/operations/deprecation-register.md`` (registered by the TASK-987
orchestrator, not this lane).
"""

from __future__ import annotations

from hope_obs import ObservabilityConfig, configure_logging, get_logger

__all__ = ["get_logger", "setup_logging"]


def setup_logging(log_level: str) -> None:
    """Configure the shared JSON logging chain at the given level.

    A minimal ``ObservabilityConfig`` is enough here: this call site (a
    standalone script, not the FastAPI app) has no OTLP endpoint, request
    context or tenant to plumb through — only a level.
    """
    configure_logging(ObservabilityConfig(service_name="guardrail", log_level=log_level))
