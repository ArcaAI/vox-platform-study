"""Harness configuration using pydantic-settings.

Application settings use the ``HARNESS_`` env prefix; the Temporal substrate
uses the shared ``TEMPORAL_`` prefix so the address/namespace/task-queue are
configured once across the API gateway, the worker, and the FastAPI app.
"""

from __future__ import annotations

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class TemporalConfig(BaseSettings):
    """Temporal durable-workflow substrate configuration.

    ``address`` is the Temporal frontend (gRPC) endpoint. Locally this is the
    dev stack's ``localhost:7233`` (see ``infrastructure/docker``); in a
    container it is ``temporal:7233``.
    """

    model_config = SettingsConfigDict(env_prefix="TEMPORAL_")

    address: str = "localhost:7233"
    namespace: str = "default"
    task_queue: str = "harness-task-queue"
    connect_timeout_s: float = 5.0


class Settings(BaseSettings):
    """Root harness application settings."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_")

    # Application
    host: str = "0.0.0.0"
    port: int = 8866
    debug: bool = False
    log_level: str = "info"
    cors_origins: list[str] = Field(default_factory=list)
    cors_enabled: bool = False

    # Inter-service authentication (empty = auth disabled for local dev).
    # This is the shared HARNESS_SERVICE_TOKEN: it guards the inbound internal
    # endpoints AND is the ``X-Service-Token`` the api_client presents to apps/api.
    service_token: SecretStr = SecretStr("")

    # Connection pooling (used by the loop's httpx tool clients)
    httpx_max_connections: int = 200
    httpx_max_keepalive: int = 100

    # -- Loop / gate-adapter (TASK-330 Phase 1, Lane I) ----------------------
    # Tool-service base URLs the durable loop calls out to.
    smr_base_url: str = "http://localhost:8862"
    nlp_base_url: str = "http://localhost:8864"
    api_base_url: str = "http://localhost:8868"
    # apps/api internal-harness mount. Lane G's ``HarnessInternalController`` sits
    # under the global ``/api/v1`` prefix (``@Controller('internal/harness')``), so
    # the live, out-of-the-box mount is ``/api/v1/internal/harness``. Override via
    # ``HARNESS_API_INTERNAL_PREFIX`` if the gateway prefix ever changes.
    api_internal_prefix: str = "/api/v1/internal/harness"

    # Bounded-regen budget + clinician-gate timing (durable, deterministic).
    max_regen: int = 2
    gate_sla_seconds: float = 86_400.0  # 24h until the first SLA escalation
    gate_escalation_seconds: float = 43_200.0  # re-escalate every 12h until sign-off

    # SMR generation defaults (None => let the SMR service choose).
    smr_provider: str | None = None
    smr_model: str | None = None
    conversation_language: str = "en"

    # Tool-call + Temporal activity timeouts / retry budgets.
    smr_timeout_s: float = 120.0
    nlp_timeout_s: float = 30.0
    api_timeout_s: float = 30.0
    activity_start_to_close_s: float = 150.0
    activity_max_attempts: int = 3
    generate_max_attempts: int = 2

    @property
    def harness_service_token(self) -> SecretStr:
        """The shared ``HARNESS_SERVICE_TOKEN`` (alias of :attr:`service_token`).

        Exposed under the name the apps/api <-> apps/harness contract uses: the
        same secret guards the inbound internal endpoints and authenticates the
        api_client's outbound calls to apps/api.
        """
        return self.service_token

    # Observability
    otel_enabled: bool = False
    otel_exporter_endpoint: str = "http://localhost:4317"
    otel_service_name: str = "harness"
    otel_service_namespace: str = "hope"
    otel_deployment_environment: str = "production"
    otel_insecure: bool = True
    otel_logs_enabled: bool = True
    metrics_enabled: bool = True

    # Sub-configs (loaded from their own env prefixes)
    temporal: TemporalConfig = Field(default_factory=TemporalConfig)

    @field_validator("log_level")
    @classmethod
    def _normalise_log_level(cls, v: str) -> str:
        return v.lower()


def _load_dotenv_into_environ() -> None:
    """Load ``.env`` files into ``os.environ`` with correct precedence.

    Walks up from this file to find all ``.env`` files (up to 10 levels).
    Loads the root-level file first, then closer ones, so an app-level
    ``apps/harness/.env`` overrides the monorepo-root ``.env``. Explicit
    environment variables always win.
    """
    import os
    import pathlib

    env_files: list[pathlib.Path] = []
    current = pathlib.Path(__file__).resolve().parent
    for _ in range(10):
        candidate = current / ".env"
        if candidate.is_file():
            env_files.append(candidate)
        current = current.parent

    for env_file in reversed(env_files):
        with open(env_file) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key not in os.environ:
                    os.environ[key] = val


def get_settings() -> Settings:
    """Create a settings instance.  Not cached — call once at startup."""
    _load_dotenv_into_environ()
    return Settings()
