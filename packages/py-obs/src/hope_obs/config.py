"""The one observability configuration contract for the HOPE Python services.

Why this is a dataclass and not a ``pydantic-settings`` model: every service
already owns a settings object, and a second settings loader inside a shared
package would be a second place an operator has to look. ``from_env`` is the
zero-argument path for a service that has no opinion; a service with one builds
the dataclass directly, or narrows one field with ``dataclasses.replace``.

The env contract (TASK-987 R-2), replacing the six shapes finding F-11 counted:

===========================================  ==========================================
Variable                                     Meaning
===========================================  ==========================================
``OTEL_EXPORTER_OTLP_ENDPOINT``              Collector address. **Presence enables
                                             tracing.** There is no boolean.
``OTEL_SERVICE_NAME``                        Overrides the ``service_name`` argument
``DEPLOYMENT_ENVIRONMENT`` → ``NODE_ENV``    Resource environment, default
                                             ``development``
``OTEL_TRACES_SAMPLER_ARG``                  Head-sampling ratio, default ``1.0``
``LOG_LEVEL``, ``<SVC>_LOG_LEVEL``           Log level, default ``info``
===========================================  ==========================================

**There is deliberately no ``*_OTEL_ENABLED`` flag.** Finding F-02: NLP shipped
with ``OTEL_EXPORTER_OTLP_ENDPOINT``, ``OTEL_TRACES_ENABLED=true`` and
``OTEL_METRICS_ENABLED=true`` all correctly set in ``hope-platform-config`` and
exported nothing, because a sixth variable — ``NLP_OTEL_ENABLED`` — was the one
the code actually read. A flag that can contradict the endpoint beside it
eventually does. One signal cannot disagree with itself.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

# Never "production". A mislabelled dev span is noise; a mislabelled prod span
# corrupts an audit trail (finding F-09 — two helpers defaulted the other way).
DEFAULT_ENVIRONMENT = "development"
DEFAULT_LOG_LEVEL = "info"
DEFAULT_SAMPLER_RATIO = 1.0

_NON_IDENTIFIER = re.compile(r"[^A-Z0-9]+")


def _service_log_level_var(service_name: str) -> str:
    """``stt`` → ``STT_LOG_LEVEL``, ``admin-console`` → ``ADMIN_CONSOLE_LOG_LEVEL``.

    Keyed on the service's own identity — the argument — and not on
    ``OTEL_SERVICE_NAME``: that variable renames the telemetry *resource*
    (in-cluster STT is ``hope-stt-v2``), and it must not move the log-level
    variable an operator would reasonably look for.
    """
    return f"{_NON_IDENTIFIER.sub('_', service_name.upper()).strip('_')}_LOG_LEVEL"


def _sampler_ratio_from_env() -> float:
    """Read ``OTEL_TRACES_SAMPLER_ARG``; fail OPEN to 1.0.

    An unparseable or out-of-range ratio must never silently drop traces: the
    failure mode of guessing low is invisible, and the failure mode of guessing
    high is a cost line somebody reads.
    """
    raw = os.getenv("OTEL_TRACES_SAMPLER_ARG")
    if not raw:
        return DEFAULT_SAMPLER_RATIO
    try:
        ratio = float(raw)
    except ValueError:
        return DEFAULT_SAMPLER_RATIO
    if not 0.0 <= ratio <= 1.0:
        return DEFAULT_SAMPLER_RATIO
    return ratio


@dataclass(frozen=True)
class ObservabilityConfig:
    """Everything ``hope_obs`` needs to configure logging and tracing.

    Frozen: a service resolves this once at startup and hands the same value to
    ``configure_observability`` and to every later reader. A mutable config is
    how one code path ends up tracing to a different endpoint than another.
    """

    service_name: str
    service_version: str = "0.0.0"
    service_namespace: str = "hope"
    deployment_environment: str = DEFAULT_ENVIRONMENT
    #: PRESENCE is the enable signal — there is no boolean (R-2).
    otlp_endpoint: str | None = None
    #: A level name (``INFO``) or a number (``20``); both are in live use.
    log_level: str = DEFAULT_LOG_LEVEL
    traces_sampler_ratio: float = DEFAULT_SAMPLER_RATIO

    @property
    def tracing_enabled(self) -> bool:
        """True when an OTLP endpoint is configured. The only enable signal."""
        return bool(self.otlp_endpoint)

    @property
    def insecure(self) -> bool:
        """Whether the OTLP channel skips TLS — derived from the endpoint scheme.

        Never a separate flag: a boolean beside a URL is one more thing that can
        disagree with the URL (the F-02 shape, one layer down).
        """
        return not (self.otlp_endpoint or "").startswith("https://")

    @classmethod
    def from_env(cls, service_name: str, *, service_version: str = "0.0.0") -> ObservabilityConfig:
        """Resolve the whole contract from the process environment.

        ``service_name`` is the service's own identity (``stt``, ``guardrail``);
        ``OTEL_SERVICE_NAME`` overrides what the telemetry resource is CALLED,
        because that is the name deployments set per Deployment.

        A service whose log level lives under a different prefix (guardrail's is
        ``GUARDRAIL_V2_LOG_LEVEL``) narrows one field rather than reimplementing
        the rest::

            config = replace(ObservabilityConfig.from_env("guardrail"),
                             log_level=settings.log_level)
        """
        return cls(
            service_name=os.getenv("OTEL_SERVICE_NAME") or service_name,
            service_version=service_version,
            deployment_environment=(
                os.getenv("DEPLOYMENT_ENVIRONMENT") or os.getenv("NODE_ENV") or DEFAULT_ENVIRONMENT
            ),
            otlp_endpoint=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or None,
            log_level=(
                os.getenv(_service_log_level_var(service_name))
                or os.getenv("LOG_LEVEL")
                or DEFAULT_LOG_LEVEL
            ),
            traces_sampler_ratio=_sampler_ratio_from_env(),
        )
