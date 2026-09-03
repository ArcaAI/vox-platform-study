"""The image build must not discover a workspace package the hard way.

``apps/text/Dockerfile`` hand-copies each workspace path dependency into the
build context before ``uv sync --frozen --package text``. uv resolves every
workspace source in the lock, so a declared-but-not-copied package fails the
layer with ``Distribution not found at: file:///app/packages/<pkg>`` — and
nothing else catches it: lint, mypy and this whole suite pass against a
dependency the Dockerfile has never heard of. It surfaces only in the ``build``
stage, which runs on release-line branches, long after the change merged.

That is exactly how hope-async-contract broke build-text: it
was added to ``[tool.uv.sources]`` and to the pip installs in CI, but never to
the Dockerfile.

This test recomputes the requirement from ``pyproject.toml`` itself, so the
Dockerfile cannot fall behind again silently. If it fails, add the named
``COPY packages/<pkg> ./packages/<pkg>`` line — do not delete the assertion.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

# …/apps/text/src/text/tests/unit/this_file.py → repo root is six levels up.
_REPO_ROOT = Path(__file__).resolve().parents[6]
_APP_PYPROJECT = _REPO_ROOT / "apps" / "text" / "pyproject.toml"
_DOCKERFILE = _REPO_ROOT / "apps" / "text" / "Dockerfile"


def _workspace_dirs_by_distribution() -> dict[str, str]:
    """Map each shared package's DISTRIBUTION name to its directory.

    The two differ by convention (``hope-otel`` lives in ``packages/py-otel``),
    so this is read off the manifests rather than guessed from the name.
    """
    mapping: dict[str, str] = {}
    for pyproject in sorted((_REPO_ROOT / "packages").glob("py-*/pyproject.toml")):
        match = re.search(r"^name\s*=\s*[\"']([^\"']+)[\"']", pyproject.read_text(), re.M)
        if match:
            mapping[match.group(1)] = f"packages/{pyproject.parent.name}"
    return mapping


def _declared_workspace_sources() -> list[str]:
    """The ``{ workspace = true }`` entries of apps/text's ``[tool.uv.sources]``."""
    text = _APP_PYPROJECT.read_text()
    block = re.search(r"\[tool\.uv\.sources\](.*?)(?=\n\[|\Z)", text, re.S)
    assert block is not None, "apps/text/pyproject.toml declares no [tool.uv.sources]"
    return sorted(re.findall(r"^(\S+)\s*=\s*\{\s*workspace\s*=\s*true", block.group(1), re.M))


def _copied_package_dirs() -> set[str]:
    return set(re.findall(r"^COPY\s+(packages/[^/\s]+)\s", _DOCKERFILE.read_text(), re.M))


class TestDockerfileCoversWorkspaceSources:
    def test_every_declared_workspace_source_is_copied(self) -> None:
        by_distribution = _workspace_dirs_by_distribution()
        copied = _copied_package_dirs()

        missing = []
        for distribution in _declared_workspace_sources():
            directory = by_distribution.get(distribution)
            assert directory is not None, (
                f"apps/text declares workspace source {distribution!r}, but no "
                f"packages/py-* manifest publishes that name"
            )
            if directory not in copied:
                missing.append(f"COPY {directory} ./{directory}")

        assert not missing, (
            "apps/text/Dockerfile is missing "
            f"{len(missing)} workspace source(s); `uv sync` will fail with "
            '"Distribution not found". Add: ' + " | ".join(missing)
        )

    @pytest.mark.parametrize("distribution", ["hope-async-contract"])
    def test_the_regression_source_is_still_declared(self, distribution: str) -> None:
        """Pins the case that broke the build.

        Without this, dropping the declaration would shrink the requirement set
        above and the test would pass on a Dockerfile that is short again.
        """
        assert distribution in _declared_workspace_sources()

    def test_the_dockerfile_still_runs_uv_sync(self) -> None:
        """Guards the guard: no ``uv sync``, no requirement, vacuous assertions."""
        assert "uv sync" in _DOCKERFILE.read_text()
