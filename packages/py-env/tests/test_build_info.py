"""Contract tests for the Python build-info reader.

Mirrors `build-info.service.test.ts` on the TypeScript side — same contract:
`docs/implementation/TASK-648-Service-Version-And-Release-Registry/contracts/build-info.schema.json`.

Read once at process boot, cached, NEVER throws (this runs on the boot path of
PHI-serving services), path overridable per call/instance (not
via env var — build identity is not configuration, `09-infrastructure-devops.md`
§Configuration Tiers), and falls back to a best-effort git identity in local dev.
"""

from __future__ import annotations

import json
from pathlib import Path

from hope_env.build_info import BuildInfo, BuildInfoReader, format_untagged_version

VALID_BUILD_INFO = {
    "service": "guardrail",
    "version": "2.1.0",
    "releaseTag": "GUARD-2.1.0",
    "gitBranch": "dev-2.1",
    "gitCommitSha": "0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557",
    "buildAt": "2026-08-09T11:22:33Z",
    "ciPipelineId": "12345",
    "ciPipelineUrl": "https://gitlab.example.com/pipelines/12345",
}


def _write(path: Path, data: object) -> None:
    if isinstance(data, str):
        path.write_text(data, encoding="utf-8")
    else:
        path.write_text(json.dumps(data), encoding="utf-8")


class TestFormatUntaggedVersion:
    def test_matches_the_documented_example(self) -> None:
        assert format_untagged_version("dev-2.1", "0ab258f9c1d2e3f4") == "0.0.0-dev-2-1.0ab258f9"

    def test_falls_back_to_unknown_for_empty_inputs(self) -> None:
        assert format_untagged_version("", "") == "0.0.0-unknown.unknown"


class TestBuildInfoReader:
    def test_reads_a_valid_baked_file(self, tmp_path: Path) -> None:
        path = tmp_path / "build-info.json"
        _write(path, VALID_BUILD_INFO)

        reader = BuildInfoReader(path)
        info = reader.get_build_info()

        assert info.service == "guardrail"
        assert info.version == "2.1.0"
        assert info.release_tag == "GUARD-2.1.0"
        assert info.git_branch == "dev-2.1"
        assert info.git_commit_sha == VALID_BUILD_INFO["gitCommitSha"]
        assert info.ci_pipeline_id == "12345"

    def test_reads_the_file_only_once_and_caches(self, tmp_path: Path) -> None:
        path = tmp_path / "build-info.json"
        _write(path, VALID_BUILD_INFO)

        reader = BuildInfoReader(path)
        first = reader.get_build_info()
        _write(path, {**VALID_BUILD_INFO, "service": "other"})
        second = reader.get_build_info()

        assert second is first
        assert second.service == "guardrail"

    def test_never_throws_when_file_absent(self, tmp_path: Path) -> None:
        path = tmp_path / "does-not-exist.json"
        reader = BuildInfoReader(path, run_git=lambda args: None)

        info = reader.get_build_info()

        assert info.service == "unknown"
        assert info.git_commit_sha == "unknown"
        assert info.version.startswith("0.0.0-")
        assert info.release_tag is None

    def test_never_throws_on_malformed_json(self, tmp_path: Path) -> None:
        path = tmp_path / "build-info.json"
        _write(path, "{ this is not json")
        reader = BuildInfoReader(path, run_git=lambda args: None)

        info = reader.get_build_info()

        assert info.service == "unknown"

    def test_never_throws_on_wrong_shape_json(self, tmp_path: Path) -> None:
        path = tmp_path / "build-info.json"
        _write(path, {"foo": "bar"})
        reader = BuildInfoReader(path, run_git=lambda args: None)

        info = reader.get_build_info()

        assert info.service == "unknown"

    def test_git_fallback_when_file_absent(self, tmp_path: Path) -> None:
        path = tmp_path / "does-not-exist.json"

        def fake_git(args: list[str]) -> str | None:
            if "--abbrev-ref" in args:
                return "dev-2.1"
            if "rev-parse" in args and "HEAD" in args:
                return "0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557"
            return None

        reader = BuildInfoReader(path, run_git=fake_git)
        info = reader.get_build_info()

        assert info.git_branch == "dev-2.1"
        assert info.git_commit_sha == "0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557"
        assert info.version == "0.0.0-dev-2-1.0ab258f9"
        assert info.release_tag is None
        assert info.service == "unknown"

    def test_never_throws_when_git_shellout_raises(self, tmp_path: Path) -> None:
        path = tmp_path / "does-not-exist.json"

        def raising_git(args: list[str]) -> str | None:
            raise RuntimeError("boom")

        reader = BuildInfoReader(path, run_git=raising_git)

        info = reader.get_build_info()

        assert info.git_commit_sha == "unknown"

    def test_defaults_to_app_build_info_json(self) -> None:
        reader = BuildInfoReader(run_git=lambda args: None)
        # No such file in this test environment — must degrade, not raise.
        info = reader.get_build_info()
        assert isinstance(info, BuildInfo)
