"""STT worker OTel service-name derivation.

Observed live 2026-08-08: Loki's ``service_name`` label set contained
``hope-stt-v2-worker-worker``. The worker appended ``-worker`` to
``OTEL_SERVICE_NAME`` unconditionally, but the worker Deployment already sets
that variable to ``hope-stt-v2-worker``. The doubled label pollutes the label
space and breaks any dashboard variable built on ``service_name``.
"""

from __future__ import annotations

import pytest

from stt.worker import _worker_service_name


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        # The suffix still applies when the name is the API's, not the worker's.
        ("stt", "stt-worker"),
        ("hope-stt-v2", "hope-stt-v2-worker"),
        # Already worker-named by the deployment — must not double up.
        ("hope-stt-v2-worker", "hope-stt-v2-worker"),
        ("stt-worker", "stt-worker"),
    ],
)
def test_worker_service_name_is_suffixed_at_most_once(configured: str, expected: str) -> None:
    assert _worker_service_name(configured) == expected


def test_repeated_application_is_idempotent() -> None:
    """Guards against a future caller applying the helper twice."""
    once = _worker_service_name("hope-stt-v2")
    assert _worker_service_name(once) == once
