"""TASK-932 R-16a — the FINALIZED note becomes the consultation's own note.

Nothing in a `core` graph persisted it. The clinician pressed stop, the durable finalizer ran (or,
before the live handoff, degraded), and the case-note column stayed empty: no `RAW_SUMMARY`
`ContextItem`, no `SummaryMeta`, no redaction marker, no DNA provenance. Measured on the dev stack
2026-09-09 across 29 e2e consultations.

`consultation.persistDraft` — the action that WOULD have written it — is structurally unreachable
from this vocabulary: its `in` port is `document`, `core.agent` publishes `text` / `object`, and
the port lattice permits widening only specific -> general (`port-model.ts`), which is the
anti-laundering rule and is not being changed. So the write is made by the node that holds the
note, under the declaration the graph author already wrote: `execution.cadence: onEnd`.

What this suite pins:

 1. an `onEnd` `core.agent` in a CONSULTATION-bound run persists its `case_note` through the same
    `persist_draft` gateway write `HarnessDocWorkflow` has always used;
 2. every other cadence, every exposure-plane run, and every sandbox run persists NOTHING;
 3. the redaction manifest carries LABELS AND COUNTS ONLY — never the identifiers a redaction
    removed, which is exactly what `SummaryMeta.redactionManifest` is documented to hold;
 4. the DNA style id comes from the run context the LIVE HANDOFF published, so `SummaryMeta`
    names the report that actually shaped the note;
 5. a persist failure DEGRADES with a named reason and KEEPS the output — it never raises, because
    raising re-runs the activity from the primary and re-bills a generation that completed.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from harness.services.api_client import ApiServiceError
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"
_CONSULTATION = "01a0816f-0000-7000-8000-0000000009e4"
_CASE_NOTE = "S: Cough for three days.\nO: Afebrile.\nA: URTI.\nP: Fluids, review in 48h."

_FINALIZER_OUTPUT = {
    "case_note": _CASE_NOTE,
    "redactions": [
        {"text": "Jane Doe", "label": "NAME"},
        {"text": "07700 900461", "label": "PHONE"},
        {"text": "John Smith", "label": "NAME"},
    ],
}


def _wire() -> dict[str, Any]:
    """A resolved `casenote-finalization` agent, in the gateway's own answer shape."""
    return {
        "agentId": "agent-fin",
        "agentVersionId": "agent-fin-v3",
        "slug": "casenote-finalization",
        "versionNumber": 3,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": {
            "task": "TEXT_GENERATION",
            "service": "llm",
            "model": {
                "id": "m-1",
                "slug": "lms-gemma",
                "provider": "lm-studio",
                "taskType": "TEXT_GENERATION",
            },
            "fallbacks": [],
            "instruction": {"systemPrompt": "Finalize the case note."},
            "resolvedPrompt": {"source": "inline", "content": "Finalize the case note."},
            "parameters": {},
            # The seeded `CASENOTE_OUTPUT_SCHEMA` shape: it is what TASK-930 §5 turns into the
            # `json_schema` response format, which is what makes `output["data"]` the parsed
            # answer this activity persists from.
            "outputSchema": {
                "type": "object",
                "required": ["case_note", "redactions"],
                "properties": {
                    "case_note": {"type": "string"},
                    "redactions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["text", "label"],
                            "properties": {"text": {"type": "string"}, "label": {"type": "string"}},
                        },
                    },
                },
            },
            "tools": [],
            "protocols": ["http"],
        },
        "models": [
            {
                "role": "primary",
                "priority": 0,
                "slug": "lms-gemma",
                "sourceUri": "gemma-4-e2b-it-qat",
                "provider": "lm-studio",
                "format": "GGUF",
                "tenantId": _TENANT,
            }
        ],
        "textFallback": {"autoSwitch": False, "chain": []},
    }


class _StubApi:
    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return _wire()

    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"phiEnabled": False, "phiFailClosed": True}


class _Result:
    content = json.dumps(_FINALIZER_OUTPUT)
    provider = "lm-studio"
    model = "gemma-4-e2b-it-qat"
    usage = {"prompt_tokens": 400, "completion_tokens": 120}
    stats = {"provider": "lm-studio", "model": "gemma-4-e2b-it-qat"}


class _StubText:
    async def generate(self, **_kwargs: Any) -> _Result:
        return _Result()


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch):
    persisted: list[Any] = []
    failure: list[Exception] = []

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def _persist_draft(payload: Any) -> Any:
        if failure:
            raise failure[0]
        persisted.append(payload)
        return type("DraftResponse", (), {"context_item_id": "ctx-1"})()

    monkeypatch.setattr(core, "record_and_flush", _noop)
    monkeypatch.setattr(core, "record_generation_and_flush", _noop)
    monkeypatch.setattr(core, "_phi_redactor", lambda: None)
    monkeypatch.setattr(core, "_text_client", lambda _settings: _StubText())
    monkeypatch.setattr(core, "_api_client", lambda _settings: _StubApi())
    # `_persist_finalized_note` imports these lazily (the same circular-import dance
    # `_run_transcription` does), so the module attribute is what has to be patched.
    from harness.temporal import activities as legacy_activities

    monkeypatch.setattr(legacy_activities, "persist_draft", _persist_draft)

    async def _go(
        *,
        cadence: str | None = "onEnd",
        consultation: bool = True,
        sandbox: bool = False,
        run_context: dict[str, Any] | None = None,
        persist_error: Exception | None = None,
    ):
        failure.clear()
        if persist_error is not None:
            failure.append(persist_error)
        execution: dict[str, Any] = {"lane": "durable"}
        if cadence is not None:
            execution["cadence"] = cadence
        result = await core.interpreter_core_agent(
            NodeActivityInput(
                node_id="n_finalize",
                node_type="core.agent",
                config={"agentRef": {"slug": "casenote-finalization"}, "execution": execution},
                tenant_id=_TENANT,
                sandbox=sandbox,
                bound_inputs={"in": "S: cough\nO: afebrile"},
                run_payload=(
                    {"consultationId": _CONSULTATION, "userId": "doctor-1"} if consultation else {}
                ),
                run_context=run_context
                or {
                    "trigger": {
                        "consultationId": _CONSULTATION,
                        "dna_style_text": "Terse.",
                        "dna_style_id": "dna-report-1",
                    },
                    "vars": {},
                    "nodes": {},
                },
                run_id=_RUN,
            )
        )
        return persisted, result

    return _go


class TestTheFinalizedNoteIsPersisted:
    @pytest.mark.asyncio
    async def test_an_onEnd_agent_in_a_consultation_run_writes_the_case_note(self, run) -> None:
        persisted, result = await run()

        assert result.status == "SUCCEEDED"
        assert len(persisted) == 1
        draft = persisted[0]
        assert draft.consultation_id == _CONSULTATION
        assert draft.tenant_id == _TENANT
        assert draft.user_id == "doctor-1"
        # The declared `case_note`, NOT the raw JSON document the model returned. Persisting the
        # latter would put a serialized object in front of a clinician.
        assert draft.content == _CASE_NOTE
        assert draft.is_auto_generated is True

    @pytest.mark.asyncio
    async def test_it_carries_the_model_and_agent_version_provenance(self, run) -> None:
        persisted, _result = await run()

        assert persisted[0].model_name == "gemma-4-e2b-it-qat"
        assert persisted[0].prompt_version == "3"

    @pytest.mark.asyncio
    async def test_the_dna_style_id_comes_from_the_handoff_context(self, run) -> None:
        """`SummaryMeta.dnaWritingStyleId` must name the report that actually shaped the note.

        Resolved by the gateway at the live handoff under the tenant AND doctor gate, published
        onto the run's `trigger` context, read here — never authored on the node.
        """
        persisted, _result = await run()

        assert persisted[0].dna_style_id == "dna-report-1"

    @pytest.mark.asyncio
    async def test_no_style_on_the_context_means_no_style_recorded(self, run) -> None:
        persisted, _result = await run(
            run_context={"trigger": {"consultationId": _CONSULTATION}, "vars": {}, "nodes": {}}
        )

        assert persisted[0].dna_style_id is None


class TestTheRedactionAudit:
    @pytest.mark.asyncio
    async def test_the_marker_says_a_redaction_ran_and_changed_the_note(self, run) -> None:
        persisted, _result = await run()

        assert persisted[0].redaction_applied is True

    @pytest.mark.asyncio
    async def test_the_manifest_carries_labels_and_counts_and_NEVER_the_removed_identifiers(
        self, run
    ) -> None:
        """The rule `SummaryMeta.redactionManifest` is documented by: rule ids, actions, spans and
        counts — never removed PHI plaintext. A finalizer reports `{text, label}` where `text` IS
        the identifier it replaced, so copying the list through would move patient names into a
        second column for no diagnostic gain."""
        persisted, _result = await run()

        manifest = persisted[0].redaction_manifest
        assert manifest == {
            "source": "core.agent",
            "labelCounts": {"NAME": 2, "PHONE": 1},
            "total": 3,
        }
        serialized = json.dumps(manifest)
        for identifier in ("Jane Doe", "John Smith", "07700 900461"):
            assert identifier not in serialized


class TestWhoDoesNotPersist:
    @pytest.mark.asyncio
    async def test_an_exposure_plane_run_persists_nothing(self, run) -> None:
        """No consultation ⇒ no clinical record to write to. The note is still returned and still
        reaches the graph's `core.output`."""
        persisted, result = await run(consultation=False)

        assert result.status == "SUCCEEDED"
        assert persisted == []

    @pytest.mark.asyncio
    async def test_a_sandbox_run_persists_nothing(self, run) -> None:
        """`core.agent` is `external_write=False` on the TYPE — an LLM agent must be runnable in a
        Workbench — so the suppression is made here, exactly as `_run_speech` makes it for a TTS
        artifact."""
        persisted, result = await run(sandbox=True)

        assert result.status == "SUCCEEDED"
        assert persisted == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize("cadence", ["perTurn", "onStart", "once", None])
    async def test_every_other_cadence_persists_nothing(self, run, cadence) -> None:
        """Only `onEnd` means "this is the consultation's note". `perTurn` is the live lane's
        running note (already persisted as `LIVE_SOAP_SNAPSHOT`), `onStart` is the warm start,
        `once` and an unauthored cadence are plain one-shot generations."""
        persisted, result = await run(cadence=cadence)

        assert result.status == "SUCCEEDED"
        assert persisted == []


class TestWhenThePersistFails:
    @pytest.mark.asyncio
    async def test_it_degrades_with_a_named_reason_and_keeps_the_output(self, run) -> None:
        """Never a raise: raising is what makes Temporal re-run this activity FROM THE PRIMARY,
        re-billing a generation that already completed. The note still reaches the review gate and
        the output node."""
        persisted, result = await run(persist_error=ApiServiceError("apps/api answered 503"))

        assert persisted == []
        assert result.status == "DEGRADED"
        assert "the finalized note was not persisted" in (result.reason or "")
        assert result.output is not None
        assert result.output["data"]["case_note"] == _CASE_NOTE


class TestTheDeterministicRedaction:
    """The manifest is a claim about a TRANSFORM, so a transform has to have run.

    `_redaction_audit` reports what the FINALIZER SAID it redacted. That is the model's own
    account of its own output — useful provenance, but it is not evidence, and
    `SummaryMeta.redactionApplied` read `false` on every interpreter-persisted note because no
    deterministic pass existed on this lane at all.

    The legacy `HarnessDocWorkflow` has always run the real thing: `apply_redaction` over the
    doctor's DNA rules, before persist, with a fail-closed posture. `persist_draft` is already
    called activity-to-activity from here, so the same transform runs the same way — one
    activity, no new workflow command, no patch era.

    OD-6 governs the failure: a note the doctor expected redacted must never persist silently
    as a clean draft, and an undocumented encounter is the worse clinical outcome — so it
    persists WITH the forced review flag the legacy gate uses (`gate_decision = FLAG`) and a
    named degraded reason on the manifest.
    """

    @staticmethod
    def _context(rules: Any) -> dict[str, Any]:
        return {
            "trigger": {
                "consultationId": _CONSULTATION,
                "dna_style_id": "dna-report-1",
                "dna_redaction_rules": rules,
            },
            "vars": {},
            "nodes": {},
        }

    @pytest.mark.asyncio
    async def test_configured_rules_run_the_deterministic_engine_before_persist(self, run) -> None:
        """The manifest names the RULE that fired — not a label the model volunteered."""
        persisted, result = await run(
            run_context=self._context(
                [{"id": "r-afebrile", "type": "remove", "match": "literal", "pattern": "Afebrile"}]
            )
        )

        assert result.status == "SUCCEEDED"
        draft = persisted[0]
        assert draft.redaction_applied is True
        assert draft.redaction_manifest["hitsByRule"] == {"r-afebrile": 1}
        assert draft.redaction_manifest["ruleIds"] == ["r-afebrile"]
        assert draft.redaction_manifest["totalHits"] == 1
        assert draft.redaction_manifest["failedClosed"] is False

    @pytest.mark.asyncio
    async def test_the_persisted_note_is_the_redacted_text(self, run) -> None:
        """The whole point: the clinical record must hold the TRANSFORMED note, not the one the
        transform was computed against."""
        persisted, _result = await run(
            run_context=self._context(
                [
                    {
                        "id": "r-urti",
                        "type": "rewrite",
                        "match": "literal",
                        "pattern": "URTI",
                        "replacement": "upper respiratory tract infection",
                    }
                ]
            )
        )

        assert "URTI" not in persisted[0].content
        assert "upper respiratory tract infection" in persisted[0].content

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "rules", [None, [], {"rules": []}], ids=["absent", "empty", "empty-set"]
    )
    async def test_no_rules_configured_falls_back_to_the_self_reported_audit(
        self, run, rules
    ) -> None:
        """Absence is not a failure. With no rules the doctor configured nothing to enforce, so
        the finalizer's own account stays the provenance — exactly today's behaviour."""
        persisted, result = await run(run_context=self._context(rules))

        assert result.status == "SUCCEEDED"
        assert persisted[0].redaction_manifest == {
            "source": "core.agent",
            "labelCounts": {"NAME": 2, "PHONE": 1},
            "total": 3,
        }
        assert persisted[0].gate_decision is None

    @pytest.mark.asyncio
    async def test_a_fail_closed_redaction_persists_with_the_forced_review_flag(
        self, run, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """OD-6. The note is KEPT — dropping it loses the encounter — but it is flagged with the
        same mechanism the legacy gate uses, so no clinician sees it as a clean draft."""
        from harness.temporal import activities as legacy_activities
        from harness.temporal.models import ApplyRedactionResult

        async def _fails_closed(payload: Any) -> Any:
            return ApplyRedactionResult(text=payload.note_text, changed=False, failed_closed=True)

        monkeypatch.setattr(legacy_activities, "apply_redaction", _fails_closed)

        persisted, result = await run(
            run_context=self._context(
                [{"id": "r-name", "type": "remove", "match": "category", "pattern": "email"}]
            )
        )

        assert result.status == "SUCCEEDED"
        draft = persisted[0]
        assert draft.content == _CASE_NOTE  # never dropped
        assert draft.gate_decision == "FLAG"
        assert draft.redaction_applied is False
        assert draft.redaction_manifest["failedClosed"] is True
        assert draft.redaction_manifest["reason"]

    @pytest.mark.asyncio
    async def test_an_unusable_rule_set_also_fails_closed(self, run) -> None:
        """Rules the doctor configured but this lane cannot parse are the same clinical situation
        as an engine that could not run: something was meant to be removed and was not."""
        persisted, result = await run(run_context=self._context(["remove the employer"]))

        assert result.status == "SUCCEEDED"
        assert persisted[0].content == _CASE_NOTE
        assert persisted[0].gate_decision == "FLAG"
        assert persisted[0].redaction_manifest["failedClosed"] is True

    @pytest.mark.asyncio
    async def test_a_redaction_crash_persists_the_note_rather_than_losing_it(
        self, run, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An unexpected exception is still OD-6: keep the note, flag it, name the reason."""
        from harness.temporal import activities as legacy_activities

        async def _boom(_payload: Any) -> Any:
            raise RuntimeError("PHI redactor unavailable")

        monkeypatch.setattr(legacy_activities, "apply_redaction", _boom)

        persisted, result = await run(
            run_context=self._context(
                [{"id": "r-x", "type": "remove", "match": "literal", "pattern": "Cough"}]
            )
        )

        assert result.status == "SUCCEEDED"
        assert persisted[0].content == _CASE_NOTE
        assert persisted[0].gate_decision == "FLAG"
        assert "PHI redactor unavailable" in persisted[0].redaction_manifest["reason"]


class TestTheHandoffRuleContract:
    """The cross-language shape of `dna_redaction_rules`, pinned on the consumer side.

    The gateway publishes it from `LiveDocumentationService.readHandoffRedactionRules`, which
    normalises the doctor's decrypted report through `validateRedactionRuleSet` and emits a BARE
    LIST of rule OBJECTS — `{ id, type, match, pattern, replacement?, note? }` — omitting the key
    entirely rather than sending `[]` when the doctor configured none.

    `RedactionRule` is `extra="forbid"`, so this contract is exact on both ends: a key the
    gateway adds and this model does not declare is a hard parse failure, which under OD-6 would
    FLAG every finalized note rather than fail visibly at the boundary. Pinning the full shape
    here is what turns that into a test failure instead.
    """

    @pytest.mark.asyncio
    async def test_the_full_gateway_rule_shape_parses_and_runs(self, run) -> None:
        persisted, result = await run(
            run_context={
                "trigger": {
                    "consultationId": _CONSULTATION,
                    "dna_style_id": "dna-report-1",
                    "dna_redaction_rules": [
                        # every optional the gateway's normaliser can emit
                        {
                            "id": "r-full",
                            "type": "rewrite",
                            "match": "literal",
                            "pattern": "URTI",
                            "replacement": "upper respiratory tract infection",
                            "note": "spell it out for the patient copy",
                        },
                        # and the minimal form it emits when both optionals are absent
                        {
                            "id": "r-min",
                            "type": "remove",
                            "match": "literal",
                            "pattern": "Afebrile",
                        },
                    ],
                },
                "vars": {},
                "nodes": {},
            }
        )

        assert result.status == "SUCCEEDED"
        draft = persisted[0]
        # Parsed AND applied — not merely accepted.
        assert draft.gate_decision is None, "a well-formed gateway rule set must not fail closed"
        assert draft.redaction_manifest["failedClosed"] is False
        assert sorted(draft.redaction_manifest["ruleIds"]) == ["r-full", "r-min"]
        assert "URTI" not in draft.content
        assert "Afebrile" not in draft.content

    def test_the_rule_vocabulary_matches_the_gateway_validator(self) -> None:
        """`RULE_TYPES` / `MATCH_KINDS` in `redaction-rules.ts` are the same two closed sets."""
        from typing import get_args

        from harness.redaction.engine import MatchKind, RuleType

        assert set(get_args(RuleType)) == {"remove", "rewrite"}
        assert set(get_args(MatchKind)) == {"literal", "regex", "category"}
