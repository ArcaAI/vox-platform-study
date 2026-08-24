"""Guardrail configuration using pydantic-settings."""

from __future__ import annotations

from hope_env import first_real_secret, hope_settings_sources, load_env, real_secret
from pydantic import AliasChoices, BaseModel, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class JudgePolicy(BaseModel):
    """Policy + tuning for the delegated LLM judgement (TASK-735 Phase 2b).

    Deliberately a plain ``BaseModel``, NOT ``BaseSettings``: none of these is an
    env var. Guardrail's five engine sub-configs used to live here — six
    six hardcoded model defaults, four vendor ``base_url``s and an
    ``api_key`` literal — and every one of them was configuration wearing an env
    costume (`.claude/rules/00-project-context.md` §Configuration Principles).
    Engine, model and credential now come from the control plane: the
    provider/model pair from ``AiTaskDefault`` (tenant row first, SYSTEM as the
    platform fallback) and the credential from the tenant's ``llm``
    ``AiProviderConnection``, forwarded as an opaque ``provider_overrides`` blob.

    What is left is POLICY (the confidence floor a verdict must clear) and pool
    TUNING. These become ``guardrail.policy.*`` ``SettingDescriptor``s in Phase 4;
    that half is blocked on the missing tenant-cascade read surface for
    ``db-config`` keys (README §6b G-01), so they sit here as code defaults —
    which is strictly better than the env surface they replaced, and reachable
    from exactly one place when the descriptors land.
    """

    # Selection knobs the runtime profile may still override per provider.
    temperature: float = 0.05
    max_tokens: int = 300
    timeout_s: float = 60.0

    # A verdict below this confidence is logged, never silently trusted.
    min_confidence: float = 0.75

    # Guardrail owns the retry budget by contract: `text`'s judge route runs zero
    # retries so a public generation never waits behind a compounding backoff.
    max_attempts: int = 2
    retry_backoff_s: float = 0.1

    # The judge sees a bounded prefix — a validation is a classification, not a read.
    max_input_chars: int = 2000


# There is deliberately NO `GlinerConfig`. Guardrail hosts no GLiNER runtime
# (TASK-735 Phase 3): content-safety classification and PII span extraction are
# delegated to `apps/nlp`, which owns NER/classification for the platform. The
# model ids and the four label taxonomies that used to live in `providers/gliner.py`
# are CONFIG: they are SYSTEM-tenant `AiModel` rows (`guardrail.safety` /
# `guardrail.pii`), resolved tenant-first and fail-closed. Thresholds that remain
# POLICY reach the analyzer through `SafetyPolicy`, never through env.


class TransportPolicy(BaseModel):
    """Pool, timeout and saturation bounds for the one shared peer client.

    A plain ``BaseModel``, NOT ``BaseSettings``, for the same reason
    :class:`JudgePolicy` is: none of this is an env var. It is the shape of the
    service's own back pressure, and TASK-735 §6b G-06 recorded the standing
    objection to spelling exactly these knobs as five new ``*_MAX_CONCURRENT`` /
    ``*_TIMEOUT_S`` environment variables. Code defaults with one reachable
    definition site are strictly better, and become ``guardrail.transport.*``
    ``SettingDescriptor``s when the tenant-cascade read surface for ``db-config``
    keys lands (G-01).

    **Every timeout phase is explicit** (TASK-777 B-1). The previous
    ``httpx.Timeout(300.0)`` was one scalar applied to all four phases, so a peer
    that accepted a connection and then stalled held a pool slot for five minutes
    — and with no POOL timeout, the 101st concurrent request waited on pool
    acquisition indefinitely rather than being told the service was full.
    """

    # --- httpx pool ---
    max_connections: int = 200
    max_keepalive_connections: int = 100
    keepalive_expiry_s: float = 30.0

    # --- httpx timeouts, per phase ---
    connect_timeout_s: float = 3.0
    read_timeout_s: float = 60.0
    write_timeout_s: float = 10.0
    #: Bounded on purpose: pool exhaustion must surface as a fast, DECLARED
    #: rejection, never as an unbounded wait.
    pool_timeout_s: float = 5.0

    # --- admission control ---
    #: Concurrent screening/analysis requests admitted. Sized for >= 100 concurrent
    #: consultation sessions with headroom; work past it queues, briefly, then 503s.
    max_concurrent_requests: int = 256
    #: Queue-wait ceiling. Past this the caller is TOLD (503 + Retry-After).
    max_queue_wait_s: float = 5.0
    #: Fan-out bound for one caller-supplied batch — never an unbounded `gather`.
    max_batch_concurrency: int = 16

    # --- per-peer circuit breakers ---
    breaker_failure_threshold: int = 5
    breaker_recovery_timeout_s: float = 15.0


class GroundednessConfig(BaseModel):
    """Live output-side NLI groundedness POLICY.

    ``False`` (default) is the dev / hermetic-CI bypass — the gate answers honestly
    with ``unverified`` verdicts and loads nothing; ``True`` is the clinical enforce
    posture. Fail posture is FAIL-CLOSED throughout: a disabled gate, an unreachable
    `apps/nlp`, or a scoring error all degrade to ``unverified`` — no path ever
    yields ``grounded`` without a model actually entailing the segment.

    TASK-735 Phase 6 — the MiniCheck GGUF, its weight path, its cache dir and its
    llama.cpp runtime knobs (``model_id``, ``model_file``, ``model_path``,
    ``model_cache_dir``, ``n_ctx``, ``n_threads``, ``n_gpu_layers``) are GONE from
    here. The weights now live in `apps/nlp`, and the model identity is the
    `guardrail.groundedness` `AiTaskDefault` selection — resolved per request,
    tenant-first, fail-closed. What is left is the POLICY guardrail owns: whether
    the gate is on, what score counts as grounded, and how much it will score.

    TASK-799 lane D — **none of that POLICY is env-reachable any more**, and this
    class holds no field at all. It survives as the runtime carrier that
    `GroundednessNliVerifier` reads, populated from the two config planes:

    * ``enabled`` / ``batch_size`` / ``max_segments`` ride the control-plane pull
      route (`guardrail.groundedness.*`, `global-kv`, `consumedBy: ['guardrail']`),
      because they are platform-scope service geometry with no tenant opinion —
      D-1's cardinality rule puts exactly that class on PULL;
    * ``entailment_threshold`` rides `AiModel._metadata.policy`
      (`groundednessEntailmentThreshold`), because it is MODEL-COUPLED: it
      thresholds the scores of the specific NLI checkpoint the selection resolved.

    The split is forced, not stylistic. Putting ``enabled`` on the model row would
    be circular — it decides whether the selection is resolved at all — and putting
    the threshold on the platform route would let it drift away from the checkpoint
    it calibrates.

    ``enabled`` still defaults to ``False``: a safety gate is never switched on by
    silence, so a control plane with no opinion leaves it off.
    """

    # Not a `BaseSettings` any more — there is nothing left for env to reach.
    enabled: bool = False
    entailment_threshold: float = 0.5
    batch_size: int = 16
    max_segments: int = 200


class RedisConfig(BaseSettings):
    """Redis configuration for job queue and caching."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_REDIS_")

    # `redis_url` is the whole surface: the job plane's TTLs and stream bound
    # were declared here and never read by anything (TASK-799 F-13).
    #
    # The alias is not decoration. `env_prefix="GUARDRAIL_REDIS_"` + a field
    # named `redis_url` resolves to `GUARDRAIL_REDIS_REDIS_URL` — a stuttering
    # name nothing sets. Every operator-facing file says `GUARDRAIL_REDIS_URL`
    # (`.gitlab/ci/test.yml:695` even wires it to `$CI_REDIS_URL`), so the
    # documented name has never actually reached this service and CI has been
    # silently testing against the localhost default. Found by the Python drift
    # gate added in TASK-799 Phase 1.5; the stuttering form stays accepted so
    # nothing that DID set it breaks.
    redis_url: str = Field(
        default="redis://localhost:6379/0",
        validation_alias=AliasChoices("GUARDRAIL_REDIS_URL", "GUARDRAIL_REDIS_REDIS_URL"),
    )


class QueueConfig(BaseSettings):
    """Job queue configuration."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_V2_QUEUE_")

    # Concurrent async analyse jobs — the ONLY field here with a reader
    # (`main.py`). Lived on the deleted engine sub-config
    # (`settings.engine.max_concurrent`), which made a queue bound look like an
    # engine knob; it is the job queue's own limit. The wait/retry/backoff/batch
    # quartet that sat alongside it had no reader at all (TASK-799 F-13);
    # admission waiting is `transport.max_queue_wait_s`, which IS read.
    max_concurrent: int = 4


class DatabaseConfig(BaseSettings):
    """Per-tenant config DB access.

    The service resolves the admin-chosen guardrail provider/model **per tenant**
    at request time by reading ``core."AiTaskDefault"`` ⋈ ``core."AiModel"``
    directly (SQLAlchemy + asyncpg, mirroring STT), with a short TTL cache. This
    is the sanctioned transport exception in `06-python-services.md`: guardrail's
    callers are peer services, not the gateway, so there is nothing to inject
    config for it — and it covers the TRANSPORT only, never a SYSTEM-only lookup
    or an env-owned engine.

    There is no longer a switch that turns this off. See ``db_config_enabled``
    below for why the one that existed was deleted.
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_")

    # Enabled by default: the resolver (get_resolved_guardian_provider in
    # core/dependencies.py) fails CLOSED (HTTP 503) when the SYSTEM
    # `db_config_enabled` is GONE (TASK-799 lane D, §D.2d).
    #
    # It was the last survivor of the era when guardrail could select an engine
    # from env. Since TASK-735/736 deleted that plane, its only non-default value
    # bypassed DB resolution while guardrail names no engine in code — so every
    # route that needs a selection answered 503 outright. A knob whose "off"
    # position bricks the service is not configuration, it is a fault injector
    # with a settings name, and leaving it declared invited an operator to reach
    # for it during exactly the incident it would deepen.
    #
    # Removing it does not remove a capability: DB config is how this service
    # works. The failure it used to express — the DB is unreachable — is already
    # modelled honestly by `TenantConfigUnavailableError` (503, and NOT cached as
    # "no tenant opinion", so a stricter tenant is never downgraded to the
    # platform floor).

    # Read-only connection string to the shared HOPE core DB.
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/hope"

    # There is deliberately NO `default_tenant_id`. The runtime cascade is
    # exactly request tenant → SYSTEM (`00000000-…`), and SYSTEM is the DECLARED
    # widening target inside the resolver, not a configurable knob. The retired
    # `GUARDRAIL_DEFAULT_TENANT_ID` defaulted to `50000000-…`, which is the
    # "Global" CUSTOMER tenant (a platform-admin playground) — so every tenant
    # without its own rows was served one customer's safety configuration. See
    # `core/tenant_config.py`'s module docstring.

    # TTL (seconds) for the resolved per-tenant config cache (OQ2 ~60s).
    config_cache_ttl_s: int = 60

    pool_size: int = 5
    max_overflow: int = 10

    @field_validator("database_url", mode="before")
    @classmethod
    def _normalize_database_url(cls, v: str) -> str:
        """Normalize Prisma-style postgres:// URLs to asyncpg form.

        Mirrors STT: convert ``postgres://``/``postgresql://`` to
        ``postgresql+asyncpg://`` and strip the Prisma-only ``?schema=`` param
        that asyncpg rejects.
        """
        if not isinstance(v, str):
            return v
        if v.startswith("postgres://"):
            v = v.replace("postgres://", "postgresql+asyncpg://", 1)
        elif v.startswith("postgresql://") and "+asyncpg" not in v:
            v = v.replace("postgresql://", "postgresql+asyncpg://", 1)

        from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

        parsed = urlparse(v)
        if parsed.query:
            params = parse_qs(parsed.query)
            params.pop("schema", None)
            v = urlunparse(parsed._replace(query=urlencode(params, doseq=True)))
        return v


class Settings(BaseSettings):
    """Root application settings."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="GUARDRAIL_V2_")

    # There is deliberately NO `provider` engine selector and no engine
    # sub-config. Guardrail hosts no LLM: judgement is delegated to `apps/text`,
    # which owns the eleven provider adapters, the BYOK credential plane and the
    # circuit breakers. The provider/model pair is DB-resolved per tenant and
    # fails CLOSED when unresolved — there is no env engine to fall back to.

    # Where `apps/text` lives. BOOTSTRAP TRANSPORT (an address), not config
    # authority — read from the repo-wide `TEXT_URL`, so guardrail adds no env
    # var of its own.
    text_url: str = Field(
        default="http://localhost:8862",
        validation_alias=AliasChoices("TEXT_URL", "GUARDRAIL_V2_TEXT_URL"),
    )

    # Where `apps/nlp` lives — guardrail's classification/NER executor after
    # TASK-735 Phase 3. BOOTSTRAP TRANSPORT (an address), not config authority:
    # read from the repo-wide `NLP_URL`, so guardrail adds no env var of its own.
    nlp_url: str = Field(
        default="http://localhost:8864",
        validation_alias=AliasChoices("NLP_URL", "GUARDRAIL_V2_NLP_URL"),
    )

    # The `s3://` model-source bootstrap credentials are GONE (Phase 6): weight
    # staging moved to `apps/nlp` together with the weights themselves.

    # Application
    host: str = "0.0.0.0"
    # `GUARDRAIL_PORT` is the fleet-wide name for this concept: it is what
    # `scripts/dev-service.sh:267` passes to uvicorn, what `.env.test` sets to
    # 8963, and what `apps/api/src/__tests__/env-port-standardization.test.ts`
    # pairs with `GUARDRAIL_URL`. Only `GUARDRAIL_V2_PORT` was ever readable
    # here, so every one of those declarations reached the launcher and not the
    # app — harmless while uvicorn always wins, and wrong the moment anything
    # reads `settings.port`. Accept both; the fleet name first (TASK-799 B.3).
    port: int = Field(
        default=8863, validation_alias=AliasChoices("GUARDRAIL_PORT", "GUARDRAIL_V2_PORT")
    )
    debug: bool = False
    log_level: str = "info"
    cors_origins: list[str] = Field(default_factory=list)

    @property
    def cors_enabled(self) -> bool:
        """CORS is on exactly when origins are named (TASK-799 lane D, §D.2e).

        `GUARDRAIL_V2_CORS_ENABLED` was a second switch over the same fact, and
        two switches over one fact can disagree: `enabled=true` with an empty
        origin list adds a middleware that permits nothing, and `enabled=false`
        with origins named silently ignores a deliberate configuration. Deriving
        it makes the contradictory states unrepresentable.

        Deliberately NOT settable — a derived value that keeps its own override is
        the original bug wearing a property.
        """
        return bool(self.cors_origins)

    # Inter-service authentication. The gateway provisions this under the
    # canonical GUARDRAIL_SERVICE_TOKEN key (turbo.json / .env.example), so read
    # it verbatim via validation_alias — NOT the GUARDRAIL_V2_ env_prefix, which
    # never matched the gateway and left prod enforcement silently disabled.
    service_token: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices("GUARDRAIL_SERVICE_TOKEN"),
    )

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

    def peer_service_token(self, legacy: SecretStr) -> str:
        """Token to PRESENT on an outbound peer call: shared first, legacy fallback."""
        # `first_real_secret`, not `or`: the sentinel is a NON-EMPTY string, so a plain
        # truthiness chain returns "CHANGE_ME" and never reaches the legacy fallback — the
        # trap that made every internal hop 401 (see hope_env.placeholders).
        return first_real_secret(self.internal_access_token, legacy)

    # Where the control plane lives (env GUARDRAIL_V2_GATEWAY_URL).
    # This is BOOTSTRAP TRANSPORT (the address of the config source), NOT config
    # authority: the retention knobs themselves come from the effective-config
    # route this URL points at.
    gateway_url: str = "http://localhost:8868/api/v1"

    # Connection pooling lives on `transport` (TASK-777 B-1) — the only thing
    # `build_http_client` reads. The superseded `httpx_max_*` pair is gone: a
    # settable knob nothing reads is not a "voice", it is a lie to the operator.
    # Aux-model cache policy is likewise gone from env — the runtime values come
    # from the control plane (`guardrail.modelCache.{ttlSeconds,maxModels}`) via
    # `core/effective_config.py`, which carries its own bootstrap defaults.

    # Observability
    otel_enabled: bool = False
    otel_exporter_endpoint: str = "http://localhost:4317"
    otel_service_name: str = "guardrail"
    metrics_enabled: bool = True

    # Sub-configs
    judge: JudgePolicy = Field(default_factory=JudgePolicy)
    transport: TransportPolicy = Field(default_factory=TransportPolicy)
    groundedness: GroundednessConfig = Field(default_factory=GroundednessConfig)
    redis: RedisConfig = Field(default_factory=RedisConfig)
    queue: QueueConfig = Field(default_factory=QueueConfig)
    db: DatabaseConfig = Field(default_factory=DatabaseConfig)

    @field_validator("log_level")
    @classmethod
    def _normalize_log_level(cls, v: str) -> str:
        return v.lower()


def get_settings() -> Settings:
    """Create settings instance."""
    load_env()
    return Settings()
