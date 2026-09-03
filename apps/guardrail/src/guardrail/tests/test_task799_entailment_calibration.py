"""the entailment calibration must travel guardrail -> nlp.

`apps/nlp` refuses to score without it, so an unforwarded blob degrades the
groundedness gate to `unverified`: safe, but silently non-functional. Both
halves existed and neither proved they connect — the same shape as the Qdrant
api_key defect Phase 3 found.
"""

from typing import Any

import httpx

from guardrail.services.external_nlp_client import NlpGuardClient

CAL = {"adapter": "minicheck-flan-t5", "supportedMin": 0.6, "unsupportedMax": 0.4}


def _client(**kw: Any) -> NlpGuardClient:
    return NlpGuardClient(
        base_url="http://nlp",
        service_token="t",
        http_client=httpx.AsyncClient(),
        tenant_id="00000000-0000-0000-0000-000000000000",
        model_id="minicheck",
        **kw,
    )


def test_calibration_reaches_the_wire() -> None:
    captured: dict[str, Any] = {}

    async def _capture(request: httpx.Request) -> httpx.Response:
        import json as _json

        captured.update(_json.loads(request.content))
        return httpx.Response(200, json={"score": 0.9})

    c = _client(calibration=CAL)
    c._http = httpx.AsyncClient(transport=httpx.MockTransport(_capture))
    import asyncio

    asyncio.run(c._post("/guard/entailment", {"premise": "a", "hypothesis": "b"}, "entailment"))
    assert captured.get("calibration") == CAL, "the blob must reach nlp verbatim"


def test_absent_calibration_is_omitted_not_faked() -> None:
    captured: dict[str, Any] = {}

    async def _capture(request: httpx.Request) -> httpx.Response:
        import json as _json

        captured.update(_json.loads(request.content))
        return httpx.Response(200, json={"score": 0.9})

    c = _client()
    c._http = httpx.AsyncClient(transport=httpx.MockTransport(_capture))
    import asyncio

    asyncio.run(c._post("/guard/entailment", {"premise": "a", "hypothesis": "b"}, "entailment"))
    assert "calibration" not in captured, "never substitute a default calibration"
