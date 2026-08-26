"""TASK-809 OD-15 — assurance data survives STRICT per-key binding.

## The failure this pins

`bound_value()` searched only INSIDE dict-valued bound inputs, and its own docstring said why: the
interpreter threaded "either the single value named by the edge's ``fromPort`` or the WHOLE
predecessor output dict", so a node "cannot assume which it received and must look inside".

Removing the whole-object fallback removes that guarantee. `persistDraft` and `finalizeAssurance`
read `scores`, `citationsMap`, `guardrailDecisions`, `ragTriadScore`, `reducedAssurance` and
`contextItemId` through `bound_value`, and `PersistDraftInput`/`FinalizeAssuranceInput` treat
`None` as "no verifier ran". So a lookup that quietly stops finding its key does not error — it
persists a clinical draft with its assurance record missing, and nothing anywhere says so.

Two changes keep that from happening, and both are asserted here rather than assumed:

1. `bound_value` consults the TOP-LEVEL key first. Under named sockets the value a graph binds is
   often the datum itself (`contextItemId`, an entity list), not a dict to rummage through.
2. The two verifier activities publish their assurance record as ONE object on the `verdict`
   socket, so a single socket carries all of it instead of whichever field the socket happened to
   name.

Hermetic: pure functions, no Temporal, no DB, no network.
"""

from __future__ import annotations

from harness.temporal.interpreter.nodes._consultation_shared import bound_entities, bound_value


class TestTopLevelKeyFirst:
    def test_finds_a_datum_bound_directly_to_a_socket_of_that_name(self):
        # `persistDraft.contextItemId -> finalizeAssurance.contextItemId`: the bound value is the
        # id itself. The old nested-only search returned None for exactly this shape.
        assert bound_value({"in": "the note", "contextItemId": "ci-1"}, "contextItemId") == "ci-1"

    def test_still_finds_a_key_nested_inside_a_dict_valued_socket(self):
        bound = {"in": "the note", "verdict": {"scores": {"coverage": 0.9}}}
        assert bound_value(bound, "scores") == {"coverage": 0.9}

    def test_the_top_level_wins_over_a_nested_hit(self):
        bound = {"contextItemId": "direct", "verdict": {"contextItemId": "nested"}}
        assert bound_value(bound, "contextItemId") == "direct"

    def test_a_top_level_None_does_not_shadow_a_real_nested_value(self):
        bound = {"scores": None, "verdict": {"scores": {"coverage": 0.4}}}
        assert bound_value(bound, "scores") == {"coverage": 0.4}

    def test_absent_everywhere_is_still_None_never_a_fabricated_value(self):
        assert bound_value({"in": "the note"}, "scores") is None


class TestEntitiesSurviveAStrictBinding:
    def test_an_entity_LIST_bound_to_the_entities_socket_is_found(self):
        # `extractEntities.out` carries the list itself, so there is no dict to look inside.
        bound = {"in": "the note", "entities": [{"text": "cough", "label": "SYMPTOM"}]}
        entities = bound_entities(bound)
        assert [e.text for e in entities] == ["cough"]

    def test_a_malformed_row_costs_that_row_only(self):
        bound = {"entities": [{"text": "cough", "label": "SYMPTOM"}, {"nope": 1}]}
        assert len(bound_entities(bound)) == 1


class TestTheFullAssuranceRecordReachesPersistence:
    def test_every_field_persistDraft_reads_survives_one_verdict_socket(self):
        # Exactly the shape `_resolve_bound_inputs` now produces for
        # `sensors.document -> persistDraft.in` + `sensors.out -> persistDraft.verdict`
        # + `inferentialSensors.out -> persistDraft.assurance`.
        bound = {
            "in": "S: cough for four days",
            "verdict": {
                "scores": {"coverage": 0.9},
                "citationsMap": {"c1": ["k1"]},
                "verdicts": [],
            },
            "assurance": {
                "guardrailDecisions": {"safety": "pass"},
                "ragTriadScore": 0.95,
                "verdicts": [],
                "reducedAssurance": False,
            },
        }
        assert bound_value(bound, "scores") == {"coverage": 0.9}
        assert bound_value(bound, "citationsMap") == {"c1": ["k1"]}
        assert bound_value(bound, "guardrailDecisions") == {"safety": "pass"}
        assert bound_value(bound, "ragTriadScore") == 0.95
        assert bound_value(bound, "reducedAssurance") is False
