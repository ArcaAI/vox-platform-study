"""Durable ``workflow.patched`` change-ids are DATA, not prose.

A change-id is written into the Temporal event history of every execution that passes the
gate. Once recorded it is a permanent fact about that run: the worker that replays it looks
for the SAME literal, and finding a marker with no corresponding change command fails the
workflow task with ``NondeterminismError`` — wedging every in-flight execution, including
runs parked at a clinician gate.

That is exactly what happened to ``task-355-optimistic-delivery``. A comment-cleanup sweep
(``d2e3ec5``, "removing TASK references for clarity") rewrote the ARGUMENT as if it were a
comment, leaving ``workflow.patched()``; a later commit (``6f30ba0``) "repaired" the broken
call with a NEW id, ``"optimistic-delivery"``. Four committed replay fixtures — and any real
``HarnessDocWorkflow`` in flight since 4 September — carry the original marker, so the worker
wedged on replay.

Re-recording the fixtures would have made the suite green while HIDING the in-flight risk, so
the remedy was to restore the literal. These tests keep it restored:

* the fixture-derived guard is the general one — every marker a committed history actually
  RECORDS must still exist as a literal in the source that replays it. It would have failed
  the moment ``d2e3ec5`` landed;
* the explicit pin names the one id this defect cost, so a future sweep that "tidies" it is a
  failing test rather than a production incident.
"""

from __future__ import annotations

import base64
import re
from pathlib import Path

import pytest

from harness.temporal.interpreter.registry import NODE_REGISTRY

_TEMPORAL_SRC = Path(__file__).resolve().parents[3] / "temporal"
_FIXTURES = Path(__file__).parent / "fixtures"

#: The grammar every durable marker in this repo follows: ``task-<number>-<slug>``. The ticket
#: number is what makes a marker unique across eras and un-guessable by a comment sweep.
_MARKER_GRAMMAR = re.compile(r"^task-\d+-[a-z0-9-]+$")

#: The one this defect cost. Named explicitly so the restoration cannot be undone silently.
_OPTIMISTIC_DELIVERY = "task-355-optimistic-delivery"


def _source_text() -> str:
    """Every Python source file the harness worker replays workflows from, concatenated."""
    return "\n".join(path.read_text() for path in sorted(_TEMPORAL_SRC.rglob("*.py")))


def _recorded_markers(history_json: str) -> set[str]:
    """The ``task-*`` patch markers a recorded history actually carries.

    Temporal records a marker's ``changeId`` inside a base64 payload, so the literal is not
    greppable in the JSON — decoding is what makes this guard see what the WORKER will see.
    """
    markers: set[str] = set()
    for encoded in re.findall(r'"data"\s*:\s*"([A-Za-z0-9+/=]{4,})"', history_json):
        try:
            decoded = base64.b64decode(encoded).decode("utf-8", "ignore")
        except (ValueError, TypeError):
            continue
        markers.update(re.findall(r"task-\d+-[a-z0-9-]+", decoded))
    return markers


def test_every_marker_a_committed_history_records_still_exists_in_source():
    """The general guard: a recorded marker is a promise the code must keep.

    Every ``changeId`` decoded out of a committed replay fixture must still appear as a literal
    in ``harness/temporal/**``. A marker that is renamed, prefixed away or deleted while a
    history carrying it exists is a wedged worker, not a cosmetic change.
    """
    source = _source_text()
    recorded: dict[str, list[str]] = {}
    for fixture in sorted(_FIXTURES.glob("*history.json")):
        for marker in _recorded_markers(fixture.read_text()):
            recorded.setdefault(marker, []).append(fixture.name)

    assert recorded, "no markers decoded — the fixture set or the decoder regressed"

    missing = {marker: names for marker, names in recorded.items() if f'"{marker}"' not in source}
    assert not missing, (
        "these patch markers are recorded in committed histories but no longer exist in "
        f"harness/temporal source: {missing}. Restore the literal — do NOT re-record the "
        "fixture, which would hide the same break for executions already in flight."
    )


def test_optimistic_delivery_marker_literal_is_pinned():
    """The explicit pin for the id ``d2e3ec5`` stripped and ``6f30ba0`` renamed."""
    source = (_TEMPORAL_SRC / "workflows.py").read_text()
    assert f'"{_OPTIMISTIC_DELIVERY}"' in source, (
        f"the durable change-id {_OPTIMISTIC_DELIVERY!r} is gone from workflows.py. It is "
        "recorded in four committed replay fixtures and in every real HarnessDocWorkflow "
        "started since 4 September — it is DATA, not a TASK reference to tidy away."
    )
    assert '"optimistic-delivery"' not in source, (
        "the renamed id 'optimistic-delivery' is back. No history carries it, and shipping it "
        "wedges every in-flight run on the original marker."
    )


@pytest.mark.parametrize("path", sorted(_TEMPORAL_SRC.rglob("*.py")), ids=lambda p: p.name)
def test_every_patch_marker_literal_follows_the_task_grammar(path: Path):
    """No marker may lose its ticket prefix — the shape a comment sweep strips first."""
    for marker in re.findall(r'workflow\.patched\(\s*"([^"]+)"', path.read_text()):
        assert _MARKER_GRAMMAR.match(marker), (
            f"{path.name}: patch marker {marker!r} does not follow 'task-<number>-<slug>'. "
            "Durable change-ids are recorded in event histories; renaming one wedges replay."
        )


def test_core_human_review_default_timeout_is_one_hour():
    """Regression pin for the vocabulary constant a `core.humanReview` falls back to.

    `_run_review` resolves `int(config.get("timeoutSeconds") or node.timeout_seconds)`, and the
    compiled node's own timeout is the gateway compiler's mirror of THIS default. The value is
    load-bearing for the clinician gate — a run parked here waits exactly this long before
    degrading `timedOut` — so it is pinned rather than left to drift with the registry.
    """
    spec = NODE_REGISTRY["core.humanReview"]
    assert spec.default_timeout_seconds == 3600
    assert spec.kind == "child_workflow"
