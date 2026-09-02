"""Fail a run that imports a DIFFERENT checkout's source.

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

The same defect exists OUTSIDE pytest. ``scripts/dev-service.sh worker`` runs
``python -m harness.temporal.worker`` with no ``--app-dir`` and no
``PYTHONPATH``, so ``sys.path[0]`` is the repo root — which contains no
importable service package — and every name falls through to the ``.pth``
entries. Measured from a worktree on 2026-09-02, that resolved ``harness`` AND
all four shared ``hope_*`` packages out of the PRIMARY checkout. The uvicorn
targets were only half-covered: ``--app-dir`` rescues the service package and
nothing else, so their shared packages came from PRIMARY too.

``main()`` below is what ``dev-service.sh`` calls, and it closes both halves
using the SAME verdict logic as the pytest path:

* ``--print-pythonpath <service-dir>`` — the invoking tree's source roots, so
  the launched process resolves them before any ``.pth`` entry.
* ``--assert <service-dir>`` — the launcher's equivalent of
  ``assert_source_tree``: exit 1, non-zero, BEFORE the service starts.

Both read the service's own ``[tool.pytest.ini_options] pythonpath``. That key
is the single declaration of "this tree's source roots"; reusing it is what
stops the launcher and the test run from ever disagreeing about them.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from collections.abc import Iterable
from pathlib import Path

import tomllib

__all__ = [
    "SourceRootsUnavailable",
    "SourceTreeMismatch",
    "assert_source_tree",
    "declared_source_roots",
    "evaluate_origin",
    "find_tree_root",
    "main",
    "provided_packages",
    "resolve_origin",
]

# Directory names that mark an INSTALLED copy rather than a checkout.
_INSTALLED_MARKERS = frozenset({"site-packages", "dist-packages"})


class SourceTreeMismatch(RuntimeError):
    """A run resolved its source from a checkout other than its own."""


class SourceRootsUnavailable(RuntimeError):
    """A service does not declare where its source lives, so it cannot be guarded."""


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
        return f"  {package}: imports {origin}\n" f"    but this run lives in {tree_root}"
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


# ── the launcher half: scripts/dev-service.sh ──────────────────────────────


def declared_source_roots(service_dir: str | Path) -> list[Path]:
    """The source roots ``service_dir`` declares, absolute, in declared order.

    Read from the service's OWN ``[tool.pytest.ini_options] pythonpath`` — the
    one place this repo states where a service's source lives. The launcher and
    the pytest run therefore cannot disagree about it.

    Entries are resolved relative to the service directory (exactly as pytest
    resolves them relative to rootdir), so a run inside a git worktree gets that
    worktree's paths. A declared entry that is not a directory is dropped: it
    would be dead weight on ``PYTHONPATH``.
    """
    service_dir = Path(service_dir).resolve()
    pyproject = service_dir / "pyproject.toml"
    if not pyproject.is_file():
        raise SourceRootsUnavailable(f"{pyproject} does not exist")

    ini = tomllib.loads(pyproject.read_text()).get("tool", {}).get("pytest", {})
    declared = ini.get("ini_options", {}).get("pythonpath")
    if not declared:
        raise SourceRootsUnavailable(
            f"{pyproject} declares no [tool.pytest.ini_options] pythonpath, so there is\n"
            "no statement of where this service's source lives and nothing to guard against."
        )

    return [(service_dir / entry).resolve() for entry in declared if (service_dir / entry).is_dir()]


def provided_packages(roots: Iterable[Path]) -> list[str]:
    """Top-level importable names the given roots provide.

    Derived from the roots rather than hand-listed, because the set at risk is
    exactly "what this tree offers that an editable ``.pth`` could shadow".
    Names starting with ``_`` are skipped, which drops ``__pycache__`` and the
    stray ``apps/text/src/__init__.py`` that is not an importable top-level name.
    """
    found: dict[str, None] = {}
    for root in roots:
        names = set()
        for child in root.iterdir():
            if child.name.startswith("_") or not child.stem.isidentifier():
                continue
            if child.is_dir() and (child / "__init__.py").is_file():
                names.add(child.name)
            elif child.is_file() and child.suffix == ".py":
                names.add(child.stem)
        found.update(dict.fromkeys(sorted(names)))
    return list(found)


def main(argv: list[str] | None = None) -> int:
    """CLI for ``scripts/dev-service.sh``. Returns a process exit status."""
    parser = argparse.ArgumentParser(prog="hope_worktree_guard", add_help=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--print-pythonpath",
        action="store_true",
        help="emit the invoking tree's source roots, os.pathsep-joined",
    )
    mode.add_argument(
        "--assert",
        dest="do_assert",
        action="store_true",
        help="fail unless every package those roots provide resolves inside this tree",
    )
    parser.add_argument("service_dir", help="the service directory, e.g. apps/harness")
    args = parser.parse_args(argv)

    service_dir = Path(args.service_dir).resolve()
    try:
        roots = declared_source_roots(service_dir)
    except SourceRootsUnavailable as exc:
        print(f"hope_worktree_guard: {exc}", file=sys.stderr)
        return 1

    if args.print_pythonpath:
        print(os.pathsep.join(str(root) for root in roots))
        return 0

    # Same no-op posture as assert_source_tree: never break a run outside a checkout.
    tree_root = find_tree_root(service_dir)
    if tree_root is None:
        return 0

    problems = [
        message
        for package in provided_packages(roots)
        if (message := evaluate_origin(package, resolve_origin(package), tree_root))
    ]
    if not problems:
        return 0

    print(
        "hope_worktree_guard: refusing to launch.\n\n"
        "This process would run source from a DIFFERENT checkout, so what you\n"
        "observe would say nothing about the code you changed:\n\n"
        + "\n".join(problems)
        + "\n\nMost likely cause: you are in a git worktree and the conda env's\n"
        "editable installs (`__editable__.*.pth` in site-packages) point at the\n"
        "primary checkout. Fix the `pythonpath` entry in this service's\n"
        "[tool.pytest.ini_options], or launch from the primary checkout.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":  # pragma: no cover - exercised via main()
    raise SystemExit(main())
