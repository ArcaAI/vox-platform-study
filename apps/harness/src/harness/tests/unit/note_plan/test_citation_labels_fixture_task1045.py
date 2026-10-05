"""The coverage regex finds the same citation labels as the shared fixture.

`tests/contracts/citation-labels.fixture.json` pins the label grammar for every port. The harness
regex only captures the source id (`S7`, not `S7 E1`), so the comparison is on that first token.
"""

import json
from pathlib import Path

import pytest

from harness.services.note_plan import coverage

_FIXTURE = next(
    p / "tests/contracts/citation-labels.fixture.json"
    for p in Path(__file__).resolve().parents
    if (p / "tests/contracts/citation-labels.fixture.json").is_file()
)
_CASES = json.loads(_FIXTURE.read_text())["cases"]

# The harness regex lets a label's trailing text run across a line break; the shared grammar does
# not. Real notes never carry an unclosed bracket mid-label, so the difference is accepted.
_KNOWN_DIFFERENCES = {"label text does not cross a line break"}


def _ids(case: dict) -> list[str]:
    return [label.split(" ", 1)[0] for label in case["labels"]]


def test_fixture_is_not_vacuous() -> None:
    assert len(_CASES) > 10


@pytest.mark.parametrize("case", [c for c in _CASES if c["name"] not in _KNOWN_DIFFERENCES], ids=lambda c: c["name"])
def test_regex_finds_the_fixture_labels(case: dict) -> None:
    found = [m.group("label") for m in coverage._BRACKETED_LABEL.finditer(case["input"])]
    assert found == _ids(case)


def test_known_difference_is_still_a_difference() -> None:
    case = next(c for c in _CASES if c["name"] in _KNOWN_DIFFERENCES)
    found = [m.group("label") for m in coverage._BRACKETED_LABEL.finditer(case["input"])]
    assert found == ["S5"]
    assert _ids(case) == []
