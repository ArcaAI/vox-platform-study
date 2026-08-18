"""Unit tests for the deterministic DNA redaction/rewrite engine.

The engine is PURE (no I/O, no clock, no randomness) so it is safe to run inside
a Temporal activity and trivially hermetic. These tests pin the ticket's core
invariants:

* deterministic ``remove`` / ``rewrite`` of literal / regex / category spans;
* the **never-add** invariant — the engine introduces no text that is not from
  the original note or a rule's own ``replacement``;
* citation markers (``[[seg:...]]``) are left untouched by ordinary rules so the
  workflow can re-validate citations on the transformed text;
* the audit **manifest carries spans + counts but NEVER the removed PHI text**.
"""

from __future__ import annotations

import json

import pytest

from harness.redaction.engine import (
    RedactionRule,
    apply_deterministic_redaction,
)


def _rule(**kw: object) -> RedactionRule:
    base: dict[str, object] = {
        "id": "r1",
        "type": "remove",
        "match": "literal",
        "pattern": "x",
    }
    base.update(kw)
    return RedactionRule(**base)  # type: ignore[arg-type]


class TestDeterministicRemove:
    def test_literal_remove_deletes_span_and_records_hit(self) -> None:
        text = "Patient works at Acme Corp and is stable."
        rule = _rule(id="emp", pattern="Acme Corp")
        out = apply_deterministic_redaction(text, [rule])

        assert "Acme Corp" not in out.text
        assert out.changed is True
        assert out.manifest.total_hits == 1
        assert out.manifest.hits_by_rule == {"emp": 1}
        hit = out.manifest.hits[0]
        assert hit.rule_id == "emp"
        assert hit.action == "remove"
        assert hit.removed_length == len("Acme Corp")

    def test_no_match_is_a_noop(self) -> None:
        text = "Nothing sensitive here."
        out = apply_deterministic_redaction(text, [_rule(pattern="absent")])
        assert out.text == text
        assert out.changed is False
        assert out.manifest.total_hits == 0

    def test_multiple_literal_occurrences_all_removed(self) -> None:
        text = "SSN SSN SSN"
        out = apply_deterministic_redaction(text, [_rule(id="s", pattern="SSN")])
        assert "SSN" not in out.text
        assert out.manifest.hits_by_rule == {"s": 3}


class TestRegexRemove:
    def test_regex_remove(self) -> None:
        text = "Call 555-123-4567 today."
        rule = _rule(id="phone", match="regex", pattern=r"\d{3}-\d{3}-\d{4}")
        out = apply_deterministic_redaction(text, [rule])
        assert "555-123-4567" not in out.text
        assert out.manifest.hits_by_rule == {"phone": 1}


class TestCategoryRemove:
    def test_builtin_email_category(self) -> None:
        text = "Reach me at john.doe@example.com please."
        rule = _rule(id="e", match="category", pattern="email")
        out = apply_deterministic_redaction(text, [rule])
        assert "john.doe@example.com" not in out.text
        assert out.manifest.total_hits == 1

    def test_unknown_category_is_noop_not_error(self) -> None:
        text = "unchanged"
        rule = _rule(id="u", match="category", pattern="not-a-real-category")
        out = apply_deterministic_redaction(text, [rule])
        assert out.text == text
        assert out.changed is False


class TestDeterministicRewrite:
    def test_literal_rewrite_substitutes_replacement(self) -> None:
        text = "The patient is a taxi driver."
        rule = _rule(
            id="job", type="rewrite", pattern="taxi driver", replacement="professional driver"
        )
        out = apply_deterministic_redaction(text, [rule])
        assert out.text == "The patient is a professional driver."
        assert out.manifest.hits[0].action == "rewrite"


class TestNeverAddInvariant:
    def test_remove_only_never_grows_text(self) -> None:
        text = "a" * 200 + " secret " + "b" * 200
        rule = _rule(id="s", pattern="secret")
        out = apply_deterministic_redaction(text, [rule])
        assert len(out.text) <= len(text)

    def test_engine_introduces_no_foreign_characters(self) -> None:
        # Output must be composed only of original characters + rule replacements.
        text = "keep AAA drop BBB keep"
        rule = _rule(id="d", type="rewrite", pattern="BBB", replacement="ZZZ")
        out = apply_deterministic_redaction(text, [rule])
        allowed = set(text) | set("ZZZ")
        assert set(out.text) <= allowed


class TestCitationMarkersUntouched:
    def test_seg_citation_markers_survive_ordinary_rules(self) -> None:
        text = "Assessment [[seg:abc-123]] employer Acme removed."
        rule = _rule(id="emp", pattern="Acme")
        out = apply_deterministic_redaction(text, [rule])
        assert "[[seg:abc-123]]" in out.text
        assert "Acme" not in out.text


class TestManifestHasNoPhi:
    def test_manifest_json_excludes_removed_text(self) -> None:
        secret = "John Q. Patient"
        text = f"Name: {secret}. Stable."
        rule = _rule(id="name", pattern=secret)
        out = apply_deterministic_redaction(text, [rule])
        blob = json.dumps(out.manifest.model_dump())
        assert secret not in blob
        # spans/counts ARE present for audit sizing
        assert out.manifest.hits[0].removed_length == len(secret)


class TestRuleValidation:
    def test_rewrite_requires_replacement_at_construction(self) -> None:
        # A deterministic rewrite with no replacement is invalid (semantic rewrite
        # is an Text concern handled in the activity, not the pure engine).
        with pytest.raises(ValueError):
            RedactionRule(id="x", type="rewrite", match="literal", pattern="a")

    def test_bad_regex_fails_closed(self) -> None:
        # A malformed regex reaching the engine must not silently pass the note
        # through unredacted — the engine raises so the activity can FLAG.
        from harness.redaction.engine import RedactionEngineError

        rule = _rule(id="bad", match="regex", pattern="(")
        with pytest.raises(RedactionEngineError):
            apply_deterministic_redaction("some text", [rule])
