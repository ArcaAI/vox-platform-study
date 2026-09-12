"""TASK-944 lane B — the ML image must honour the DECLARED extra conflicts.

## The defect this exists to prevent

Measured on ``hope-v2-dev`` 2026-09-10, the first streaming session after an STT
pod restart::

    stt.streaming.session_manager  level=warning
      "Failed to warm embedding model for streaming pipeline"
      error: "Missing required package for HuggingFace loader: Could not import
              module 'AutoProcessor'. Are this object's requirements defined
              correctly?"

``wespeaker-voxceleb-resnet34`` began loading at 09:37:15.700 and the warm failed at
09:37:25.033 — 9.33 s of torch + transformers cold import paid for an exception, and
the speaker-embedding stage silently disabled for the whole session.

The cause is not the model file. The repo root ``pyproject.toml`` DECLARES
``stt[ml]`` and ``stt[nemo]`` (and ``stt[ml-gpu]`` / ``stt[nemo]``) as CONFLICTING
uv extras, and ``uv.lock`` resolves them apart: ``ml``/``ml-gpu`` on torch 2.8.0 with
torchvision, ``nemo`` on torch 2.12.1 with none. ``apps/stt/docker/Dockerfile``
installed BOTH into the same ``/opt/venv`` anyway, so the nemo step upgraded torch out
from under the torchvision wheel the ml step had pinned for torch 2.8. An
ABI-mismatched torchvision raises ``RuntimeError`` on import; transformers reaches it
through ``video_processing_utils`` -> ``models.auto.processing_auto``, and
``_LazyModule.__getattr__`` catches exactly ``(ModuleNotFoundError, RuntimeError)``
and re-raises the message above.

## Why the check lives here

Whether the image is INTERNALLY CONSISTENT is a static fact about two committed files.
It cannot be observed from a unit test of the service, and observing it from a build
needs a CUDA GPU runner — which is exactly how it reached production unnoticed. So it
is asserted where "these extras conflict" and "this stage installs these extras" are
both readable, with no Docker and no network.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).parents[4]
STT_ROOT = Path(__file__).parents[2]
DOCKERFILE = STT_ROOT / "docker" / "Dockerfile"
STT_PYPROJECT = STT_ROOT / "pyproject.toml"
ROOT_PYPROJECT = REPO_ROOT / "pyproject.toml"

# `uv pip install ... "./apps/stt[ml-gpu]"` / `uv sync --package stt --extra nemo`
_EXTRA_IN_LOCAL_INSTALL = re.compile(r"\./apps/stt\[([^\]]+)\]")


def _declared_conflicts() -> list[set[str]]:
    """The `stt` extra groups uv is told may never share an environment."""
    data = tomllib.loads(ROOT_PYPROJECT.read_text(encoding="utf-8"))
    groups: list[set[str]] = []
    for group in data["tool"]["uv"]["conflicts"]:
        extras = {
            item["extra"]
            for item in group
            if item.get("package") == "stt" and item.get("extra") is not None
        }
        if len(extras) > 1:
            groups.append(extras)
    return groups


def _dockerfile_instructions() -> str:
    """The Dockerfile with comment lines removed.

    Load-bearing: this file explains its own history at length, and a removed install
    is described in prose right where it used to run. Matching raw text would make the
    fix indistinguishable from the defect and pin the comment, not the build.
    """
    text = DOCKERFILE.read_text(encoding="utf-8")
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def _extras_installed_by_dockerfile() -> set[str]:
    """Every `stt` extra the Dockerfile installs into the shared ML venv.

    The ML stages build ONE venv (`/opt/venv`) which `ml-runtime` and `worker` copy
    wholesale, so any two extras named anywhere in the file land in the same
    environment — there is no per-stage isolation to appeal to.
    """
    return set(_EXTRA_IN_LOCAL_INSTALL.findall(_dockerfile_instructions()))


def test_root_pyproject_still_declares_the_ml_nemo_conflict() -> None:
    """Guards the guard: if the declaration is ever dropped, this test says so
    rather than silently passing because there is nothing left to conflict with."""
    conflicts = _declared_conflicts()

    assert {"ml", "nemo"} in conflicts
    assert {"ml-gpu", "nemo"} in conflicts


def test_dockerfile_never_installs_two_conflicting_extras_into_one_venv() -> None:
    installed = _extras_installed_by_dockerfile()

    violations = [
        sorted(group & installed) for group in _declared_conflicts() if len(group & installed) > 1
    ]

    assert violations == [], (
        "apps/stt/docker/Dockerfile installs uv extras the root pyproject declares as "
        f"conflicting, into the same /opt/venv: {violations}. The second install "
        "silently re-resolves shared pins (torch) out from under the first, which is how "
        "torchvision ended up ABI-mismatched and `AutoProcessor` became unimportable."
    )


def test_dockerfile_pins_no_transformers_version_below_the_declared_ml_floor() -> None:
    """A `--override transformers==X` that undercuts `[ml]`'s own floor ships an image
    the pyproject says is unsupported, and the version-gated RNNT loader then fails
    closed for a reason nothing in the tree explains."""
    overrides = re.findall(
        r"transformers==([0-9]+)\.([0-9]+)(?:\.[0-9]+)?", _dockerfile_instructions()
    )

    stt = tomllib.loads(STT_PYPROJECT.read_text(encoding="utf-8"))
    ml_requirements = stt["project"]["optional-dependencies"]["ml"]
    floor = next(r for r in ml_requirements if r.startswith("transformers"))
    floor_match = re.search(r">=([0-9]+)\.([0-9]+)", floor)
    assert floor_match is not None, f"[ml] transformers requirement has no >= floor: {floor!r}"
    floor_version = (int(floor_match.group(1)), int(floor_match.group(2)))

    undercutting = [
        f"{major}.{minor}"
        for major, minor in ((int(a), int(b)) for a, b in overrides)
        if (major, minor) < floor_version
    ]

    assert undercutting == [], (
        f"apps/stt/docker/Dockerfile pins transformers {undercutting} but "
        f"apps/stt/pyproject.toml [ml] declares {floor!r}."
    )
