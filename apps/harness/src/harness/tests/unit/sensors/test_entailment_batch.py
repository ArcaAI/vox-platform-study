"""Unit tests for the batched-entailment helper.

The helper turns the per-claim groundedness loop into a few JSON-array calls
against the shared transcript premise. The parser is **conservative**: anything
ambiguous (unparseable/truncated array, missing id, non-bool ``supported``,
duplicate-id conflict) maps the affected claim(s) to *ungrounded* (``False``),
never the looser direction. Extra ids that do not match a real claim are ignored
and can never ground a real claim.
"""

from __future__ import annotations

import json

from harness.sensors.inferential.entailment_batch import (
    batch_entailment_messages,
    chunk,
    parse_batch_verdicts,
)


class TestChunk:
    def test_groups_in_runs_of_size_order_preserved(self):
        assert chunk([1, 2, 3, 4, 5, 6], 3) == [[1, 2, 3], [4, 5, 6]]

    def test_last_group_is_remainder(self):
        assert chunk([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]

    def test_size_below_one_is_treated_as_one(self):
        assert chunk([1, 2], 0) == [[1], [2]]

    def test_empty_is_no_groups(self):
        assert chunk([], 5) == []


class TestBatchMessages:
    def _items(self):
        return [
            {"id": "c1", "hypothesis": "BP elevated", "evidence": ["BP 150/95"]},
            {"id": "c2", "hypothesis": "penicillin allergy", "evidence": []},
        ]

    def test_shared_premise_present_once_and_roles(self):
        msgs = batch_entailment_messages("TRANSCRIPT TEXT", self._items())
        assert msgs[0]["role"] == "system"
        assert msgs[-1]["role"] == "user"
        user = msgs[-1]["content"]
        assert user.count("TRANSCRIPT TEXT") == 1

    def test_every_id_and_hypothesis_enumerated(self):
        user = batch_entailment_messages("PREM", self._items())[-1]["content"]
        assert "c1" in user and "c2" in user
        assert "BP elevated" in user and "penicillin allergy" in user

    def test_instruction_demands_json_array_each_id(self):
        system = batch_entailment_messages("PREM", self._items())[0]["content"].lower()
        assert "json array" in system
        assert "supported" in system
        # Must instruct one verdict per id (label-each-item).
        assert "id" in system


class TestParseBatchVerdicts:
    def test_wellformed_array_maps_each_id(self):
        raw = json.dumps([{"id": "c1", "supported": True}, {"id": "c2", "supported": False}])
        assert parse_batch_verdicts(raw, ["c1", "c2"]) == {"c1": True, "c2": False}

    def test_reasoning_wrapped_array_is_extracted(self):
        raw = '<think>c1 is in the premise; c2 is not</think>\n[{"id":"c1","supported":true},{"id":"c2","supported":false}]'
        assert parse_batch_verdicts(raw, ["c1", "c2"]) == {"c1": True, "c2": False}

    def test_object_not_array_is_all_ungrounded(self):
        # A single object (not the requested array) is ambiguous -> all ungrounded.
        assert parse_batch_verdicts('{"supported": true}', ["c1", "c2"]) == {
            "c1": False,
            "c2": False,
        }

    def test_unparseable_is_all_ungrounded(self):
        assert parse_batch_verdicts("not json at all", ["c1"]) == {"c1": False}

    def test_truncated_array_is_all_ungrounded(self):
        raw = '[{"id":"c1","supported":true},{"id":"c2","suppo'
        assert parse_batch_verdicts(raw, ["c1", "c2"]) == {"c1": False, "c2": False}

    def test_missing_id_is_ungrounded_others_honored(self):
        raw = json.dumps([{"id": "c1", "supported": True}])
        assert parse_batch_verdicts(raw, ["c1", "c2"]) == {"c1": True, "c2": False}

    def test_extra_id_never_grounds_a_real_claim(self):
        raw = json.dumps([{"id": "c-bogus", "supported": True}])
        assert parse_batch_verdicts(raw, ["c1", "c2"]) == {"c1": False, "c2": False}

    def test_nonbool_supported_is_ungrounded(self):
        raw = json.dumps([{"id": "c1", "supported": "yes"}])
        assert parse_batch_verdicts(raw, ["c1"]) == {"c1": False}

    def test_duplicate_conflict_is_ungrounded(self):
        raw = json.dumps([{"id": "c1", "supported": True}, {"id": "c1", "supported": False}])
        assert parse_batch_verdicts(raw, ["c1"]) == {"c1": False}

    def test_dict_wrapped_list_is_parsed(self):
        raw = json.dumps({"results": [{"id": "c1", "supported": True}]})
        assert parse_batch_verdicts(raw, ["c1"]) == {"c1": True}
