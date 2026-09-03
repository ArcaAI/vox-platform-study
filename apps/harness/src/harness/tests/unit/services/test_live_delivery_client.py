"""the wire contract for the two realtime delivery planes.

These two publishes are the ONLY way an interpreter-produced summary, suggestion or correction
proposal reaches a clinician, and the gateway route + console surface are built against exactly
these bodies. Pinning the path, the method and the key names here is what lets build a
renderer without guessing — a silent rename on this side is a silent blank panel on that one.

The swallow posture is deliberately NOT here: the client raises like every other method and the
calling NODE absorbs it (see ``test_realtime_delivery.py``), so an operator still sees the
transport failure in the client's own error path.
"""

from __future__ import annotations

import json

import httpx
import pytest

from harness.services.api_client import ApiClient, ApiServiceError

_TENANT = "10000000-0000-0000-0000-000000000001"


def _client(handler) -> ApiClient:
    return ApiClient(
        "http://api:8868",
        internal_prefix="/internal/harness",
        service_token="svc-token",
        transport=httpx.MockTransport(handler),
    )


class TestPublishLiveSummary:
    @pytest.mark.asyncio
    async def test_posts_the_snapshot_to_the_existing_live_summary_plane(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"ok": True})

        ok = await _client(handler).publish_live_summary(
            "c1",
            tenant_id=_TENANT,
            running_summary="Cough for three days.",
            sections=[{"title": "Subjective", "content": "Cough for three days."}],
            node_type="consultation.realtimeSummary",
            ordinal=1,
            total=3,
            provider="lm-studio",
            model="a-model",
            task_key="text.live",
            user_id="u1",
            job_id="j1",
        )

        assert ok is True
        request = seen["request"]
        assert request.method == "POST"
        assert str(request.url) == "http://api:8868/internal/harness/consultations/c1/live-summary"
        assert request.headers["X-Service-Token"] == "svc-token"
        body = json.loads(request.content)
        assert body == {
            "tenantId": _TENANT,
            "runningSummary": "Cough for three days.",
            "sections": [{"title": "Subjective", "content": "Cough for three days."}],
            "source": "interpreter",
            "nodeType": "consultation.realtimeSummary",
            "ordinal": 1,
            "total": 3,
            "provider": "lm-studio",
            "model": "a-model",
            "taskKey": "text.live",
            "userId": "u1",
            "jobId": "j1",
        }

    @pytest.mark.asyncio
    async def test_omits_absent_optional_fields(self):
        """apps/api runs ``forbidNonWhitelisted``; a ``null`` for an unset optional would 400
        the whole publish, so ``_prune`` must drop it (every other method's contract)."""
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"ok": True})

        await _client(handler).publish_live_summary(
            "c1", tenant_id=_TENANT, running_summary="x", sections=[]
        )
        body = json.loads(seen["request"].content)
        assert set(body) == {"tenantId", "runningSummary", "sections", "source"}

    @pytest.mark.asyncio
    async def test_transport_failure_raises_for_the_node_to_absorb(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"message": "down"})

        with pytest.raises(ApiServiceError):
            await _client(handler).publish_live_summary(
                "c1", tenant_id=_TENANT, running_summary="x", sections=[]
            )


class TestPublishLiveAssist:
    @pytest.mark.asyncio
    async def test_posts_suggestions_under_the_suggestions_kind(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"ok": True})

        await _client(handler).publish_live_assist(
            "c1",
            tenant_id=_TENANT,
            kind="suggestions",
            node_type="consultation.suggestions",
            suggestions=[
                {
                    "suggestionId": "abc123",
                    "text": "Ask about penicillin allergy",
                    "category": "history",
                    "status": "PROPOSED",
                    "proposedBy": "lm-studio:a-model",
                }
            ],
        )

        request = seen["request"]
        assert str(request.url) == "http://api:8868/internal/harness/consultations/c1/live-assist"
        body = json.loads(request.content)
        assert body["kind"] == "suggestions"
        assert body["nodeType"] == "consultation.suggestions"
        assert body["suggestions"][0]["suggestionId"] == "abc123"
        # The corrections envelope is absent on a suggestions publish.
        assert "corrections" not in body

    @pytest.mark.asyncio
    async def test_posts_a_proposal_first_corrections_envelope(self):
        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["request"] = request
            return httpx.Response(200, json={"ok": True})

        await _client(handler).publish_live_assist(
            "c1",
            tenant_id=_TENANT,
            kind="corrections",
            node_type="consultation.proposeCorrections",
            corrections={
                "proposals": [
                    {
                        "proposalId": "def456",
                        "start": 19,
                        "end": 29,
                        "original": "amoxicilin",
                        "proposed": "amoxicillin",
                        "category": "drugName",
                        "confidence": 0.96,
                        "rationale": "misspelling",
                        "detectedBy": "nlp.ner",
                        "proposedBy": "lm-studio:a-model",
                        "status": "PROPOSED",
                    }
                ],
                "applied": False,
                "appliedCount": 0,
                "rejectedProposals": 0,
                "textSha256": "0" * 64,
            },
        )

        body = json.loads(seen["request"].content)
        assert body["kind"] == "corrections"
        # `applied: False` must survive `_prune` — it is a safety assertion, not an empty value.
        assert body["corrections"]["applied"] is False
        assert body["corrections"]["proposals"][0]["status"] == "PROPOSED"
        assert "suggestions" not in body
