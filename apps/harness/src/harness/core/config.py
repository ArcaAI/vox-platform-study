"""Harness configuration using pydantic-settings.

Application settings use the ``HARNESS_`` env prefix; the Temporal substrate
uses the shared ``TEMPORAL_`` prefix so the address/namespace/task-queue are
configured once across the API gateway, the worker, and the FastAPI app.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

if TYPE_CHECKING:
    from harness.eval.config import JudgeConfig


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
    # Grace period the worker gives in-flight activities to finish (or observe
    # cancellation) after shutdown is requested, before it force-cancels them.
    # 0 = cancel immediately (Temporal's default). Applies on SIGINT/SIGTERM.
    graceful_shutdown_timeout_s: float = 30.0


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


_CLAIM_CHECK_STORES = ("memory", "s3")


class ClaimCheckConfig(BaseSettings):
    """Claim-check out-of-band blob store (TASK-483 — Temporal history budget).

    Large clinical blobs (transcript / assembled prompt / generated note / RAG
    chunks) are moved OUT of Temporal workflow history and replaced with a small
    content-addressed reference, protecting the ~50 MB history-size budget under a
    long / heavily-regenerated encounter. The store is SELF-HOSTED only (MinIO,
    S3-compatible) — the offloaded payloads carry clinical content and must never
    egress to a cloud bucket (track guardrail).

    ``enabled`` defaults ON with ``min_bytes`` set so offload protects the budget
    out of the box, and ``should_offload`` keeps small payloads inline (no store
    tax). The DEFAULT ``store`` is the process-local ``memory`` fake — correct for
    the hermetic suite and SINGLE-worker local dev; a MULTI-worker deploy MUST set
    ``store=s3`` + the MinIO endpoint/creds, because a cross-worker activity retry
    against the in-memory fake fails LOUD (``ClaimCheckNotFound``). Creds are
    ``SecretStr``, validated at startup (AC-7).
    """

    model_config = SettingsConfigDict(env_prefix="HARNESS_CLAIM_CHECK_")

    # Offload ON by default (protect the history budget); the threshold keeps small
    # payloads inline so tiny prompts/notes never pay a store round-trip.
    enabled: bool = True
    # Backend selector: ``memory`` (process-local fake — dev/test) | ``s3`` (self-hosted MinIO).
    store: str = "memory"
    # Blobs at/above this many utf-8 BYTES are offloaded; below it they stay inline.
    min_bytes: int = 65_536  # 64 KiB
    # Tenant-scoped, access-controlled PHI bucket (NOT a public bucket).
    bucket: str = "harness-claim-check"
    # Self-hosted MinIO S3 endpoint (host under platform control — no cloud egress).
    endpoint_url: str = "http://localhost:9000"
    access_key: SecretStr = SecretStr("")
    secret_key: SecretStr = SecretStr("")
    region: str = "us-east-1"
    secure: bool = False
    # Advisory blob lifetime (a bucket lifecycle rule enforces expiry out-of-band);
    # a blob must outlive the longest workflow that may still dereference it.
    ttl_seconds: int = 604_800  # 7 days

    @field_validator("store")
    @classmethod
    def _validate_store(cls, v: str) -> str:
        if v not in _CLAIM_CHECK_STORES:
            raise ValueError(f"store must be one of {list(_CLAIM_CHECK_STORES)}")
        return v

    @field_validator("min_bytes")
    @classmethod
    def _positive_min_bytes(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("min_bytes must be a positive integer")
        return v


class McpConfig(BaseSettings):
    """MCP external-tools client config (TASK-516 Phase 5 — default OFF).

    The whole MCP tool path is DORMANT unless the per-tenant
    ``HarnessPolicy.mcpToolsEnabled`` flag is set AND the referenced
    ``McpServer.enabled`` is true (defense in depth); this config only supplies
    the client TUNING (timeout / bounded retry / result size cap). READ-ONLY
    tools only in this ticket. Credentials are resolved from Vault at call time
    by the server's ``authRef`` PATH — never stored or logged here.
    """

    model_config = SettingsConfigDict(env_prefix="HARNESS_MCP_")

    # Per-call wall-clock timeout for a single MCP tool invocation.
    timeout_s: float = 20.0
    # Bounded transport retries inside the client for a transient/5xx error before
    # the activity degrades (never crashes the loop).
    max_attempts: int = 2
    # Result size cap (utf-8 BYTES). A tool result above this is claim-checked
    # (offloaded, keeping the blob OUT of Temporal history) when claim-check is
    # enabled, else truncated to the cap. Mirrors the claim-check threshold.
    max_result_bytes: int = 65_536

    @field_validator("max_attempts")
    @classmethod
    def _positive_max_attempts(cls, v: int) -> int:
        if v < 1:
            raise ValueError("max_attempts must be >= 1")
        return v

    @field_validator("max_result_bytes")
    @classmethod
    def _positive_max_result_bytes(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("max_result_bytes must be a positive integer")
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

    # TASK-355 Phase D (R-7) — optimistic two-phase delivery kill-switch. The FIRST
    # key of the two-key optimistic gate; the second is the durable
    # ``workflow.patched("task-355-optimistic-delivery")`` marker (permanent in code).
    # Read here, in NON-workflow settings, and snapshotted into ``HarnessGateConfig``
    # at workflow start (document:start + the policy merge), so it stays deterministic
    # across replay — never read from env inside the workflow body. Default OFF ⇒ the
    # legacy single-phase path, byte-identical to pre-Phase-D history.
    optimistic_delivery_enabled: bool = False

    # TASK-480 Half-B — NER-priors reuse kill-switch (HARNESS_NER_PRIORS_ENABLED,
    # default OFF). When ON, the transcript ``extract_entities`` activity reuses
    # already-persisted CODED NamedEntity rows (TASK-476) as the NER priors instead of
    # re-running the cold NLP pass — killing the redundant second transcript-NER pass.
    # Read at runtime inside the (non-deterministic) activity, NOT the workflow body, so
    # it needs no snapshot/patch marker; when OFF (or when no prior carries a code) the
    # activity falls back to the cold extraction, so enabling it is an explicit ops
    # rollout, never a silent default flip, and it is inert until TASK-476 codes exist.
    ner_priors_enabled: bool = False

    # TASK-481 (E2) — reference-free atomic-fact verifier kill-switch
    # (HARNESS_ATOMIC_FACT_ENABLED, default OFF). When ON, the ``run_inferential_sensors``
    # activity runs the DETERMINISTIC self-hosted-NLI atomic-fact verifier ALONGSIDE the
    # LLM-judge groundedness sensor (a second, model-cheap groundedness gate). Read at
    # runtime inside the (non-deterministic) activity — NOT the workflow body — so it adds
    # no new command / snapshot / patch marker (the sensor result flows through the
    # activity output; the workflow command sequence is byte-identical, replay-safe).
    # Default OFF ⇒ enabling it is an explicit ops rollout once a self-hosted NLI model
    # (MiniCheck / AlignScore / HHEM-class) is provisioned; the hermetic default entailer
    # (:class:`DeterministicOverlapEntailer`) needs no model and never auto-PASSes.
    atomic_fact_enabled: bool = False

    # TASK-481 — optional self-hosted MiniCheck-Flan-T5 GGUF entailer (owner directive
    # 2026-07-11: "GGUF everywhere"). When `atomic_fact_model_path` is set (a staged local
    # .gguf), the verifier swaps the model-free DeterministicOverlapEntailer for the
    # MiniCheck NLI; unset (default) keeps the hermetic model-free entailer. `model_id`/
    # `model_file` are provenance only. A build/calibration failure falls back to the safe
    # deterministic entailer (see `_atomic_fact_entailer`). CPU-default (Q6 quant).
    atomic_fact_model_path: str | None = None
    atomic_fact_model_id: str = "nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF"
    atomic_fact_model_file: str = "minicheck-flan-t5-large-q6_k.gguf"
    # 512 matches Flan-T5's training context (`n_ctx_train`); MiniCheck windows long
    # documents to ~512-token chunks, so more only wastes the encoder KV alloc and trips
    # llama.cpp's `n_ctx_seq > n_ctx_train` overflow warning.
    atomic_fact_n_ctx: int = 512
    atomic_fact_n_threads: int | None = None
    atomic_fact_n_gpu_layers: int = 0
    # Per-claim entailment decision: P(entailed) >= this ⇒ grounded.
    atomic_fact_entail_threshold: float = 0.5

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

    # Per-call LLM wall-clock timeout (TASK-354 Defect A). Bounds EACH individual judge /
    # citation-verify / Granite Guardian request inside the inferential pass so a single
    # hung LM Studio call can no longer burn the whole 900s start_to_close before Temporal
    # retries; a timed-out call is transient (retried within HARNESS_LLM_MAX_ATTEMPTS) and
    # the owning sensor then self-degrades. Enforced by the shared LLM governor (env
    # ``HARNESS_LLM_REQUEST_TIMEOUT_S``; see ``core.llm_concurrency.LlmGovernorConfig`` and
    # ``eval.judge.providers._create_with_retry``). Safety net for the raised
    # HARNESS_LLM_MAX_CONCURRENCY (TASK-355 Phase A): a hung call now ties up a real slot.
    llm_request_timeout_s: float = 120.0

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
    # TASK-483 claim-check: out-of-band blob store for the Temporal history budget.
    claim_check: ClaimCheckConfig = Field(default_factory=ClaimCheckConfig)
    # TASK-516 (Phase 5) — MCP external-tools client tuning (default OFF; the path is
    # gated on HarnessPolicy.mcpToolsEnabled + McpServer.enabled + workflow.patched).
    mcp: McpConfig = Field(default_factory=McpConfig)

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


def get_runtime_judge_config() -> JudgeConfig:
    """Reuse the eval ``JudgeConfig`` (``HARNESS_JUDGE_*``) at harness runtime.

    Phase 2's groundedness + reasoning judge is the **same** calibrated judge the
    eval gate uses — it is NOT re-declared under a new prefix. Construct the client
    with ``harness.eval.judge.providers.build_judge_client(get_runtime_judge_config())``.
    Imported lazily so ``core.config`` keeps no module-level dependency on ``eval``.
    """
    from harness.eval.config import get_judge_config

    return get_judge_config()
