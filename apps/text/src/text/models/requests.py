"""Request models for the generate API."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, SecretStr, field_validator

from text.core.defaults import PENALTY_MAX, PENALTY_MIN


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
    # TASK-958 — WHICH connection row of this provider the credential came from. A
    # tenant may hold several `AiProviderConnection` rows for one (service, provider),
    # so `funding` says WHOSE money and this says WHICH KEY — two different questions a
    # tenant with two accounts needs answered separately on its cost surfaces.
    #
    # This plane does NOT re-key `provider_overrides` by connection: the fallback chain
    # is walked by the GATEWAY, one request per candidate, so a request carries at most
    # one candidate per provider and there is nothing to disambiguate. These are
    # attribution metadata only — every adapter ignores them.
    #
    # Non-secret, so deliberately NOT SecretStr: the attribution must survive
    # `model_dump()`, exactly like `funding`.
    connection_id: str | None = None
    connection_slug: str | None = None
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
    """The tenant's own moderation TUNING, injected per request.

    Only ``include_reasoning`` remains. ``enabled`` (the per-call opt-out, TASK-890
    OD-R) and ``require_medical`` were REMOVED by TASK-1035 (OD-1, OD-5): both
    gates always run, and the medical judge is skipped only by a request declaring
    ``medical_exempt: "internal"``. A gateway that still pushes either key is
    ignored rather than refused — unknown fields are dropped — so a mixed-version
    rollout degrades to "screened", never to a 422.

    ``None`` means NO OPINION — the platform default stands.
    """

    include_reasoning: bool | None = None


class KnownPhi(BaseModel):
    """A value the CALLER already holds that must never reach a cloud provider.

    Schema-PHI-class context fields plus the patient/clinician identity the
    gateway or harness resolved. Replaced deterministically on cloud egress, in
    addition to the GLiNER2 spans. Never logged.
    """

    label: str = Field(..., min_length=1, max_length=64)
    value: str = Field(..., min_length=2, max_length=2_000)

    def __repr__(self) -> str:  # the value is PHI
        return f"KnownPhi(label={self.label!r})"

    __str__ = __repr__


#: The provider locality the caller stamps (`core/locality.py` decides).
ProviderLocalityStamp = Literal["local", "cloud"]


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


ReasoningEffort = Literal["minimal", "low", "medium", "high"]
"""The ONE effort vocabulary, neutral of any engine.

Deliberately NOT OpenAI's full `reasoning_effort` literal (which also carries
``none``/``xhigh``/``max``): ``none`` is not an effort, it is the OFF state, and
conflating the two is the exact loss this contract removes.
"""


class ReasoningPosture(BaseModel):
    """One request's resolved reasoning/thinking posture (TASK-970).

    The posture travels as a POSTURE and each adapter renders it into its own
    engine's parameter. It used to be pre-rendered gateway-side into
    ``extra.reasoning_effort`` — `agent-reasoning.ts::reasoningExtra` mapped
    ``enabled: false`` onto ``'minimal'`` — which is LOSSY twice over: once on
    the wire, "the admin turned reasoning OFF" was indistinguishable from "the
    admin asked for minimal effort", and an engine whose off-switch is a
    different parameter entirely (Ollama ``think: false``, Anthropic
    ``thinking: {type: disabled}``) could no longer be driven at all.

    Three states, and ABSENCE is a fourth that must never be synthesized here:

    * ``{enabled: false}`` — render the engine's own off-switch.
    * ``{enabled: true}`` — reasoning on, no budget named; render "on" without
      pinning an effort (on an engine whose default is already on, that means
      sending nothing).
    * ``{enabled: true, effort: ...}`` — on at a named budget.
    * the FIELD ABSENT — no posture at any tier. Send nothing; the engine
      decides. The platform tier resolved before the wire, so an absent field
      here is a real "nobody had an opinion", not a missing default.

    Which adapter can express which state is declared per adapter and pinned by
    the cross-language contract ``tests/contracts/reasoning-posture.fixture.json``
    (see `text/core/reasoning.py`).
    """

    enabled: bool
    effort: ReasoningEffort | None = None


#: The request-size envelope for ONE half of a prompt, system or user. It guards payload
#: size only: whether the prompt fits is the model's context window, which the engine
#: enforces and this service surfaces as ``CONTEXT_WINDOW_EXCEEDED`` (never a truncation).
#: The system half shares the user half's envelope — a governed call carries the agent's
#: instruction and the document template's section rules there, and a smaller cap refused
#: prompts that fit the window with room to spare.
MAX_PROMPT_CHARS = 200_000


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=MAX_PROMPT_CHARS)
    system_prompt: str | None = Field(default=None, max_length=MAX_PROMPT_CHARS)
    # Selection is fail-closed: Text names no engine of its own, so a request that
    # omits `provider` is refused (422) exactly as one that omits `model` is
    # (`api/endpoints/generate.py`). The caller resolves both halves of the
    # `{provider, model}` pair from the same Agent / routing-policy resolution.
    provider: str = Field(..., min_length=1)
    model: str | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    # TASK-1001 OD-10 — decode-time repetition pressure, by its OpenAI-wire
    # names. OPTIONAL end to end and deliberately NOT floored: absent means "no
    # opinion" and `0` means "neutral", and neither is ever sent to an engine
    # (`core/defaults.resolve_request_defaults`). An engine that cannot take a
    # penalty drops it with a debug log, never an error. Bounds are the agent
    # schema's (`GENERATION_PROPERTY`, `packages/workflow-contract`).
    frequency_penalty: float | None = Field(default=None, ge=PENALTY_MIN, le=PENALTY_MAX)
    presence_penalty: float | None = Field(default=None, ge=PENALTY_MIN, le=PENALTY_MAX)
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
    # TASK-970 — the resolved reasoning/thinking posture, rendered per engine by
    # the adapter (see `ReasoningPosture`). ABSENT means "no posture at any
    # tier": every adapter sends nothing and synthesizes no default.
    #
    # `extra.reasoning_effort` REMAINS supported and still wins per key — a call
    # site that pins the raw OpenAI-shaped ride-along is not second-guessed, and
    # `core/reasoning.posture_to_render` is the single place that rule lives.
    reasoning: ReasoningPosture | None = None
    # TASK-1035 §5.0 — the egress contract. `provider_locality` is keyed by
    # provider name and covers `provider` AND `fallback_provider`; an absent or
    # unknown stamp resolves to CLOUD unless the provider is engine-served
    # (`core/locality.py`). `known_phi` is replaced on cloud egress. `medical_exempt`
    # is the ONLY way to skip the medical judge, and only internal service callers
    # set it.
    provider_locality: dict[str, ProviderLocalityStamp] | None = None
    known_phi: list[KnownPhi] | None = Field(default=None, max_length=200)
    medical_exempt: Literal["internal"] | None = None

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
