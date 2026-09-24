"""TASK-1004 — the language-resolution contract, Python half.

``tests/contracts/language-resolution.fixture.json`` is the ONE statement of the
spoken-language selection shared by the gateway normalizer/resolver (TypeScript),
this service's normalizer + receipt builder, both SDKs and the ALaaS broker. This
file locks the parts ``apps/stt`` produces:

* the edge normalizer (``normalize``) — a catalog id wins as-is, a BCP-47
  ``<lang>-<REGION>`` tag whose language IS a single-language catalog id maps to
  that id, anything else is ``None`` (the gateway's 400);
* the closed ``source`` / ``reason`` enums and the catalog ids;
* the ``LanguageResolution`` receipt, snake_case on this service's wire — every
  ``receipt.examples[].python`` must be reproduced EXACTLY by the resolver the
  streaming and batch runtimes both call.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from stt.pipeline import language_modes
from stt.pipeline.dto import AiModelFormat
from stt.pipeline.language_modes import (
    LANGUAGE_MODE_CATALOG,
    LANGUAGE_MODE_SOURCES,
    LANGUAGE_RESOLUTION_REASONS,
    LanguageResolution,
    normalize_language_mode,
    resolve_language,
)
from stt.streaming.session_manager import _language_mode_for_declared_language


def _load_fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "language-resolution.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared language-resolution contract fixture not found")


FIXTURE = _load_fixture()


def _snake(name: str) -> str:
    return "".join(f"_{c.lower()}" if c.isupper() else c for c in name)


@pytest.mark.parametrize(
    "case", FIXTURE["normalize"], ids=[repr(c["input"]) for c in FIXTURE["normalize"]]
)
def test_normalizer_matches_the_shared_table(case: dict[str, Any]) -> None:
    assert normalize_language_mode(case["input"]) == case["expected"]


@pytest.mark.parametrize("value", [None, 7, ["en"], {"en": 1}])
def test_normalizer_rejects_non_strings(value: object) -> None:
    assert normalize_language_mode(value) is None


def test_catalog_ids_match_the_contract_in_display_order() -> None:
    assert [m.id for m in LANGUAGE_MODE_CATALOG] == FIXTURE["catalogIds"]


def test_closed_enums_match_the_contract() -> None:
    assert list(LANGUAGE_MODE_SOURCES) == FIXTURE["enums"]["source"]
    assert list(LANGUAGE_RESOLUTION_REASONS) == FIXTURE["enums"]["reason"]


def test_a_declared_bcp47_tag_now_promotes_to_its_catalog_mode() -> None:
    """TASK-938's promotion reads through the shared normalizer, so ``en-US`` is a
    declaration of ``en`` rather than a non-catalog raw language."""
    assert _language_mode_for_declared_language("en-US") == "en"
    assert _language_mode_for_declared_language(" ML-in ") == "ml"
    assert _language_mode_for_declared_language("fr-FR") is None
    assert _language_mode_for_declared_language(None) is None


def test_receipt_wire_keys_are_the_contract_keys_in_snake_case() -> None:
    receipt = FIXTURE["receipt"]
    example = receipt["examples"][0]["python"]
    assert list(example) == [_snake(k) for k in receipt["keys"]]
    assert list(example["params"]) == [_snake(k) for k in receipt["paramsKeys"]]
    rebuilt = LanguageResolution.from_wire(example)
    assert list(rebuilt.to_wire()) == list(example)
    assert list(rebuilt.to_wire()["params"]) == list(example["params"])


@pytest.mark.parametrize(
    "example",
    FIXTURE["receipt"]["examples"],
    ids=[e["name"] for e in FIXTURE["receipt"]["examples"]],
)
def test_resolver_reproduces_every_contract_receipt(
    example: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    # Example 1 is the TASK-985 OD-B state: the whisper.cpp pair prompt is OFF.
    monkeypatch.setattr(language_modes, "WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED", False)
    monkeypatch.setattr(language_modes, "WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED", False)
    expected = example["python"]

    _resolved, receipt = resolve_language(
        expected["requested_mode"],
        AiModelFormat(expected["engine"]),
        source=expected["source"],
        provider=expected["provider"],
    )

    assert receipt.to_wire() == expected


@pytest.mark.parametrize(
    "example",
    FIXTURE["receipt"]["examples"],
    ids=[e["name"] for e in FIXTURE["receipt"]["examples"]],
)
def test_receipt_json_round_trips(example: dict[str, Any]) -> None:
    receipt = LanguageResolution.from_wire(example["python"])
    assert json.loads(receipt.to_json()) == example["python"]
    assert LanguageResolution.from_json(receipt.to_json()) == receipt


def test_from_wire_rejects_a_value_outside_the_closed_enums() -> None:
    bad = dict(FIXTURE["receipt"]["examples"][0]["python"], source="tenant")
    with pytest.raises(ValueError):
        LanguageResolution.from_wire(bad)
    bad = dict(FIXTURE["receipt"]["examples"][0]["python"], reason="vibes")
    with pytest.raises(ValueError):
        LanguageResolution.from_wire(bad)
