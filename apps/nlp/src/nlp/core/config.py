import logging
import os
from enum import IntEnum, StrEnum
from typing import Any

from hope_env import (
    build_hope_sources,
    hope_settings_sources,
    load_env,
    real_secret,
)
from pydantic import AliasChoices, Field, SecretStr, field_validator, model_validator
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


# Fields the CONTROL PLANE owns (TASK-799 lane D). Dropped from every env-ish
# source for the same reason model identity is: the value has exactly one
# writer, and a second way to set it is a way for the two to disagree.
#
# These are platform-scope SERVICE GEOMETRY — queue depths, batch sizes, linger
# and wait ceilings, cache retention, concurrency bounds. D-1's cardinality rule
# puts precisely this class on the PULL route: one cached snapshot per process,
# no tenant dimension. Each field survives here as the BOOTSTRAP FLOOR the
# process runs on until the first successful fetch, and as the value it keeps if
# the control plane is unreachable — which is why the fields are not simply
# deleted.
#
# Deliberately ABSENT: `inference_device` and `inference_device_cpu_only_modules`.
# Those are HOST facts (which accelerator this pod has; which submodule the
# installed torch/gliner2 build SIGABRTs on), not platform policy — serving them
# from the control plane would push one host's hardware onto every other.
_CONTROL_PLANE_FIELDS = frozenset(
    {
        "inference_max_concurrent",
        "peer_call_max_concurrent",
        "model_cache_ttl_seconds",
        "model_cache_max_models",
        "inference_batch_max_size",
        "inference_batch_linger_ms",
        "inference_queue_max_depth",
        "inference_queue_max_wait_seconds",
        "inference_max_inflight_batches",
        "inference_interactive_batch_max_size",
        "inference_interactive_batch_linger_ms",
        "inference_interactive_queue_max_depth",
        "inference_interactive_queue_max_wait_seconds",
    }
)


class _FilteredSource(PydanticBaseSettingsSource):
    """Wrap an env/dotenv settings source, dropping a declared set of keys."""

    def __init__(self, wrapped: PydanticBaseSettingsSource, dropped: frozenset[str]) -> None:
        super().__init__(wrapped.settings_cls)
        self._wrapped = wrapped
        self._dropped = dropped

    def get_field_value(self, field: FieldInfo, field_name: str) -> tuple[Any, str, bool]:
        # Unused: the whole source is materialized via __call__ below.
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        return {k: v for k, v in self._wrapped().items() if k not in self._dropped}


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
        source if source is init_settings else _FilteredSource(source, _MODEL_IDENTITY_FIELDS)
        for source in ordered
    )


def _control_plane_filtered_sources(
    cls: type[BaseSettings],
    settings_cls: type[BaseSettings],
    init_settings: PydanticBaseSettingsSource,
    env_settings: PydanticBaseSettingsSource,
    dotenv_settings: PydanticBaseSettingsSource,
    file_secret_settings: PydanticBaseSettingsSource,
) -> tuple[PydanticBaseSettingsSource, ...]:
    """`settings_customise_sources` that drops control-plane-owned keys.

    Same shape and the same reasoning as `_model_identity_filtered_sources`
    above, for `_CONTROL_PLANE_FIELDS`. Constructor kwargs still set them, which
    is what keeps every existing test and the bootstrap floor constructible;
    what is closed is the ENV path, so a host can no longer contradict the
    platform value the control plane serves.
    """
    ordered = build_hope_sources(
        settings_cls,
        init_settings=init_settings,
        env_settings=env_settings,
        dotenv_settings=dotenv_settings,
        file_secret_settings=file_secret_settings,
    )
    return tuple(
        source if source is init_settings else _FilteredSource(source, _CONTROL_PLANE_FIELDS)
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

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default,
    # with `_CONTROL_PLANE_FIELDS` dropped from every source but `init`.
    settings_customise_sources = classmethod(_control_plane_filtered_sources)

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
    # Typed `int` (a `logging` level number) but written by operators as a NAME
    # — `apps/nlp/.env.sample` shipped `LOG_LEVEL=info`, and every other service
    # in the fleet takes a name. So `NLP_LOG_LEVEL=INFO` used to be a boot-time
    # ValidationError while `NLP_LOG_LEVEL=20` was undocumented anywhere. Accept
    # both spellings of the ONE name (TASK-799 B.3); `core/logging.py` reads the
    # same variable and resolves it the same way.
    log_level: int = Field(default=LogLevel.INFO)

    @field_validator("log_level", mode="before")
    @classmethod
    def _coerce_log_level(cls, value: object) -> object:
        """Map a level NAME (``"info"``, ``"WARNING"``) to its numeric level."""
        if isinstance(value, str) and not value.strip().isdigit():
            named = getattr(logging, value.strip().upper(), None)
            if isinstance(named, int):
                return named
        return value

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

    # The LEGACY per-service credential (`NLP_SERVICE_TOKEN`) is GONE
    # (TASK-799 lane D). It existed only as a migration fallback while call
    # sites were moved onto `peer_service_token()`; Phase 0 finished that move,
    # so what remained was a SECOND accepted credential — a second thing to
    # rotate, and a second way to be silently unauthenticated when only one of
    # the two is set.

    @property
    def accepted_service_tokens(self) -> tuple[str, ...]:
        """Every token accepted as inbound ``X-Service-Token``, shared token first.

        Empty tuple ⇒ auth is bypassed (local dev / hermetic CI) — the pre-existing
        behaviour when no token is configured at all.
        """
        # `real_secret` maps the unfilled-secret sentinel onto "" so a `CHANGE_ME` token is
        # never ACCEPTED as a credential — see hope_env.placeholders.
        return tuple(t for t in (real_secret(self.internal_access_token),) if t)

    def peer_service_token(self) -> str:
        """Token to PRESENT on an outbound peer call — the ONE shared credential.

        `real_secret`, not `.get_secret_value()`: the unfilled-secret sentinel is
        a NON-EMPTY string, so a plain read hands `CHANGE_ME` to a peer and every
        internal hop 401s (see `hope_env.placeholders`).
        """
        return real_secret(self.internal_access_token)

    # Where the control plane lives (env NLP_GATEWAY_URL). This is
    # BOOTSTRAP TRANSPORT (the address of the config source), NOT config
    # authority: the service-level knobs themselves come from the
    # effective-config route this URL points at.
    gateway_url: str = Field(default="http://localhost:8868/api/v1")

    # ── How this process REACHES Redis (owner decision D-5, 2026-08-23) ────
    #
    # BOOTSTRAP TRANSPORT, and env-tier for the same reason `gateway_url` is:
    # it is the ADDRESS of a backing service, not a value read from one. Rule 00
    # §Configuration Principles keeps exactly this class of variable in env —
    # "what is needed to reach the DB or authenticate to Vault" — and nothing
    # else.
    #
    # It exists so the `arca:config:invalidate` subscriber built in
    # `core/effective_config.py` has a transport. Before D-5 this service held
    # no Redis client at all, so that channel had a handler and no wire, and
    # every control-plane write took a full TTL window to be seen here. The TTL
    # stays as the bounded-staleness backstop (rule 09 §"Config caches"), so a
    # process that boots while Redis is down still starts and still converges.
    redis_url: str = Field(default="redis://localhost:6379/0")

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

    # Model settings.
    #
    # `model_name`/`tokenizer_name` are REQUIRED and have NO default. They used
    # to default to a real HuggingFace NER checkpoint, which the env-source
    # filter above then made unchangeable — the appearance of compliance around
    # a live hardcoded selection. A model id is configuration
    # (`AiTaskDefault` ⋈ `AiModel`, resolved tenant → SYSTEM by the gateway and
    # injected per request), so an unresolved selection must be a REFUSAL, not a
    # substitution: constructing this config without one raises, and the routes
    # turn that into a fail-closed 503.
    model_name: str
    model_version: str = Field(default="1.0.0")
    model_path: str | None = Field(default=None)
    tokenizer_name: str

    # NER settings that used to live here are GONE (TASK-799 lane G):
    # `aggregation_strategy`, `ignore_labels` and `assertion_enabled` were
    # `TOKEN_CLASSIFIER_*` env fields. A LABEL SET in an env var is precisely
    # what rule 00 §Configuration Principles forbids, and the first two are
    # properties OF THE CHECKPOINT (which labels it emits meaning "nothing", how
    # its subword pieces aggregate) — an env var cannot vary with the model it
    # describes. They now ride on
    # `AiModel._metadata.clinicalTaxonomy.tokenClassifier`, resolved by the
    # gateway from the row `nlp.ner` selects and injected per request.

    # Performance settings
    use_gpu: bool = Field(default=True)

    model_config = SettingsConfigDict(env_prefix="TOKEN_CLASSIFIER_")

    # model identity is DB/gateway-selected, never env-selected.
    settings_customise_sources = classmethod(_model_identity_filtered_sources)


# `OntologyLinkerConfig` is GONE (TASK-799 lane G). Its two fields —
# `NLP_LINKER_ENABLED` and `NLP_LINKER_CONFIDENCE_FLOOR` — were an env-owned
# master switch and threshold for a CLINICAL enrichment. A threshold is not an
# env var (rule 00), and neither is a per-model enrichment toggle: both now ride
# on `AiModel._metadata.clinicalTaxonomy.linker`, resolved by the gateway and
# injected per request, so a platform admin can retune them without a redeploy.


class MedicalSuggesterConfig(BaseSettings):
    """Medical Suggester configuration"""

    # Model settings. REQUIRED, no default — see `TokenClassificationConfig`
    # above for why a real checkpoint id may not sit here.
    model_name: str
    model_version: str = Field(default="1.0.0")
    tokenizer_name: str

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

    # `populate_by_name` so `ExternalTextConfig(base_url=...)` still works:
    # pydantic-settings matches init kwargs against the ALIAS once one is
    # declared, and every existing caller and test builds this by field name.
    model_config = SettingsConfigDict(
        env_prefix="NLP_EXTERNAL_TEXT_", populate_by_name=True
    )

    # `TEXT_URL` is the repo-wide name for this address — `apps/guardrail`
    # already reads it under the same alias, and `turbo.json#globalEnv` declares
    # it once for the whole fleet. `NLP_EXTERNAL_TEXT_BASE_URL` was a second name
    # for the same endpoint (TASK-799 lane D): two names for one address is how
    # half a fleet ends up pointed at a decommissioned host.
    base_url: str = Field(
        default="http://localhost:8862",
        validation_alias=AliasChoices("TEXT_URL"),
    )
    timeout_s: int = 30
    # Bounded retry for a transient blip, mirroring
    # `ExternalGuardrailConfig`: total tries = max_retries + 1, linear backoff.
    max_retries: int = 2
    retry_backoff_ms: int = 100

    # No `service_token` here either — the one shared `INTERNAL_ACCESS_TOKEN` on
    # `NLPServiceConfig` is what every outbound peer call presents.


class Settings:
    """Main settings container for the service-level (non-model) configuration.

    The three per-model configs are DELIBERATELY absent: model identity is
    resolved per request, so a process-wide instance would have to invent a
    selection to exist at all — which is precisely how the hardcoded NER and
    diagnosis checkpoints stayed live. They are constructed by the per-request
    cache factories in `nlp.dependencies`, from the caller's selection.
    """

    def __init__(self) -> None:
        self.service = NLPServiceConfig()
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
