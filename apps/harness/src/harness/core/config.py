"""Harness configuration using pydantic-settings.

Application settings use the ``HARNESS_`` env prefix; the Temporal substrate
uses the shared ``TEMPORAL_`` prefix so the address/namespace/task-queue are
configured once across the API gateway, the worker, and the FastAPI app.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from hope_env import hope_settings_sources, load_env
from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Environments where the in-memory claim-check store is a data-loss bug rather than a
# convenience. Anything else — "development", "test", a bare default —
# is treated as single-process and allowed.
_DEPLOYED_ENVIRONMENTS = frozenset({"production", "prod", "staging"})

if TYPE_CHECKING:
    from harness.eval.config import JudgeConfig


class TemporalConfig(BaseSettings):
    """Temporal durable-workflow substrate configuration.

    ``address`` is the Temporal frontend (gRPC) endpoint. Locally this is the
    dev stack's ``localhost:7233`` (see ``infrastructure/docker``); in a
    container it is ``temporal:7233``.
    """

    # TASK-558-H: init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

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

    The safety sensor screens the generated note through Granite Guardian.
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

    # TASK-558-H: init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

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

    # TASK-558-H: init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="HARNESS_PHI_")

    enabled: bool = True
    fail_closed: bool = True
    cloud_egress_providers: list[str] = Field(default_factory=lambda: ["azure", "bedrock"])


class RetrievalConfig(BaseSettings):
    """Institutional-RAG hybrid retriever.

    The JIT retriever grounds generation in a tenant-owned knowledge corpus: a
    query built from the extracted entities is dense-embedded (self-hosted LM
    Studio ``/v1/embeddings``) **and** sparse-embedded (in-process fastembed
    ``Qdrant/bm25``), fused server-side via the Qdrant Query API
    (``prefetch(dense)`` + ``prefetch(sparse)`` -> ``FusionQuery(RRF, k=rrf_k)``)
    filtered by ``tenant_id`` + ``status=APPROVED`` over the dedicated
    ``knowledge_chunks`` collection, then reranked by a HF TEI cross-encoder
    (``hope-reranker``) down to ``top_k_rerank``.

    ``enabled`` is **False by default** — the whole feature is flag-gated and
    additive, so prior behaviour is unchanged until an operator opts in. Every
    backend is degrade-safe: if embeddings/Qdrant/reranker are down the retriever
    yields an empty context (generation proceeds, flagged), never an exception
    into the durable loop.

    The dense query is entity/transcript-derived and can contain PHI, so it stays
    on the self-hosted LM Studio path (a cloud embeddings provider would trip the
    fail-closed PHI guard). ``embeddings_dim`` defaults to 1024 (``BAAI/bge-m3``);
    set it to 1536 (and recreate the collection) only if a 1536-dim model is
    loaded — it MUST match both the loaded model and the Qdrant collection.
    """

    # TASK-558-H: init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="HARNESS_RETRIEVAL_")

    enabled: bool = False
    qdrant_url: str = "http://localhost:6333"
    # Qdrant ships with NO authentication (TASK-624 Q-04). Unauthenticated is
    # correct for local dev; in-cluster it means any pod in the namespace can
    # read or delete the tenant knowledge corpus. SecretStr because the settings
    # object is logged at startup. Default None, not "" — an empty string is
    # itself a credential to Qdrant, so absent must mean absent.
    qdrant_api_key: SecretStr | None = None
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
    """Claim-check out-of-band blob store (Temporal history budget).

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
    ``SecretStr``, validated at startup.

    That MUST is ENFORCED, not just documented. ``Settings``
    carries a ``_reject_memory_claim_check_outside_dev`` model validator that turns
    ``enabled=True`` + ``store="memory"`` into a hard startup error whenever
    ``HARNESS_ENVIRONMENT`` names a deployed environment, and
    ``harness.temporal.worker`` re-asserts it at boot (warning in dev, where a
    single worker makes the in-memory store legitimate). The defaults below are
    unchanged: this is a deployment guard, not a default change.
    """

    # TASK-558-H: init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

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
    """MCP external-tools client config.

    The whole MCP tool path is DORMANT unless the per-tenant
    ``HarnessPolicy.mcpToolsEnabled`` flag is set AND the referenced
    ``McpServer.enabled`` is true (defense in depth); this config only supplies
    the client TUNING (timeout / bounded retry / result size cap). READ-ONLY
    tools only. Credentials are resolved from Vault at call time
    by the server's ``authRef`` PATH — never stored or logged here.
    """

    # TASK-558-H: init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

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

    # TASK-558-H: init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="HARNESS_")

    # Application
    host: str = "0.0.0.0"
    port: int = 8866
    debug: bool = False
    # Deployment signal. Deliberately SEPARATE from ``debug``: that
    # flag defaults False, so "not debug" cannot distinguish a production deploy from
    # unconfigured local dev — and the claim-check guard below must not fire on the
    # latter. Production/staging deploys set ``HARNESS_ENVIRONMENT`` explicitly.
    environment: str = "development"
    log_level: str = "info"
    cors_origins: list[str] = Field(default_factory=list)
    cors_enabled: bool = False

    # Inter-service authentication (empty = auth disabled for local dev).
    # This is the shared HARNESS_SERVICE_TOKEN: it guards the inbound internal
    # endpoints AND is the ``X-Service-Token`` the api_client presents to apps/api.
    service_token: SecretStr = SecretStr("")

    # Dedicated token for the institutional-knowledge ingest
    # endpoint (``POST /internal/knowledge/ingest``). The ingest guard accepts an
    # ``X-Service-Token`` matching THIS secret OR the shared ``service_token``;
    # empty (and an empty shared token) disables the guard for local dev. The
    # BullMQ ingest processor presents this as the ingest contract's token.
    internal_service_token: SecretStr = SecretStr("")

    # Connection pooling (used by the loop's httpx tool clients)
    httpx_max_connections: int = 200
    httpx_max_keepalive: int = 100

    # -- Loop / gate-adapter --------------------------------------------------
    # Tool-service base URLs the durable loop calls out to.
    smr_base_url: str = "http://localhost:8862"
    nlp_base_url: str = "http://localhost:8864"
    api_base_url: str = "http://localhost:8868"
    # apps/api internal-harness mount. ``HarnessInternalController`` sits
    # under the global ``/api/v1`` prefix (``@Controller('internal/harness')``), so
    # the live, out-of-the-box mount is ``/api/v1/internal/harness``. Override via
    # ``HARNESS_API_INTERNAL_PREFIX`` if the gateway prefix ever changes.
    api_internal_prefix: str = "/api/v1/internal/harness"

    # Bounded-regen budget + clinician-gate timing (durable, deterministic).
    max_regen: int = 2
    gate_sla_seconds: float = 86_400.0  # 24h until the first SLA escalation
    gate_escalation_seconds: float = 43_200.0  # re-escalate every 12h until sign-off

    # Optimistic two-phase delivery kill-switch. The FIRST
    # key of the two-key optimistic gate; the second is the durable
    # ``workflow.patched("task-355-optimistic-delivery")`` marker (permanent in code).
    # Read here, in NON-workflow settings, and snapshotted into ``HarnessGateConfig``
    # at workflow start (document:start + the policy merge), so it stays deterministic
    # across replay — never read from env inside the workflow body. Default OFF ⇒ the
    # legacy single-phase path, byte-identical to before optimistic delivery.
    optimistic_delivery_enabled: bool = False

    # NER-priors reuse kill-switch (HARNESS_NER_PRIORS_ENABLED,
    # default OFF). When ON, the transcript ``extract_entities`` activity reuses
    # already-persisted CODED NamedEntity rows as the NER priors instead of
    # re-running the cold NLP pass — killing the redundant second transcript-NER pass.
    # Read at runtime inside the (non-deterministic) activity, NOT the workflow body, so
    # it needs no snapshot/patch marker; when OFF (or when no prior carries a code) the
    # activity falls back to the cold extraction, so enabling it is an explicit ops
    # rollout, never a silent default flip, and it is inert until coded entities are
    # actually persisted elsewhere.
    ner_priors_enabled: bool = False

    # Reference-free atomic-fact verifier kill-switch
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

    # Optional self-hosted MiniCheck-Flan-T5 GGUF entailer (owner directive
    # 2026-07-11: "GGUF everywhere"). When `atomic_fact_model_path` is set (a staged local
    # .gguf), the verifier swaps the model-free DeterministicOverlapEntailer for the
    # MiniCheck NLI; unset (default) keeps the hermetic model-free entailer. `model_id`/
    # `model_file` are provenance only. A build/calibration failure falls back to the safe
    # deterministic entailer (see `_atomic_fact_entailer`). CPU-default (Q6 quant).
    # BOOTSTRAP FALLBACK ONLY. The runtime value comes from the
    # control plane's effective-config `modelWeights['minicheck-flan-t5-large']`
    # (harness holds no DB handle, so it cannot read the control plane directly). This
    # env var applies when that key is absent — which is every deployment until the
    # `modelWeights` control-plane rollout completes — so behaviour predating that
    # rollout is preserved byte-for-byte.
    atomic_fact_model_path: str | None = None
    # Cache dir for weights materialised from an `s3://` source_uri.
    atomic_fact_model_cache_dir: str = "/models/harness-cache"
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

    # MiniCheck entailer retention. Before this the
    # entailer sat in a module dict with no TTL, no bound and no unload, so a
    # worker that verified one document pinned the GGUF for its whole life.
    #
    # BOOTSTRAP FALLBACK ONLY — the runtime value comes from the control plane
    # (`harness.modelCache.{ttlSeconds,maxModels}`), applied by
    # `sensors.inferential.minicheck_entailer.configure_entailer_cache`. Env:
    # HARNESS_MODEL_CACHE_TTL_SECONDS / HARNESS_MODEL_CACHE_MAX_MODELS. The
    # 600 s default is an owner decision; maxModels 1 preserves today's residency
    # exactly.
    model_cache_ttl_seconds: int = 600
    model_cache_max_models: int = 1

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

    # F-29 — Worker-level admission cap (``Worker(max_concurrent_activities=...)``,
    # ``worker.py``). Left unset, Temporal admits activities unbounded, which lets
    # many concurrent inferential activities queue behind the single
    # ``HARNESS_LLM_MAX_CONCURRENCY`` semaphore (``core/llm_concurrency.py``) — a
    # cheap non-LLM activity (fetch_policy, persist_entities, ...) can then starve
    # behind that queue. Kept deliberately conservative (well above
    # ``HARNESS_LLM_MAX_CONCURRENCY``'s default of 1, since most admitted activities
    # never touch the LLM governor at all); raise together with
    # ``HARNESS_LLM_MAX_CONCURRENCY`` if the semaphore is ever raised.
    max_concurrent_activities: int = 8

    # Per-call LLM wall-clock timeout. Bounds EACH individual judge /
    # citation-verify / Granite Guardian request inside the inferential pass so a single
    # hung LM Studio call can no longer burn the whole 900s start_to_close before Temporal
    # retries; a timed-out call is transient (retried within HARNESS_LLM_MAX_ATTEMPTS) and
    # the owning sensor then self-degrades. Enforced by the shared LLM governor (env
    # ``HARNESS_LLM_REQUEST_TIMEOUT_S``; see ``core.llm_concurrency.LlmGovernorConfig`` and
    # ``eval.judge.providers._create_with_retry``). Safety net for the raised
    # HARNESS_LLM_MAX_CONCURRENCY: a hung call now ties up a real slot.
    llm_request_timeout_s: float = 120.0

    # F-19 — assembled-prompt size alarm (``HARNESS_PROMPT_SIZE_WARN_CHARS``).
    # The doc loop deliberately re-sends the ENTIRE template+transcript prefix on
    # every regen iteration and never compacts or truncates it: dropping clinical
    # content to fit a budget is the wrong failure mode. This threshold makes an
    # oversized prompt VISIBLE instead — above it the ``generate`` activity emits
    # a structured ``harness.prompt_size_warn`` and generates anyway. 400_000
    # chars ~= 100k tokens at the chars/4 heuristic, i.e. the point where a long
    # consultation starts to crowd a 128k-context model.
    prompt_size_warn_chars: int = 400_000

    @property
    def harness_service_token(self) -> SecretStr:
        """The shared ``HARNESS_SERVICE_TOKEN`` (alias of :attr:`service_token`).

        Exposed under the name the apps/api <-> apps/harness contract uses: the
        same secret guards the inbound internal endpoints and authenticates the
        api_client's outbound calls to apps/api.
        """
        return self.service_token

    @property
    def otel_tracing_enabled(self) -> bool:
        """The real gate: the master switch AND a configured collector endpoint.

        ``otel_enabled`` alone is not enough — flipping it on with no endpoint
        set must stay a no-op (TASK-411: never require a reachable collector to
        start). Both ``core/observability.py`` and ``temporal/client.py`` read
        this property rather than ``otel_enabled`` directly.
        """
        return self.otel_enabled and bool(self.otel_exporter_endpoint)

    # Observability — traces (TASK-636 OBS-14). Prometheus metrics + the
    # trajectory spine cover most of the observability need, but neither one
    # replaces distributed tracing across FastAPI request handling and the
    # Temporal workflow/activity spans. ``_add_otel_context`` in core/logging.py
    # is no longer inert: `core/observability.py` is the consumer that installs a
    # TracerProvider (default OFF — TASK-411), after which every log line carries
    # the active trace/span id.
    #
    # Default OFF and requires an explicit endpoint (not just the flag) — a
    # bare ``HARNESS_OTEL_ENABLED=true`` with no collector configured must not
    # change startup behaviour. See ``otel_tracing_enabled`` below.
    otel_enabled: bool = False
    otel_exporter_endpoint: str = ""
    otel_service_name: str = "harness"
    otel_service_namespace: str = "hope"
    # TASK-636 OBS-18. Resolved from the environment, and defaulting to
    # DEVELOPMENT — never "production".
    #
    # This is the same defect that was fixed in `apps/stt/core/telemetry.py`
    # in this ticket: a hardcoded "production" tags a developer laptop's spans
    # as production data. That is the dangerous direction — a mislabelled dev
    # span is noise, a mislabelled prod span corrupts an audit trail.
    #
    # Precedence matches STT and the OTel collector: DEPLOYMENT_ENVIRONMENT
    # (what the k8s overlays patch) then NODE_ENV (the repo-wide selector,
    # TASK-558) then "development".
    otel_deployment_environment: str = Field(
        default_factory=lambda: os.getenv("DEPLOYMENT_ENVIRONMENT")
        or os.getenv("NODE_ENV")
        or "development"
    )
    otel_insecure: bool = True

    metrics_enabled: bool = True

    # Bind address for the Temporal SDK's Prometheus exporter in the WORKER
    # process (TASK-636 OBS-06). Separate from the FastAPI app's :8866 — the
    # worker is its own process and shares no HTTP server with it.
    #
    # Loopback by default: this is a PHI-processing service and must not become
    # LAN-reachable by accident. `scripts/dev-service.sh` takes the same posture
    # for the HTTP ports; containers override with 0.0.0.0.
    temporal_metrics_host: str = "127.0.0.1"
    temporal_metrics_port: int = 9464

    # Sub-configs (loaded from their own env prefixes)
    temporal: TemporalConfig = Field(default_factory=TemporalConfig)
    # Granite Guardian safety + fail-closed PHI.
    safety: SafetyGuardConfig = Field(default_factory=SafetyGuardConfig)
    phi: PhiConfig = Field(default_factory=PhiConfig)
    # Institutional RAG: hybrid JIT retriever (flag-gated off).
    retrieval: RetrievalConfig = Field(default_factory=RetrievalConfig)
    # Claim-check: out-of-band blob store for the Temporal history budget.
    claim_check: ClaimCheckConfig = Field(default_factory=ClaimCheckConfig)
    # MCP external-tools client tuning (default OFF; the path is
    # gated on HarnessPolicy.mcpToolsEnabled + McpServer.enabled + workflow.patched).
    mcp: McpConfig = Field(default_factory=McpConfig)

    @field_validator("log_level")
    @classmethod
    def _normalise_log_level(cls, v: str) -> str:
        return v.lower()

    @field_validator("environment")
    @classmethod
    def _normalise_environment(cls, v: str) -> str:
        return v.strip().lower()

    @model_validator(mode="after")
    def _reject_memory_claim_check_outside_dev(self) -> Settings:
        """Fail fast when a real deploy would offload clinical blobs to the fake store.

        ``ClaimCheckConfig`` defaults to the process-local in-memory store, which is
        correct for the hermetic suite and single-worker local dev. In a deployed
        environment it is a data-loss bug: the store is a per-process singleton, so a
        cross-worker activity retry raises ``ClaimCheckNotFound`` and the offloaded
        transcript/prompt/note is simply gone. The class docstring says "a
        MULTI-worker deploy MUST set store=s3"; this enforces it.

        Cross-field, so it cannot live on ``ClaimCheckConfig`` — the deployment
        signal belongs to the parent. Development stays silent here; the worker
        logs a warning at boot instead (see ``harness.temporal.worker``).
        """
        if (
            self.environment in _DEPLOYED_ENVIRONMENTS
            and self.claim_check.enabled
            and self.claim_check.store == "memory"
        ):
            raise ValueError(
                f"claim-check offload is enabled with the in-memory store in "
                f"'{self.environment}'. A deployed harness MUST set "
                f"HARNESS_CLAIM_CHECK_STORE=s3 (plus the MinIO endpoint/credentials), "
                f"because the in-memory store is per-process and a cross-worker "
                f"activity retry would lose the offloaded clinical blob. Set "
                f"HARNESS_CLAIM_CHECK_ENABLED=false only if you accept unbounded "
                f"Temporal history growth."
            )
        return self


def get_settings() -> Settings:
    """Create a settings instance.  Not cached — call once at startup."""
    load_env()
    return Settings()


def get_runtime_judge_config() -> JudgeConfig:
    """Reuse the eval ``JudgeConfig`` (``HARNESS_JUDGE_*``) at harness runtime.

    The groundedness + reasoning judge is the **same** calibrated judge the
    eval gate uses — it is NOT re-declared under a new prefix. Construct the client
    with ``harness.eval.judge.providers.build_judge_client(get_runtime_judge_config())``.
    Imported lazily so ``core.config`` keeps no module-level dependency on ``eval``.
    """
    from harness.eval.config import get_judge_config

    return get_judge_config()
