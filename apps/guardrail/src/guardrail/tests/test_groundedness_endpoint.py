"""TDD tests for ``POST /guardrail/ground`` — the live output-moderation +
groundedness endpoint.

Hermetic: the app is built with ``create_app()`` and driven over an ASGI
transport WITHOUT entering the lifespan (no Redis / GLiNER / LLM providers).
A stub-scorer verifier is pre-seeded on ``app.state.groundedness_verifier``
where a real verdict is needed; the un-seeded paths exercise the honest
degrade contract (model un-staged → ``unverified``, NEVER ``grounded``).

RED: written before the endpoint exists (POST /api/guardrail/ground → 404/405).
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from guardrail.core.config import GroundednessConfig
from guardrail.main import create_app
from guardrail.services.groundedness_nli import GroundednessNliVerifier

GROUND_PATH = "/api/guardrail/ground"
SERVICE_TOKEN = "test-service-token-groundedness-abc123"  # noqa: S105 — test constant

TRANSCRIPT = (
    "Patient reports a persistent dry cough for two weeks. "
    "Doctor started amlodipine five milligrams daily."
)
SUPPORTED_CLAIM = "Patient reports a persistent dry cough."
HALLUCINATED_CLAIM = "MRI confirmed metastatic pancreatic carcinoma."


class KeywordOverlapScorer:
    """Deterministic tiny stand-in NLI (see test_groundedness_nli.py)."""

    def score_pairs(self, pairs: Sequence[tuple[str, str]]) -> Sequence[float]:
        scores: list[float] = []
        for source, claim in pairs:
            source_words = set(re.findall(r"[a-z0-9]+", source.lower()))
            claim_words = [w for w in re.findall(r"[a-z0-9]+", claim.lower()) if len(w) > 2]
            if not claim_words:
                scores.append(0.0)
                continue
            scores.append(sum(1 for w in claim_words if w in source_words) / len(claim_words))
        return scores


class ExplodingVerifier:
    """A verifier whose verify() raises — drives the endpoint's fail-closed catch."""

    model_id = "exploding-stub"

    def verify(self, summary: str, transcript: str) -> Any:
        raise RuntimeError("verifier exploded")


def _app(
    *,
    enabled: bool = True,
    seed_stub_scorer: bool = False,
    seed_scorerless_verifier: bool = False,
    token: str = "",
) -> FastAPI:
    """Build the app (no lifespan), configure the gate, optionally seed a stub verifier."""
    app = create_app()
    app.state.settings.service_token = SecretStr(token)
    # Pin the SHARED token too: the middleware accepts EITHER it or the legacy
    # per-service token (`Settings.accepted_service_tokens`), and both are populated from
    # the environment — so setting only `service_token` left whatever `INTERNAL_ACCESS_TOKEN`
    # the loaded `.env.test` carried silently in play, and `token=""` (auth off) still 401'd.
    app.state.settings.internal_access_token = SecretStr(token)
    app.state.settings.groundedness = GroundednessConfig(enabled=enabled)
    # Hermetic: no DB. With no resolver wired, a gate that IS enabled fails
    # closed on SELECTION (503) — the same outcome the retired
    # `db_config_enabled=False` flag produced — so these tests exercise the
    # scorer degrade/verdict contracts without a live AiTaskDefault registry.
    app.state.tenant_config_resolver = None
    if seed_stub_scorer:
        app.state.groundedness_verifier = GroundednessNliVerifier(
            app.state.settings.groundedness, scorer=KeywordOverlapScorer()
        )
    elif seed_scorerless_verifier:
        # the "model unavailable" state is no longer "the local
        # GGUF is unstaged" (guardrail hosts no weights): it is a verifier that
        # ended up with no usable scorer. Seeded explicitly so this test still
        # exercises the DEGRADE path; a MISSING registry selection is a different
        # condition with its own 503 contract (see below).
        app.state.groundedness_verifier = GroundednessNliVerifier(
            app.state.settings.groundedness, scorer=None
        )
    return app


# `X-Tenant-Id` is mandatory on every tenant-scoped route (428 otherwise), so the
# helper supplies one by default; tests about the header pass their own.
TEST_TENANT = "11111111-1111-1111-1111-111111111111"


async def _post(app: FastAPI, body: dict[str, Any], headers: dict[str, str] | None = None) -> Any:
    transport = ASGITransport(app=app)
    merged = {"X-Tenant-Id": TEST_TENANT, **(headers or {})}
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(GROUND_PATH, json=body, headers=merged)


# ── Contract: per-segment verdicts + flagged spans ──


async def test_ground_returns_per_segment_verdicts_and_flagged_spans() -> None:
    """{summary, transcript} → per-segment verdicts, strict grounded booleans, flagged spans."""
    app = _app(enabled=True, seed_stub_scorer=True)
    summary = f"{SUPPORTED_CLAIM} {HALLUCINATED_CLAIM}"

    resp = await _post(app, {"summary": summary, "transcript": TRANSCRIPT})

    assert resp.status_code == 200
    body = resp.json()
    assert body["checked"] is True
    assert body["reason"] == "checked"
    assert [s["verdict"] for s in body["segments"]] == ["grounded", "ungrounded"]
    # `grounded` is STRICT: True only for a verified-grounded verdict.
    assert [s["grounded"] for s in body["segments"]] == [True, False]
    # Offsets index the submitted summary.
    for segment in body["segments"]:
        assert summary[segment["start"] : segment["end"]] == segment["text"]
    # Flagged spans cover exactly the ungrounded segment.
    assert body["flagged_spans"] == [
        {"start": body["segments"][1]["start"], "end": body["segments"][1]["end"]}
    ]
    assert body["throughput_docs_per_min"] is not None
    assert "request_id" in body and "timestamp" in body


async def test_ground_empty_summary_returns_no_segments() -> None:
    app = _app(enabled=True, seed_stub_scorer=True)
    resp = await _post(app, {"summary": "", "transcript": TRANSCRIPT})

    assert resp.status_code == 200
    assert resp.json()["segments"] == []


# ── X-Service-Token posture (the middleware covers this route) ──


async def test_ground_is_behind_service_token() -> None:
    """With a configured token: no header → 401; the right header → 200."""
    app = _app(enabled=True, seed_stub_scorer=True, token=SERVICE_TOKEN)
    body = {"summary": SUPPORTED_CLAIM, "transcript": TRANSCRIPT}

    rejected = await _post(app, body)
    assert rejected.status_code == 401

    accepted = await _post(app, body, headers={"X-Service-Token": SERVICE_TOKEN})
    assert accepted.status_code == 200


# ── Degrade paths: the endpoint must NEVER mark grounded on an error path ──


async def test_ground_503s_when_the_registry_selection_is_missing() -> None:
    """A MISSING `guardrail.groundedness` selection is 503, not a silent degrade."""
    app = _app(enabled=True, seed_stub_scorer=False)

    resp = await _post(app, {"summary": SUPPORTED_CLAIM, "transcript": TRANSCRIPT})

    assert resp.status_code == 503


async def test_ground_degrades_to_unverified_when_model_unavailable() -> None:
    """A selected-but-unusable scorer → every segment ``unverified``, never grounded."""
    app = _app(enabled=True, seed_scorerless_verifier=True)

    resp = await _post(
        app,
        {
            "summary": f"{SUPPORTED_CLAIM} {HALLUCINATED_CLAIM}",
            "transcript": TRANSCRIPT,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["checked"] is False
    assert body["reason"] == "nli_model_unavailable"
    assert body["segments"], "segments are still enumerated so the caller can mark them"
    assert all(s["verdict"] == "unverified" for s in body["segments"])
    assert not any(s["grounded"] for s in body["segments"])


async def test_ground_disabled_returns_unverified() -> None:
    """enabled=False (dev/CI bypass) → honest ``unverified``, reason states the bypass."""
    app = _app(enabled=False, seed_stub_scorer=False)

    resp = await _post(app, {"summary": SUPPORTED_CLAIM, "transcript": TRANSCRIPT})

    assert resp.status_code == 200
    body = resp.json()
    assert body["checked"] is False
    assert body["reason"] == "groundedness_disabled"
    assert all(s["verdict"] == "unverified" for s in body["segments"])


async def test_ground_never_marks_grounded_when_verifier_raises() -> None:
    """An unexpected verifier crash → 200 with all-``unverified`` (fail-closed), not a 500 fail-open."""
    app = _app(enabled=True)
    app.state.groundedness_verifier = ExplodingVerifier()

    resp = await _post(
        app,
        {
            "summary": f"{SUPPORTED_CLAIM} {HALLUCINATED_CLAIM}",
            "transcript": TRANSCRIPT,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["checked"] is False
    assert body["reason"] == "nli_error"
    assert all(s["verdict"] == "unverified" for s in body["segments"])
    assert not any(s["grounded"] for s in body["segments"])
