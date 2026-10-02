"""TASK-1035 §5.0 — provider locality and the request-scoped pseudonymizer.

Locality decides whether a prompt may leave the platform with real identifiers in
it. The rules are frozen in the ticket's wire contract:

1. stamp ``local`` AND the provider is not a known cloud vendor ⇒ local;
2. no stamp AND the provider is engine-served (or ``built-in``) ⇒ local;
3. everything else ⇒ cloud (fail closed). A stamp never downgrades a cloud vendor.

The pseudonymizer replaces identifiers with ``[<LABEL>_<n>]`` tokens — stable per
distinct value within one request — and restores them on the way back.
"""

from __future__ import annotations

import pytest

from text.core.locality import CLOUD, KNOWN_CLOUD_PROVIDERS, LOCAL, resolve_locality
from text.services.pseudonymizer import Pseudonymizer, Span


class TestLocality:
    def test_known_cloud_list_is_the_frozen_contract(self) -> None:
        assert KNOWN_CLOUD_PROVIDERS == frozenset(
            {
                "azure",
                "azure-openai",
                "bedrock",
                "openai",
                "anthropic",
                "vertex",
                "google",
                "gemini",
                "mistral",
                "cohere",
                "groq",
                "together",
                "openrouter",
            }
        )

    @pytest.mark.parametrize("provider", ["lm-studio", "lmstudio", "ollama", "vllm", "llama-cpp"])
    def test_engine_served_without_a_stamp_is_local(self, provider: str) -> None:
        assert resolve_locality(provider, None) == LOCAL

    def test_built_in_without_a_stamp_is_local(self) -> None:
        assert resolve_locality("built-in", {}) == LOCAL

    def test_unknown_provider_without_a_stamp_is_cloud(self) -> None:
        assert resolve_locality("openai_compat", None) == CLOUD

    def test_a_local_stamp_makes_a_non_vendor_provider_local(self) -> None:
        assert resolve_locality("openai_compat", {"openai_compat": "local"}) == LOCAL

    @pytest.mark.parametrize("provider", ["azure", "openai", "anthropic", "bedrock"])
    def test_a_local_stamp_never_downgrades_a_cloud_vendor(self, provider: str) -> None:
        assert resolve_locality(provider, {provider: "local"}) == CLOUD

    def test_a_cloud_stamp_wins_over_an_engine_served_provider(self) -> None:
        assert resolve_locality("lm-studio", {"lm-studio": "cloud"}) == CLOUD

    def test_a_stamp_for_another_provider_does_not_apply(self) -> None:
        assert resolve_locality("openai_compat", {"lm-studio": "local"}) == CLOUD


class TestPseudonymizer:
    def test_known_phi_is_replaced_case_insensitively_and_stably(self) -> None:
        p = Pseudonymizer([("patient_name", "John Doe")])

        out = p.pseudonymize("john  doe came in. JOHN DOE has a cough.", [])

        assert out == "[PATIENT_NAME_1] came in. [PATIENT_NAME_1] has a cough."
        assert p.redacted == 2
        assert p.detected == {"patient_name": 2}

    def test_known_phi_respects_word_boundaries(self) -> None:
        p = Pseudonymizer([("person", "Ann")])
        assert p.pseudonymize("Annual review for Ann.", []) == "Annual review for [PERSON_1]."

    def test_spans_get_per_label_per_value_tokens_across_fields(self) -> None:
        p = Pseudonymizer([])
        system = p.pseudonymize("Clinician: Dr Smith.", [Span("person", 11, 19)])
        prompt = p.pseudonymize(
            "Dr Smith saw Mary Jones.", [Span("person", 0, 8), Span("person", 13, 23)]
        )

        assert system == "Clinician: [PERSON_1]."
        assert prompt == "[PERSON_1] saw [PERSON_2]."
        assert p.detected == {"person": 3}

    def test_label_is_uppercase_snake(self) -> None:
        p = Pseudonymizer([("date of-birth", "1970-01-02")])
        assert p.pseudonymize("DOB 1970-01-02", []) == "DOB [DATE_OF_BIRTH_1]"

    def test_overlapping_span_and_known_value_replace_once(self) -> None:
        p = Pseudonymizer([("mrn", "MRN-12345")])
        out = p.pseudonymize("Record MRN-12345 open.", [Span("account_id", 7, 16)])
        assert out == "Record [MRN_1] open."
        assert p.redacted == 1

    def test_count_only_detects_without_replacing(self) -> None:
        p = Pseudonymizer([("person", "John Doe")])
        p.count("John Doe, 54.", [Span("person", 0, 8)])
        assert p.detected == {"person": 1}
        assert p.redacted == 0

    def test_restore_returns_the_original_values_and_counts_them(self) -> None:
        p = Pseudonymizer([("person", "John Doe")])
        p.pseudonymize("John Doe", [])

        restored, count = p.restore("Note for [PERSON_1]. [PERSON_1] is stable. [PERSON_9]?")

        assert restored == "Note for John Doe. John Doe is stable. [PERSON_9]?"
        assert count == 2

    def test_the_map_never_appears_in_repr(self) -> None:
        p = Pseudonymizer([("person", "John Doe")])
        p.pseudonymize("John Doe", [])
        assert "John Doe" not in repr(p)
