import os
from enum import IntEnum, StrEnum
from typing import Any

from hope_env import (
    build_hope_sources,
    first_real_secret,
    hope_settings_sources,
    load_env,
    real_secret,
)
from pydantic import AliasChoices, Field, SecretStr, model_validator
from pydantic.fields import FieldInfo
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict

from nlp.utils import get_project_root

# NODE_ENV-selected root env file (.env.dev / .env.test); host env always wins.
# Runs before any BaseSettings class below is instantiated.
load_env()


# model identity (which model to run) is selected from the DB via the
# gateway-injected request `model_name`, never from environment variables. These
# fields are dropped from env/dotenv sources so `*_MODEL_NAME` / `*_TOKENIZER_NAME`
# can no longer *select* a model; all other (tuning) env still applies.
_MODEL_IDENTITY_FIELDS = frozenset({"model_name", "tokenizer_name", "model_path", "model_version"})


class _ModelIdentityFilteredSource(PydanticBaseSettingsSource):
    """Wrap an env/dotenv settings source, dropping model-identity keys."""

    def __init__(self, wrapped: PydanticBaseSettingsSource) -> None:
        super().__init__(wrapped.settings_cls)
        self._wrapped = wrapped

    def get_field_value(self, field: FieldInfo, field_name: str) -> tuple[Any, str, bool]:
        # Unused: the whole source is materialized via __call__ below.
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        return {k: v for k, v in self._wrapped().items() if k not in _MODEL_IDENTITY_FIELDS}


def _model_identity_filtered_sources(
    cls: type[BaseSettings],
    settings_cls: type[BaseSettings],
    init_settings: PydanticBaseSettingsSource,
    env_settings: PydanticBaseSettingsSource,
    dotenv_settings: PydanticBaseSettingsSource,
    file_secret_settings: PydanticBaseSettingsSource,
) -> tuple[PydanticBaseSettingsSource, ...]:
    """`settings_customise_sources` that drops model-identity keys.

    COMPOSES with the shared HOPE order rather than replacing it: `build_hope_sources`
    supplies `init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default`,
    and the model-identity filter is then applied to every source except
    `init_settings`.

    Constructor kwargs (`init_settings`) still set model identity — that is the
    path the per-request cache factories use to load the DB-selected model.

    The filter now covers the Vault `secrets_dir` source too. Before
    that source was inert (no `secrets_dir` was ever configured), so leaving it
    unfiltered cost nothing; now that a Vault Agent can populate it, an
    unfiltered `secrets_dir` would reopen exactly the hole this filter closes —
    a `/vault/secrets/NLP_MODEL_NAME` file selecting a model. Model identity
    comes from the DB, never from the environment or the filesystem.
    """
    ordered = build_hope_sources(
        settings_cls,
        init_settings=init_settings,
        env_settings=env_settings,
        dotenv_settings=dotenv_settings,
        file_secret_settings=file_secret_settings,
    )
    return tuple(
        source if source is init_settings else _ModelIdentityFilteredSource(source)
        for source in ordered
    )


class Environment(StrEnum):
    """Deployment environments"""

    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class LogLevel(IntEnum):
    """Possible log levels."""

    NOTSET = 0
    DEBUG = 10
    INFO = 20
    WARNING = 30
    ERROR = 40
    FATAL = 50


def _parse_otel_resource_attributes(raw: str | None) -> dict[str, str]:
    """Parse OTel-standard `key=val,key=val` format into a dict."""
    if not raw:
        return {}
    result: dict[str, str] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if "=" in pair:
            key, value = pair.split("=", 1)
            result[key.strip()] = value.strip()
    return result


class NLPServiceConfig(BaseSettings):
    """Main configuration for NLP service"""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    # Every field below carries an explicit `validation_alias` and a STATIC
    # default. Neither half is decoration:
    #
    # * a `default=os.getenv(...)` is an env read evaluated once at class-
    #   definition time — the module-scope pattern TASK-558 removed, and it
    #   cannot be reached by the Vault `secrets_dir` tier at all;
    # * an `__init__` that pre-fills these from `os.getenv` is worse, because
    #   `init_settings` is the HIGHEST-precedence source in `build_hope_sources`,
    #   so it outranks host env, `secrets_dir` AND the env file.
    #
    # Declaring the alias instead puts every one of them back on the shared
    # chain: init > host env > secrets_dir > .env.<NODE_ENV> > default. The
    # prefixed `NLP_*` name is listed FIRST so `turbo.json#globalEnv`'s
    # declaration is the reachable one; the unprefixed / OTel-standard names the
    # deployment already sets stay accepted behind it.
    name: str = Field(
        default="nlp",
        validation_alias=AliasChoices("NLP_SERVICE_NAME", "OTEL_SERVICE_NAME", "SERVICE_NAME"),
    )
    version: str = Field(
        default="0.1.0",
        validation_alias=AliasChoices(
            "NLP_SERVICE_VERSION", "OTEL_SERVICE_VERSION", "SERVICE_VERSION"
        ),
    )
    environment: Environment = Field(default=Environment.DEVELOPMENT)
    log_level: int = Field(default=LogLevel.INFO)

    host: str = Field(default="0.0.0.0", validation_alias=AliasChoices("NLP_HOST", "HOST"))
    port: int = Field(default=8864, validation_alias=AliasChoices("NLP_PORT", "PORT"))
    workers: int = Field(default=1, validation_alias=AliasChoices("NLP_WORKERS", "WORKERS"))

    otlp_endpoint: str | None = Field(
        default=None,
        validation_alias=AliasChoices("NLP_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"),
    )
    resource_attributes_raw: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "NLP_OTEL_RESOURCE_ATTRIBUTES", "OTEL_RESOURCE_ATTRIBUTES"
        ),
    )
    # Master switch: gates traces, metrics, AND log export (default off).
    otel_enabled: bool = Field(default=False, validation_alias=AliasChoices("NLP_OTEL_ENABLED"))
    traces_enabled: bool = Field(
        default=True, validation_alias=AliasChoices("NLP_TRACES_ENABLED", "OTEL_TRACES_ENABLED")
    )
    # Gates the Prometheus /metrics endpoint AND the OTLP metric reader.
    #
    # Reads NLP_METRICS_ENABLED first (the fleet convention — every other
    # service uses its own prefixed switch: TEXT_METRICS_ENABLED,
    # TTS_METRICS_ENABLED, GUARDRAIL_V2_METRICS_ENABLED, HARNESS_METRICS_ENABLED,
    # METRICS_ENABLED for STT). It used to read ONLY the gateway-scoped
    # OTEL_METRICS_ENABLED, which .env.dev sets to false — so NLP's /metrics
    # was disabled by a variable documented under the API gateway. OTEL_METRICS_ENABLED is kept as a fallback for compatibility.
    metrics_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("NLP_METRICS_ENABLED", "OTEL_METRICS_ENABLED"),
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

    # LEGACY per-service credential. Reads NLP_SERVICE_TOKEN via the env_prefix
    # below — superseded by INTERNAL_ACCESS_TOKEN above, kept as the fallback.
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

    def peer_service_token(self, legacy: SecretStr) -> str:
        """Token to PRESENT on an outbound peer call: shared first, legacy fallback."""
        # `first_real_secret`, not `or`: the sentinel is a NON-EMPTY string, so a plain
        # truthiness chain returns "CHANGE_ME" and never reaches the legacy fallback — the
        # trap that made every internal hop 401 (see hope_env.placeholders).
        return first_real_secret(self.internal_access_token, legacy)

    # Where the control plane lives (env NLP_GATEWAY_URL). This is
    # BOOTSTRAP TRANSPORT (the address of the config source), NOT config
    # authority: the service-level knobs themselves come from the
    # effective-config route this URL points at.
    gateway_url: str = Field(default="http://localhost:8868/api/v1")

    # Bootstrap fallback; the runtime value comes from the control
    # plane (`nlp.inference.maxConcurrent`).
    inference_max_concurrent: int = Field(default=4, ge=1)

    # Owner decision (2026-08-20, TASK-729 §6): outbound peer HTTP (the
    # `nlp` → `text` delegation behind `/classify/topic`/`/classify/intent`)
    # gets its OWN bound, never `inference_max_concurrent`. That semaphore
    # protects local GPU/CPU inference slots; a slow HTTP round-trip to `text`
    # is a completely different resource (this process's own outbound
    # connection/concurrency budget) and must not be able to starve — or be
    # starved by — local classification. Bootstrap fallback only; the
    # runtime value comes from the control plane (`nlp.peerCall.maxConcurrent`),
    # configured the exact same way as `inference_max_concurrent` above.
    peer_call_max_concurrent: int = Field(default=8, ge=1)

    # Micro-batching + backpressure bounds (TASK-778).
    #
    # BOOTSTRAP FLOOR ONLY, and deliberately TRANSPORT-shaped: these are queue
    # and batch geometry, not model identity, taxonomy, threshold or any other
    # policy value — so they are legitimately env-tier under
    # `00-project-context.md` §Configuration Principles, unlike a model id or a
    # label set, which may never be a settings default.
    #
    # `inference_batch_linger_ms` is the ENTIRE latency price of batching: an
    # otherwise-idle request waits at most this long for company. Keep it well
    # under the p50 forward pass, or batching costs more than it saves.
    inference_batch_max_size: int = Field(default=8, ge=1, le=64)
    inference_batch_linger_ms: int = Field(default=5, ge=0, le=1000)
    # The queue is bounded so overload degrades into a 503 instead of an OOM.
    inference_queue_max_depth: int = Field(default=256, ge=1)
    inference_queue_max_wait_seconds: float = Field(default=20.0, gt=0)
    # Concurrent forward passes against ONE model. Small on purpose: torch
    # already parallelises inside a pass, so stacking passes on the same weights
    # buys cache contention rather than throughput.
    inference_max_inflight_batches: int = Field(default=2, ge=1, le=32)

    # ── Two service classes, two queue geometries (TASK-782) ───────────────
    #
    # TASK-778 shipped ONE geometry and measured p95 ~1.7 s at 100 concurrent —
    # fine for the asynchronous per-utterance redaction pass, unfit for a
    # SYNCHRONOUS inline gate on a clinician's turn. The two jobs have different
    # latency budgets, so they no longer share a queue.
    #
    # The interactive lane trades coalescing for latency: a small batch, a
    # linger measured against ITS budget rather than the bulk pass, and a wait
    # ceiling short enough that a shed is still useful to the caller. Its
    # ceiling IS its declared SLO: past it the answer would arrive too late to
    # gate anything, so a 503 the caller can fail closed on beats a stale 200.
    #
    # `latency_class` on the request selects the lane; absent ⇒ bulk, so an
    # existing caller keeps byte-identical behaviour.
    # 2, not 4: the lane exists for latency, and the measured cost of a wider
    # gate batch is paid by the request that is waiting for the verdict
    # (TASK-782 §5.4).
    inference_interactive_batch_max_size: int = Field(default=2, ge=1, le=64)
    inference_interactive_batch_linger_ms: int = Field(default=2, ge=0, le=1000)
    inference_interactive_queue_max_depth: int = Field(default=64, ge=1)
    inference_interactive_queue_max_wait_seconds: float = Field(default=2.0, gt=0)

    # ── Where the tensors execute (TASK-782) ───────────────────────────────
    #
    # TRANSPORT/TOPOLOGY, not model identity — env-tier for the same reason the
    # batch geometry is, and unlike a model id, which may never be a settings
    # default. "cpu" is the bootstrap floor because it is the only placement
    # that is correct on every host; "auto" degrades to the best device present;
    # an explicit "mps"/"cuda" that is absent RAISES rather than silently
    # running 3x slower on CPU (see `nlp.core.device`).
    inference_device: str = Field(default="cpu")

    # Submodules kept on CPU when the device is an accelerator. This is a
    # runtime-COMPATIBILITY fact about the installed `gliner2`/torch build, not
    # policy: `count_embed.gru` trips an MPSNDArray assertion that ABORTS the
    # process (SIGABRT, not an exception), so the relocation is mandatory
    # wherever that build is used. A torch release that fixes it is answered by
    # emptying this list, not by editing code.
    inference_device_cpu_only_modules: str = Field(default="count_embed.gru")

    # Model-cache retention.
    #
    # BOOTSTRAP FALLBACK ONLY — the runtime value comes from the control plane
    # (`nlp.modelCache.{ttlSeconds,maxModels}`). Env: NLP_MODEL_CACHE_TTL_SECONDS
    # / NLP_MODEL_CACHE_MAX_MODELS.
    model_cache_ttl_seconds: int = Field(default=600, ge=60, le=3600)
    model_cache_max_models: int = Field(default=3, ge=1)

    # ── Model weight cache root ────────────────────────────────────────────
    # WHERE weights are cached; never WHICH checkpoint runs (that stays
    # `AiTaskDefault` x `AiModel`, resolved per request). Transport/topology,
    # so env-tier is correct — but it must be DECLARED, not inherited from an
    # operator's login shell: `~/.zshrc` is sourced by INTERACTIVE shells only,
    # and services, CI jobs and coding agents all run in non-interactive ones.
    # An undeclared value silently redirects every download to
    # `~/.cache/huggingface`, which is how TASK-778's first "measured against
    # real weights" claim came to be unsubstantiated.
    #
    # Unprefixed (`validation_alias` bypasses the `NLP_` prefix) because it
    # belongs to the huggingface stack, not to this service. It arrives through
    # the ONE canonical loader — `hope_env.load_env()` at the top of this
    # module — and is pushed back into `os.environ` by `apply_hf_home` below.
    # Empty = the huggingface default.
    hf_home: str = Field(default="", validation_alias=AliasChoices("HF_HOME"))

    # `populate_by_name` because the fields above now declare a
    # `validation_alias`, and pydantic-settings matches init kwargs against the
    # (case-folded) ALIAS, not the field name — so without this, constructing
    # `NLPServiceConfig(port=…)` raises `extra_forbidden`. Every existing caller
    # and test builds this class by field name.
    model_config = SettingsConfigDict(env_prefix="NLP_", populate_by_name=True)

    @property
    def resource_attributes(self) -> dict[str, str]:
        return _parse_otel_resource_attributes(self.resource_attributes_raw)


# Sentinel default for the document-type text classifier.
#
# OPEN DECISION: the `/classify/text` endpoint is meant for clinical
# *document-type* classification (e.g. clinical note vs discharge summary vs lab report),
# but no clinical doc-type model or label taxonomy has been chosen yet. The previous
# default, `michellejieli/emotion_text_classifier`, is an *emotion* model and was only ever
# a placeholder — it would emit emotion labels for clinical text. Until a product owner
# picks the intended model + taxonomy, the default is this non-functional sentinel so the
# service refuses to silently run the wrong model and instead reports the feature as
# unconfigured (see `TransformerTextClassifier.initialize`). the endpoint is now
# fail-closed-until-configured driven by the REQUIRED, gateway-injected `model_name` (from a
# DB AiModel) rather than an env var — configure a real doc-type model in the DB to enable it.
UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL = "__UNCONFIGURED_DOC_TYPE_CLASSIFIER__"


class TextClassificationConfig(BaseSettings):
    """Text classification model configuration"""

    # Model settings
    model_name: str = Field(default=UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL)
    model_version: str = Field(default="1.0.0")
    model_path: str | None = Field(default=None)
    tokenizer_name: str = Field(default=UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL)

    # Performance settings
    use_gpu: bool = Field(default=True)

    model_config = SettingsConfigDict(env_prefix="TEXT_CLASSIFIER_")

    # model identity comes from the DB (gateway-injected request
    # `model_name`), never from env; tuning env (thresholds, GPU, etc.) stays.
    settings_customise_sources = classmethod(_model_identity_filtered_sources)

    @property
    def is_configured(self) -> bool:
        """True once a real doc-type model is set (i.e. not the placeholder sentinel)."""
        return self.model_name != UNCONFIGURED_DOC_TYPE_CLASSIFIER_MODEL


class TokenClassificationConfig(BaseSettings):
    """Token classification model configuration"""

    # Model settings
    model_name: str = Field(default="blaze999/Medical-NER")
    model_version: str = Field(default="1.0.0")
    model_path: str | None = Field(default=None)
    tokenizer_name: str = Field(default="blaze999/Medical-NER")

    # NER specific settings
    aggregation_strategy: str = Field(default="simple")  # simple, first, max, average
    ignore_labels: list[str] = Field(default_factory=lambda: ["O"])
    # negation/assertion pass over recognized spans (ConText/NegEx).
    # Default ON; deterministic + offline. Disable to skip the pass entirely.
    assertion_enabled: bool = Field(default=True)

    # Performance settings
    use_gpu: bool = Field(default=True)

    model_config = SettingsConfigDict(env_prefix="TOKEN_CLASSIFIER_")

    # model identity is DB/gateway-selected, never env-selected.
    settings_customise_sources = classmethod(_model_identity_filtered_sources)


class OntologyLinkerConfig(BaseSettings):
    """Clinical ontology linker configuration.

    Gates the deterministic ``OntologyLinker`` wired into token classification:
    a master toggle plus a confidence floor below which a recognized span is
    left un-coded (avoids coding low-confidence NER noise). Reads ``NLP_LINKER_*``
    via the env_prefix. The bundled vocabulary is self-hosted — no cloud PHI.
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    linker_enabled: bool = Field(default=True)
    linker_confidence_floor: float = Field(default=0.0, ge=0.0, le=1.0)

    model_config = SettingsConfigDict(env_prefix="NLP_")


class MedicalSuggesterConfig(BaseSettings):
    """Medical Suggester configuration"""

    # Model settings
    model_name: str = Field(default="shanover/symps_disease_bert_v3_c41")
    model_version: str = Field(default="1.0.0")
    tokenizer_name: str = Field(default="shanover/symps_disease_bert_v3_c41")

    # Performance settings
    use_gpu: bool = Field(default=True)

    model_config = SettingsConfigDict(env_prefix="MEDICAL_SUGGESTER_")

    # model identity is DB/gateway-selected, never env-selected.
    settings_customise_sources = classmethod(_model_identity_filtered_sources)


class SecurityConfig(BaseSettings):
    """Security configuration"""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    cors_origins: list[str] = Field(default=["*"])
    cors_methods: list[str] = Field(default=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    # Credentialed CORS is OFF by default. `apps/nlp` is an internal service
    # reached by the gateway and by peer services, never by a browser carrying a
    # session — so it has nothing to gain from credentialed cross-origin
    # requests, and everything to lose from `*` + credentials.
    cors_allow_credentials: bool = Field(default=False)

    model_config = SettingsConfigDict(env_prefix="SECURITY_")

    @model_validator(mode="after")
    def _refuse_wildcard_with_credentials(self) -> "SecurityConfig":
        """A wildcard origin and credentials may never be enabled together.

        This pairing hands every origin a credentialed cross-origin channel. It
        was live: the field below was declared and never read, while `app.py`
        passed `allow_credentials=True` as a literal. Refusing it HERE, at
        settings validation, means an operator who wants credentials must first
        name the origins — the misconfiguration cannot boot.
        """
        if self.cors_allow_credentials and "*" in self.cors_origins:
            raise ValueError(
                "cors_allow_credentials cannot be enabled while cors_origins contains '*'; "
                "name the permitted origins explicitly (SECURITY_CORS_ORIGINS)."
            )
        return self


class TextCorrectorConfig(BaseSettings):
    """Text corrector configuration"""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    dictionary_path: str = Field(default=str(get_project_root() / "data" / "dictionaries"))

    symspell_max_edit_distance: int = Field(default=2)
    symspell_prefix_length: int = Field(default=7)
    symspell_preserve_case: bool = Field(default=True)
    symspell_ignore_non_words: bool = Field(default=True)
    symspell_ignore_term_with_digits: bool = Field(default=True)

    model_config = SettingsConfigDict(env_prefix="SPELLING_CORRECTOR_")


class ExternalTextConfig(BaseSettings):
    """apps/nlp's peer-to-peer client config for calling `text` (TASK-729).

    Mirrors `apps/text`'s `ExternalGuardrailConfig` field-for-field: this is
    the first outbound peer-service call `apps/nlp` makes (§2.3/§2.4 of the
    ticket — every prior `httpx` call site targets the gateway, never a peer
    AI service). Used by `nlp.topic`/`nlp.intent` to delegate open-taxonomy
    labeling to a real LLM call, with the tenant's topic/intent list injected
    into the prompt as per-tenant instructions (resolved server-side from
    `TenantNlpTaskInstructions` and gateway-injected into the request body —
    `apps/nlp` itself never touches Postgres).
    """

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="NLP_EXTERNAL_TEXT_")

    base_url: str = "http://localhost:8862"
    timeout_s: int = 30
    # Bounded retry for a transient blip, mirroring
    # `ExternalGuardrailConfig`: total tries = max_retries + 1, linear backoff.
    max_retries: int = 2
    retry_backoff_ms: int = 100
    service_token: SecretStr = SecretStr("")


class Settings:
    """Main settings container for dual-model architecture"""

    def __init__(self) -> None:
        self.service = NLPServiceConfig()
        self.text_classification = TextClassificationConfig()
        self.token_classification = TokenClassificationConfig()
        self.ontology_linker = OntologyLinkerConfig()
        self.medical_suggester = MedicalSuggesterConfig()
        self.security = SecurityConfig()
        self.text_corrector = TextCorrectorConfig()
        self.external_text = ExternalTextConfig()


settings = Settings()


def apply_hf_home(service: NLPServiceConfig) -> None:
    """Export the declared cache root into ``os.environ`` for huggingface.

    ``huggingface_hub`` snapshots its cache constants at IMPORT time and reads
    them from ``os.environ``, never from this settings object — so a declared
    field that is not exported is documentation, not configuration. Called at
    module import, i.e. before any ``gliner2`` / ``transformers`` import that a
    request path could trigger.

    Idempotent, and never invents a path: an empty value leaves the huggingface
    default in place rather than pointing the cache somewhere the operator did
    not ask for.
    """
    if service.hf_home:
        os.environ["HF_HOME"] = service.hf_home


apply_hf_home(settings.service)
