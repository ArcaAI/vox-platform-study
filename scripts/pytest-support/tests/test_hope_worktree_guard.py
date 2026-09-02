"""Unit tests for the worktree source-provenance guard.

These are pure path-logic tests: they never import a service package, so they
prove the guard's VERDICT for every environment we care about (primary
checkout, git worktree, CI non-editable install) without having to reproduce
those environments.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from hope_worktree_guard import (
    SourceRootsUnavailable,
    SourceTreeMismatch,
    assert_source_tree,
    declared_source_roots,
    evaluate_origin,
    find_tree_root,
    main,
    provided_packages,
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


# ── declared_source_roots ──────────────────────────────────────────────────
#
# The launcher (scripts/dev-service.sh) and the pytest run must agree on which
# directories are "this tree's source". They agree because BOTH read the same
# `[tool.pytest.ini_options] pythonpath` key out of the service's own
# pyproject.toml — there is no second list to drift.


def _write_service(tmp_path: Path, pythonpath: list[str]) -> Path:
    """A minimal service tree: pyproject + the roots it declares."""
    (tmp_path / ".git").write_text("gitdir: /elsewhere\n")
    service = tmp_path / "apps/harness"
    service.mkdir(parents=True)
    entries = ",\n".join(f'    "{p}"' for p in pythonpath)
    (service / "pyproject.toml").write_text(
        "[tool.pytest.ini_options]\npythonpath = [\n" + entries + ",\n]\n"
    )
    return service


def test_declared_source_roots_resolves_relative_to_the_service_dir(tmp_path):
    service = _write_service(tmp_path, ["src", "../../packages/py-env/src"])
    (service / "src").mkdir()
    (tmp_path / "packages/py-env/src").mkdir(parents=True)

    assert declared_source_roots(service) == [
        (service / "src").resolve(),
        (tmp_path / "packages/py-env/src").resolve(),
    ]


def test_declared_source_roots_skips_declared_dirs_that_do_not_exist(tmp_path):
    """A stale entry must not put a non-directory on PYTHONPATH."""
    service = _write_service(tmp_path, ["src", "../../packages/py-gone/src"])
    (service / "src").mkdir()

    assert declared_source_roots(service) == [(service / "src").resolve()]


def test_declared_source_roots_raises_when_the_service_declares_none(tmp_path):
    """Silently launching unguarded is the failure mode; refuse instead."""
    (tmp_path / ".git").write_text("gitdir: /elsewhere\n")
    service = tmp_path / "apps/harness"
    service.mkdir(parents=True)
    (service / "pyproject.toml").write_text("[project]\nname = 'harness'\n")

    with pytest.raises(SourceRootsUnavailable):
        declared_source_roots(service)


def test_declared_source_roots_raises_when_there_is_no_pyproject(tmp_path):
    with pytest.raises(SourceRootsUnavailable):
        declared_source_roots(tmp_path / "apps/nope")


# ── provided_packages ──────────────────────────────────────────────────────


def test_provided_packages_finds_packages_and_top_level_modules(tmp_path):
    root = tmp_path / "src"
    (root / "harness").mkdir(parents=True)
    (root / "harness/__init__.py").write_text("")
    (root / "notapackage").mkdir()  # no __init__.py — not importable as a name
    (root / "hope_worktree_guard.py").write_text("")
    (root / "__init__.py").write_text("")  # the stray apps/text/src/__init__.py

    assert provided_packages([root]) == ["harness", "hope_worktree_guard"]


def test_provided_packages_deduplicates_across_roots(tmp_path):
    first = tmp_path / "a"
    second = tmp_path / "b"
    for root in (first, second):
        (root / "hope_env").mkdir(parents=True)
        (root / "hope_env/__init__.py").write_text("")

    assert provided_packages([first, second]) == ["hope_env"]


# ── the CLI the launcher calls ─────────────────────────────────────────────


def test_cli_print_pythonpath_emits_the_declared_roots(tmp_path, capsys):
    service = _write_service(tmp_path, ["src", "../../packages/py-env/src"])
    (service / "src").mkdir()
    (tmp_path / "packages/py-env/src").mkdir(parents=True)

    assert main(["--print-pythonpath", str(service)]) == 0
    printed = capsys.readouterr().out.strip()
    assert printed == os.pathsep.join(
        [str((service / "src").resolve()), str((tmp_path / "packages/py-env/src").resolve())]
    )


def test_cli_assert_fails_when_a_package_resolves_to_another_checkout(
    tmp_path, capsys, monkeypatch
):
    service = _write_service(tmp_path, ["src"])
    (service / "src/harness").mkdir(parents=True)
    (service / "src/harness/__init__.py").write_text("")

    monkeypatch.setattr(
        "hope_worktree_guard.resolve_origin",
        lambda pkg: PRIMARY / f"apps/harness/src/{pkg}/__init__.py",
    )
    assert main(["--assert", str(service)]) == 1
    err = capsys.readouterr().err
    assert "harness" in err
    assert str(PRIMARY) in err


def test_cli_assert_passes_when_every_package_is_in_the_invoking_tree(
    tmp_path, capsys, monkeypatch
):
    service = _write_service(tmp_path, ["src"])
    (service / "src/harness").mkdir(parents=True)
    (service / "src/harness/__init__.py").write_text("")

    monkeypatch.setattr(
        "hope_worktree_guard.resolve_origin",
        lambda pkg: service / f"src/{pkg}/__init__.py",
    )
    assert main(["--assert", str(service)]) == 0


def test_cli_assert_reports_a_service_that_declares_no_roots(tmp_path, capsys):
    """`apps/text` was the uncovered service; an uncovered one must not launch."""
    (tmp_path / ".git").write_text("gitdir: /elsewhere\n")
    service = tmp_path / "apps/text"
    service.mkdir(parents=True)
    (service / "pyproject.toml").write_text("[project]\nname = 'text'\n")

    assert main(["--assert", str(service)]) == 1
    assert "pythonpath" in capsys.readouterr().err
