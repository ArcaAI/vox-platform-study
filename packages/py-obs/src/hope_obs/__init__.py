"""``hope_obs`` — the shared logging and tracing runtime for HOPE's Python services.

One implementation of the standard in
``docs/implementation/TASK-987-Python-Logging-And-Tracing-Standard/README.md``
§3, so that six services stop carrying six of them.

A FastAPI service::

    from hope_obs import ObservabilityConfig, configure_observability, shutdown_observability

    config = ObservabilityConfig.from_env("stt", service_version=build_info.version)

    def create_app() -> FastAPI:
        app = FastAPI(lifespan=lifespan)
        configure_observability(app, config)   # logging + request context + tracing
        return app

    # in the lifespan teardown:
    shutdown_observability(app)

A worker (no FastAPI in the process)::

    from hope_obs import ObservabilityConfig, configure_worker_observability

    handle = configure_worker_observability(ObservabilityConfig.from_env("stt"))
    ...
    handle.shutdown()          # on SIGTERM

Writing a log line::

    from hope_obs import get_logger, redact_id

    logger = get_logger(__name__)
    logger.info("stt.session.started", session=redact_id(session_id), ms=12)

Never an f-string, never clinical content, never a raw identifier.

The whole public surface is ``__all__`` below. Everything else
(``hope_obs.middleware``, ``hope_obs.tracing``, ``hope_obs.phi``) is importable
for a service that needs to compose its own middleware stack, but the nine names
here are the contract the services are written against.
"""

from hope_obs.config import ObservabilityConfig
from hope_obs.logging import (
    bind_request_context,
    clear_request_context,
    configure_logging,
    get_logger,
)
from hope_obs.phi import redact_id
from hope_obs.runtime import (
    WorkerObservability,
    configure_observability,
    configure_worker_observability,
    shutdown_observability,
)
from hope_obs.tracing import get_tracer

__all__ = [
    "ObservabilityConfig",
    "WorkerObservability",
    "bind_request_context",
    "clear_request_context",
    "configure_logging",
    "configure_observability",
    "configure_worker_observability",
    "get_logger",
    "get_tracer",
    "redact_id",
    "shutdown_observability",
]
