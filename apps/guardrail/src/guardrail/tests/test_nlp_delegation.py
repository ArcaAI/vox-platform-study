"""Phases 3 & 6 — guardrail delegates classification/NER to `apps/nlp`.

After this phase `apps/guardrail` holds ZERO resident model weights and ZERO
hardcoded model ids or label taxonomies. It keeps POLICY (which taxonomy, which
threshold, the verdict shape, the fail-closed posture) and calls `apps/nlp` as
a peer with `X-Service-Token` + a MANDATORY `X-Tenant-Id`.
"""

from __future__ import annotations

import inspect

import pytest

# ── the absence claims (what must no longer exist) ───────────────────────


def test_guardrail_hosts_no_gliner_provider():
    with pytest.raises(ImportError):
        import guardrail.providers.gliner  # noqa: F401


def test_guardrail_hosts_no_minicheck_scorer():
    with pytest.raises(ImportError):
        import guardrail.services.groundedness_scorer_minicheck  # noqa: F401


def test_guardrail_has_no_aux_model_cache_or_weight_staging():
    """Zero resident weights ⇒ no model cache and no weight-staging resolver."""
    with pytest.raises(ImportError):
        import guardrail.services.model_cache  # noqa: F401
    with pytest.raises(ImportError):
        import guardrail.core.model_source  # noqa: F401


def test_settings_name_no_model_and_no_label_taxonomy():
    """A model id or label set in a pydantic default is a hardcoded selection."""
    from guardrail.core.config import Settings

    assert not hasattr(Settings, "gliner")
    settings = Settings()
    assert not hasattr(settings.groundedness, "model_id")
    assert not hasattr(settings.groundedness, "model_path")

    import guardrail.core.config as config_module

    source = inspect.getsource(config_module)
    for literal in (
        "hivetrace/",
        "fastino/",
        "MiniCheck-Flan-T5",
        "gliner-guard",
        "jailbreak_detection",
        "prompt_safety",
    ):
        assert literal not in source, f"{literal!r} is configuration, not a code literal"


def test_no_model_id_or_taxonomy_literal_anywhere_in_guardrail_source():
    """Repo-grep absence claim over the whole service (tests excluded)."""
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    offenders: list[str] = []
    for path in root.rglob("*.py"):
        if "tests" in path.parts:
            continue
        text = path.read_text()
        for literal in (
            "hivetrace/",
            "fastino/",
            "nvhf/",
            "granite-guardian",
            "gemma3:",
        ):
            if literal in text:
                offenders.append(f"{path.name}: {literal}")
    assert offenders == [], offenders


# ── the peer-client contract ─────────────────────────────────────────────


def test_nlp_client_sends_service_token_and_mandatory_tenant():
    from guardrail.services.external_nlp_client import NlpGuardClient

    signature = inspect.signature(NlpGuardClient.__init__)
    assert "tenant_id" in signature.parameters
    # No credential parameter: guardrail sources no vendor key (BYOK posture).
    assert "api_key" not in signature.parameters


def test_nlp_client_refuses_construction_without_a_tenant():
    import httpx

    from guardrail.services.external_nlp_client import NlpGuardClient

    with pytest.raises(ValueError):
        NlpGuardClient(
            base_url="http://nlp",
            service_token="t",
            http_client=httpx.AsyncClient(),
            tenant_id="",
        )


async def test_pii_spans_round_trip_byte_exactly():
    """Redaction slices the original string — the network hop must be lossless."""
    import httpx

    from guardrail.services.external_nlp_client import NlpGuardClient

    text = "Contact Jane Roe at jane@roe.example."
    start = text.index("jane@roe.example")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Tenant-Id"] == "tenant-a"
        assert request.headers["X-Service-Token"] == "svc"
        return httpx.Response(
            200,
            json={
                "entities": [
                    {
                        "label": "email",
                        "start": start,
                        "end": start + len("jane@roe.example"),
                        "score": 0.99,
                        "text": "jane@roe.example",
                    }
                ],
                "model_version": "m",
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = NlpGuardClient(
            base_url="http://nlp",
            service_token="svc",
            http_client=http_client,
            tenant_id="tenant-a",
            model_id="m",
            labels=["email"],
        )
        spans = await client.extract_pii_entities(text)

    assert text[spans[0].start : spans[0].end] == "jane@roe.example"


async def test_an_nlp_outage_raises_rather_than_reporting_no_pii():
    """Declared fail posture: redaction fails CLOSED, never 'nothing found'."""
    import httpx

    from guardrail.core.errors import GuardrailUndeterminedError
    from guardrail.services.external_nlp_client import NlpGuardClient

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = NlpGuardClient(
            base_url="http://nlp",
            service_token="svc",
            http_client=http_client,
            tenant_id="tenant-a",
            model_id="m",
            labels=["email"],
            max_attempts=2,
            retry_backoff_s=0.0,
        )
        with pytest.raises(GuardrailUndeterminedError):
            await client.extract_pii_entities("Email a@b.com")


async def test_a_moderation_verdict_fails_closed_to_unsafe():
    """A moderation verdict HAS a safe default; a generated label does not."""
    import httpx

    from guardrail.core.errors import GuardrailUndeterminedError
    from guardrail.services.external_nlp_client import NlpGuardClient

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = NlpGuardClient(
            base_url="http://nlp",
            service_token="svc",
            http_client=http_client,
            tenant_id="tenant-a",
            model_id="m",
            max_attempts=1,
            retry_backoff_s=0.0,
        )
        with pytest.raises(GuardrailUndeterminedError):
            await client.classify({"prompt_safety": {"labels": ["safe", "unsafe"]}}, "hello")


# ── taxonomy is CONFIG, resolved tenant → SYSTEM ─────────────────────────


def test_label_taxonomy_is_read_from_the_registry_row():
    """The taxonomy travels with the model selection it belongs to."""
    from guardrail.core.tenant_config import KEY_LABEL_TAXONOMY, GuardrailTenantConfig

    assert KEY_LABEL_TAXONOMY == "label-taxonomy"
    assert "label_taxonomy" in GuardrailTenantConfig.__dataclass_fields__
