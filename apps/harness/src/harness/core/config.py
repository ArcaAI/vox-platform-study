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


_SAFETY_PROVIDERS = ("lm-studio", "ollama", "azure", "bedrock")


class SafetyGuardConfig(BaseSettings):
    """IBM Granite Guardian content-safety classifier over a selectable engine.

    The Phase-2 safety sensor screens the generated note through Granite Guardian.
    The **default** engine is **LM Studio** — an OpenAI-compatible endpoint: the
    safety client posts to ``{base_url}/chat/completions`` (``base_url`` already
    includes the ``/v1`` path) and reads ``choices[0].message.content``. ``provider``
    switches the engine: ``lm-studio`` (default) | ``ollama`` (native ``/api/chat``)
    | ``azure`` | ``bedrock`` — the last two require a guardian-capable model hosted
    on that engine.

    ``harm_criteria`` is the Bring-Your-Own-Criteria (BYOC) list of risk dimensions
    the guardian evaluates one-per-call via the canonical IBM 4.1 ``<guardian>``
    block; ``no_think`` runs the classifier without an explicit reasoning pass for
    fast, deterministic ``<score>yes/no</score>`` verdicts.

    The default ``model`` slug is ``granite-guardian-4.1-8b``; operators load the
    matching build in their engine (e.g. ``lmstudio-community/granite-guardian-4.1-8b-GGUF``,
    resolving to the ``granite-guardian-4.1-8b`` id) or override via
    ``HARNESS_SAFETY_MODEL``.
    """

    model_config = SettingsConfigDict(env_prefix="HARNESS_SAFETY_")

    enabled: bool = True
    # Engine selector: lm-studio (default, OpenAI-compatible) | ollama | azure | bedrock.
    provider: str = "lm-studio"
    # LM Studio OpenAI-compatible root (already includes ``/v1``). For the ``ollama``
    # provider, override to the Ollama native root, e.g. ``http://localhost:11434``.
    base_url: str = "http://localhost:1234/v1"
    model: str = "granite-guardian-4.1-8b"
    # Guard classifier in no-think mode (fast, deterministic yes/no per criterion).
    no_think: bool = True
    timeout_s: float = 60.0
    # BYOC risk dimensions screened on the generated note (env: JSON array).
    harm_criteria: list[str] = Field(
        default_factory=lambda: [
            "harm",
            "social_bias",
            "jailbreak",
            "violence",
            "profanity",
            "sexual_content",
            "unethical_behavior",
        ]
    )

    @field_validator("provider")
    @classmethod
    def _validate_provider(cls, v: str) -> str:
        if v not in _SAFETY_PROVIDERS:
            raise ValueError(f"provider must be one of {list(_SAFETY_PROVIDERS)}")
        return v


class PhiConfig(BaseSettings):
    """Pre-cloud-egress PHI redaction guard (Presidio + clinical NER), fail-closed.

    ``fail_closed`` is the load-bearing default: if the redactor cannot *confirm*
    PHI was removed (analyzer failure, missing model, etc.), egress to a cloud
    provider must be **blocked**, never silently allowed. ``cloud_egress_providers``
    is the allowlist of provider identifiers treated as cloud egress — i.e. the
    providers for which the guard's ``ensure_safe_for_cloud(...)`` must verify
    redaction before any data leaves the box. Local providers (LM Studio / Ollama /
    the local SMR) are not egress and are not listed here.
    """

    model_config = SettingsConfigDict(env_prefix="HARNESS_PHI_")

    enabled: bool = True
    fail_closed: bool = True
    cloud_egress_providers: list[str] = Field(default_factory=lambda: ["azure", "bedrock"])


class RetrievalConfig(BaseSettings):
    """Phase-3 institutional-RAG hybrid retriever (TASK-330 Phase 3, Lane A).

    The JIT retriever grounds generation in a tenant-owned knowledge corpus: a
    query built from the extracted entities is dense-embedded (self-hosted LM
    Studio ``/v1/embeddings``) **and** sparse-embedded (in-process fastembed
    ``Qdrant/bm25``), fused server-side via the Qdrant Query API
    (``prefetch(dense)`` + ``prefetch(sparse)`` -> ``FusionQuery(RRF, k=rrf_k)``)
    filtered by ``tenant_id`` + ``status=APPROVED`` over the dedicated
    ``knowledge_chunks`` collection, then reranked by a HF TEI cross-encoder
    (``hope-reranker``) down to ``top_k_rerank``.

    ``enabled`` is **False by default** — the whole feature is flag-gated and
    additive, so Phase 1/2 behaviour is unchanged until an operator opts in. Every
    backend is degrade-safe: if embeddings/Qdrant/reranker are down the retriever
    yields an empty context (generation proceeds, flagged), never an exception
    into the durable loop.

    The dense query is entity/transcript-derived and can contain PHI, so it stays
    on the self-hosted LM Studio path (a cloud embeddings provider would trip the
    fail-closed PHI guard). ``embeddings_dim`` defaults to 1024 (``BAAI/bge-m3``);
    set it to 1536 (and recreate the collection) only if a 1536-dim model is
    loaded — it MUST match both the loaded model and the Qdrant collection.
    """

    model_config = SettingsConfigDict(env_prefix="HARNESS_RETRIEVAL_")

    enabled: bool = False
    qdrant_url: str = "http://localhost:6333"
    collection: str = "knowledge_chunks"
    # LM Studio OpenAI-compatible root (already includes ``/v1``); the embeddings
    # client posts to ``{base_url}/embeddings``.
    embeddings_base_url: str = "http://localhost:1234/v1"
    # Model id the engine exposes for the loaded dense embedding model. Operators
    # override to match the loaded build (the plan's reference model is BAAI/bge-m3).
    embeddings_model: str = "text-embedding-bge-m3"
    # Dense vector dimension — MUST match the loaded model AND the Qdrant collection.
    embeddings_dim: int = 1024
    # HF Text-Embeddings-Inference reranker root (cross-encoder ``/rerank``).
    reranker_base_url: str = "http://localhost:8870"
    # Hybrid knobs: dense+sparse prefetch limit -> RRF fusion -> cross-encoder rerank.
    top_k_retrieval: int = 20
    top_k_rerank: int = 5
    rrf_k: int = 60
    embeddings_timeout_s: float = 30.0
    reranker_timeout_s: float = 30.0
    qdrant_timeout_s: float = 10.0

    @field_validator("embeddings_dim", "top_k_retrieval", "top_k_rerank", "rrf_k")
    @classmethod
    def _positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("retrieval sizing knobs must be positive integers")
        return v


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

    # Phase-3 (TASK-330) dedicated token for the institutional-knowledge ingest
    # endpoint (``POST /internal/knowledge/ingest``). The ingest guard accepts an
    # ``X-Service-Token`` matching THIS secret OR the shared ``service_token``;
    # empty (and an empty shared token) disables the guard for local dev. Lane B's
    # BullMQ ingest processor presents this as the ingest contract's token.
    internal_service_token: SecretStr = SecretStr("")

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
    # Phase-2 guardrails (TASK-330): Granite Guardian safety + fail-closed PHI.
    safety: SafetyGuardConfig = Field(default_factory=SafetyGuardConfig)
    phi: PhiConfig = Field(default_factory=PhiConfig)
    # Phase-3 institutional RAG (TASK-330): hybrid JIT retriever (flag-gated off).
    retrieval: RetrievalConfig = Field(default_factory=RetrievalConfig)

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


def get_runtime_judge_config():  # noqa: ANN201 — return type is eval.JudgeConfig (lazy import)
    """Reuse the eval ``JudgeConfig`` (``HARNESS_JUDGE_*``) at harness runtime.

    Phase 2's groundedness + reasoning judge is the **same** calibrated judge the
    eval gate uses — it is NOT re-declared under a new prefix. Construct the client
    with ``harness.eval.judge.providers.build_judge_client(get_runtime_judge_config())``.
    Imported lazily so ``core.config`` keeps no module-level dependency on ``eval``.
    """
    from harness.eval.config import get_judge_config

    return get_judge_config()
