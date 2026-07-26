"""Which ``os.environ`` entries came from the env FILE rather than the host.

:func:`hope_env.load_env` merges ``.env.<NODE_ENV>`` into ``os.environ`` so that
non-pydantic readers (plain ``os.environ.get`` call sites, the harness Temporal
worker's governor, shell-invoked scripts) see the same values as the settings
objects. The cost of that choice is that pydantic then sees ONE
``EnvSettingsSource`` holding host exports and file values with nothing to tell
them apart — and the two must land on opposite sides of the Vault ``secrets_dir``
tier (``host env > secrets_dir > .env.<NODE_ENV>``).

This module is the missing provenance. It is a separate module purely to keep
``hope_env/__init__`` (the loader) and ``hope_env/settings_sources`` (the pydantic
layer) free of a circular import.
"""

from __future__ import annotations

import os

#: key -> the exact value :func:`load_env` wrote into ``os.environ``.
FILE_INJECTED: dict[str, str] = {}


def record_injection(key: str, value: str) -> None:
    """Note that ``key`` was supplied by the env file, not by the host."""
    FILE_INJECTED[key] = value


def is_file_injected(key: str) -> bool:
    """True when ``key``'s CURRENT value is still the one the env file supplied.

    The current-value comparison is what keeps this honest. If anything assigns
    ``os.environ[key]`` after :func:`load_env` ran, the stored value no longer
    matches and the key is reclassified as host env — i.e. it outranks the Vault
    file. That is the right answer: a deliberate runtime override should behave
    exactly like a host export, and a stale record can never silently DEMOTE a
    value below ``secrets_dir``.
    """
    recorded = FILE_INJECTED.get(key)
    return recorded is not None and os.environ.get(key) == recorded
