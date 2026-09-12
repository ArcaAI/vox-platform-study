"""TASK-879 — ``ResolvedTtsSpec`` cross-language parity (Python half).

The gateway PRODUCES the spec (``buildResolvedTtsSpec`` in ``@arcaai/applications``) and this
service CONSUMES it (``tts.spec``). Both halves read the SAME committed fixture —
``tests/contracts/resolved-tts-spec.fixture.json`` — so a shape change one side makes fails the
other. The TypeScript half is ``tests/contracts/resolved-tts-spec-parity.contract.test.ts``.

What this half locks:

* every ``expected`` spec validates against the pydantic mirror AND round-trips byte-for-byte
  (``extra='forbid'`` — an unknown field is a contract drift, never silently dropped);
* ``candidate_chain`` orders and FILTERS the candidates the way the gateway's decisions say:
  the funding-gated ``autoSwitch``, the enabled-connection gate that replaced
  ``tts.<engine>.enabled``, and the voice a candidate can actually speak;
* selection fails CLOSED on a schema version this runtime does not know.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from tts.spec import (
    RESOLVED_TTS_SPEC_SCHEMA_VERSION,
    ResolvedTtsSpec,
    UnsupportedTtsSpecError,
    candidate_chain,
)


def _load_fixture() -> dict[str, Any]:
    """Locate the shared contract fixture by walking up to the repo root."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-tts-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedTtsSpec contract fixture not found")


FIXTURE = _load_fixture()
CASES = {name: case for name, case in FIXTURE.items() if isinstance(case, dict)}


@pytest.mark.parametrize("name", sorted(CASES))
def test_expected_spec_validates_and_round_trips(name: str) -> None:
    expected = CASES[name]["expected"]
    spec = ResolvedTtsSpec.model_validate(expected)
    assert spec.schema_version == RESOLVED_TTS_SPEC_SCHEMA_VERSION
    # by_alias → camelCase wire keys; exclude nothing so `null`s survive.
    assert spec.model_dump(by_alias=True, mode="json") == expected


def test_unknown_field_is_a_contract_drift_not_a_silent_drop() -> None:
    expected = dict(CASES["platformDefault"]["expected"])
    expected["routingEn"] = ["azure", "kokoro"]
    with pytest.raises(ValidationError):
        ResolvedTtsSpec.model_validate(expected)


def test_unknown_schema_version_fails_closed() -> None:
    expected = dict(CASES["platformDefault"]["expected"])
    expected["schemaVersion"] = 99
    with pytest.raises(UnsupportedTtsSpecError):
        candidate_chain(ResolvedTtsSpec.model_validate(expected))


def test_the_platform_default_resolves_one_candidate_on_its_own_voice() -> None:
    spec = ResolvedTtsSpec.model_validate(CASES["platformDefault"]["expected"])
    chain = candidate_chain(spec)
    assert [c.engine for c in chain] == ["kokoro"]
    assert chain[0].binding_for(None) is not None
    assert chain[0].binding_for(None).engine_voice == "af_heart"
    assert chain[0].sample_rate() == 24000


def test_the_chain_is_walked_in_order_and_each_candidate_speaks_its_own_voice() -> None:
    spec = ResolvedTtsSpec.model_validate(CASES["tenantAgentWithCloudFallback"]["expected"])
    chain = candidate_chain(spec)
    assert [c.engine for c in chain] == ["indic_parler", "azure", "kokoro"]
    # Each candidate's voice comes from ITS OWN agent + model, never the primary's: falling over
    # must not carry a voice name the next engine cannot say.
    assert [c.binding_for(None).engine_voice for c in chain] == [
        "Anjali",
        "ml-IN-SobhanaNeural",
        "af_heart",
    ]


def test_auto_switch_off_runs_the_primary_and_stops() -> None:
    expected = json.loads(json.dumps(CASES["tenantAgentWithCloudFallback"]["expected"]))
    expected["fallback"]["autoSwitch"] = False
    chain = candidate_chain(ResolvedTtsSpec.model_validate(expected))
    assert [c.engine for c in chain] == ["indic_parler"]


def test_a_candidate_whose_engine_the_platform_has_not_enabled_is_walked_past() -> None:
    """`connection: null` is what `tts.<engine>.enabled: false` used to say."""
    expected = json.loads(json.dumps(CASES["tenantAgentWithCloudFallback"]["expected"]))
    expected["primary"]["connection"] = None
    chain = candidate_chain(ResolvedTtsSpec.model_validate(expected))
    assert [c.engine for c in chain] == ["azure", "kokoro"]


def test_a_caller_named_voice_excludes_the_candidates_that_cannot_say_it() -> None:
    spec = ResolvedTtsSpec.model_validate(CASES["tenantAgentWithCloudFallback"]["expected"])
    assert [c.engine for c in candidate_chain(spec, voice_id="ml-IN-SobhanaNeural")] == ["azure"]
    # A voice no candidate binds resolves to NO candidate at all — the endpoint answers 404
    # rather than substituting a voice the caller did not ask for.
    assert candidate_chain(spec, voice_id="no-such-voice") == []
