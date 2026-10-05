"""TASK-1035 §5.0 — the harness half of the frozen `/generate` egress contract.

`apps/text` now owns cloud redaction and re-identification and fails CLOSED: an absent locality
stamp is CLOUD. The harness therefore only ever:

* stamps `provider_locality` when it actually KNOWS the model's deployment kind
  (`SELF_HOSTED` ⇒ local, `CLOUD`/`BYOK` ⇒ cloud) — never from a provider name, never from env;
* forwards the identity values it already holds as `known_phi` (≥ 2 chars, ≤ 200 items);
* records the response's `egress` object as COUNTS only.
"""

from __future__ import annotations

from harness.core.llm_egress import (
    KNOWN_PHI_MAX_ITEMS,
    egress_counts,
    is_local_direct_transport,
    known_phi_from,
    locality_from_deployment_kind,
    provider_locality,
)


class TestLocalityFromDeploymentKind:
    def test_self_hosted_is_local(self) -> None:
        assert locality_from_deployment_kind("SELF_HOSTED") == "local"

    def test_cloud_and_byok_are_cloud(self) -> None:
        assert locality_from_deployment_kind("CLOUD") == "cloud"
        assert locality_from_deployment_kind("BYOK") == "cloud"

    def test_unknown_or_absent_is_no_stamp(self) -> None:
        # Absent ⇒ OMIT: text decides (fail-closed cloud, engine-served ⇒ local).
        assert locality_from_deployment_kind(None) is None
        assert locality_from_deployment_kind("") is None
        assert locality_from_deployment_kind("SOMETHING_NEW") is None

    def test_case_insensitive(self) -> None:
        assert locality_from_deployment_kind("self_hosted") == "local"


class TestProviderLocality:
    def test_stamp_is_keyed_by_the_wire_provider(self) -> None:
        assert provider_locality("lm-studio", "SELF_HOSTED") == {"lm-studio": "local"}
        assert provider_locality("azure-openai", "BYOK") == {"azure-openai": "cloud"}

    def test_no_kind_or_no_provider_means_no_stamp(self) -> None:
        assert provider_locality("lm-studio", None) is None
        assert provider_locality(None, "SELF_HOSTED") is None
        assert provider_locality("", "SELF_HOSTED") is None


class TestKnownPhi:
    def test_reads_the_identity_keys_the_harness_holds(self) -> None:
        found = known_phi_from(
            {"consultationId": "c-1", "externalPatientId": "MRN-00042", "userId": "u-1"},
            {"patient": {"name": "Ada Lovelace", "mrn": "889900"}, "staffId": "DR-77"},
        )
        assert {"label": "patient_id", "value": "MRN-00042"} in found
        assert {"label": "person", "value": "Ada Lovelace"} in found
        assert {"label": "mrn", "value": "889900"} in found
        assert {"label": "staff_id", "value": "DR-77"} in found
        # Internal UUIDs are not PHI and never travel.
        assert all(item["value"] not in {"c-1", "u-1"} for item in found)

    def test_short_values_are_dropped_and_duplicates_collapse(self) -> None:
        found = known_phi_from({"externalPatientId": "X"}, {"mrn": " 1234 ", "MRN": "1234"})
        assert found == [{"label": "mrn", "value": "1234"}]

    def test_nothing_held_is_none_not_an_empty_list(self) -> None:
        assert known_phi_from({}, None, {"consultationId": "c-1"}) is None

    def test_bounded(self) -> None:
        many = {"patients": [{"patientName": f"Person Number {i}"} for i in range(500)]}
        found = known_phi_from(many)
        assert found is not None and len(found) == KNOWN_PHI_MAX_ITEMS
        assert all(len(item["value"]) <= 200 for item in found)

    def test_non_string_values_are_ignored(self) -> None:
        assert known_phi_from({"mrn": {"nested": True}, "staffId": None}) is None


class TestEgressCounts:
    def test_counts_only_never_values(self) -> None:
        counts = egress_counts(
            {
                "locality": "cloud",
                "detected": {"person": 2, "mrn": 1},
                "redacted": 3,
                "restored": 3,
                "images_unredacted": 0,
                "pii_leak_blocked": False,
                "values": ["Ada"],  # a field the contract does not define is never copied
            }
        )
        assert counts == {
            "locality": "cloud",
            "detected": {"person": 2, "mrn": 1},
            "redacted": 3,
            "restored": 3,
            "images_unredacted": 0,
            "pii_leak_blocked": False,
        }

    def test_absent_or_malformed_is_none(self) -> None:
        assert egress_counts(None) is None
        assert egress_counts("cloud") is None


class TestDirectTransportLocality:
    """The judge posts DIRECTLY to its provider (not through `/generate`), so its Presidio screen
    stays — but its local list is code, not the retired `HARNESS_PHI_LOCAL_PROVIDERS` env."""

    def test_engine_served_transports_are_local(self) -> None:
        # The former `HARNESS_PHI_LOCAL_PROVIDERS` default (ollama included, owner 2026-08-20).
        for transport in ("lm-studio", "lmstudio", "openai_compat", "ollama", "vllm", "llama-cpp"):
            assert is_local_direct_transport(transport)

    def test_known_cloud_and_unknown_are_not_local(self) -> None:
        for transport in ("azure", "bedrock", "openai", "anthropic", "something-new"):
            assert not is_local_direct_transport(transport)
        assert not is_local_direct_transport(None)
