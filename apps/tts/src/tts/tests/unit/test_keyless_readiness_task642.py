"""TASK-642 Step 5 — regression gate: TTS is Ready with NO cloud credential.

This is the condition that had been silently false since the service was first
deployed: `hope-tts` answered `/health/ready` with 503 forever, so its Service
carried no endpoints and `TTS_URL` resolved to nothing.

Unlike `test_health.py`, which exercises the readiness *logic* against a
hand-built registry of fakes, this module exercises the *wiring*: the real
`create_app()` running the real lifespan, with the provider set derived from
`Settings` read out of the environment exactly as it is in the container. It
fails if any of the four layers in the ticket's §2 regresses:

* §2.1 — readiness contract: a keyless deployment must reach 200;
* §2.2 — the image: `kokoro` must be a dependency of the DEFAULT image, not of
  a `[local]` extra nobody builds;
* §2.3 — enablement: `TTS_KOKORO_ENABLED=true` must actually register the
  provider (and it must be the flag that does it — the manifest's suggested
  `TTS_AZURE_ENABLED` path cannot work, §2.1);
* §2.4 — routing: the SYSTEM row routes `en` to `kokoro`, so `kokoro` is the
  name that has to be present and healthy.

Hermeticity: registration is deliberately lazy — `KokoroProvider` imports the
`kokoro` package inside `_load_pipeline`, which the ModelCache only calls on the
first synth. Readiness must therefore be reachable with ZERO network I/O, and
`test_reaching_ready_opens_no_network_connection` pins that by making every
outbound socket connect raise. Without it this gate would pull ~327 MB of
weights from huggingface.co on every CI run.
"""

from __future__ import annotations

import os
import socket
import tomllib
from collections.abc import AsyncIterator
from importlib.util import find_spec
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from tts.main import create_app

_TTS_DIR = Path(__file__).parents[4]

# Everything that could hand the service a platform credential or flip a
# provider on. Cleared so the app boots as a keyless deployment does.
_CREDENTIAL_ENV_PREFIXES = ("TTS_", "AZURE_", "SARVAM_", "SPEECH_")


@pytest.fixture
def keyless_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """A container-shaped environment: Kokoro on, not one credential anywhere."""
    for key in list(os.environ):
        if key.startswith(_CREDENTIAL_ENV_PREFIXES):
            monkeypatch.delenv(key, raising=False)
    # `hope_env.load_env()` reads no file when CI is truthy (TASK-558), so the
    # developer's gitignored `.env.dev` cannot smuggle a key into this test.
    monkeypatch.setenv("CI", "true")
    monkeypatch.setenv("TTS_KOKORO_ENABLED", "true")


@pytest_asyncio.fixture
async def keyless_client(keyless_env: None) -> AsyncIterator[tuple[AsyncClient, object]]:
    """The REAL boot path: `create_app()` + `Settings` from env + the lifespan."""
    app = create_app()
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client, app


@pytest.mark.asyncio
async def test_ready_with_no_cloud_credential_present_at_all(keyless_client) -> None:
    client, app = keyless_client
    settings = app.state.settings

    # Precondition: this really is a keyless deployment.
    assert settings.azure.enabled is False
    assert settings.sarvam.enabled is False
    assert settings.azure.api_key.get_secret_value() == ""
    assert settings.sarvam.api_key.get_secret_value() == ""

    # §2.3 + §2.4 — the flag registers the provider the SYSTEM row routes `en` to.
    assert app.state.provider_registry.list_providers() == ["kokoro"]

    response = await client.get("/api/v1/health/ready")

    assert response.status_code == 200, response.text
    # `healthy`, not `degraded`: Kokoro is self-hosted, so it is not merely
    # "registered awaiting a per-request key" — it can synthesize right now.
    assert response.json()["status"] == "healthy"


@pytest.mark.asyncio
async def test_reaching_ready_opens_no_network_connection(
    keyless_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Boot + readiness must not touch huggingface.co (or anything else)."""

    def _forbidden(self, address):  # noqa: ANN001, ANN202
        raise AssertionError(f"unexpected outbound connection to {address!r}")

    monkeypatch.setattr(socket.socket, "connect", _forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", _forbidden)

    app = create_app()
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            assert (await client.get("/api/v1/health/ready")).status_code == 200


@pytest.mark.asyncio
async def test_azure_alone_cannot_make_the_service_synthesizable(
    keyless_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pins §2.1's correction of the `tts-v2.yaml` header comment.

    `TTS_AZURE_ENABLED=true` — "the cheapest path" the manifest recommends —
    yields a pod that is schedulable (200, thanks to Step 1) but only `degraded`:
    it can serve nothing unless the request carries a BYOK override. It is not a
    substitute for building Kokoro in.
    """
    monkeypatch.setenv("TTS_KOKORO_ENABLED", "false")
    monkeypatch.setenv("TTS_AZURE_ENABLED", "true")

    app = create_app()
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/health/ready")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["awaiting_credentials"] == ["azure"]


def test_kokoro_is_a_dependency_of_the_default_image() -> None:
    """§2.2 — the deployed image must actually contain the engine.

    Deterministic proxy for "is it in the image": the `kokoro` extra declares the
    engine, and the Dockerfile's `uv sync` lines install that extra. Before
    TASK-642 Step 2 the engine lived in a `[local]` extra that the Dockerfile
    explicitly did NOT install, and the "separate GPU image variant" its comment
    deferred to was never built.
    """
    pyproject = tomllib.loads((_TTS_DIR / "pyproject.toml").read_text())
    extras = pyproject["project"]["optional-dependencies"]

    assert "kokoro" in extras, "the `kokoro` extra must exist"
    assert any(
        req.split()[0].split(">")[0].split("=")[0].strip() == "kokoro" for req in extras["kokoro"]
    ), f"the `kokoro` extra must require the kokoro package: {extras['kokoro']}"

    dockerfile = (_TTS_DIR / "Dockerfile").read_text()
    sync_lines = [
        line
        for line in dockerfile.splitlines()
        if "uv sync" in line and not line.lstrip().startswith("#")
    ]
    assert sync_lines, "Dockerfile must install the package with `uv sync`"
    assert all("--extra kokoro" in line for line in sync_lines), (
        "every `uv sync` in the default image must install the kokoro extra; "
        f"found: {sync_lines}"
    )


@pytest.mark.skipif(
    find_spec("kokoro") is None,
    reason="the [kokoro] extra is not installed in this environment; "
    "test_kokoro_is_a_dependency_of_the_default_image is the deterministic gate",
)
def test_kokoro_engine_imports() -> None:
    """The lazy import inside `KokoroProvider._load_pipeline` must resolve."""
    from kokoro import KPipeline

    assert KPipeline is not None
