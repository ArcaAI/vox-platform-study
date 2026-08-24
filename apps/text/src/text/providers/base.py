"""LLMProvider protocol and ProviderRegistry."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from enum import StrEnum
from typing import Protocol, runtime_checkable

from text.core.exceptions import ModelNotSelectedError, VisionNotSupportedError
from text.models.probe import ProbeConnection
from text.models.provider import ProviderInfo
from text.models.requests import GenerateRequest
from text.models.stats import GenerationStats
from text.models.stream import StreamChunk


class ProviderNotFoundError(KeyError):
    """Raised when a requested provider is not registered."""


class CredentialPosture(StrEnum):
    """How an adapter obtains the credential it authenticates with.

    This exists so the BYOK lock test can iterate the REGISTRY instead of a
    hand-written list of provider names. That distinction is not cosmetic: the
    previous list named azure/openai/anthropic, and underneath it ``bedrock``
    built a ``boto3`` client with no credentials (silently authenticating from
    ``AWS_ACCESS_KEY_ID`` / ``AWS_PROFILE`` / instance metadata) and ``vertex``
    built a ``genai`` client with no ``credentials=`` (Google ADC) — for years,
    because neither was on the list. A declaration each adapter must make, and
    a test that reads it off every registered provider, cannot skip the adapter
    nobody remembered.

    An adapter that declares NOTHING fails the lock test. Default-deny is the
    point: a new provider is not silently assumed credential-free.
    """

    #: Vendor credential REQUIRED. It arrives per request as a gateway-injected
    #: ``ProviderOverride`` (tenant → SYSTEM), or — in tests only — as an
    #: explicitly constructed platform key. Absent both, the adapter MUST raise
    #: ``ProviderCredentialsError`` rather than construct a client that would
    #: pick a credential up from the process environment.
    BYOK = "byok"
    #: An operator-run engine reached by topology ``base_url`` (Ollama, LM Studio /
    #: OpenAI-compatible, vLLM, llama.cpp). No vendor credential is required, so
    #: there is nothing to fail closed on — but a tenant fronting its own endpoint
    #: may still supply one through the same override path.
    SELF_HOST = "self_host"


def require_model(model: str | None, *, provider: str) -> str:
    """Fail-closed guard for CLOUD providers (Azure/Bedrock/OpenAI/Anthropic/
    Vertex): raise when no model resolved rather than falling through to a
    substituted default.

    The five cloud sub-configs (``core/config.py``) carry no runtime
    fallback model — provider/model SELECTION is ``failMode=closed``, so an
    unresolved value must raise, never substitute a vendor model. Local
    built-in engines (Ollama, LM Studio/OpenAICompat, vLLM, llama.cpp) do
    NOT call this guard; they keep their topology-level model default.
    """
    if not model or not model.strip():
        raise ModelNotSelectedError(
            f"No model selected for provider '{provider}': Text does not "
            "substitute a default cloud model — the caller must supply "
            "'model' (resolved via AiTaskDefault upstream).",
            provider=provider,
        )
    return model


def reject_vision(request: GenerateRequest, *, provider: str) -> None:
    """Fail-closed guard for a provider with NO multimodal wire capability
    (today: llama.cpp's raw ``/completion`` endpoint).

    Raises ``VisionNotSupportedError`` when the request carries an image
    content part, rather than silently sending the text-only prompt and
    dropping the image. A caller that picked a text-only engine for a vision
    request must find out with a clear typed error.
    """
    if request.image_parts():
        raise VisionNotSupportedError(
            f"Provider '{provider}' does not support vision input: an 'image' "
            "content part was supplied but this engine has no multimodal wire "
            "capability.",
            provider=provider,
        )


@runtime_checkable
class LLMProvider(Protocol):
    """Contract that every LLM provider must satisfy.

    ``generate``/``generate_stream`` accept an OPTIONAL multimodal payload via
    ``request.content_parts`` — a text-only ``GenerateRequest`` (the
    default) is unaffected; a provider with no vision wire capability must
    raise ``VisionNotSupportedError`` (see ``reject_vision``) rather than drop
    the image parts.

    Every implementation must also carry a ``credential_posture`` class attribute
    (see ``CredentialPosture``). It is deliberately NOT declared as a member of
    this Protocol: ``runtime_checkable`` turns any non-method member into an
    ``isinstance`` requirement, which would change ``isinstance(x, LLMProvider)``
    for every duck-typed provider and test double in the codebase. The obligation
    is enforced instead by the registry-iterating lock test
    (``tests/unit/test_task602_byok_credentials.py``), which fails for any
    registered adapter that does not declare one.
    """

    # AD-1: the third element is a normalized ``GenerationStats`` (real
    # stop reason + token counts + engine-native blob), NOT a bare usage dict —
    # every provider (incl. the vLLM / llama.cpp wave) must return exactly this.
    async def generate(self, request: GenerateRequest) -> tuple[str, str, GenerationStats]:
        """Non-streaming generation. Returns (content, reasoning, GenerationStats)."""
        ...

    def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        """Streaming generation. Yields StreamChunk objects."""
        ...

    async def get_info(self) -> ProviderInfo:
        """Return metadata about the provider and its available models."""
        ...

    async def health_check(self) -> bool:
        """Return True if the provider is reachable and operational."""
        ...


@runtime_checkable
class ConnectionAwareProbe(Protocol):
    """An adapter that can enumerate an engine it is TOLD about.

    ``get_info()`` on a self-hosted adapter probes ``self._last_base_url`` — the
    endpoint this process happened to serve a generation from last. That memo is
    process-wide, so it can only ever describe ONE engine per provider name,
    which is why model discovery could not show a tenant its own LM Studio or
    Ollama instance.

    ``discover_models`` is the connection-scoped answer: the gateway resolves the
    caller's row through the one tenant → SYSTEM cascade and hands the endpoint
    down, exactly as ``/generate`` hands down ``provider_overrides``. The gateway
    still never opens an engine connection itself.

    Two obligations for an implementation, both asserted by
    ``tests/unit/test_task799_provider_discovery.py``:

    * build a REQUEST-SCOPED client and do NOT write ``_last_base_url`` — a
      probe describes an engine, it must never re-point the generation memo of a
      concurrently-serving process;
    * a connection with no ``api_key`` is the NORMAL self-hosted shape and must
      probe UNAUTHENTICATED, never raise.

    Declared as a ``Protocol`` rather than added to ``LLMProvider`` because only
    the self-hosted engines can be enumerated at all: a cloud provider has no
    per-tenant model listing to fetch, and forcing every adapter to grow a method
    it cannot implement would buy nothing. ``_probe`` falls back to ``get_info()``
    for anything that does not satisfy this.
    """

    async def discover_models(self, connection: ProbeConnection) -> ProviderInfo:
        """Enumerate the models served by ``connection.base_url``."""
        ...


class ProviderRegistry:
    """Registry of named LLMProviders with LAZY, request-driven instantiation.

    a provider is *available* once its CONNECTION config is present
    (``register_factory`` at startup), but the (weight/connection-bearing)
    instance is built only on the first ``get(name)`` for that key and then
    memoized. A request for a name with neither an instance nor a factory
    (missing connection config) fails closed with ``ProviderNotFoundError``.
    Eager ``register`` is retained for tests / direct wiring.
    """

    def __init__(self) -> None:
        self._providers: dict[str, LLMProvider] = {}
        self._factories: dict[str, Callable[[], LLMProvider]] = {}

    def register(self, name: str, provider: LLMProvider) -> None:
        """Register an already-built provider instance (eager)."""
        self._providers[name] = provider

    def register_factory(self, name: str, factory: Callable[[], LLMProvider]) -> None:
        """Register a lazy builder; the instance is created on first ``get``."""
        self._factories[name] = factory

    def get(self, name: str) -> LLMProvider:
        provider = self._providers.get(name)
        if provider is not None:
            return provider
        factory = self._factories.get(name)
        if factory is not None:
            provider = factory()
            self._providers[name] = provider  # memoize the lazily-built instance
            return provider
        raise ProviderNotFoundError(
            f"Provider '{name}' not registered. Available: {self.list_providers()}"
        ) from None

    def unregister(self, name: str) -> None:
        self._providers.pop(name, None)
        self._factories.pop(name, None)

    def list_providers(self) -> list[str]:
        """All AVAILABLE provider names (instantiated OR lazily registered)."""
        return list({**self._factories, **self._providers}.keys())

    def is_instantiated(self, name: str) -> bool:
        """True once the named provider has actually been built (test aid)."""
        return name in self._providers
