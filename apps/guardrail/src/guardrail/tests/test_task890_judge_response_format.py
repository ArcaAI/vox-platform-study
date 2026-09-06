"""The judge lane's ``response_format`` must be a shape BOTH hops accept.

Two independent contracts sit on this one field, and the shipped value
(``{"type": "json_object"}``) satisfied neither:

* **`apps/text`** validates it against ``ResponseFormat.type``, a
  ``Literal["text", "json", "json_schema"]``. ``json_object`` is not a member,
  so every judge call was rejected with a 422 before any model ran — which
  guardrail read as "no verdict", failed CLOSED, and turned into a 502 on every
  guardrail-enabled generation in the platform.
* **LM Studio**, the engine behind the default judge model, refuses the
  OpenAI ``json_object`` wire form outright (``'response_format.type' must be
  'json_schema' or 'text'``; the same behaviour is recorded in
  ``apps/harness/eval/README.md``). ``text`` maps its own ``"json"`` literal
  onto exactly that refused wire form
  (``providers/openai_compat.py::_apply_response_format``), so merely renaming
  the literal to ``"json"`` would have moved the failure one hop later.

The shape that satisfies both — and the one this client's own docstring already
promises ("guardrail pins a JSON schema so it parses a shape rather than
prose") — is ``json_schema`` carrying the verdict schema.

The `text` literal is read out of the committed source rather than restated, so
this pins the real contract instead of a copy of it.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from guardrail.services.external_text_client import JUDGE_VERDICT_SCHEMA, TextJudgeClient

# apps/guardrail/src/guardrail/tests/<this file> → repo root
_REPO_ROOT = Path(__file__).resolve().parents[5]
_TEXT_REQUESTS = _REPO_ROOT / "apps" / "text" / "src" / "text" / "models" / "requests.py"

_LITERAL = re.compile(r"^\s*type:\s*Literal\[(?P<members>[^\]]+)\]")

#: What LM Studio accepts on the OpenAI wire. `text` maps its ``"json"`` literal
#: to ``{"type": "json_object"}``, which is NOT in this set.
_LM_STUDIO_WIRE_TYPES = frozenset({"json_schema", "text"})


def _text_response_format_literal() -> frozenset[str]:
    """``ResponseFormat.type``'s accepted members, as `apps/text` declares them."""
    if not _TEXT_REQUESTS.is_file():
        pytest.skip(f"apps/text request models not available at {_TEXT_REQUESTS}")

    source = _TEXT_REQUESTS.read_text(encoding="utf-8")
    marker = source.index("class ResponseFormat(BaseModel):")
    for line in source[marker:].splitlines()[1:]:
        match = _LITERAL.match(line)
        if match:
            return frozenset(m.strip().strip("\"'") for m in match.group("members").split(","))
    raise AssertionError("ResponseFormat.type is no longer a Literal — re-derive this contract")


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _RecordingClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"url": url, **kwargs})
        return _FakeResponse(
            {
                "content": (
                    '{"is_medical": true, "confidence": 0.93, '
                    '"context_type": "clinical", "reasoning": "vitals"}'
                ),
                "provider": "lm-studio",
                "model": "guardian-1",
                "stats": {"provider": "lm-studio", "model": "guardian-1"},
            }
        )


def _client(http_client: Any) -> TextJudgeClient:
    return TextJudgeClient(
        base_url="http://text:8862",
        http_client=http_client,
        service_token="tok",
        provider="lm-studio",
        model="guardian-1",
        tenant_id="11111111-1111-1111-1111-111111111111",
        criteria="you are a medical context validator",
        temperature=0.05,
        max_tokens=300,
        timeout_s=60.0,
    )


async def _sent_response_format() -> dict[str, Any]:
    http = _RecordingClient()
    await _client(http).validate_medical_context("chest pain, BP 140/90")
    return dict(http.calls[0]["json"]["response_format"])


@pytest.mark.asyncio
async def test_response_format_type_is_a_member_of_texts_literal() -> None:
    """The callee's validator is the published contract; guardrail obeys it."""
    sent = await _sent_response_format()
    accepted = _text_response_format_literal()

    assert sent["type"] in accepted, (
        f"apps/text rejects response_format.type={sent['type']!r} with a 422 "
        f"(accepted: {sorted(accepted)}), which fails the safety gate closed"
    )


@pytest.mark.asyncio
async def test_response_format_survives_texts_mapping_onto_the_lm_studio_wire() -> None:
    """`json` is accepted by `text` and then refused by the engine — pick `json_schema`."""
    sent = await _sent_response_format()

    assert sent["type"] in _LM_STUDIO_WIRE_TYPES, (
        f"`text` maps response_format.type={sent['type']!r} onto an OpenAI wire form "
        f"LM Studio refuses; it accepts only {sorted(_LM_STUDIO_WIRE_TYPES)}"
    )


@pytest.mark.asyncio
async def test_the_pinned_schema_is_the_verdict_shape_the_parser_reads_back() -> None:
    sent = await _sent_response_format()

    assert sent["json_schema"] == JUDGE_VERDICT_SCHEMA
    assert sent["strict"] is True
    # `text` names the schema from its `title` (openai_compat `_apply_response_format`),
    # so an untitled schema reaches the engine as the generic "output".
    assert JUDGE_VERDICT_SCHEMA["title"]
    # Every field `_parse_verdict` reads must be required, or the engine is free to
    # emit a shape the parser then calls undetermined.
    assert set(JUDGE_VERDICT_SCHEMA["required"]) == {
        "is_medical",
        "confidence",
        "context_type",
        "reasoning",
    }
    assert set(JUDGE_VERDICT_SCHEMA["properties"]) == set(JUDGE_VERDICT_SCHEMA["required"])
