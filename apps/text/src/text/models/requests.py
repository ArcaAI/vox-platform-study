"""Request models for the generate API."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, SecretStr, field_validator


class RetryConfig(BaseModel):
    max_retries: int = 3
    retry_on: list[str] = Field(default_factory=lambda: ["timeout", "provider_error"])


class ResponseFormat(BaseModel):
    type: Literal["text", "json", "json_schema"] = "text"
    json_schema: dict[str, Any] | None = None
    strict: bool = True


ProviderFunding = Literal["tenant", "platform"]
"""WHO PAID for an injected credential.

The gateway can inject a credential from two tiers — the caller tenant's own
connection row, or the SYSTEM-tenant platform default — and they are the same
bytes on the wire with opposite economics. Tenant-funded spend is metered
notionally and never invoiced; platform-funded spend is real COGS the platform
must recover. Text must therefore be TOLD which it was, not left to infer it
from the presence of an override.
"""


class ProviderOverride(BaseModel):
    """Per-request BYO cloud credential the gateway injects for the resolved
    cloud provider (`apps/api` ``TextProxyController.applyTenantProviderOverrides``).

    ``api_key`` is a ``SecretStr`` so it never surfaces via ``repr()``/``str()``/
    ``model_dump()``/logging — a provider client must call
    ``.get_secret_value()`` at the single point it hands the key to the SDK.
    """

    # OPTIONAL, and empty is a real state (TASK-890). An ENGINE-SERVED provider
    # (LM Studio, Ollama, vLLM, llama.cpp) authenticates nobody, and the one
    # caller that can resolve its endpoint without the gateway — `apps/guardrail`,
    # building a fallback connection for its own judge — can supply a `base_url`
    # and NOTHING else: `AiProviderConnection.encryptedApiKey` is Vault ciphertext
    # it cannot and must not decrypt. While this field was REQUIRED such an
    # override was a 422 at the wire model, so the keyless engine that needs no
    # credential was the one shape the credential field forbade.
    #
    # This does NOT weaken the cloud lane: a credential is required by the
    # ADAPTER, not by the wire (`core/connection.require_api_key` raises
    # `ProviderCredentialsError` → 503 on an empty key), which is the layer that
    # knows whether its provider needs one.
    api_key: SecretStr = SecretStr("")
    base_url: str | None = None
    region: str | None = None
    api_version: str | None = None
    deployment_name: str | None = None
    # C4 wire shape: an override MAY pin the model (override-wins over the
    # caller-supplied ``request.model``). Absent ⇒ the caller's model stands.
    model: str | None = None
    # Google Vertex routing — a Vertex client is bound to a (project, location);
    # the tenant's BYO service-account key (``api_key``) is scoped to a project,
    # so both travel with the override. Ignored by every non-Vertex provider.
    project: str | None = None
    location: str | None = None
    # Funding origin. Carried PER ENTRY rather than once per
    # request because the platform-default cascade merges tenant-over-platform
    # per provider: one request can legitimately hold a tenant-funded entry and
    # a platform-funded one, which a request-level field cannot express.
    # Non-secret metadata, so deliberately NOT a SecretStr — the attribution
    # must survive ``model_dump()``.
    funding: ProviderFunding = "tenant"
    # AWS Bedrock Guardrails. A guardrail belongs to the AWS ACCOUNT the request
    # authenticates against, so it travels with that account's credential rather
    # than as a process-wide `TEXT_BEDROCK_GUARDRAIL_ID` that would apply one
    # tenant's guardrail to every other tenant's traffic. Ignored by every
    # non-Bedrock provider.
    guardrail_id: str | None = None
    guardrail_version: str | None = None

    @field_validator("funding", mode="before")
    @classmethod
    def _unknown_funding_is_tenant(cls, value: object) -> object:
        """Degrade an unrecognized value to ``"tenant"`` instead of 422-ing.

        ABSENT means ``"tenant"`` and that is exact, not a hedge: a gateway
        that does not stamp funding has no platform tier to draw from, so every
        credential it can inject is the caller's own. For a MALFORMED value,
        rejecting the request would take generation down over a metering label
        — the opposite of this lane's fail-open posture for BYO credentials —
        so it degrades to the same conservative default, which can never
        silently convert tenant-funded spend into a platform COGS charge.
        """
        return value if value in ("tenant", "platform") else "tenant"


def serialize_provider_overrides(
    overrides: dict[str, ProviderOverride] | None,
) -> dict[str, dict[str, Any]] | None:
    """The wire form of an injected connection map, for forwarding it onward.

    `model_dump()` cannot be used: `api_key` is a `SecretStr`, so a dump either
    hands on the wrapper object (python mode) or the literal mask `'**********'`
    (json mode). A masked key on the guardrail hop is the same outage as no key
    at all, with a longer stack trace — so the secret is unwrapped EXPLICITLY,
    at this one seam, exactly as an adapter unwraps it at the one point it hands
    it to an SDK.

    Only set fields are emitted, so the far side sees the same shape the gateway
    sent rather than a wall of nulls. `None`/empty ⇒ `None`: an absent blob must
    stay absent, because ABSENT is what lets `apps/guardrail` resolve its own
    engine connection instead of being handed an empty dict that says nothing.

    Forwarded ONLY over the internal peer wire (`X-Service-Token`), never logged,
    never persisted.
    """
    if not overrides:
        return None
    wire: dict[str, dict[str, Any]] = {}
    for provider, override in overrides.items():
        entry = override.model_dump(exclude_none=True, exclude={"api_key"})
        key = override.api_key.get_secret_value()
        if key:
            entry["api_key"] = key
        wire[provider] = entry
    return wire


class GuardrailPolicyOverride(BaseModel):
    """The tenant's own input-moderation policy, injected per request.

    `require_medical` and `include_reasoning` are the two parts of the guardrail
    posture that legitimately differ BETWEEN tenants: a non-clinical tenant needs
    medical enforcement off while every other tenant keeps it on. A process-wide
    `TEXT_EXTERNAL_GUARDRAIL_REQUIRE_MEDICAL` could express only one of those, so
    the real choice it offered was "redeploy, or force clinical validation on a
    tenant it does not fit". Cardinality decides the channel (owner decision D-1
    rule 3): anything that can differ per tenant is PUSHED.

    ``None`` on a field means NO OPINION — the platform default stands. It is not
    the same as ``False`` and must never be flattened into it. Resolution lives in
    `core/guardrail_posture.resolve_posture`.

    ``enabled`` is the per-call OPT-OUT (TASK-890 OD-R, 2026-09-06), and it is
    asymmetric on purpose. This field used to be described here as platform-scope
    and PULL-only; the owner decided a tenant may switch platform screening off
    for one agent, one workflow or one node, so the decision — folded gateway-side
    by `resolveGuardrailDecision` (node > workflow > agent > on) — rides on the
    request. What it can do is SUBTRACT: a pushed ``False`` turns both gates off
    for this call, while a pushed ``True`` can never revive a platform kill
    switch, because `resolve_posture` keeps ``platform.enabled`` as the floor.
    Every ``False`` is on the record three ways — a publish WARNING
    (`GUARDRAIL_OPTED_OUT`), the per-call ledger attribute
    ``guardrail: 'opted_out'``, and the ``tenant_opted_out`` skip reason this
    service reports — so the omission is attributable, never merely permitted.

    The remaining posture fields (the retry budget and the platform switch's own
    value) stay platform-scope and arrive on the PULL channel; the FAIL POSTURE is
    not configurable at all — an errored guardrail can never return
    ``allowed: True``.
    """

    enabled: bool | None = None
    require_medical: bool | None = None
    include_reasoning: bool | None = None


class TextContentPart(BaseModel):
    """A text segment of a multimodal ``content_parts`` payload."""

    type: Literal["text"] = "text"
    text: str = Field(..., min_length=1)


class ImageContentPart(BaseModel):
    """An image segment of a multimodal ``content_parts`` payload.

    ``data`` is base64-encoded image bytes with NO ``data:`` URI prefix — that
    prefix is one provider's (OpenAI) wire convention, not a property of the
    image itself. Each adapter builds its own native wire shape from
    ``data``/``media_type`` (OpenAI-wire prepends ``data:``, Anthropic/Bedrock/
    Vertex decode/use the raw bytes).
    """

    type: Literal["image"] = "image"
    data: str = Field(..., min_length=1)
    media_type: str = Field(default="image/png", min_length=1)

    @field_validator("media_type")
    @classmethod
    def _media_type_is_image(cls, v: str) -> str:
        if not v.startswith("image/"):
            raise ValueError(f"media_type must be an image/* MIME type, got '{v}'")
        return v


ContentPart = Annotated[TextContentPart | ImageContentPart, Field(discriminator="type")]


#: The engine a request that names no provider is routed to.
#:
#: ⚠️ THIS IS A HARDCODED SELECTION, and it is retained deliberately rather than
# by oversight ( calls it "a rule-00 config costume"). Recorded
#: here so the next reader does not have to re-derive why it is still standing:
#:
#: * It is ASYMMETRIC with `model`, which has NO default: `POST /generate`
# Fail-closes with a 422 when the model is missing (`api/endpoints/generate.py`
# "Text has no default model"). Provider selection deserves the same posture —
# Both halves of a `{provider, model}` pair come from the same `Agent` /
# `AiRoutingPolicy` resolution on the gateway.
#: * It is REACHABLE, not vestigial. `apps/api`
# `streaming/text-proxy.controller.ts::applyTextModelSelection` stamps
# `{provider, model}` only when `!target.model`, so a caller that PINS a model
# And omits the provider reaches this line — and is then routed to LM Studio
# Whatever engine that model actually lives on.
#:
#: WHAT BLOCKS REMOVAL, precisely: turning this into a required field (or
#: `None` + a 422, mirroring `model`) converts that silent mis-route into a hard
#: failure for two callers that live OUTSIDE `apps/text` and cannot be fixed from
#: here — `apps/api` `text-proxy.controller.ts:299` (above) and
#: `apps/harness/src/harness/services/text_client.py:144`
#: (`if provider: body["provider"] = provider`, with `model` set independently).
#: The correct fix is upstream: the gateway resolves and stamps the provider
#: whenever it is absent, not only when the model is. Once it does, this default
#: is removable in one edit and `tests/unit/test_models_edge_cases.py`
#: ::test_provider_defaults_to_lm_studio is the test that must flip.
#:
#: `apps/nlp` `services/external_text_client.py` is NOT a blocker: it sends
#: neither `provider` nor `model`, so it already fail-closes on the model guard.
_HARDCODED_DEFAULT_PROVIDER = "lm-studio"


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=200_000)
    system_prompt: str | None = Field(default=None, max_length=50_000)
    # See `_HARDCODED_DEFAULT_PROVIDER` — a known, documented config violation
    # whose removal is blocked on two callers outside this service.
    provider: str = _HARDCODED_DEFAULT_PROVIDER
    model: str | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    stream: bool = False
    response_format: ResponseFormat | None = None
    context: dict[str, Any] | None = None
    retry_config: RetryConfig = Field(default_factory=RetryConfig)
    # Gateway-injected tenant BYO credential, keyed by the SAME provider name
    # as ``provider`` (e.g. ``{"azure": {...}}``). Absent for every caller
    # until a tenant configures an enabled cloud (azure/bedrock) connection —
    # override-wins-over-env/config semantics live in the provider clients.
    provider_overrides: dict[str, ProviderOverride] | None = None
    # ADDITIVE multimodal input. ``None``/absent ⇒ every existing
    # text-only caller is byte-identical to before — adapters only branch on
    # this when ``image_parts()`` is non-empty. ``prompt`` remains the single
    # source of the textual instruction every adapter sends; a ``TextContentPart``
    # here is advisory (room for future fine-grained multimodal ordering).
    content_parts: list[ContentPart] | None = None
    # ADDITIVE degrade-routing opt-in. None/absent ⇒ a
    # known-unhealthy ``provider`` fails fast with a typed 503
    # (``PoolUnhealthyError``), same as before this field existed. When set and
    # actually registered, a known-unhealthy ``provider`` reroutes to this name
    # instead — see ``services/pool_router.py``.
    fallback_provider: str | None = None
    # ADDITIVE per-tenant moderation policy (see `GuardrailPolicyOverride`).
    # ``None``/absent ⇒ the platform posture from the PULL channel stands, which
    # is what every caller gets until the gateway resolves a tenant policy.
    guardrail_policy: GuardrailPolicyOverride | None = None
    # engine-specific ride-along from `AiRuntimeProfile.extraJson`
    # (`n_threads`, `num_predict`, `reasoning_effort`, …), injected by the gateway's
    # `applyTextRuntimeProfile`. Undeclared before this, so pydantic dropped it and
    # no profile extra ever reached an engine. The OpenAI-compatible family sends
    # it as `extra_body`; adapters with no such ride-along ignore it.
    extra: dict[str, Any] | None = None

    @field_validator("prompt")
    @classmethod
    def _prompt_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Prompt must not be blank or whitespace-only")
        return v

    def image_parts(self) -> list[ImageContentPart]:
        """Return the image parts of ``content_parts`` (empty when absent)."""
        if not self.content_parts:
            return []
        return [p for p in self.content_parts if isinstance(p, ImageContentPart)]


class GenerateBatchRequest(BaseModel):
    """Async batch-generation submission ( residual close-out)
    enqueued onto ``WorkerPoolQueue`` and processed out-of-process by
    ``worker.py::_handle_batch_generation``, which re-validates this payload
    as a `GenerateRequest`.

    Mirrors ``EmbeddingBatchRequest``'s minimalism (``models/embedding.py``):
    the async surface exposes only the fields the out-of-process handler
    actually consumes to build a ``GenerateRequest`` — not the synchronous
    ``/generate`` request's same-pod concerns (``stream``, ``retry_config``,
    ``provider_overrides``, ``content_parts``, ``fallback_provider``), none of
    which the worker's ``_handle_batch_generation`` reads or acts on today.
    """

    prompt: str = Field(..., min_length=1, max_length=200_000)
    system_prompt: str | None = Field(default=None, max_length=50_000)
    # Same default, same blocker — the worker re-validates this payload as a
    # `GenerateRequest`, so the two must not disagree about the fallback engine.
    provider: str = _HARDCODED_DEFAULT_PROVIDER
    model: str | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)

    @field_validator("prompt")
    @classmethod
    def _prompt_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Prompt must not be blank or whitespace-only")
        return v
