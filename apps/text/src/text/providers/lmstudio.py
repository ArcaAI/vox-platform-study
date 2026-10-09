"""LM Studio LLM provider — first-class engine over the OpenAI wire.

LM Studio speaks the OpenAI chat-completions wire, so ``LMStudioProvider``
composes the same async client as ``OpenAICompatProvider`` but carries a distinct
engine identity (``provider="lm-studio"`` in AD-1 stats / spans / ``get_info``)
and owns the three affordances that are NOT part of that wire:

* the JIT idle-retention hint ``extra_body.ttl`` (`core/retention.py` — Text
  holds no weights, LM Studio does, so retention is propagation);
* the native ``GET {root}/api/v0/models`` listing, which carries ``state`` /
  ``quantization`` / ``max_context_length`` that ``/v1/models`` does not;
* the non-standard ``stats`` blob LM Studio adds to a completion, captured
  audit-only into ``GenerationStats.engine_native``;
* the structured-output wire, which admits ONLY ``json_schema`` and ``text`` —
  never OpenAI's ``json_object`` (see ``_apply_response_format``).

## Why this is a class and not three ``if provider_name == "lm-studio"`` guards

That is what it was, and the guard never fired. ``main.py`` registered ONE
``OpenAICompatProvider`` under BOTH ``lm-studio`` and ``openai_compat``, built
with the DEFAULT ``provider_name="openai_compat"`` — so every request that named
``lm-studio`` was served by an instance that did not believe it was LM Studio.
The retention hint was silently dead, and the native listing had to be re-enabled
by widening its guard to a two-name set that then also probed GENERIC endpoints.
A subclass cannot be wrong about which engine it is.

## What is deliberately NOT here

**No HOPE internal headers.** `06-python-services.md` requires ``X-Service-Token``
plus a mandatory ``X-Tenant-Id`` on internal PEER calls (text→guardrail,
nlp→text). LM Studio is not a peer: it is a third-party OpenAI-compatible server
outside the platform's trust boundary, with no HOPE service identity and no
notion of a tenant. Sending it the one shared internal token would export that
secret to a process that cannot check it, and sending the tenant id would leak a
customer identifier for no reader. The only credential on this wire is the
``AiProviderConnection`` row's own ``api_key``.

**No invented credential.** LM Studio has NO headless authentication of any kind
— its ``/v1`` surface accepts any bearer token, including none. The keyless
self-hosted row therefore carries the non-secret ``not-needed`` placeholder
(`seed/17-ai-provider-connection.ts` ``SELF_HOST_PLACEHOLDER_API_KEY``), which
exists only because the gateway's override fold drops keyless rows. The
CONSEQUENCE, stated so nobody has to rediscover it: anything that can reach LM
Studio's port can use it. Its protection is network reachability, not
authentication.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx
import structlog

from text.core.exceptions import ProviderUnavailableError
from text.core.reasoning import ReasoningSupport
from text.models.provider import ModelInfo
from text.models.requests import GenerateRequest
from text.models.stats import GenerationStats
from text.models.stream import StreamChunk
from text.providers.openai_compat import OpenAICompatProvider
from text.services.judge_guard import in_judge_scope

logger = structlog.get_logger(__name__)

_ENGINE = "lm-studio"

#: Short, self-contained budget for the OPTIONAL native listing probe. The
#: endpoint-level `asyncio.wait_for` caps the whole `get_info`; this keeps the
#: enrichment from consuming that entire budget and losing the `/v1` result.
_NATIVE_PROBE_TIMEOUT_S = 3.0


def _native_probe_client() -> httpx.AsyncClient:
    """Factory for the native-probe transport (patched in tests)."""
    return httpx.AsyncClient(timeout=_NATIVE_PROBE_TIMEOUT_S)


def _ensure_client(timeout_s: float) -> httpx.AsyncClient:
    """Factory for the residency-agent transport (patched in tests)."""
    return httpx.AsyncClient(timeout=timeout_s)


_ENVELOPE_KEYS = frozenset({"name", "schema", "strict", "description"})


def _unwrapped_envelope(request: GenerateRequest) -> dict[str, Any] | None:
    """The LM Studio wire for a ``json_schema`` that is the OpenAI ``{name, schema, strict}``
    envelope; ``None`` when it is a bare schema (or not a ``json_schema`` at all).

    A bare JSON schema never qualifies: ``schema`` is not a schema keyword (``$schema`` is), so a
    root made only of envelope keys with an object ``schema`` is unambiguous.
    """
    rf = request.response_format
    if rf is None or rf.type != "json_schema" or not rf.json_schema:
        return None
    envelope = rf.json_schema
    schema = envelope.get("schema")
    if not isinstance(schema, dict) or not set(envelope) <= _ENVELOPE_KEYS:
        return None
    name = envelope.get("name")
    strict = envelope.get("strict")
    return {
        "type": "json_schema",
        "json_schema": {
            "name": name if isinstance(name, str) and name else "output",
            "schema": schema,
            "strict": strict if isinstance(strict, bool) else rf.strict,
        },
    }


class LMStudioProvider(OpenAICompatProvider):
    """LM Studio self-hosted provider (OpenAI-wire, engine-native identity)."""

    # TASK-970 — restated rather than inherited, because this subclass knows its
    # engine and the evidence is its own. The DOCS list `reasoning_effort` rungs
    # low|medium|high (gpt-oss) with no off value, and this was first classified
    # EFFORT_ONLY on that basis. MEASURING the deployed server overturned it:
    # `'minimal'` does not stop thinking and is WORSE than sending nothing
    # (gemma-4-e2b-it-qat 84 completion tokens / 289ch reasoning at 'minimal' vs
    # 70 / 231 at baseline), while `'none'` genuinely stops it (9 tokens / 0ch;
    # gemma-4-e4b 61.7s -> 0.9s; granite-guardian-4.1-8b 17.7s -> 1.3s). A
    # non-reasoning model accepts 'none' without rejecting it.
    #
    # This is why the fixture demands verification against the DEPLOYED engine
    # rather than its documentation: shipping the documented answer here left
    # every agent, every guardrail medical validation and every judge call
    # thinking, with the platform believing it had turned reasoning off.
    reasoning_support = ReasoningSupport.NATIVE_OFF
    reasoning_parameter = "reasoning_effort"
    reasoning_effort_parameter = "reasoning_effort"

    def __init__(self) -> None:
        """No configuration — the engine endpoint arrives per request, exactly as
        for the base OpenAI-compatible adapter."""
        super().__init__(provider_name=_ENGINE, display_name="LM Studio")
        self._ensure_url = ""
        self._ensure_token = ""

    def configure_residency_ensure(self, *, agent_url: str, service_token: str) -> None:
        """Point the pre-request ensure at the LM Studio residency agent (TASK-1055 wave 3).

        The agent is a HOPE peer (unlike LM Studio itself), so it — and only it — gets
        ``X-Service-Token``. An empty URL leaves the feature off.
        """
        self._ensure_url = agent_url.strip().rstrip("/")
        self._ensure_token = service_token

    async def _ensure_resident(self, request: GenerateRequest) -> None:
        """Ask the agent to make sure the request's model is loaded, before sending to LM Studio.

        200 proceeds. A 503 ``LOAD_FAILED`` fails the request (the model cannot be served, and
        the JIT fallback would only repeat the failure). Anything else — agent unreachable, slow,
        401, 404 ``MODEL_UNKNOWN``, an unrelated 503 — is logged and skipped: LM Studio's own JIT
        load is the behaviour before this existed.
        """
        url = getattr(self, "_ensure_url", "")
        model = self._resolve_model(request)
        if not url or not model:
            return
        try:
            async with _ensure_client(float(self._timeout_s)) as client:
                resp = await client.post(
                    f"{url}/internal/residency/ensure",
                    json={"model_ref": model},
                    headers={"X-Service-Token": self._ensure_token},
                )
        except Exception as exc:  # noqa: BLE001 — unreachable/timeout never blocks a request
            logger.warning(
                "text.lmstudio.ensure_skipped", model=model, reason="unreachable", error=str(exc)
            )
            return
        if resp.status_code == 200:
            return
        try:
            body = resp.json()
        except ValueError:
            body = {}
        code = body.get("code") if isinstance(body, dict) else None
        if resp.status_code == 503 and code == "LOAD_FAILED":
            cause = body.get("message") or "model load failed"
            raise ProviderUnavailableError(
                f"LM Studio could not load model '{model}': {cause}", provider=self._provider_name
            )
        logger.warning(
            "text.lmstudio.ensure_skipped",
            model=model,
            reason="agent_refused",
            status=resp.status_code,
            code=code,
        )

    async def generate(self, request: GenerateRequest) -> tuple[str, str, GenerationStats]:
        await self._ensure_resident(request)
        return await super().generate(request)

    async def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        await self._ensure_resident(request)
        async for chunk in super().generate_stream(request):
            yield chunk

    def _apply_response_format(self, kwargs: dict[str, Any], request: GenerateRequest) -> None:
        """LM Studio's structured-output wire: ``json_schema`` or ``text``, nothing else.

        ``ResponseFormat.type == "json"`` is Text's vocabulary for "answer in JSON, no schema",
        and the generic OpenAI wire spells it ``{"type": "json_object"}``. LM Studio refuses
        that outright::

            400 {'error': "'response_format.type' must be 'json_schema' or 'text'"}

        so every published agent whose ``parameters.responseFormat`` is ``json`` failed on this
        engine before a token was generated. It is expressed here as the PERMISSIVE object
        schema — the same intent LM Studio's grammar engine can carry: constrain the output to
        be a JSON object and nothing further, because the caller declared no shape. ``strict``
        stays False for exactly that reason (a strict schema demands a closed property set
        nobody named).

        A caller-declared ``json_schema`` is forwarded by the base adapter untouched — except when
        it arrives as the OpenAI envelope ``{name, schema, strict}`` (what an agent's declared
        ``outputSchema`` becomes on every lane). The base adapter reads ``json_schema`` as the
        schema itself, so LM Studio was handed a root of ``{name, schema, strict}`` and its grammar
        constrained nothing; the envelope is unwrapped here into the schema it carries.
        """
        if request.response_format is not None and request.response_format.type == "json":
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "output", "schema": {"type": "object"}, "strict": False},
            }
            return
        unwrapped = _unwrapped_envelope(request)
        if unwrapped is not None:
            kwargs["response_format"] = unwrapped
            return
        super()._apply_response_format(kwargs, request)

    def _apply_retention_hint(self, kwargs: dict[str, Any]) -> None:
        """Attach LM Studio's JIT ``ttl`` (seconds) via the OpenAI SDK's
        sanctioned ``extra_body`` ride-along for non-standard fields.

        The value is the control-plane retention TTL adopted by
        ``apply_retention`` and clamped to the shared product range — one
        admin-controlled number, not LM Studio's own 60-minute default.

        Never sent for the internal judge route: a judge model's residency is
        managed explicitly on /model-residency, and an idle-TTL unload would make
        it read "not resident" there.
        """
        if in_judge_scope():
            return
        kwargs["extra_body"] = {"ttl": self._retention_ttl_s}

    def _engine_native(self, response: Any, usage: dict[str, Any]) -> dict[str, Any]:
        """OpenAI ``usage`` plus LM Studio's non-standard ``stats`` blob when the
        server includes it (extra field, dict-shaped) — audit-only, never billed."""
        native = super()._engine_native(response, usage)
        lm_stats = getattr(response, "stats", None)
        if isinstance(lm_stats, dict):
            native["lm_studio_stats"] = lm_stats
        return native

    async def _native_models(self, base_url: str | None = None) -> dict[str, dict[str, Any]]:
        """LM Studio's native REST listing, keyed by model id.

        `/v1/models` (OpenAI wire) carries no load state, but LM Studio also
        serves `GET {root}/api/v0/models` with `state` / `quantization` /
        `max_context_length` on the SAME host — the AsyncOpenAI client cannot
        reach it (it prefixes `/v1`), so this uses a plain httpx call against
        `base_url` minus its trailing `/v1`.

        ``base_url`` is explicit so a connection-scoped discovery probe enriches
        the engine it was GIVEN; omitted, it falls back to the process memo, which
        is what `get_info()` has always used.

        ANY failure returns `{}`: enrichment is strictly best-effort and must
        never degrade or fail the `/v1/models` listing.
        """
        root = (base_url or self._probe_url() or "").rstrip("/")
        if not root:
            return {}
        if root.endswith("/v1"):
            root = root[: -len("/v1")].rstrip("/")
        try:
            async with _native_probe_client() as client:
                resp = await client.get(f"{root}/api/v0/models")
            if resp.status_code != 200:
                return {}
            return {m["id"]: m for m in resp.json().get("data", []) if m.get("id")}
        except Exception as exc:  # noqa: BLE001 — best-effort enrichment
            logger.warning(
                "get_info.native_probe_failed", provider=self._provider_name, error=str(exc)
            )
            return {}

    async def count_tokens(
        self, texts: list[str], *, model: str, request: object
    ) -> list[int] | None:
        """Exact counts from LM Studio's own tokenizer, or ``None``.

        LM Studio's REST surface (``/v1``, ``/api/v0``) exposes no tokenize or
        count endpoint; tokenization is reachable only through its JS SDK
        websocket. The one HTTP-reachable measurement of the engine's tokenizer is
        the ``usage.prompt_tokens`` of a raw ``/v1/completions`` call, so that is
        used: ``max_tokens=1`` bounds generation, and the constant per-request
        overhead (BOS etc.) is calibrated away with a one-token probe. It is only
        attempted for a model that is already resident, because a request to an
        unloaded id would make the engine JIT-load it.
        """
        from text.core.connection import resolve_connection

        connection = resolve_connection(request)
        base_url = (connection.base_url or "").strip() if connection else ""
        if connection is None or not base_url:
            return None
        native = await self._native_models(base_url)
        if (native.get(model) or {}).get("state") != "loaded":
            return None
        client = self._client_at(base_url, connection.api_key.get_secret_value())

        async def _prompt_tokens(prompt: str) -> int:
            resp = await client.completions.create(model=model, prompt=prompt, max_tokens=1)
            if resp.usage is None:
                raise ValueError("the engine returned no usage for the token count")
            return int(resp.usage.prompt_tokens)

        try:
            overhead = await _prompt_tokens("a") - 1
            return [max(0, await _prompt_tokens(t) - overhead) if t else 0 for t in texts]
        except Exception as exc:  # noqa: BLE001 — best-effort; caller falls through
            logger.warning("count_tokens.failed", provider=self._provider_name, error=str(exc))
            return None

    async def _enrich_models(self, models: list[ModelInfo], base_url: str | None) -> None:
        """Decorate the `/v1/models` listing with the native load state."""
        native = await self._native_models(base_url)
        for model in models:
            meta = native.get(model.name)
            if not meta:
                continue
            model.state = meta.get("state")
            model.engine_native = meta
