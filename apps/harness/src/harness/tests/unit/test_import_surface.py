"""RED-first import-surface test for TASK-508 Phase 0 item 0.3 (D1).

The production harness image installs the ``rag``/``guardrails``/``atomic-fact``
extras (0.1), but nothing should require them just to *import* the app or the
Temporal worker — a slim/partial image (or a dependency install that lags the
Dockerfile change) must degrade gracefully rather than crash at import. As of
this ticket, ``harness.guides.retrieval.{qdrant_store,retriever,sparse}``
import ``qdrant_client``/``fastembed`` at module top level, so importing
``harness.main``/``harness.temporal.worker`` hard-crashes without the ``rag``
extra installed (0.2 fixes this by moving those imports into the
functions/``TYPE_CHECKING`` blocks that actually use them).

Hermetic: no live Temporal/DB/Redis/Qdrant — this is purely an import-surface
check. ``qdrant_client``/``fastembed`` ARE installed in the local dev env
(arcaenv carries the ``rag`` extra for local retrieval work), and the
top-level ``tests/conftest.py`` already imports ``harness.main`` (which calls
``create_app()`` at module scope) before this test ever runs. So simulating
"the extra is absent" needs two things, not just hiding the packages:
(1) ``sys.modules`` entries for ``qdrant_client``/``fastembed`` set to
``None`` so any *future* ``import qdrant_client``/``import fastembed`` raises
``ImportError`` (the standard import-halting trick), AND (2) eviction of
every harness module in the ``harness.main`` / ``harness.temporal.worker``
import chain that touches those packages at module level, so this test forces
a *fresh* import instead of getting served the module already cached by
collection-time imports elsewhere.
"""

from __future__ import annotations

import sys

import pytest

# The two optional `rag`-extra packages this test simulates as absent.
_OPTIONAL_EXTRA_MODULES = ("qdrant_client", "fastembed")

# Every harness module that, as of this ticket, sits between harness.main /
# harness.temporal.worker and the optional-extra imports above. Evicted from
# sys.modules before the import-surface assertions so each is re-executed
# under the simulated-absent condition rather than served from cache.
_HARNESS_IMPORT_CHAIN = (
    "harness.main",
    "harness.api.endpoints.knowledge",
    "harness.temporal.worker",
    "harness.temporal.activities",
    "harness.guides.retrieval.qdrant_store",
    "harness.guides.retrieval.retriever",
    "harness.guides.retrieval.sparse",
)


@pytest.fixture
def _without_rag_extra(monkeypatch: pytest.MonkeyPatch) -> None:
    """Simulate a slim image: hide qdrant_client/fastembed, force a fresh import."""
    for name in _OPTIONAL_EXTRA_MODULES:
        monkeypatch.setitem(sys.modules, name, None)
    for name in _HARNESS_IMPORT_CHAIN:
        monkeypatch.delitem(sys.modules, name, raising=False)


class TestImportSurfaceWithoutOptionalExtras:
    def test_app_and_worker_import_without_optional_extras(
        self, _without_rag_extra: None
    ) -> None:
        """create_app() and harness.temporal.worker import cleanly sans qdrant_client/fastembed."""
        import harness.main as harness_main

        app = harness_main.create_app()
        assert app is not None

        import harness.temporal.worker as harness_worker

        assert harness_worker is not None
