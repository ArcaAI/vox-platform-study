"""TASK-944 B1 — the platform HuggingFace token resolves from EITHER side of the
async boundary, and a defect no longer wears a control-plane fault's log line.

Measured on `hope-v2-dev` (pipeline #1169): every diarization warm logged
``Could not resolve the platform HuggingFace token; continuing unauthenticated``
next to ``RuntimeWarning: coroutine 'resolve_hf_token' was never awaited``. The
coroutine was never STARTED — ``asyncio.run()`` refuses to run on a thread that
already owns a loop, and ``SileroVADService.initialize`` calls
``_resolve_model_path`` (hence ``_resolve_hf_token``) straight from a coroutine.
The bare ``except`` then downgraded a programming error to the same warning a
gateway outage produces, so the platform token was never resolved on that path
whatever it was set to.

Hermetic: no network, no GPU, no gateway — the resolver and ``huggingface_hub``
are both stubbed.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import types
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

LOGGER_NAME = "stt.diarization.embedding_service"
CONTROL_PLANE_MESSAGE = "Could not resolve the platform HuggingFace token"


def _no_local_hf_cache() -> dict[str, types.ModuleType]:
    """Stub ``huggingface_hub`` so a developer box's cached login cannot answer."""
    module = types.ModuleType("huggingface_hub")
    module.get_token = lambda: None  # type: ignore[attr-defined]
    return {"huggingface_hub": module}


def _call_resolver(resolver: Any) -> str | None:
    from stt.diarization.embedding_service import _resolve_hf_token

    with (
        patch("stt.core.model_credentials.resolve_hf_token", new=resolver),
        patch.dict(sys.modules, _no_local_hf_cache()),
    ):
        return _resolve_hf_token(MagicMock())


async def _resolves_to(_tenant_id: str | None) -> str | None:
    return "platform-hf-token"


def test_token_resolves_when_called_from_a_running_event_loop() -> None:
    """The defect: a caller already on the loop got ``None``, silently."""

    async def main() -> str | None:
        # A real loop is running on THIS thread, exactly as it is inside
        # `SileroVADService.initialize`.
        return _call_resolver(_resolves_to)

    assert asyncio.run(main()) == "platform-hf-token"


def test_token_resolves_when_called_from_a_worker_thread() -> None:
    """The path that already worked — ``asyncio.to_thread(self._do_load)``."""

    async def main() -> str | None:
        return await asyncio.to_thread(_call_resolver, _resolves_to)

    assert asyncio.run(main()) == "platform-hf-token"


def test_token_resolves_when_no_loop_exists_at_all() -> None:
    """CLI / worker bootstrap: no loop anywhere on the thread."""
    assert _call_resolver(_resolves_to) == "platform-hf-token"


def test_a_control_plane_fault_is_tolerated_and_named_as_such(
    caplog: pytest.LogCaptureFixture,
) -> None:
    from stt.core.model_credentials import CredentialUnavailable

    async def unavailable(_tenant_id: str | None) -> str | None:
        raise CredentialUnavailable("no usable model-registry credential for 'huggingface'")

    with caplog.at_level(logging.DEBUG, logger=LOGGER_NAME):
        assert _call_resolver(unavailable) is None

    records = [r for r in caplog.records if r.name == LOGGER_NAME]
    assert [r.levelno for r in records] == [logging.WARNING]
    assert CONTROL_PLANE_MESSAGE in records[0].getMessage()


def test_a_programming_error_is_distinguishable_from_a_control_plane_fault(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A defect in THIS code must not read as "the control plane is down"."""

    async def defective(_tenant_id: str | None) -> str | None:
        raise TypeError("resolve_hf_token() takes 0 positional arguments")

    with caplog.at_level(logging.DEBUG, logger=LOGGER_NAME):
        assert _call_resolver(defective) is None

    records = [r for r in caplog.records if r.name == LOGGER_NAME]
    assert [r.levelno for r in records] == [logging.ERROR]
    assert CONTROL_PLANE_MESSAGE not in records[0].getMessage()
    # The traceback is what makes the defect actionable at all.
    assert records[0].exc_info is not None
