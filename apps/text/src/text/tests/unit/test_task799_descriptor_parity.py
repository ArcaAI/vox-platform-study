"""A.3 — the TS producer and the Python consumer agree, mechanically.

Two things landed in `packages/applications` that `apps/text` was already
written against: the `externalGuardrail` and `generation` views on
`GET /internal/effective-config?service=text`, and the descriptors behind them.
Both are cross-language couplings that no reviewer can check by eye, and both
fail SILENTLY when they drift:

1.  **A default that is not the floor RETUNES the service on first deploy.**
    With no ``GlobalSetting`` row the gateway resolves ``descriptor.default`` and
    serves it as the effective value, so the number in force changes even though
    nobody wrote a row. The registry's own history has the precedent — an
    orphaned stt seed row carried 16384 against running code using 10000, and
    adopting it would have raised a cache ceiling by 64% with no one asking.
    Here the stakes are `require_medical` (clinical enforcement) and
    `temperature` (how inventive an unprofiled model is allowed to be).

2.  **A field name the view does not emit is a knob nobody can ever set.** The
    response groups are hand-shaped views, and the Python readers look keys up
    BY NAME with a floor fallback (``platform_posture``,
    ``generation_defaults``). A producer that emitted ``requireMedical`` as
    ``require_medical`` would not raise anywhere: every value would simply keep
    its floor, exactly as it did before the view existed, which is the failure
    this whole ticket is about.

Direction of the check is deliberate: PYTHON reads the TypeScript, because the
Python floor is the AUTHORITY (it is what the service runs on today) and the
descriptor is the copy. The TS is parsed rather than imported — a ``node``
round-trip would need a build, and the shapes being read are flat object
literals of primitives plus one object-literal view per group.
"""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from text.core.defaults import (
    GENERATION_FLOOR,
    active_generation_defaults,
    apply_generation_defaults,
    resolve_request_defaults,
)
from text.core.effective_config import EffectiveConfigSnapshot
from text.core.runtime_defaults import (
    GUARDRAIL_ENABLED_FLOOR,
    GUARDRAIL_INCLUDE_REASONING_FLOOR,
    GUARDRAIL_MAX_RETRIES_FLOOR,
    GUARDRAIL_REQUIRE_MEDICAL_FLOOR,
    GUARDRAIL_RETRY_BACKOFF_FLOOR_MS,
    GUARDRAIL_TIMEOUT_FLOOR_S,
)
from text.models.requests import GenerateRequest
from text.services.runtime_limits import apply_platform_posture

_REPO_ROOT = Path(__file__).resolve().parents[6]
_DESCRIPTOR_DIR = _REPO_ROOT / "packages/applications/src/services/settings-registry/descriptors"
_GUARDRAIL_POSTURE_TS = _DESCRIPTOR_DIR / "text-provider-connections.descriptors.ts"
_GENERATION_TS = _DESCRIPTOR_DIR / "text-generation.descriptors.ts"
_GUARDRAIL_POLICY_TS = _DESCRIPTOR_DIR / "text-guardrail-policy.descriptors.ts"
_EFFECTIVE_CONFIG_TS = (
    _REPO_ROOT / "packages/applications/src/services/effective-config/effective-config.service.ts"
)

#: TS constant name → the Python floor each entry must equal, keyed by registry key.
_PARITY: dict[str, dict[str, object]] = {
    "TEXT_GUARDRAIL_POSTURE_DEFAULTS": {
        "text.externalGuardrail.enabled": GUARDRAIL_ENABLED_FLOOR,
        "text.externalGuardrail.timeoutS": GUARDRAIL_TIMEOUT_FLOOR_S,
        "text.externalGuardrail.maxRetries": GUARDRAIL_MAX_RETRIES_FLOOR,
        "text.externalGuardrail.retryBackoffMs": GUARDRAIL_RETRY_BACKOFF_FLOOR_MS,
        "text.externalGuardrail.requireMedical": GUARDRAIL_REQUIRE_MEDICAL_FLOOR,
        "text.externalGuardrail.includeReasoning": GUARDRAIL_INCLUDE_REASONING_FLOOR,
    },
    "TEXT_GENERATION_DEFAULTS": {
        "text.generation.temperature": GENERATION_FLOOR["temperature"],
        "text.generation.maxTokens": GENERATION_FLOOR["max_tokens"],
        "text.generation.topP": GENERATION_FLOOR["top_p"],
    },
    # The TENANT half of the posture. Its `default` is never what a tenant is
    # served (absence pushes nothing, so the platform value stands) — it is the
    # floor the key documents, and it must not disagree with the platform half
    # about what "no opinion anywhere" means.
    "TEXT_GUARDRAIL_POLICY_DEFAULTS": {
        "text.guardrailPolicy.requireMedical": GUARDRAIL_REQUIRE_MEDICAL_FLOOR,
        "text.guardrailPolicy.includeReasoning": GUARDRAIL_INCLUDE_REASONING_FLOOR,
    },
}

_SOURCE_FILE = {
    "TEXT_GUARDRAIL_POSTURE_DEFAULTS": _GUARDRAIL_POSTURE_TS,
    "TEXT_GENERATION_DEFAULTS": _GENERATION_TS,
    "TEXT_GUARDRAIL_POLICY_DEFAULTS": _GUARDRAIL_POLICY_TS,
}


def _literal(raw: str) -> object:
    """Evaluate a TS primitive literal (boolean / number). Numeric separators
    (`16_384`) are TS-legal and mean the same thing they do in Python."""
    raw = raw.strip()
    if raw == "true":
        return True
    if raw == "false":
        return False
    cleaned = raw.replace("_", "")
    return float(cleaned) if "." in cleaned else int(cleaned)


def _parse_defaults(source: str, const_name: str) -> dict[str, object]:
    """Extract the `export const <NAME> = { 'key': <literal>, … } as const;` map."""
    block = re.search(rf"export const {const_name} = \{{(?P<body>.*?)\n\}} as const;", source, re.S)
    assert block is not None, f"{const_name} is no longer a flat `as const` object literal"
    return {
        m.group("key"): _literal(m.group("value"))
        for m in re.finditer(
            r"'(?P<key>[A-Za-z0-9.]+)':\s*(?P<value>[^,\n]+),", block.group("body")
        )
    }


def _parse_view_fields(source: str, view: str) -> set[str]:
    """The field names one hand-shaped view puts on the wire.

    Reads the object literal the view RETURNS, so it reports what a client will
    actually receive rather than what the interface declares.
    """
    body = re.search(rf"{view}\(resolved: Map<string, ResolvedKey>\).*?\n  \}}", source, re.S)
    assert body is not None, f"{view} is missing from effective-config.service.ts"
    returned = re.search(r"\n      \w+: \{\n(?P<fields>.*?)\n      \},", body.group(0), re.S)
    assert returned is not None, f"{view} no longer returns a literal group object"
    return set(re.findall(r"^\s+(\w+):", returned.group("fields"), re.M))


@pytest.fixture(scope="module")
def descriptor_defaults() -> dict[str, dict[str, object]]:
    parsed: dict[str, dict[str, object]] = {}
    for const_name, path in _SOURCE_FILE.items():
        assert path.is_file(), f"missing descriptor file: {path}"
        parsed[const_name] = _parse_defaults(path.read_text(encoding="utf-8"), const_name)
    return parsed


@pytest.fixture(scope="module")
def effective_config_source() -> str:
    assert _EFFECTIVE_CONFIG_TS.is_file(), f"missing: {_EFFECTIVE_CONFIG_TS}"
    return _EFFECTIVE_CONFIG_TS.read_text(encoding="utf-8")


class TestDescriptorParity:
    """A.3 — every descriptor default equals the Python floor it replaces."""

    @pytest.mark.parametrize("const_name", sorted(_PARITY))
    def test_the_key_set_matches_exactly(
        self, const_name: str, descriptor_defaults: dict[str, dict[str, object]]
    ) -> None:
        """Both directions: a missing key is an unsettable knob, an extra one is
        a descriptor no Python floor backs."""
        assert set(descriptor_defaults[const_name]) == set(_PARITY[const_name])

    @pytest.mark.parametrize(
        ("const_name", "key"),
        sorted((c, k) for c, keys in _PARITY.items() for k in keys),
    )
    def test_the_default_matches_the_python_floor_verbatim(
        self, const_name: str, key: str, descriptor_defaults: dict[str, dict[str, object]]
    ) -> None:
        served = descriptor_defaults[const_name][key]
        floor = _PARITY[const_name][key]
        # `is` on the bools, not `==`: `1 == True` in Python, and a descriptor
        # that stored 1 for a boolean floor would pass a loose comparison while
        # being refused by the wire's `dataType` gate.
        if isinstance(floor, bool):
            assert served is floor, f"{key}: descriptor default {served!r} != floor {floor!r}"
        else:
            assert served == pytest.approx(floor), f"{key}: {served!r} != floor {floor!r}"


class TestTheViewEmitsTheNamesThisServiceReads:
    """The other half of the coupling: names, not just values."""

    def test_the_external_guardrail_view_emits_every_posture_field(
        self, effective_config_source: str
    ) -> None:
        fields = _parse_view_fields(effective_config_source, "externalGuardrailView")
        # Exactly the names `core/guardrail_posture.platform_posture` looks up,
        # plus the `source` label every group carries.
        assert fields == {
            "enabled",
            "timeoutS",
            "maxRetries",
            "retryBackoffMs",
            "requireMedical",
            "includeReasoning",
            "source",
        }

    def test_the_generation_view_emits_every_hyperparameter(
        self, effective_config_source: str
    ) -> None:
        fields = _parse_view_fields(effective_config_source, "generationView")
        # Exactly the names `core/effective_config.generation_defaults` reads.
        assert fields == {"temperature", "topP", "maxTokens", "source"}


class TestAServedValueChangesBehaviour:
    """Load-bearing: a row in the DB must reach this service and DO something.

    The payload is built from the field names PARSED out of the view above, so
    these cannot pass against a producer that emits different names — which is
    the whole point, since a name mismatch is otherwise indistinguishable from
    "the platform has no opinion".
    """

    @pytest.fixture(autouse=True)
    def _restore_process_defaults(self):
        """The served profile lives in MODULE state (`core/defaults._ACTIVE`),
        so a test that adopts one must hand the process back at the floor."""
        yield
        apply_generation_defaults({})

    def test_a_served_posture_changes_what_the_service_enforces(
        self, effective_config_source: str
    ) -> None:
        fields = _parse_view_fields(effective_config_source, "externalGuardrailView")
        # Every value below is the OPPOSITE of the floor, so a group that failed
        # to land could not accidentally produce this state.
        served = {
            "enabled": True,
            "timeoutS": 30,
            "maxRetries": 5,
            "retryBackoffMs": 750,
            "requireMedical": False,
            "includeReasoning": True,
            "source": "db",
        }
        assert set(served) == fields

        state = SimpleNamespace(guardrail_posture=None)
        apply_platform_posture(
            EffectiveConfigSnapshot(raw={"externalGuardrail": served}, ok=True), state
        )

        posture = state.guardrail_posture
        assert posture.enabled is True and GUARDRAIL_ENABLED_FLOOR is False
        assert posture.timeout_s == 30
        assert posture.max_retries == 5
        assert posture.retry_backoff_ms == 750
        assert posture.require_medical is False and GUARDRAIL_REQUIRE_MEDICAL_FLOOR is True
        assert posture.include_reasoning is True

    def test_a_served_generation_profile_changes_the_request_that_goes_out(
        self, effective_config_source: str
    ) -> None:
        fields = _parse_view_fields(effective_config_source, "generationView")
        served = {"temperature": 0.85, "topP": 0.4, "maxTokens": 2048, "source": "db"}
        assert set(served) == fields

        apply_platform_posture(
            EffectiveConfigSnapshot(raw={"generation": served}, ok=True),
            SimpleNamespace(guardrail_posture=None),
        )

        # Not "the field exists": the hyperparameters an unprofiled request
        # actually carries to the engine are now the served ones.
        resolved = resolve_request_defaults(GenerateRequest(prompt="hello"))
        assert resolved == {"temperature": 0.85, "max_tokens": 2048, "top_p": 0.4}
        assert resolved != {
            "temperature": GENERATION_FLOOR["temperature"],
            "max_tokens": GENERATION_FLOOR["max_tokens"],
            "top_p": GENERATION_FLOOR["top_p"],
        }

    def test_a_caller_who_set_a_value_still_wins_over_the_served_profile(self) -> None:
        """The served profile is a DEFAULT, not an override — it must not
        silently retune a request that stated its own hyperparameters."""
        apply_platform_posture(
            EffectiveConfigSnapshot(
                raw={"generation": {"temperature": 0.85, "maxTokens": 2048, "topP": 0.4}}, ok=True
            ),
            SimpleNamespace(guardrail_posture=None),
        )
        resolved = resolve_request_defaults(GenerateRequest(prompt="hi", temperature=0.0))
        assert resolved["temperature"] == 0.0


class TestWithNoRowNothingMoves:
    """The other load-bearing half: landing the views changed nothing today.

    With no ``GlobalSetting`` row the gateway serves ``descriptor.default``,
    which the parity tests above pin to the floor — so the resolved posture and
    the outgoing hyperparameters must be byte-identical to a service that never
    saw a group at all.
    """

    def test_the_defaults_the_gateway_would_serve_leave_the_floor_in_force(
        self, descriptor_defaults: dict[str, dict[str, object]]
    ) -> None:
        posture_defaults = descriptor_defaults["TEXT_GUARDRAIL_POSTURE_DEFAULTS"]
        generation_defaults = descriptor_defaults["TEXT_GENERATION_DEFAULTS"]

        with_rows = SimpleNamespace(guardrail_posture=None)
        apply_platform_posture(
            EffectiveConfigSnapshot(
                raw={
                    "externalGuardrail": {
                        "enabled": posture_defaults["text.externalGuardrail.enabled"],
                        "timeoutS": posture_defaults["text.externalGuardrail.timeoutS"],
                        "maxRetries": posture_defaults["text.externalGuardrail.maxRetries"],
                        "retryBackoffMs": posture_defaults["text.externalGuardrail.retryBackoffMs"],
                        "requireMedical": posture_defaults["text.externalGuardrail.requireMedical"],
                        "includeReasoning": posture_defaults[
                            "text.externalGuardrail.includeReasoning"
                        ],
                        "source": "env-fallback",
                    },
                    "generation": {
                        "temperature": generation_defaults["text.generation.temperature"],
                        "topP": generation_defaults["text.generation.topP"],
                        "maxTokens": generation_defaults["text.generation.maxTokens"],
                        "source": "env-fallback",
                    },
                },
                ok=True,
            ),
            with_rows,
        )
        served_request = resolve_request_defaults(GenerateRequest(prompt="hello"))

        apply_generation_defaults({})
        without = SimpleNamespace(guardrail_posture=None)
        apply_platform_posture(EffectiveConfigSnapshot(raw={}, ok=True), without)
        floor_request = resolve_request_defaults(GenerateRequest(prompt="hello"))

        assert with_rows.guardrail_posture == without.guardrail_posture
        assert served_request == floor_request

    def test_an_absent_group_is_still_the_floor(self) -> None:
        state = SimpleNamespace(guardrail_posture=None)
        apply_platform_posture(EffectiveConfigSnapshot(raw={}, ok=True), state)
        assert state.guardrail_posture.enabled is GUARDRAIL_ENABLED_FLOOR
        assert state.guardrail_posture.require_medical is GUARDRAIL_REQUIRE_MEDICAL_FLOOR
        assert active_generation_defaults() == {**GENERATION_FLOOR}
