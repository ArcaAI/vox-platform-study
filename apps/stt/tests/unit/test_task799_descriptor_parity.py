"""Every migrated stt knob has a descriptor, and its default matches VERBATIM.

This is the gate that makes TASK-799 lane C behaviour-neutral, and it is the one
thing a reviewer cannot check by eye across 72 keys in two languages.

The failure it prevents is quiet and expensive. With no ``GlobalSetting`` row the
gateway resolves ``descriptor.default`` and serves it as the effective value, so
a descriptor default that does NOT match the Python field default silently
RETUNES the service on first deploy — the value in force changes even though
nobody wrote a row. The registry's own history has the precedent: the orphaned
``stt.config/model_cache/max_memory_mb`` seed row carried 16384 while the running
code used 10000, and adopting it would have raised the cache ceiling by 64% with
no one asking for it ("wiring a dead field flips real defaults",
``service-runtime.descriptors.ts``).

Direction of the check is deliberate: PYTHON reads the TypeScript, because the
Python field default is the authority (it is what the service ran on before) and
the descriptor is the copy. The TS file is parsed rather than imported — a
``node`` round-trip would need a build, and the shape being read is a flat object
literal of primitives.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from stt.core.config.settings import Settings
from stt.core.control_plane import CONTROL_PLANE_KEYS

_REPO_ROOT = Path(__file__).resolve().parents[4]
_DESCRIPTORS = (
    _REPO_ROOT
    / "packages/applications/src/services/settings-registry/descriptors/stt-runtime.descriptors.ts"
)
_SERVICE_RUNTIME = (
    _REPO_ROOT
    / "packages/applications/src/services/settings-registry/descriptors/service-runtime.descriptors.ts"
)

#: stt's four CAPACITY knobs live in the generated `<service>.modelCache.*`
#: family in `service-runtime.descriptors.ts`, registered before this ticket.
#: They are covered by the second test below rather than the first.
_IN_SERVICE_RUNTIME = {
    "stt.modelCache.maxModels",
    "stt.modelCache.ttlSeconds",
    "stt.workers.concurrency",
    "stt.streaming.maxConcurrent",
}


def _parse_knob_defaults(source: str) -> dict[str, object]:
    """Extract `'<key>': { … default: <literal> … }` from the KNOBS object."""
    knobs: dict[str, object] = {}
    for match in re.finditer(
        r"'(?P<key>stt\.[A-Za-z0-9.]+)':\s*\{(?P<body>.*?)\n  \},",
        source,
        re.S,
    ):
        body = match.group("body")
        default = re.search(r"\n\s+default:\s*(?P<value>.+?),\n", body, re.S)
        assert default is not None, f"no `default:` for {match.group('key')}"
        knobs[match.group("key")] = _literal(default.group("value").strip())
    return knobs


def _literal(raw: str) -> object:
    """Evaluate a TS primitive literal (string / number / boolean)."""
    if raw == "true":
        return True
    if raw == "false":
        return False
    if raw.startswith(("'", '"')):
        # Handles the `'a' + 'b'` concatenations used for long descriptions;
        # no default uses them, but be tolerant rather than silently wrong.
        parts = re.findall(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"", raw)
        return "".join(a or b for a, b in parts)
    return float(raw) if "." in raw else int(raw)


@pytest.fixture(scope="module")
def descriptor_defaults() -> dict[str, object]:
    assert _DESCRIPTORS.is_file(), f"missing descriptor file: {_DESCRIPTORS}"
    return _parse_knob_defaults(_DESCRIPTORS.read_text(encoding="utf-8"))


class TestDescriptorParity:
    def test_every_migrated_knob_has_a_descriptor(
        self, descriptor_defaults: dict[str, object]
    ) -> None:
        """A closed env path with no descriptor is a knob nobody can ever set."""
        expected = {k for k in CONTROL_PLANE_KEYS.values() if k not in _IN_SERVICE_RUNTIME}
        missing = sorted(expected - set(descriptor_defaults))
        assert missing == [], f"env path closed but no descriptor registered: {missing}"

    def test_no_descriptor_is_orphaned(self, descriptor_defaults: dict[str, object]) -> None:
        """The other direction: a descriptor nothing consumes is dead weight."""
        expected = {k for k in CONTROL_PLANE_KEYS.values() if k not in _IN_SERVICE_RUNTIME}
        extra = sorted(set(descriptor_defaults) - expected)
        assert extra == [], f"descriptors with no consuming settings field: {extra}"

    def test_the_capacity_knobs_are_still_declared_in_service_runtime(self) -> None:
        source = _SERVICE_RUNTIME.read_text(encoding="utf-8")
        for key in _IN_SERVICE_RUNTIME:
            assert f"'{key}'" in source, f"{key} vanished from service-runtime.descriptors.ts"

    @pytest.mark.parametrize(
        "field",
        sorted(f for f, k in CONTROL_PLANE_KEYS.items() if k not in _IN_SERVICE_RUNTIME),
    )
    def test_the_default_matches_the_python_field_verbatim(
        self, field: str, descriptor_defaults: dict[str, object]
    ) -> None:
        key = CONTROL_PLANE_KEYS[field]
        python_default = Settings.model_fields[field].default
        served = descriptor_defaults[key]

        if python_default is None:
            # A `str | None` field. The registry has no null literal for a
            # `string` descriptor, so `''` is the agreed spelling of "no
            # opinion" and `apply_control_plane` refuses to adopt it.
            assert served == "", (
                f"{key} backs a nullable field, so its descriptor default must be '' "
                f"(got {served!r})"
            )
            return

        assert served == python_default, (
            f"{key} would RETUNE {field} on first deploy: the descriptor serves "
            f"{served!r} but the service has always run on {python_default!r}"
        )
