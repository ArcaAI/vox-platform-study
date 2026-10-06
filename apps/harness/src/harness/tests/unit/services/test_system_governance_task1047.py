"""TASK-1047 L10 / FC-6 — when the harness may send ``system_governance`` to apps/text."""

from __future__ import annotations

import hashlib
from typing import Any

import httpx
import pytest

from harness.services.api_client import ApiClient, ApiServiceError
from harness.services.guardrail_client import GuardrailClient, GuardrailServiceError
from harness.services.system_governance import (
    GovernanceVerifier,
    PolicyVersionProbe,
    build_system_governance,
    non_instruction_pieces,
)
from harness.services.text_client import TextClient
from harness.temporal.interpreter.compose_messages import output_language_step, platform_rules

_T = "10000000-0000-0000-0000-000000000001"
_COMPOSED = {
    "pieces": [
        {"kind": "PLATFORM", "key": "platform-rules@1", "digest": "d1"},
        {"kind": "TEMPLATE_BODY", "key": "body", "digest": "d2"},
    ],
    "composed_digest": "dc",
}
_COMPILED = {"policyVersion": "pv1", "pieceDigests": ["d1", "d2", "d9"]}


class TestBuild:
    def test_sends_when_every_digest_is_in_compiled_config_and_versions_match(self) -> None:
        assert build_system_governance(_COMPOSED, _COMPILED, "pv1") == {
            "composed_digest": "dc",
            "pieces": _COMPOSED["pieces"],
            "policy_version": "pv1",
        }

    @pytest.mark.parametrize(
        "composed,compiled,version",
        [
            (None, _COMPILED, "pv1"),
            ({"pieces": [], "composed_digest": "dc"}, _COMPILED, "pv1"),
            (_COMPOSED, None, "pv1"),
            (_COMPOSED, {"policyVersion": "pv1"}, "pv1"),
            (_COMPOSED, {"policyVersion": "pv1", "pieceDigests": ["d1"]}, "pv1"),  # d2 missing
            (_COMPOSED, {"policyVersion": "old", "pieceDigests": ["d1", "d2"]}, "pv1"),
            (_COMPOSED, _COMPILED, "pv2"),  # guardrail moved on
            (_COMPOSED, _COMPILED, None),  # fetch failed
            ({"pieces": _COMPOSED["pieces"]}, _COMPILED, "pv1"),  # no composed digest
        ],
    )
    def test_omits_on_any_gap(self, composed: Any, compiled: Any, version: Any) -> None:
        assert build_system_governance(composed, compiled, version) is None

    def test_non_instruction_pieces_need_no_stamp_entry(self) -> None:
        # d1 (PLATFORM) is not in the stamp — only instruction pieces are checked against it.
        compiled = {"policyVersion": "pv1", "pieceDigests": ["d2"]}
        assert build_system_governance(_COMPOSED, compiled, "pv1") is not None


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class TestNonInstructionPieces:
    def test_reconstructs_platform_and_language_text_when_digests_match(self) -> None:
        rules, lang = platform_rules(), output_language_step("English")
        governance = {
            "pieces": [
                {"kind": "PLATFORM", "key": "platform-rules@1", "digest": _sha(rules)},
                {"kind": "TEMPLATE_BODY", "key": "body", "digest": "x"},
                {"kind": "LANGUAGE", "key": "language:English", "digest": _sha(lang)},
            ],
            "composed_digest": "dc",
        }
        assert non_instruction_pieces(governance) == [
            {"kind": "PLATFORM", "key": "platform-rules@1", "digest": _sha(rules), "text": rules},
            {"kind": "LANGUAGE", "key": "language:English", "digest": _sha(lang), "text": lang},
        ]

    def test_drops_a_piece_whose_reconstruction_does_not_match(self) -> None:
        governance = {"pieces": [{"kind": "PLATFORM", "key": "k", "digest": "0" * 64}]}
        assert non_instruction_pieces(governance) == []


class _Api:
    def __init__(self, answers: list[Any]) -> None:
        self.answers = answers
        self.calls: list[dict[str, Any]] = []

    async def verify_governed_prompts(self, *, tenant_id: str, digests: list[str], pieces: Any):
        self.calls.append({"tenant_id": tenant_id, "digests": digests, "pieces": pieces})
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class TestVerifier:
    _G = {
        "pieces": [{"kind": "TEMPLATE_BODY", "key": "body", "digest": "d2"}],
        "composed_digest": "dc",
    }

    @pytest.mark.asyncio
    async def test_returns_the_gateway_answer_and_caches_per_digest_set(self) -> None:
        api = _Api([{"governed": True, "policyVersion": "pv1"}, {"governed": False}])
        verifier = GovernanceVerifier(api, _T)  # type: ignore[arg-type]
        assert await verifier.verify(self._G) == (True, "pv1")
        assert await verifier.verify(self._G) == (True, "pv1")
        assert len(api.calls) == 1
        assert api.calls[0]["digests"] == ["d2"]

    @pytest.mark.asyncio
    async def test_a_failed_verification_is_not_governed_and_not_retried(self) -> None:
        api = _Api([ApiServiceError("down"), {"governed": True, "policyVersion": "pv1"}])
        verifier = GovernanceVerifier(api, _T)  # type: ignore[arg-type]
        assert await verifier.verify(self._G) == (False, None)
        assert await verifier.verify(self._G) == (False, None)
        assert len(api.calls) == 1

    @pytest.mark.asyncio
    async def test_offers_non_instruction_text_for_registration(self) -> None:
        rules = platform_rules()
        gov = {
            "pieces": [{"kind": "PLATFORM", "key": "platform-rules@1", "digest": _sha(rules)}],
            "composed_digest": "dc",
        }
        api = _Api([{"governed": True, "policyVersion": "pv1"}])
        await GovernanceVerifier(api, _T).verify(gov)  # type: ignore[arg-type]
        assert api.calls[0]["pieces"][0]["text"] == rules


class TestApiClientVerify:
    @pytest.mark.asyncio
    async def test_posts_to_the_sibling_mount_with_token_and_tenant(self) -> None:
        import json

        seen: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            seen.append(req)
            return httpx.Response(200, json={"governed": True, "policyVersion": "pv1"})

        client = ApiClient(
            "http://api", service_token="tok", transport=httpx.MockTransport(handler)
        )
        out = await client.verify_governed_prompts(tenant_id=_T, digests=["d" * 64], pieces=None)
        assert out == {"governed": True, "policyVersion": "pv1"}
        assert seen[0].url.path == "/api/v1/internal/governed-prompts/verify"
        assert seen[0].headers["x-service-token"] == "tok"
        assert seen[0].headers["x-tenant-id"] == _T
        assert json.loads(seen[0].content) == {"tenantId": _T, "digests": ["d" * 64]}


class _Client:
    def __init__(self, answers: list[Any]) -> None:
        self.answers = answers
        self.calls = 0

    async def policy_version(self, *, tenant_id: str) -> str:
        self.calls += 1
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class TestProbe:
    @pytest.mark.asyncio
    async def test_fetches_once_and_caches(self) -> None:
        client = _Client(["pv1", "pv2"])
        probe = PolicyVersionProbe(client, _T)  # type: ignore[arg-type]
        assert await probe.get() == "pv1"
        assert await probe.get() == "pv1"
        assert client.calls == 1

    @pytest.mark.asyncio
    async def test_failure_is_none_and_not_retried_again(self) -> None:
        client = _Client([GuardrailServiceError("down"), "pv1"])
        probe = PolicyVersionProbe(client, _T)  # type: ignore[arg-type]
        assert await probe.get() is None
        assert await probe.get() is None
        assert client.calls == 1


class TestGuardrailClientPolicyVersion:
    @pytest.mark.asyncio
    async def test_reads_the_endpoint_with_token_and_tenant(self) -> None:
        seen: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            seen.append(req)
            return httpx.Response(200, json={"policyVersion": "pv1"})

        client = GuardrailClient(
            "http://g", service_token="tok", transport=httpx.MockTransport(handler)
        )
        assert await client.policy_version(tenant_id=_T) == "pv1"
        assert seen[0].url.path == "/api/v1/guardrail/policy-version"
        assert seen[0].headers["x-service-token"] == "tok"
        assert seen[0].headers["x-tenant-id"] == _T

    @pytest.mark.asyncio
    async def test_retries_once_then_raises(self) -> None:
        n = 0

        def handler(_req: httpx.Request) -> httpx.Response:
            nonlocal n
            n += 1
            return httpx.Response(503)

        client = GuardrailClient(
            "http://g", service_token="tok", transport=httpx.MockTransport(handler)
        )
        with pytest.raises(GuardrailServiceError):
            await client.policy_version(tenant_id=_T)
        assert n == 2


class TestTextClientBody:
    @pytest.mark.asyncio
    async def test_system_governance_travels_in_the_body_only_when_given(self) -> None:
        bodies: list[dict[str, Any]] = []

        def handler(req: httpx.Request) -> httpx.Response:
            import json

            bodies.append(json.loads(req.content))
            return httpx.Response(200, json={"content": "x", "provider": "p", "model": "m"})

        client = TextClient("http://t", transport=httpx.MockTransport(handler))
        gov = {"composed_digest": "dc", "pieces": [], "policy_version": "pv1"}
        await client.generate(
            tenant_id=_T,
            prompt="u",
            system_prompt="s",
            provider="p",
            model="m",
            system_governance=gov,
        )
        await client.generate(tenant_id=_T, prompt="u", system_prompt="s", provider="p", model="m")
        assert bodies[0]["system_governance"] == gov
        assert "system_governance" not in bodies[1]
