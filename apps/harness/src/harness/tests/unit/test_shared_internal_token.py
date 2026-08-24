"""Every outbound harness hop PRESENTS the one shared ``INTERNAL_ACCESS_TOKEN``.

Owner decision D-D: the shared token is the credential; the legacy per-target
``*_SERVICE_TOKEN`` secrets survive only as the fallback for an environment that
has not been migrated. ``Settings.peer_service_token`` encodes "shared first,
legacy second" in ONE place — a call site that reads
``settings.service_token.get_secret_value()`` directly bypasses it and, on a
platform configured the way D-D specifies (shared set, legacy empty), sends an
EMPTY token and 401s. That failure is negative-cached, so the service degrades
silently with one warning per minute rather than failing loudly.

The sweep below is deliberately a TREE SCAN rather than a list of known call
sites: the point is that the guarantee survives the NEXT client factory someone
adds, not that four particular lines are currently correct.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from harness.core.config import Settings
from harness.temporal import activities

HARNESS_SRC = Path(activities.__file__).resolve().parents[2] / "harness"


class TestFireAndForgetApiClientsUseTheSharedToken:
    """The progress / trajectory / loop-event clients are fire-and-forget, which
    is exactly why a silent 401 on them is easy to miss."""

    FACTORIES = (
        "_progress_api_client",
        "_trajectory_api_client",
        "_loop_event_api_client",
    )

    @pytest.mark.parametrize("factory", FACTORIES)
    def test_shared_token_wins_over_the_legacy_secret(self, factory: str) -> None:
        # Explicit values, not a bare Settings(): the ambient .env.dev/.env.test
        # legitimately set these, and an unpinned one would decide the assertion.
        settings = Settings(internal_access_token="shared-tok", service_token="legacy-tok")
        client = getattr(activities, factory)(settings)
        assert client._service_token == "shared-tok"

    @pytest.mark.parametrize("factory", FACTORIES)
    def test_legacy_secret_is_the_fallback_when_the_shared_one_is_unset(self, factory: str) -> None:
        settings = Settings(internal_access_token="", service_token="legacy-tok")
        client = getattr(activities, factory)(settings)
        assert client._service_token == "legacy-tok"

    @pytest.mark.parametrize("factory", FACTORIES)
    def test_no_token_when_neither_is_configured(self, factory: str) -> None:
        settings = Settings(internal_access_token="", service_token="")
        client = getattr(activities, factory)(settings)
        assert client._service_token == ""


class TestNoCallSiteBypassesThePeerTokenHelper:
    """Tree-wide lock. ``settings.service_token`` may still be READ — the inbound
    guard legitimately accepts it (``accepted_service_tokens``) — but never
    unwrapped straight into an OUTBOUND credential."""

    # INBOUND guards only: these build the set of tokens the service ACCEPTS,
    # which is the opposite direction and correctly includes the legacy secret.
    INBOUND_GUARDS = {"api/endpoints/knowledge.py"}

    @staticmethod
    def _bypasses(path: Path) -> list[int]:
        """Line numbers of ``<anything>.service_token.get_secret_value()``."""
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        hits: list[int] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not isinstance(func, ast.Attribute) or func.attr != "get_secret_value":
                continue
            inner = func.value
            if isinstance(inner, ast.Attribute) and inner.attr == "service_token":
                hits.append(node.lineno)
        return hits

    def test_no_module_unwraps_the_legacy_token_directly(self) -> None:
        offenders: dict[str, list[int]] = {}
        for path in sorted(HARNESS_SRC.rglob("*.py")):
            if "tests" in path.parts:
                continue
            rel = path.relative_to(HARNESS_SRC).as_posix()
            if rel in self.INBOUND_GUARDS:
                continue
            lines = self._bypasses(path)
            if lines:
                offenders[rel] = lines

        assert offenders == {}, (
            "these call sites bypass Settings.peer_service_token and will send an "
            f"EMPTY token under owner decision D-D: {offenders}"
        )

    def test_the_sweep_can_actually_see_a_bypass(self, tmp_path: Path) -> None:
        """Guard the guard — a scan that matches nothing proves nothing."""
        planted = tmp_path / "planted.py"
        planted.write_text(
            "def f(settings):\n"
            "    return dict(service_token=settings.service_token.get_secret_value())\n",
            encoding="utf-8",
        )
        assert self._bypasses(planted) == [2]
