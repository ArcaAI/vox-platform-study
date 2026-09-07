"""Refuse to run against another checkout's source (git-worktree false-greens).

`hope-env` is installed EDITABLE into the conda env `arcaenv`, and that
`.pth` file is an absolute path into the PRIMARY checkout — so without the
`pythonpath` entry in this package's `[tool.pytest.ini_options]`, a run started
from a git worktree imported, and reported on, source it had not changed. The
`pythonpath` entry is the fix; this assertion is the proof that it held.

See scripts/pytest-support/hope_worktree_guard.py.
"""

from hope_worktree_guard import assert_source_tree

assert_source_tree(["hope_env"], __file__)
