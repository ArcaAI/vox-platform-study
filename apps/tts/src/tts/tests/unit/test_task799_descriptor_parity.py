"""Every migrated tts knob has a descriptor, and its default matches VERBATIM.

Same gate as the stt lane's, for the same reason: with no ``GlobalSetting`` row
the gateway serves ``descriptor.default`` as the effective value, so a descriptor
default that does NOT match the Python field silently RETUNES the service on
first deploy — the value in force changes although nobody wrote a row.

For tts the stakes are a notch higher than "a number moved". Several of these
keys are safety or licensing controls: ``tts.sarvam.baseUrl`` decides whether
clinical text leaves for a non-BAA public API, ``tts.azure.region`` is a data
residency choice, and ``tts.indicF5.enabled`` gates a CC-BY-NC model. A default
that drifts from the Python side changes one of those without anyone asking.

Direction is deliberate: Python reads the TypeScript, because the Python field
default is the authority (it is what the service ran on) and the descriptor is
the copy.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tts.core.config import Settings
from tts.core.control_plane import CONTROL_PLANE_KEYS, bootstrap_defaults

_REPO_ROOT = Path(__file__).resolve().parents[6]
_DESCRIPTORS = (
    _REPO_ROOT
    / "packages/applications/src/services/settings-registry/descriptors/tts-runtime.descriptors.ts"
)

#: Registered by `service-runtime.descriptors.ts` (the generated
#: `<service>.modelCache.*` family) rather than by the tts-runtime file, so it is
#: excluded from the coverage assertions and checked separately.
_IN_SERVICE_RUNTIME = {"tts.modelCache.ttlSeconds"}


def _parse_knob_defaults(source: str) -> dict[str, object]:
    knobs: dict[str, object] = {}
    for match in re.finditer(
        r"'(?P<key>tts\.[A-Za-z0-9.]+)':\s*\{(?P<body>.*?)\n  \},",
        source,
        re.S,
    ):
        body = match.group("body")
        default = re.search(r"\n\s+default:\s*(?P<value>.+?),\n", body, re.S)
        assert default is not None, f"no `default:` for {match.group('key')}"
        knobs[match.group("key")] = _literal(default.group("value").strip())
    return knobs


def _literal(raw: str) -> object:
    if raw == "true":
        return True
    if raw == "false":
        return False
    if raw.startswith(("'", '"')):
        parts = re.findall(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"", raw)
        return "".join(a or b for a, b in parts)
    return float(raw) if "." in raw else int(raw)


@pytest.fixture(scope="module")
def descriptor_defaults() -> dict[str, object]:
    assert _DESCRIPTORS.is_file(), f"missing descriptor file: {_DESCRIPTORS}"
    return _parse_knob_defaults(_DESCRIPTORS.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def python_defaults() -> dict[str, object]:
    return bootstrap_defaults(Settings())


class TestDescriptorParity:
    def test_every_migrated_knob_has_a_descriptor(
        self, descriptor_defaults: dict[str, object]
    ) -> None:
        """A closed env path with no descriptor is a knob nobody can ever set."""
        expected = {k for k in CONTROL_PLANE_KEYS.values() if k not in _IN_SERVICE_RUNTIME}
        missing = sorted(expected - set(descriptor_defaults))
        assert missing == [], f"env path closed but no descriptor registered: {missing}"

    def test_no_descriptor_is_orphaned(self, descriptor_defaults: dict[str, object]) -> None:
        expected = {k for k in CONTROL_PLANE_KEYS.values() if k not in _IN_SERVICE_RUNTIME}
        extra = sorted(set(descriptor_defaults) - expected)
        assert extra == [], f"descriptors with no consuming settings field: {extra}"

    def test_no_credential_key_leaked_into_the_pull_route(
        self, descriptor_defaults: dict[str, object]
    ) -> None:
        """The BYOK keys must appear in NEITHER the key table nor the descriptors.

        A secret must not traverse a config READ surface. The gateway filters
        `sensitivity: 'secret'` off the route unconditionally, so a key declared
        here would resolve to null forever — a knob that silently never arrives —
        while also advertising a credential's existence on a non-secret channel.
        """
        suspicious = [k for k in descriptor_defaults if "apikey" in k.lower() or "credential" in k.lower()]
        assert suspicious == []
        assert not [p for p in CONTROL_PLANE_KEYS if p.endswith("api_key")]

    @pytest.mark.parametrize(
        "path",
        sorted(p for p, k in CONTROL_PLANE_KEYS.items() if k not in _IN_SERVICE_RUNTIME),
    )
    def test_the_default_matches_the_python_field_verbatim(
        self,
        path: str,
        descriptor_defaults: dict[str, object],
        python_defaults: dict[str, object],
    ) -> None:
        key = CONTROL_PLANE_KEYS[path]
        served = descriptor_defaults[key]
        current = python_defaults[path]

        assert served == current, (
            f"{key} would RETUNE `{path}` on first deploy: the descriptor serves "
            f"{served!r} but the service has always run on {current!r}"
        )
