"""The outbound screen is an IN-BOUNDARY path — pinned, not assumed (TASK-799).

`apps/harness` posts a generated clinical note to ``POST /guardrail/screen/outbound``
and deliberately does NOT redact it first (``activities.py`` passes
``safety_provider=None`` to ``ensure_inferential_egress_safe``). That is only correct
because of a property of THIS service: the outbound screen never leaves the trust
boundary. It delegates to the self-hosted ``apps/nlp``, which runs local weights —
guardrail performs no PHI redaction of the screened text at all, so if this path ever
reached a vendor the note would arrive raw.

The property was previously asserted only in a comment inside another service. These
tests move it into executable evidence on the side that owns it:

* the screen composes ONE executor — the ``apps/nlp`` peer — and the cloud-capable
  :class:`~guardrail.services.external_text_client.TextJudgeClient` (reachable from
  ``/medical/validate`` for ``guardrail.validate``) is not in this path;
* the peer's ``base_url`` is ``settings.nlp_url``, the self-hosted service address —
  it is NOT derived from the selected model's ``provider``, so a tenant selecting a
  ``guardrail.safety`` model whose registry row names a cloud vendor still routes to
  the in-boundary executor and never egresses.

If a future change makes the outbound screen cloud-capable, these fail — and the
harness-side decision to skip redaction must be revisited at the same time (see
``harness/tests/unit/temporal/test_activities_phi_egress.py``).
"""

from __future__ import annotations

import inspect
from types import SimpleNamespace
from typing import Any

import pytest

TENANT = "11111111-1111-1111-1111-111111111111"
NLP_URL = "http://nlp.internal:8864"

#: A `guardrail.safety` selection whose registry row names a CLOUD vendor. The
#: point of the test is that this changes NOTHING about where the note goes.
_CLOUD_PROVIDER = "azure"


def _cfg(**kw: Any) -> Any:
    base: dict[str, Any] = {
        "provider": _CLOUD_PROVIDER,
        "model": "some-selected-model",
        "local_path": None,
        "timeout_s": None,
        "entailment": None,
        "policy": None,
        "source_tenant_id": TENANT,
        "label_taxonomy": {
            "tasks": {
                "response_safety": {"labels": ["benign", "harm"]},
                "response_toxicity": {"labels": ["benign", "toxic"]},
                "response_refusal": {"labels": ["benign", "refusal"]},
            },
            "labels": ["PERSON"],
        },
    }
    base.update(kw)
    return SimpleNamespace(**base)


class _Resolver:
    """Resolves every task key to a cloud-provider selection."""

    async def resolve(self, tenant_id: str | None, task_key: str) -> Any:
        return _cfg()


def _app_state() -> Any:
    from guardrail.core.config import Settings

    settings = Settings()
    # `nlp_url` is the peer transport address; force a recognisable value so the
    # assertion below cannot pass by coincidence with a provider endpoint.
    settings = settings.model_copy(update={"nlp_url": NLP_URL})
    return SimpleNamespace(
        settings=settings,
        http_client=object(),
        tenant_config_resolver=_Resolver(),
        circuit_breakers=None,
    )


@pytest.mark.asyncio
async def test_outbound_screen_executor_targets_the_self_hosted_nlp_peer() -> None:
    """The screen's only executor is `apps/nlp` — never a provider endpoint.

    The selection deliberately names a CLOUD provider. If routing ever became
    provider-derived, `base_url` would stop being `settings.nlp_url` and the note
    harness sends unredacted would leave the boundary.
    """
    from guardrail.core.dependencies import build_screener

    screener = await build_screener(_app_state(), TENANT)
    analyzer = screener._analyzer  # noqa: SLF001 — pinning composition is the point

    clients = [analyzer._safety_client, analyzer._pii_client]  # noqa: SLF001
    assert all(c is not None for c in clients), "both executors must be bound"
    for client in clients:
        assert client._base_url == NLP_URL, (  # noqa: SLF001
            "the outbound screen must route to the self-hosted apps/nlp peer; a "
            "provider-derived endpoint would egress the unredacted note"
        )


@pytest.mark.asyncio
async def test_outbound_screen_binds_no_cloud_capable_client() -> None:
    """`TextJudgeClient` (→ apps/text → BYO cloud vendors) is not in this path.

    It lives in the same service and backs `/medical/validate`, so "guardrail can
    reach a cloud engine" is true of the SERVICE and false of this ROUTE. That
    distinction is exactly what the harness decision rests on.
    """
    from guardrail.core.dependencies import build_screener
    from guardrail.services.external_nlp_client import NlpGuardClient
    from guardrail.services.external_text_client import TextJudgeClient

    screener = await build_screener(_app_state(), TENANT)
    analyzer = screener._analyzer  # noqa: SLF001

    for client in (analyzer._safety_client, analyzer._pii_client):  # noqa: SLF001
        assert isinstance(client, NlpGuardClient)
        assert not isinstance(client, TextJudgeClient)


def test_screening_module_reaches_no_cloud_client() -> None:
    """Absence claim over the composition module itself."""
    import guardrail.services.screening as screening

    source = inspect.getsource(screening)
    for literal in ("TextJudgeClient", "external_text_client", "httpx"):
        assert literal not in source, (
            f"{literal!r} in services/screening.py would put a vendor-capable hop on "
            "the outbound screen, which harness sends UNREDACTED clinical notes to"
        )


def test_guardrail_never_redacts_the_screened_text() -> None:
    """States the posture harness must NOT assume it has.

    `screen_outbound` sanitizes for prompt INJECTION and then classifies; it never
    redacts. Recorded so a reader cannot mistake "guardrail screens PHI" for
    "guardrail removes PHI" — the safety of the harness hop rests on the screen being
    in-boundary (the tests above), not on redaction happening here.
    """
    import guardrail.services.screening as screening

    source = inspect.getsource(screening.Screener.screen_outbound)
    assert "sanitize_untrusted" in source
    assert "redact" not in source
