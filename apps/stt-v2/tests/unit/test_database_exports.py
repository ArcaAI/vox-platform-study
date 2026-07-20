"""TASK-525 D-11 — the dead `GlobalSettingRead` SQLAlchemy path is gone.

It was a read-only mirror of the `core.GlobalSetting` table with ZERO callers:
the seed wrote `stt.config.*` rows that nothing ever read. Its replacement is the
effective-config pull client, so the mapping is removed outright rather than left
as a second, unused config lane (Completion & Cleanup Doctrine §2.5).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[2] / "src"


class TestGlobalSettingReadRemoved:
    def test_importing_it_from_the_package_fails(self) -> None:
        with pytest.raises(ImportError):
            from stt_v2.core.database import GlobalSettingRead  # noqa: F401

    def test_importing_it_from_the_models_module_fails(self) -> None:
        with pytest.raises(ImportError):
            from stt_v2.core.database.models import GlobalSettingRead  # noqa: F401

    def test_it_is_absent_from_the_package_all(self) -> None:
        import stt_v2.core.database as db

        assert "GlobalSettingRead" not in db.__all__

    def test_no_code_references_remain(self) -> None:
        """A dangling CODE reference would mean the deletion was partial.

        Matches import/definition/instantiation forms only. The tombstone comments
        left at the deletion sites are deliberate documentation, not references,
        so a bare substring search would fail on them forever.
        """
        result = subprocess.run(
            [
                "grep",
                "-rnE",
                r"(import[^#\n]*GlobalSettingRead|class GlobalSettingRead|GlobalSettingRead\s*\()",
                "--include=*.py",
                str(SRC),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.stdout == "", f"stale GlobalSettingRead code references:\n{result.stdout}"


class TestSurvivingModels:
    """The deletion must not take the live read-only mirrors with it."""

    def test_the_other_mirrors_still_import(self) -> None:
        from stt_v2.core.database import AiModelRead, AsrPipelineRead

        assert AiModelRead.__tablename__ == "AiModel"
        assert AsrPipelineRead.__tablename__ == "AsrPipeline"

    def test_they_are_still_exported(self) -> None:
        import stt_v2.core.database as db

        assert {"AiModelRead", "AsrPipelineRead"} <= set(db.__all__)
