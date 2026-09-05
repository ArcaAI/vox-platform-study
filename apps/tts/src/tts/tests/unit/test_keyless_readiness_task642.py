"""Regression gate: TTS is Ready with NO cloud credential.

This is the condition that had been silently false since the service was first
deployed: `hope-tts` answered `/health/ready` with 503 forever, so its Service
carried no endpoints and `TTS_URL` resolved to nothing.

Unlike `test_health.py`, which exercises the readiness *logic* against a
hand-built registry of fakes, this module exercises the *wiring*: the real
`create_app` running the real lifespan, with the provider set derived from
`Settings` read out of the environment exactly as it is in the container. It
fails if any of the four layers in regresses:

* readiness contract: a keyless deployment must reach 200;
* the image: `kokoro` must be a dependency of the DEFAULT image, not of
  a `[local]` extra nobody builds;
* enablement: since TASK-879 registration is IMAGE-driven, so what has to be true is that the
  engine the image contains actually registers — there is no `TTS_KOKORO_ENABLED` left to get
  wrong, and no ConfigMap in another repository that a deployment depends on for readiness;
* routing: the SYSTEM TEXT_TO_SPEECH agent binds `kokoro`, so `kokoro` is the name that has to be
  present and healthy.

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

# Everything that could hand the service a platform credential. Cleared so the app boots as a
# keyless deployment does.
_CREDENTIAL_ENV_PREFIXES = ("TTS_", "AZURE_", "SARVAM_", "SPEECH_")


@pytest.fixture
def keyless_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """A container-shaped environment: not one credential anywhere."""
    for key in list(os.environ):
        if key.startswith(_CREDENTIAL_ENV_PREFIXES):
            monkeypatch.delenv(key, raising=False)
    # `hope_env.load_env` reads no file when CI is truthy, so the
    # developer's gitignored `.env.dev` cannot smuggle a key into this test.
    monkeypatch.setenv("CI", "true")


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
    assert settings.azure.api_key.get_secret_value() == ""
    assert settings.sarvam.api_key.get_secret_value() == ""

    # The engine the SYSTEM TEXT_TO_SPEECH agent binds is registered because it is IN THE IMAGE —
    # no flag, no ConfigMap. The keyless cloud engines register too (registration says what this
    # process contains); they are simply not usable candidates, which readiness reports below and
    # the router enforces per request.
    assert "kokoro" in app.state.provider_registry.list_providers()

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
async def test_a_process_holding_only_keyless_cloud_engines_is_degraded_not_healthy(
    keyless_env: None,
) -> None:
    """The distinction readiness must keep making, now that registration is image-driven.

    Before TASK-879 this was reached by setting `TTS_AZURE_ENABLED=true` and nothing else — "the
    cheapest path" a manifest header once recommended. There is no such flag now, so the same
    condition is reached by asking what a process holding ONLY keyless cloud engines reports: 200
    (it is not broken — a request that brings its own key can be served) but `degraded`, never
    `healthy`. It is not a substitute for building Kokoro in.
    """
    app = create_app()
    async with app.router.lifespan_context(app):
        registry = app.state.provider_registry
        for name in list(registry.list_providers()):
            if name != "azure":
                registry.unregister(name)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/health/ready")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["awaiting_credentials"] == ["azure"]


def test_kokoro_is_a_dependency_of_the_default_image() -> None:
    """the deployed image must actually contain the engine.

    Deterministic proxy for "is it in the image": the `kokoro` extra declares the
    engine, and the Dockerfile's `uv sync` lines install that extra. Before
     the engine lived in a `[local]` extra that the Dockerfile
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
