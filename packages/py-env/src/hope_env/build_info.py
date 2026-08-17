"""Reads the baked build-identity contract at process boot.

Uniform contract shared with the TypeScript reader
(``packages/applications/src/common/build-info/build-info.service.ts``):
``docs/implementation/TASK-648-Service-Version-And-Release-Registry/contracts/build-info.schema.json``.

This is immutable artifact data written once by the Dockerfile at build time —
read once here, never re-read per request.

NEVER throws. This runs on the boot path of PHI-serving services: a missing,
unreadable, or malformed file logs a warning and degrades to a best-effort
identity instead of raising, so version reporting can never become a new
startup dependency.

The path is overridable via the ``path`` constructor argument for tests — NOT
via an environment variable. Build identity is not configuration
(``.claude/rules/09-infrastructure-devops.md`` §Configuration Tiers).

``format_untagged_version`` re-implements the pure function of the same name
in ``@arcaai/utils`` (``packages/utils/src/version-grammar.ts``) rather than
sharing code across the TS/Python boundary; the two are pinned to produce
byte-identical output for the same inputs (see the test asserting the
documented example).
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

#: Where CI bakes the contract in every image.
DEFAULT_BUILD_INFO_PATH = Path("/app/build-info.json")

_UNKNOWN_SHA = "unknown"
_UNKNOWN_SERVICE = "unknown"
_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
_SLUG_PATTERN = re.compile(r"[^a-zA-Z0-9]")

#: Injectable seam for tests — never anything but a real `git` shell-out in production.
GitRunner = Callable[[list[str]], "str | None"]


@dataclass(frozen=True)
class BuildInfo:
    """The build-info contract, snake_cased for Python callers."""

    service: str
    version: str
    release_tag: str | None
    git_branch: str
    git_commit_sha: str
    build_at: str
    ci_pipeline_id: str | None
    ci_pipeline_url: str | None


def format_untagged_version(branch: str, commit_sha: str) -> str:
    """Identity for an UNTAGGED build: ``0.0.0-<branch-slug>.<sha8>``.

    Must stay byte-identical to ``formatUntaggedVersion`` in
    ``packages/utils/src/version-grammar.ts`` — same slug rule
    (``[^a-zA-Z0-9]`` -> ``-``), same 8-char lowercase short SHA, same
    ``unknown`` fallback for empty inputs.
    """
    slug = _SLUG_PATTERN.sub("-", branch) or "unknown"
    short_sha = (commit_sha[:8] or "unknown").lower()
    if not commit_sha:
        short_sha = "unknown"
    return f"0.0.0-{slug}.{short_sha}"


def _default_run_git(args: list[str]) -> str | None:
    git_executable = shutil.which("git")
    if git_executable is None:
        return None
    try:
        result = subprocess.run(  # noqa: S603 - resolved, absolute `git` executable
            [git_executable, *args],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (
        Exception
    ):  # noqa: BLE001 - the git shell-out must never raise past this point
        return None
    if result.returncode != 0:
        return None
    output = result.stdout.strip()
    return output or None


def _is_build_info_shaped(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    required = ("service", "version", "gitBranch", "gitCommitSha", "buildAt")
    return all(isinstance(value.get(key), str) for key in required)


def _degraded_build_info(run_git: GitRunner) -> BuildInfo:
    git_commit_sha = _UNKNOWN_SHA
    git_branch = ""

    try:
        sha = run_git(["rev-parse", "HEAD"])
        if sha and _SHA_PATTERN.match(sha):
            git_commit_sha = sha.lower()
    except Exception as error:  # noqa: BLE001 - never let a fallback attempt propagate
        logger.warning("build_info.git_sha_lookup_failed", extra={"error": str(error)})

    try:
        branch = run_git(["rev-parse", "--abbrev-ref", "HEAD"])
        if branch:
            git_branch = branch
    except Exception as error:  # noqa: BLE001 - never let a fallback attempt propagate
        logger.warning(
            "build_info.git_branch_lookup_failed", extra={"error": str(error)}
        )

    return BuildInfo(
        service=_UNKNOWN_SERVICE,
        version=format_untagged_version(git_branch or "unknown", git_commit_sha),
        release_tag=None,
        git_branch=git_branch,
        git_commit_sha=git_commit_sha,
        build_at="1970-01-01T00:00:00.000Z",
        ci_pipeline_id=None,
        ci_pipeline_url=None,
    )


class BuildInfoReader:
    """Reads ``/app/build-info.json`` once at process boot and caches the result."""

    def __init__(
        self,
        path: Path | str | None = None,
        *,
        run_git: GitRunner = _default_run_git,
    ) -> None:
        self._path = Path(path) if path is not None else DEFAULT_BUILD_INFO_PATH
        self._run_git = run_git
        self._cached: BuildInfo | None = None

    def get_build_info(self) -> BuildInfo:
        if self._cached is None:
            self._cached = self._read_once()
        return self._cached

    def _read_once(self) -> BuildInfo:
        try:
            raw = self._path.read_text(encoding="utf-8")
            parsed = json.loads(raw)
            if _is_build_info_shaped(parsed):
                return BuildInfo(
                    service=parsed["service"],
                    version=parsed["version"],
                    release_tag=parsed.get("releaseTag"),
                    git_branch=parsed["gitBranch"],
                    git_commit_sha=parsed["gitCommitSha"],
                    build_at=parsed["buildAt"],
                    ci_pipeline_id=parsed.get("ciPipelineId"),
                    ci_pipeline_url=parsed.get("ciPipelineUrl"),
                )
            logger.warning(
                "build_info.wrong_shape",
                extra={"path": str(self._path)},
            )
        except (
            Exception
        ) as error:  # noqa: BLE001 - must never propagate on the boot path
            logger.warning(
                "build_info.read_failed",
                extra={"path": str(self._path), "error": str(error)},
            )
        return _degraded_build_info(self._run_git)
