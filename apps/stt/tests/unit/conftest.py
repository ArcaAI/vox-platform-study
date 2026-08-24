"""Unit-suite configuration for STT.

TASK-799 — model-registry credentials resolve over the gateway, and the unit
suite is HERMETIC: there is no gateway, so every resolve would fault and every
loader would correctly fail CLOSED. That is the right production behaviour and
the wrong test fixture — a unit test of "does the HuggingFace loader wire
`attn_implementation` through" must not be a test of credential delivery.

The default here is ABSENT, not a fake token. ABSENT means "no tier has an
opinion", which is exactly the state these tests ran in before the credential
moved off env (``HUGGINGFACE_TOKEN`` unset ⇒ anonymous pull), so loader
behaviour is unchanged rather than newly-credentialed.

Deliberately scoped to `tests/unit/`. The client's own contract — the four
outcomes, the tenant-keyed cache, fail-closed on a fault — is tested against a
real `httpx.MockTransport` in `test_task799_model_credentials.py`, which
constructs its own client and is untouched by this fixture. Any test that wants
a different outcome overrides it locally.
"""

from __future__ import annotations

import pytest

from stt.core import model_credentials


@pytest.fixture(autouse=True)
def _model_registry_credentials_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Resolve every model-registry credential to ABSENT (anonymous fetch)."""

    async def _absent_token(_model_tenant_id: str | None) -> None:
        return None

    async def _absent_s3(_model_tenant_id: str | None) -> model_credentials.ModelRegistryCredential:
        return model_credentials.ModelRegistryCredential(
            outcome=model_credentials.CredentialOutcome.ABSENT
        )

    # The DEFINING module covers every consumer that imports inside the function
    # body (`source_resolver.config_for_model`, `embedding_service`), because
    # those resolve the name at call time.
    monkeypatch.setattr(model_credentials, "resolve_hf_token", _absent_token)
    monkeypatch.setattr(model_credentials, "resolve_s3_credentials", _absent_s3)

    # `huggingface_loader` binds the name at IMPORT time, so it needs its own
    # patch — the defining-module one would not be seen.
    from stt.models import huggingface_loader

    monkeypatch.setattr(huggingface_loader, "resolve_hf_token", _absent_token)
