"""Fail a pytest run that imports a DIFFERENT checkout's source.

The conda env ``arcaenv`` holds EDITABLE installs of every Python service and
shared package, and each ``__editable__.*.pth`` in site-packages is a bare,
absolute path into the PRIMARY checkout. A ``.pth`` path is appended to
``sys.path`` at interpreter start, so inside a git worktree it is a standing
offer to satisfy ``import guardrail`` from a tree you are not editing.

Whether that offer is taken depends on whether pytest happens to put the
worktree's own ``src`` on ``sys.path`` FIRST, which in turn depends on the
``__init__.py`` topology of each service's test directory. Measured 2026-08-30
against the real ``pnpm <svc>:test`` commands, that came out different for
every service — ``harness`` and ``tts`` imported worktree source, while
``stt``, ``nlp``, ``text`` and ``guardrail`` silently imported PRIMARY source
and reported a green suite for code they had not changed.

The ``pythonpath`` entries in each service's ``[tool.pytest.ini_options]`` are
the fix: applied at ``pytest_load_initial_conftests`` (earliest hook there is),
they make the invoking tree win before anything can be imported. This module is
the PROOF that the fix held — a silent fix that silently stops working is the
failure mode this whole exercise exists to remove.

Verdicts, in order:

* origin inside the tree the tests live in .... accept
* origin inside site-packages / dist-packages . accept (CI installs
  non-editably with ``pip install .``; ``apps/stt`` and ``apps/nlp`` run there
  with no ``PYTHONPATH`` at all, so their source legitimately lives outside
  the repo tree)
* anything else ............................... REJECT — another checkout

Deliberately NOT a pytest plugin: ``-p`` plugins are imported during
``Config._preparse``, before the ini ``pythonpath`` entries that make this
module importable. A plain call from each service's ``conftest.py`` runs late
enough to be importable and early enough to precede every test module.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

__all__ = [
    "SourceTreeMismatch",
    "assert_source_tree",
    "evaluate_origin",
    "find_tree_root",
    "resolve_origin",
]

# Directory names that mark an INSTALLED copy rather than a checkout.
_INSTALLED_MARKERS = frozenset({"site-packages", "dist-packages"})


class SourceTreeMismatch(RuntimeError):
    """A test run resolved its source from a checkout other than its own."""


def find_tree_root(start: Path) -> Path | None:
    """Return the working-tree root at or above ``start``, or ``None``.

    ``.git`` is a directory in a normal checkout and a FILE in a git worktree;
    ``.exists()`` covers both.
    """
    start = Path(start).resolve()
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def resolve_origin(package: str) -> Path | None:
    """Where would ``import <package>`` come from, without executing it?

    ``find_spec`` returns the already-imported spec when there is one, so this
    reports the binding that is actually in force — not a fresh guess.
    """
    try:
        spec = importlib.util.find_spec(package)
    except (ImportError, ValueError):
        return None
    if spec is None or not spec.origin:
        return None
    return Path(spec.origin).resolve()


def evaluate_origin(package: str, origin: Path | None, tree_root: Path) -> str | None:
    """Return an error message for a bad ``origin``, or ``None`` if it is fine."""
    if origin is None:
        return None
    if any(part in _INSTALLED_MARKERS for part in origin.parts):
        return None
    try:
        origin.relative_to(tree_root)
    except ValueError:
        return f"  {package}: imports {origin}\n" f"    but this test run lives in {tree_root}"
    return None


def assert_source_tree(packages: list[str], anchor: str | Path) -> None:
    """Raise unless every package resolves inside ``anchor``'s working tree.

    ``anchor`` is the calling ``conftest.py``'s ``__file__``. Outside a
    checkout this is a no-op: a run we cannot reason about is never one we
    should break.
    """
    tree_root = find_tree_root(Path(anchor).parent)
    if tree_root is None:
        return

    problems = [
        message
        for package in packages
        if (message := evaluate_origin(package, resolve_origin(package), tree_root))
    ]
    if not problems:
        return

    raise SourceTreeMismatch(
        "This pytest run would exercise source from a DIFFERENT checkout, so a\n"
        "green result would say nothing about the code you changed:\n\n"
        + "\n".join(problems)
        + "\n\nMost likely cause: you are in a git worktree and the conda env's\n"
        "editable installs (`__editable__.*.pth` in site-packages) point at the\n"
        "primary checkout. Fix the `pythonpath` entry in this service's\n"
        "[tool.pytest.ini_options], or run the suite from the primary checkout."
    )
