"""Harness configuration using pydantic-settings.

Application settings use the ``HARNESS_`` env prefix; the Temporal substrate
uses the shared ``TEMPORAL_`` prefix so the address/namespace/task-queue are
configured once across the API gateway, the worker, and the FastAPI app.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from hope_env import first_real_secret, hope_settings_sources, load_env, real_secret
from pydantic import AliasChoices, Field, SecretStr, field_validator, model_validator
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

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
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


class PhiConfig(BaseSettings):
    """Pre-cloud-egress PHI redaction guard (Presidio + clinical NER), fail-closed.

    ``fail_closed`` is the load-bearing default: if the redactor cannot *confirm*
    PHI was removed (analyzer failure, missing model, etc.), egress to a cloud
    provider must be **blocked**, never silently allowed. ``local_providers`` is
    the allowlist of provider identifiers treated as **local, non-egress** calls —
    i.e. the ONLY providers the guard's ``ensure_safe_for_cloud(...)`` skips.
    Every other provider string, including one not yet in this list (an
    omission, drift, or a provider Text adds tomorrow), is treated as cloud
    egress and must clear redact-and-confirm before it leaves the box. This is
    a deliberate default-deny inversion: the list enumerates what is *known
    safe*, not what is *known unsafe*, so an unrecognized provider fails
    closed (redacts) rather than failing open (passes through unredacted).
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="HARNESS_PHI_")

    enabled: bool = True
    fail_closed: bool = True
    local_providers: list[str] = Field(
        default_factory=lambda: ["lm-studio", "openai_compat", "ollama", "vllm", "llama-cpp"]
    )

    @model_validator(mode="after")
    def _assert_local_providers_safe(self) -> PhiConfig:
        if self.enabled and not self.local_providers:
            raise ValueError(
                "Refusing to boot: HARNESS_PHI_ENABLED is true but "
                "HARNESS_PHI_LOCAL_PROVIDERS is empty. Under the default-deny egress "
                "policy an empty local-provider list redacts EVERY call, including "
                "genuinely local ones — almost certainly a misconfiguration "
                "(operator wiped the list) rather than an intended lockdown. Set at "
                "least the local providers actually in use, e.g. "
                "['lm-studio', 'vllm']."
            )
        if len(self.local_providers) != len({p.strip() for p in self.local_providers}):
            raise ValueError(
                "Refusing to boot: HARNESS_PHI_LOCAL_PROVIDERS contains duplicate entries."
            )
        if any(not p.strip() for p in self.local_providers):
            raise ValueError(
                "Refusing to boot: HARNESS_PHI_LOCAL_PROVIDERS contains a blank entry."
            )
        return self


class RetrievalConfig(BaseSettings):
    """Institutional-RAG hybrid retriever.

    The JIT retriever grounds generation in a tenant-owned knowledge corpus: a
    query built from the extracted entities is dense-embedded (self-hosted LM
    Studio ``/v1/embeddings``) **and** sparse-embedded (in-process fastembed
    ``Qdrant/bm25``), fused server-side via the Qdrant Query API
    (``prefetch(dense)`` + ``prefetch(sparse)`` -> ``FusionQuery(RRF)``)
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

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="HARNESS_RETRIEVAL_")

    # ── Why the ENDPOINTS below are still env, and stay env ─────────
    #
    # A.2 recorded that there was NO delivery path for an `AiProviderConnection` row
    # into this process, on three grounds: harness holds no DB handle (so
    # `resolveConnection` is unreachable); the retriever runs inside a Temporal
    # ACTIVITY with no gateway request to inject into; and `EffectiveConfigResponse`
    # carries `settings` + `modelWeights` only, with no `connections` block.
    #
    # THE THIRD GROUND STILL HOLDS AND THE FIRST TWO ARE NOW ROUTED AROUND.
    # The worker asks the gateway for ONE credential from inside
    # the activity that uses it — `GET /internal/harness/provider-credential`,
    # generalising the shipped `mcp-token` precedent — so a `vector:qdrant` row DOES
    # reach this process now. See `harness/core/provider_credentials.py` for why that
    # shape was chosen over snapshotting onto the workflow input (Temporal history is
    # durable) or extending the platform-scope pull (the D-1 cardinality failure).
    #
    # What that changed and what it did NOT:
    #
    #   * `qdrant_api_key` (below) is now BYO-only — its env path is CLOSED, and the
    #     value arrives from the connection row, tenant → SYSTEM.
    # * The ENDPOINTS stay env. Rule 09 Tiers puts a transport
    #     address in the `env` tier by name, and rule 06 calls a `*_URL` default "the
    #     ONE sanctioned kind of hardcoded default" (see `guardrail_base_url` below).
    #     These are one platform Qdrant and one platform TEI reranker; where a TENANT
    #     brings its own Qdrant cluster, its `base_url` rides its OWN connection row
    #     and overrides `qdrant_url` for that tenant only — which is the tenant-first
    #     rule satisfied, not bypassed.
    #   * `embeddings_*` NO LONGER matches that description (TASK-952 D-1c). A tenant
    #     CAN now hold an opinion — `AiProviderConnection(service='embeddings')` was a
    #     write-only console surface that nothing resolved — so the embeddings endpoint,
    #     key and model resolve through the SAME per-activity gateway pull as the Qdrant
    #     credential, and the fields below are the PLATFORM floor an absent row falls to.
    #     `reranker_*` is untouched: no tenant opinion exists for it today, so by D-1's
    #     cardinality rule it is still correctly env-tiered.
    #
    # The landmine A.2 cited is still live and still worth heeding: a KEYLESS row
    # injects on NEITHER tier. That is now a DEFINED outcome (`absent` ⇒ call the
    # endpoint unauthenticated) rather than a silent no-op.
    enabled: bool = False
    qdrant_url: str = "http://localhost:6333"
    # Qdrant ships with NO authentication. Unauthenticated is
    # correct for local dev; in-cluster it means any pod in the namespace can
    # read or delete the tenant knowledge corpus. SecretStr because the settings
    # object is logged at startup. Default None, not "" — an empty string is
    # itself a credential to Qdrant, so absent must mean absent.
    #
    # ── BYO-only credential ─────────────────────────────
    # The key moved onto `AiProviderConnection(service='vector',
    # provider='qdrant')` — Qdrant Cloud is a real per-tenant subscription, so
    # `vector:qdrant` is listed in `CLOUD_BYO_PROVIDERS` and a tenant may point
    # the plane at its own cluster with its own key; the SYSTEM row is the
    # platform Qdrant fallback.
    #
    # The env path is CLOSED STRUCTURALLY (dead `validation_alias`,
    # `populate_by_name` OFF for this class) rather than merely discouraged.
    # The field itself STAYS, and stays wired to `KnowledgeQdrantStore` at both
    # construction sites: it is now populated by INJECTION only — `model_copy`
    # from the gateway-resolved credential — which bypasses validation and this
    # guard. Deleting it would remove the only way to authenticate to Qdrant,
    # which is the defect a previous lane just finished fixing.
    #
    # `None`, never `""` — an empty string is itself a credential to Qdrant, so
    # absent must mean absent (the `KnowledgeQdrantStore` unauthenticated path).
    qdrant_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="HARNESS_RETRIEVAL_QDRANT_API_KEY__ENV_REMOVED",
    )
    # The PLATFORM's collection. A tenant that brings its own Qdrant may prefix it
    # from its own connection row (`extraJson.collection`, the console's
    # "Collection prefix"); the derivation lives in ONE place
    # (`provider_credentials.apply_vector_credential`) so ingest, retrieval and
    # delete can never disagree about which collection a tenant's vectors are in.
    collection: str = "knowledge_chunks"
    # ── The embeddings endpoint: platform floor, tenant override ────
    #
    # Same two-tier shape as `qdrant_url` / `qdrant_api_key` above, and for the
    # same reasons. These three fields DESCRIBE THE ENDPOINT THE PLATFORM RUNS —
    # one self-hosted OpenAI-compatible server (LM Studio), whose address is an
    # `env`-tier transport value by rule 09 §Configuration Tiers. A TENANT that
    # brings its own embeddings account overrides all three from its OWN
    # `AiProviderConnection(service='embeddings', provider='openai')` row, which
    # is the tenant-first rule satisfied, not bypassed.
    #
    # `embeddings_model` and `embeddings_dim` are ONE coupled description: the dim
    # MUST match the loaded model AND the Qdrant collection. They nevertheless
    # live in DIFFERENT tiers, and the split is deliberate — the model is a
    # SELECTION and resolves from the connection row (tenant → platform); the dim
    # is a property of the Qdrant collection, which no connection row can
    # declare, so it stays here. A row that pins a different-dimension model gets
    # a Qdrant dimension rejection (visible, degrade-safe) rather than silently
    # wrong vectors. Keep them adjacent.
    embeddings_base_url: str = "http://localhost:1234/v1"
    # ── The MODEL is a SELECTION, so it is neither a literal nor an env var ────
    #
    # D-1c retired `"text-embedding-bge-m3"` and the
    # `HARNESS_RETRIEVAL_EMBEDDINGS_MODEL` variable that carried it. Rule 09
    # §"No hardcoded configuration" is explicit that a model id is CONFIG and is
    # not an env var, and rule 00 names "a `pydantic-settings` field with a real
    # default" as the exact shape of the violation. Its home is
    # `AiProviderConnection.extraJson.model` — the TENANT's on its own
    # `embeddings:openai` row, the PLATFORM's on the SYSTEM
    # `embeddings:tei-embed` row the seed writes (`BAAI/bge-m3`).
    #
    # The env path is CLOSED STRUCTURALLY (dead `validation_alias`;
    # `populate_by_name` is OFF for this class), like the two credentials below,
    # so the field is written by `model_copy` INJECTION only
    # (`provider_credentials.apply_embeddings_credential`).
    #
    # Unresolved is FAIL-CLOSED, not "pick something": selection is
    # `failMode: closed`, and `provider_credentials.require_embeddings_model`
    # raises `CredentialUnavailable` so the retriever degrades visibly rather
    # than embedding a corpus with one model and its queries with another.
    embeddings_model: str | None = Field(
        default=None,
        validation_alias="HARNESS_RETRIEVAL_EMBEDDINGS_MODEL__ENV_REMOVED",
    )
    # Dense vector dimension — MUST match the loaded model AND the Qdrant
    # collection, which is why it did NOT follow the model onto the connection
    # row: the dim describes the COLLECTION as much as the model, and a
    # connection row has nowhere to declare one. It therefore stays an env-tier
    # sizing knob. A row that pins a different-dimension model gets a Qdrant
    # dimension rejection — visible and degrade-safe — which is the same outcome
    # the field comment above already promised for a tenant BYO model.
    embeddings_dim: int = 1024
    # ── BYO-only credential ─────────────────────────────
    # The platform's own embeddings server authenticates nobody, so this is `None`
    # by default and the client calls it unauthenticated. A tenant's cloud
    # embeddings account carries a real key, and it arrives the SAME way the Qdrant
    # key does — by `model_copy` injection from a gateway-resolved connection row,
    # never from the environment. The env path is CLOSED STRUCTURALLY (dead
    # `validation_alias`; `populate_by_name` is OFF for this class), so
    # "fall back to env" is not a reachable behaviour for a credential.
    #
    # `None`, never `""` — an empty string is itself a bearer value, so absent
    # must mean absent (see `_empty_api_key_is_absent`).
    embeddings_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="HARNESS_RETRIEVAL_EMBEDDINGS_API_KEY__ENV_REMOVED",
    )
    # HF Text-Embeddings-Inference reranker root (cross-encoder ``/rerank``).
    reranker_base_url: str = "http://localhost:8870"
    # Hybrid knobs: dense+sparse prefetch limit -> RRF fusion -> cross-encoder rerank.
    top_k_retrieval: int = 20
    top_k_rerank: int = 5
    embeddings_timeout_s: float = 30.0
    reranker_timeout_s: float = 30.0
    qdrant_timeout_s: float = 10.0

    @field_validator("qdrant_api_key", "embeddings_api_key", mode="before")
    @classmethod
    def _empty_api_key_is_absent(cls, v: object) -> object:
        """An empty env var means ABSENT, not "the empty credential".

        `.env.dev`/`.env.sample` spell an unset optional as `KEY=`, which pydantic
        would otherwise bind as `SecretStr("")` — and "" is itself a credential to
        Qdrant, so it must never reach the client (see the field comment above and
        `KnowledgeQdrantStore`'s `api_key=None` unauthenticated path).
        """
        if v is None:
            return None
        raw = v.get_secret_value() if isinstance(v, SecretStr) else v
        return None if isinstance(raw, str) and raw == "" else v

    @field_validator("embeddings_dim", "top_k_retrieval", "top_k_rerank")
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

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
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
    # ⚠️ DELIBERATE, REVERSIBLE SECURITY RELAXATION (owner ruling 2026-08-30).
    # Defaults to False — the object store's TLS certificate is NOT verified.
    # There is no private CA, MinIO serves HTTPS with a certificate nothing here
    # can chain to a trusted root, and MinIO authenticates with a SERVICE
    # ACCOUNT (access key + secret) rather than the certificate; defaulting to
    # "verify" would fail every claim-check read and write closed. PHI hardening
    # is explicitly de-prioritised for now — grep `MINIO_CERT_CHECK` for every
    # consumer (here, apps/stt, apps/api) to revert when a CA lands.
    #
    # `validation_alias` deliberately ESCAPES the `HARNESS_CLAIM_CHECK_` prefix:
    # this is one platform-wide trust decision about one object store, and it is
    # the same bare variable apps/stt reads and `turbo.json#globalEnv` declares.
    # A `HARNESS_CLAIM_CHECK_CERT_CHECK` of its own would be a second knob that
    # can disagree with the first about a single fact.
    # `AliasChoices` and not a bare `validation_alias`: the alias REPLACES the
    # field name for init as well as for env lookup, so `ClaimCheckConfig(
    # cert_check=...)` (tests, and any direct construction) would be rejected as
    # an extra field. Listing both keeps the platform variable authoritative and
    # the field constructible by name.
    cert_check: bool = Field(
        default=False, validation_alias=AliasChoices("MINIO_CERT_CHECK", "cert_check")
    )
    # There is deliberately no `ttl_seconds` here. It was declared as an "advisory blob
    # lifetime (a bucket lifecycle rule enforces expiry out-of-band)" and read by NOTHING
    # — the expiry really is enforced by the object store, so the field was documentation
    # wearing a config costume, and an admin slider wired to it would control nothing.
    # `test_task799_claim_check_config.py` keeps it gone.
    #
    # `bucket` / `endpoint_url` / `region` / `secure` above are the storage LOCATION and
    # are now BOOTSTRAP FLOOR ONLY. The admin-managed source of truth is
    # the `storage.platformDefault.*` cascade (the SYSTEM `TenantStorageConfig` row) —
    # the claim-check store IS platform object storage, so it must not be described a
    # second time here (D-2). `temporal/claim_check.py:resolve_claim_check_location`
    # applies the cascade over these values; a degraded control plane leaves them in
    # force, which is what makes the migration behaviour-neutral. Do not tune the
    # deployed store by editing these — set the platform row.

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

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
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

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
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

    # ── CANONICAL internal credential (owner decision D-D, 2026-08-17) ──────
    # ONE shared access token for ALL internal service-to-service communication,
    # identical across every HOPE service, set by the DevOps engineer, internal use
    # only. Unprefixed on purpose (`validation_alias` bypasses the env_prefix) —
    # it belongs to no single service. This is what the service ACCEPTS inbound as
    # `X-Service-Token` and PRESENTS on every outbound peer call.
    # The legacy per-service token below stays accepted / used as a zero-cost
    # backward-compatibility fallback; both empty ⇒ auth bypassed (dev / CI).
    internal_access_token: SecretStr = Field(
        default=SecretStr(""), validation_alias=AliasChoices("INTERNAL_ACCESS_TOKEN")
    )

    # LEGACY per-service credential (empty = auth disabled for local dev).
    # This is HARNESS_SERVICE_TOKEN: it guards the inbound internal endpoints AND
    # is the ``X-Service-Token`` the api_client presents to apps/api when the
    # shared INTERNAL_ACCESS_TOKEN above is unset.
    service_token: SecretStr = SecretStr("")

    @property
    def accepted_service_tokens(self) -> tuple[str, ...]:
        """Every token accepted as inbound ``X-Service-Token``, shared token first.

        Empty tuple ⇒ auth is bypassed (local dev / hermetic CI) — the pre-existing
        behaviour when no token is configured at all.
        """
        # `real_secret` maps the unfilled-secret sentinel onto "" so a `CHANGE_ME` token is
        # never ACCEPTED as a credential — see hope_env.placeholders.
        return tuple(
            t
            for t in (
                real_secret(self.internal_access_token),
                real_secret(self.service_token),
            )
            if t
        )

    def peer_service_token(self, legacy: SecretStr | None = None) -> str:
        """Token to PRESENT on an outbound peer call: shared first, legacy fallback.

        TASK-941 R3 — `legacy` is OPTIONAL now. The three per-TARGET fallbacks
        (`text_service_token`, `nlp_service_token`, `guardrail_service_token`) are
        retired: their env names were set in no cluster manifest and were empty in
        `.env.dev`, while all three targets accept the shared token, so
        `first_real_secret` already returned the shared one at every such site.
        The parameter survives for the hop that still HAS a legacy credential —
        harness→apps/api, which passes `service_token` (and that field is also
        harness's own inbound guard, so it is not retirable).
        """
        # `first_real_secret`, not `or`: the sentinel is a NON-EMPTY string, so a plain
        # truthiness chain returns "CHANGE_ME" and never reaches the legacy fallback — the
        # trap that made every internal hop 401 (see hope_env.placeholders).
        return first_real_secret(self.internal_access_token, legacy)

    # Dedicated token for the institutional-knowledge ingest
    # endpoint (``POST /internal/knowledge/ingest``). The ingest guard accepts an
    # ``X-Service-Token`` matching THIS secret OR the shared ``service_token``;
    # empty (and an empty shared token) disables the guard for local dev. The
    # BullMQ ingest processor presents this as the ingest contract's token.
    internal_service_token: SecretStr = SecretStr("")

    # Redis — ONE job: the `arca:config:invalidate` subscriber that makes a
    # control-plane write reach this process without waiting out the 60s TTL
    # ( A.3 / owner decision D-5). harness stores nothing in Redis and queues
    # nothing through it; its durable state is Temporal's.
    #
    # ENV-TIER and staying that way: this is how the process REACHES Redis, which is
    # exactly the bootstrap floor rule 09 reserves for env — a value delivered over the
    # channel it configures could never bootstrap itself. Unreachable ⇒ the service
    # still boots and still converges on the TTL backstop.
    redis_url: str = "redis://localhost:6379/0"

    # -- Loop / gate-adapter --------------------------------------------------
    # Tool-service base URLs the durable loop calls out to.
    text_base_url: str = "http://localhost:8862"
    nlp_base_url: str = "http://localhost:8864"
    api_base_url: str = "http://localhost:8868"
    # TASK-941 R3 — `text_service_token`, `nlp_service_token` and
    # `guardrail_service_token` were here: harness's own copies of each target's
    # inbound secret, presented as X-Service-Token on the outbound hop. Owner
    # decision D-D made the shared INTERNAL_ACCESS_TOKEN the credential and kept
    # these "only as the fallback for an environment that has not been migrated
    # yet"; that migration is complete, verified before deleting them — their env
    # names appear in NO cluster manifest, they were empty-valued in `.env.dev`,
    # and apps/{text,nlp,guardrail} all accept the shared token. So
    # `first_real_secret(shared, legacy)` already resolved to the shared token at
    # every one of those sites and this removal is behaviour-neutral.
    #
    # `service_token` (above) is deliberately NOT in that set: it is harness's own
    # INBOUND guard and the token the api_client presents to apps/api, and the
    # cluster still sets it.
    #
    # NOTE the blank line below: `scripts/python-env-surface.py` harvests the
    # contiguous `#` block directly above a field as that field's DESCRIPTION in the
    # generated `.env.sample`. Without the separator this tombstone becomes
    # `guardrail_base_url`'s documentation in an operator-facing artifact.

    # Peer service — the summarization palette's `guardrail.check` node calls
    # apps/guardrail directly, mirroring the established `text_base_url`/`nlp_base_url` bootstrap-
    # floor pattern (rule 09 §Configuration Tiers: a `*_URL` transport address is the ONE
    # sanctioned kind of hardcoded default). `X-Tenant-Id` is mandatory on every call.
    guardrail_base_url: str = "http://localhost:8863"
    # apps/api internal-harness mount. ``HarnessInternalController`` sits
    # under the global ``/api/v1`` prefix (``@Controller('internal/harness')``), so
    # the live, out-of-the-box mount is ``/api/v1/internal/harness``. Override via
    # ``HARNESS_API_INTERNAL_PREFIX`` if the gateway prefix ever changes.
    api_internal_prefix: str = "/api/v1/internal/harness"

    # Gateway-internal consent-assert mount.
    # A SIBLING of api_internal_prefix (``ConsentInternalController`` is
    # `@Controller('internal/consent')`, not nested under `internal/harness`),
    # so it gets its own prefix rather than reusing the harness one.
    consent_internal_prefix: str = "/api/v1/internal/consent"
    # TTL for `ConsentClient`'s per-(tenant, patient, purpose) cache — a
    # bounded-staleness BACKSTOP, not the propagation mechanism (mirrors
    # `.claude/rules/09-infrastructure-devops.md` §Config caches rule 2; this
    # phase has no cross-process invalidation channel for the harness worker,
    # a disclosed, TTL-bounded scope choice — see consent-design.md). Mirrors
    # the TS-side ConsultationConsentService cache TTL (30s).
    consent_cache_ttl_seconds: int = 30

    # Bounded-regen budget + clinician-gate timing (durable, deterministic).
    max_regen: int = 2
    gate_sla_seconds: float = 86_400.0  # 24h until the first SLA escalation
    gate_escalation_seconds: float = 43_200.0  # re-escalate every 12h until sign-off

    # Optimistic two-phase delivery kill-switch. The FIRST
    # key of the two-key optimistic gate; the second is the durable
    # ``workflow.patched`` marker (permanent in code).
    # Read here, in NON-workflow settings, and snapshotted into ``HarnessGateConfig``
    # at workflow start (document:start + the policy merge), so it stays deterministic
    # across replay — never read from env inside the workflow body. Default OFF ⇒ the
    # legacy single-phase path, byte-identical to before optimistic delivery.
    optimistic_delivery_enabled: bool = False

    # ``ner_priors_enabled`` / ``atomic_fact_enabled`` (``HARNESS_NER_PRIORS_ENABLED`` /
    # ``HARNESS_ATOMIC_FACT_ENABLED``) were here as env FALLBACKS for the SUPER_ADMIN_ONLY
    # ``HarnessPolicy.{nerPriorsEnabled,atomicFactEnabled}`` columns. TASK-882 removed them:
    # the activities read the column off the effective policy threaded onto their input, and
    # a null column is the code default (OFF) — see ``extract_entities`` and
    # ``run_inferential_sensors``.

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

    # Text generation defaults (None => let the Text service choose).
    text_provider: str | None = None
    text_model: str | None = None
    conversation_language: str = "en"

    # Per-PEER-CALL httpx timeouts, read by the clients this process builds.
    #
    # There are deliberately NO `HARNESS_ACTIVITY_START_TO_CLOSE_S`,
    # `HARNESS_ACTIVITY_MAX_ATTEMPTS` or `HARNESS_GENERATE_MAX_ATTEMPTS` knobs.
    # They were declared here, advertised in `.env.sample` and `turbo.json`, and read by
    # NOTHING: Temporal activity timeouts and retry policies are module-level constants
    # in `temporal/workflows.py` (`_INFERENTIAL_TIMEOUT`, `_INFERENTIAL_RETRY`,
    # `_GENERATE_RETRY`) and MUST be, because a workflow body may not read env — that is
    # the determinism rule 06 states. Wiring them would break replay; the honest fix is
    # that they are gone. `test_task799_dead_settings.py` keeps them gone.
    text_timeout_s: float = 120.0
    nlp_timeout_s: float = 30.0
    api_timeout_s: float = 30.0
    guardrail_timeout_s: float = 30.0

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

    # NOTE: there is no `llm_request_timeout_s` field here. `HARNESS_LLM_REQUEST_TIMEOUT_S`
    # is real and live — its reader is `core/llm_concurrency.py` (`LlmGovernorConfig`),
    # which reads the environment directly. This class carried a SECOND declaration of the
    # same knob that nothing read; two declarations of one setting is how a value and its
    # documentation drift apart, so the unread one is gone.

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
        """The pre-TASK-987 gate: the master switch AND a configured collector endpoint.

        ``otel_enabled`` alone is not enough — flipping it on with no endpoint
        set must stay a no-op (never require a reachable collector to
        start). ``temporal/client.py`` still reads this property for its
        ``TracingInterceptor`` wiring, deliberately left untouched by TASK-987.
        The FastAPI app and the worker no longer do: since TASK-987, both build
        their ``hope_obs.ObservabilityConfig`` from ``otel_exporter_endpoint``
        directly (endpoint presence alone is the enable signal — R-2), with
        ``otel_enabled=False`` honoured for one release as a deprecated VETO —
        see ``core/observability.py::build_observability_config``.
        """
        return self.otel_enabled and bool(self.otel_exporter_endpoint)

    # Observability — traces. Prometheus metrics + the
    # trajectory spine cover most of the observability need, but neither one
    # replaces distributed tracing across FastAPI request handling and the
    # Temporal workflow/activity spans. TASK-987 moved the tracer/log
    # implementation into the shared `hope_obs` package; `core/observability.py`
    # now only maps `Settings` onto `hope_obs.ObservabilityConfig` (default OFF),
    # after which every log line carries the active trace/span id.
    #
    # Default OFF and requires an explicit endpoint (not just the flag) — a
    # bare ``HARNESS_OTEL_ENABLED=true`` with no collector configured must not
    # change startup behaviour. See ``otel_tracing_enabled`` below.
    otel_enabled: bool = False
    otel_exporter_endpoint: str = ""
    otel_service_name: str = "harness"
    otel_service_namespace: str = "hope"
    # Resolved from the environment, and defaulting to
    # DEVELOPMENT — never "production".
    #
    # This is the same defect that was fixed in `apps/stt/core/telemetry.py`
    # in this ticket: a hardcoded "production" tags a developer laptop's spans
    # as production data. That is the dangerous direction — a mislabelled dev
    # span is noise, a mislabelled prod span corrupts an audit trail.
    #
    # Precedence matches STT and the OTel collector: DEPLOYMENT_ENVIRONMENT
    # (what the k8s overlays patch) then NODE_ENV (the repo-wide selector,
    # ) then "development".
    otel_deployment_environment: str = Field(
        default_factory=lambda: os.getenv("DEPLOYMENT_ENVIRONMENT")
        or os.getenv("NODE_ENV")
        or "development"
    )

    @field_validator("otel_deployment_environment", mode="before")
    @classmethod
    def _blank_environment_resolves(cls, v: object) -> object:
        """An empty `HARNESS_OTEL_DEPLOYMENT_ENVIRONMENT=` re-enters the chain.

        A bound "" would win over the default_factory and tag every span with an
        EMPTY environment — the same class of defect as a hardcoded "production",
        just failing the other way: unattributable spans instead of mislabelled
        ones. `.env.dev` and `.env.sample` both ship the key blank, which is how
        they spell "let the service resolve it".
        """
        if isinstance(v, str) and v.strip() == "":
            return os.getenv("DEPLOYMENT_ENVIRONMENT") or os.getenv("NODE_ENV") or "development"
        return v

    otel_insecure: bool = True

    metrics_enabled: bool = True

    # Bind address for the Temporal SDK's Prometheus exporter in the WORKER
    # process. Separate from the FastAPI app's:8866 — the
    # worker is its own process and shares no HTTP server with it.
    #
    # Loopback by default: this is a PHI-processing service and must not become
    # LAN-reachable by accident. `scripts/dev-service.sh` takes the same posture
    # for the HTTP ports; containers override with 0.0.0.0.
    temporal_metrics_host: str = "127.0.0.1"
    temporal_metrics_port: int = 9464

    # Sub-configs (loaded from their own env prefixes)
    temporal: TemporalConfig = Field(default_factory=TemporalConfig)
    # Fail-closed PHI redaction. There is deliberately NO `safety` sub-config: the
    # content-safety screen is DELEGATED to `apps/guardrail` over `guardrail_base_url`
    # ( A.1 / F-02), so harness holds no guardian provider, endpoint, model id
    # or harm-criteria taxonomy of its own. Do not reintroduce one — rule 06,
    # "Do not grow a second inference stack".
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
