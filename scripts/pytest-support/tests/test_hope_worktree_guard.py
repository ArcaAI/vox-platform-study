"""Unit tests for the worktree source-provenance guard.

These are pure path-logic tests: they never import a service package, so they
prove the guard's VERDICT for every environment we care about (primary
checkout, git worktree, CI non-editable install) without having to reproduce
those environments.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from hope_worktree_guard import (
    SourceTreeMismatch,
    assert_source_tree,
    evaluate_origin,
    find_tree_root,
)

PRIMARY = Path("/repo/hope-v2")
WORKTREE = PRIMARY / ".claude/worktrees/lane-x"


# ── evaluate_origin ────────────────────────────────────────────────────────


def test_origin_inside_the_expected_tree_is_accepted():
    """The primary checkout, and a correctly-resolved worktree run."""
    assert (
        evaluate_origin("guardrail", PRIMARY / "apps/guardrail/src/guardrail/__init__.py", PRIMARY)
        is None
    )
    assert (
        evaluate_origin(
            "guardrail", WORKTREE / "apps/guardrail/src/guardrail/__init__.py", WORKTREE
        )
        is None
    )


@pytest.mark.parametrize("marker", ["site-packages", "dist-packages"])
def test_installed_copy_is_accepted(marker):
    """CI installs non-editably (`pip install .`), so origin is outside the repo.

    apps/stt and apps/nlp run in CI with no PYTHONPATH=src at all, so this
    branch is the ONLY thing keeping the guard green there.
    """
    origin = Path(f"/usr/local/lib/python3.11/{marker}/stt/__init__.py")
    assert evaluate_origin("stt", origin, PRIMARY) is None


def test_origin_in_a_different_checkout_is_rejected():
    """The defect: tests in the worktree, source from the primary checkout."""
    origin = PRIMARY / "apps/guardrail/src/guardrail/__init__.py"
    msg = evaluate_origin("guardrail", origin, WORKTREE)
    assert msg is not None
    assert "guardrail" in msg
    assert str(origin) in msg
    assert str(WORKTREE) in msg


def test_unresolvable_origin_is_ignored():
    assert evaluate_origin("guardrail", None, PRIMARY) is None


# ── find_tree_root ─────────────────────────────────────────────────────────


def test_find_tree_root_detects_a_git_directory(tmp_path):
    (tmp_path / ".git").mkdir()
    nested = tmp_path / "apps/guardrail/src/guardrail/tests"
    nested.mkdir(parents=True)
    assert find_tree_root(nested) == tmp_path


def test_find_tree_root_detects_a_git_file(tmp_path):
    """A git worktree's `.git` is a FILE, not a directory."""
    (tmp_path / ".git").write_text("gitdir: /repo/hope-v2/.git/worktrees/lane-x\n")
    nested = tmp_path / "apps/stt/tests"
    nested.mkdir(parents=True)
    assert find_tree_root(nested) == tmp_path


def test_find_tree_root_returns_none_outside_a_checkout(tmp_path):
    nested = tmp_path / "a/b"
    nested.mkdir(parents=True)
    assert find_tree_root(nested) is None


# ── assert_source_tree ─────────────────────────────────────────────────────


def test_assert_source_tree_is_a_no_op_outside_a_checkout(tmp_path):
    """Never break a run we cannot reason about (tarball, vendored copy)."""
    anchor = tmp_path / "conftest.py"
    anchor.write_text("")
    assert_source_tree(["guardrail"], anchor)  # no raise


def test_assert_source_tree_raises_with_every_mismatch_listed(tmp_path, monkeypatch):
    (tmp_path / ".git").write_text("gitdir: /elsewhere\n")
    anchor = tmp_path / "apps/guardrail/src/guardrail/tests/conftest.py"
    anchor.parent.mkdir(parents=True)
    anchor.write_text("")

    monkeypatch.setattr(
        "hope_worktree_guard.resolve_origin",
        lambda pkg: PRIMARY / f"pkg/{pkg}/__init__.py",
    )
    with pytest.raises(SourceTreeMismatch) as excinfo:
        assert_source_tree(["guardrail", "hope_env"], anchor)

    message = str(excinfo.value)
    assert "guardrail" in message
    assert "hope_env" in message
