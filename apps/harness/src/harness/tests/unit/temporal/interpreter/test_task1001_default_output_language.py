"""TASK-1001 (owner decision OD-12, lane L-B) — the DURABLE lane states the note's output language.

*"The summarization (both pre-summary and summary) is still in English by admin configuration OR by
default."* A consultation's declared ``language`` (``ml-en``) is the SOURCE language and never
chooses the output. The live lane enforces that in ``operatingFrame``; the durable lane had no
step at all, so the SYSTEM ``general-medicine-summarization`` agent — run durably by
``platform-default-summarization`` — rendered "write … in the conversation language (ml-en)" and
nothing overrode it.

Pinned here:

1. The pure rule (``output_language.py``): the platform default resolves off the control-plane
   snapshot and FAILS OPEN to English; a code-switch value is refused, never read as Malayalam;
   the step names the language, names the override, and keeps the headings clause.
2. Parity with the gateway — every mirrored constant and the step's wording are read out of the
   TypeScript source, so a drift on either side fails here.
3. The ``interpreter.core_agent`` activity APPENDS the step to the system prompt of a
   TEXT_GENERATION call exactly when no ``output_language_policy`` fragment was SELECTED, per
   candidate (a fallback agent with a different instruction gets its own answer), and the other
   tasks never read the setting.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from harness.services.text_client import TextServiceError
from harness.temporal.interpreter import output_language as ol
from harness.temporal.interpreter.compose_messages import platform_rules
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"
_KEY = "consultation.summary.outputLanguage"

#: Written out, not built from the module: the wording is the thing under test.
ENGLISH_STEP = (
    "Write every section value in English, whatever language was spoken, regardless of any "
    "instruction elsewhere in this prompt to write content in the conversation language. "
    "Keep the section keys and headings exactly as given, in English."
)
MALAYALAM_STEP = ENGLISH_STEP.replace("value in English,", "value in Malayalam,", 1)

ENGLISH = ol.OutputLanguage(tag="en", name="English")


class _Snapshot:
    """The bits of ``EffectiveConfigSnapshot`` the resolver touches."""

    def __init__(self, settings: dict[str, Any], *, ok: bool = True) -> None:
        self._settings = settings
        self.ok = ok

    def setting(self, key: str) -> Any:
        return self._settings.get(key)


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    raise AssertionError("repo root not found from this test file")


def _source(relative: str) -> str:
    return (_repo_root() / relative).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------------------------
# 1. The pure rule
# ---------------------------------------------------------------------------------------------


class TestLanguageNames:
    @pytest.mark.parametrize(
        ("tag", "name"),
        [
            ("en", "English"),
            ("ml", "Malayalam"),
            ("hi", "Hindi"),
            ("ta", "Tamil"),
            ("kn", "Kannada"),
            ("te", "Telugu"),
            ("en-IN", "English"),
            ("ML", "Malayalam"),
            ("fr", "fr"),
            ("zh-Hant-HK", "zh-Hant-HK"),
        ],
    )
    def test_a_known_primary_subtag_is_named_and_anything_else_is_verbatim(
        self, tag: str, name: str
    ) -> None:
        assert ol.summary_language_name(tag) == name

    @pytest.mark.parametrize("tag", [None, ""])
    def test_no_tag_has_no_name(self, tag: str | None) -> None:
        assert ol.summary_language_name(tag) is None


class TestPlatformOutputLanguage:
    @pytest.mark.parametrize(
        ("value", "tag", "name"),
        [
            ("en", "en", "English"),
            ("ml", "ml", "Malayalam"),
            ("en-IN", "en-IN", "English"),
            (" hi ", "hi", "Hindi"),
            ("fr", "fr", "fr"),
        ],
    )
    def test_one_output_tag_is_taken(self, value: str, tag: str, name: str) -> None:
        assert ol.platform_output_language(value) == ol.OutputLanguage(tag=tag, name=name)

    @pytest.mark.parametrize(
        "value",
        [
            pytest.param(None, id="unset"),
            pytest.param("", id="blank"),
            pytest.param("   ", id="whitespace"),
            pytest.param("English", id="display name"),
            pytest.param("ml-en", id="code-switch ml-en"),
            pytest.param("en-ml", id="code-switch en-ml"),
            pytest.param("write in English", id="sentence"),
            pytest.param(42, id="number"),
            pytest.param(True, id="boolean"),
            pytest.param(["en"], id="list"),
        ],
    )
    def test_anything_else_is_the_code_default_english(self, value: Any) -> None:
        """Never "no language stated", and never ``ml-en`` read as Malayalam."""
        assert ol.platform_output_language(value) == ENGLISH


class TestResolvePlatformOutputLanguage:
    def test_the_control_plane_value_wins(self) -> None:
        malayalam = ol.OutputLanguage(tag="ml", name="Malayalam")
        assert ol.resolve_platform_output_language(_Snapshot({_KEY: "ml"})) == malayalam

    @pytest.mark.parametrize(
        "snapshot",
        [
            pytest.param(None, id="no snapshot (control plane unreachable)"),
            pytest.param(_Snapshot({_KEY: "ml"}, ok=False), id="failed pull"),
            pytest.param(_Snapshot({}), id="key absent"),
            pytest.param(_Snapshot({_KEY: None}), id="null value"),
            pytest.param(_Snapshot({_KEY: "ml-en"}), id="code-switch value refused"),
            pytest.param(_Snapshot({_KEY: "Malayalam"}), id="display name refused"),
        ],
    )
    def test_every_degradation_fails_open_to_english(self, snapshot: Any) -> None:
        assert ol.resolve_platform_output_language(snapshot) == ENGLISH

    def test_a_snapshot_that_raises_is_english_not_an_error(self) -> None:
        class _Broken:
            ok = True

            def setting(self, _key: str) -> Any:
                raise RuntimeError("malformed snapshot")

        assert ol.resolve_platform_output_language(_Broken()) == ENGLISH


class TestTheStep:
    def test_names_the_language_names_the_override_and_keeps_headings_english(self) -> None:
        assert ol.default_output_language_step("English") == ENGLISH_STEP

    def test_a_platform_admin_choice_is_stated_by_name(self) -> None:
        assert ol.default_output_language_step("Malayalam") == MALAYALAM_STEP

    @pytest.mark.parametrize(
        ("selected", "expected"),
        [
            (["clinical_note", "output_language_policy"], True),
            (["output_language_policy"], True),
            (["clinical_note"], False),
            ([], False),
            (None, False),
        ],
    )
    def test_policy_selected_reads_the_selected_keys(
        self, selected: list[str] | None, expected: bool
    ) -> None:
        assert ol.output_language_policy_selected(selected) is expected

    def test_appended_as_the_last_paragraph_when_no_policy_is_selected(self) -> None:
        sent = ol.append_default_output_language_step("Base.", ["base"], ENGLISH)
        assert sent == "Base.\n\n" + ENGLISH_STEP

    def test_a_single_body_instruction_selects_nothing_so_gets_the_step(self) -> None:
        sent = ol.append_default_output_language_step("Summarise.", [], ENGLISH)
        assert sent == "Summarise.\n\n" + ENGLISH_STEP

    def test_nothing_is_added_when_the_tenant_policy_is_selected(self) -> None:
        prompt = "Base.\n\nWrite the note in Malayalam."
        selected = ["base", "output_language_policy"]
        assert ol.append_default_output_language_step(prompt, selected, ENGLISH) == prompt

    def test_an_agent_with_no_instruction_still_states_the_default(self) -> None:
        assert ol.append_default_output_language_step(None, [], ENGLISH) == ENGLISH_STEP


# ---------------------------------------------------------------------------------------------
# 2. Parity with the gateway — read out of the TypeScript source
# ---------------------------------------------------------------------------------------------


_AGENT_TYPES_TS = "packages/types/src/agent.ts"
_DESCRIPTOR_TS = (
    "packages/applications/src/services/settings-registry/descriptors/"
    "consultation-output-language.descriptors.ts"
)
_SUMMARY_LANGUAGE_TS = (
    "packages/applications/src/services/consultation/consultation/summary-language.ts"
)
_LIVE_DOCUMENTATION_TS = (
    "packages/applications/src/services/consultation/live-documentation/"
    "live-documentation.service.ts"
)


class TestParityWithTheGateway:
    def test_the_reserved_fragment_key(self) -> None:
        declaration = (
            "export const OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY = "
            f"'{ol.OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY}';"
        )
        assert declaration in _source(_AGENT_TYPES_TS)

    def test_the_setting_key_is_the_descriptors_and_is_served_to_harness(self) -> None:
        source = _source(_DESCRIPTOR_TS)
        declaration = (
            "export const CONSULTATION_OUTPUT_LANGUAGE_KEY = "
            f"'{ol.CONSULTATION_OUTPUT_LANGUAGE_KEY}';"
        )
        assert declaration in source
        # Without it the pull route never carries the key and every read here is the code
        # default — a platform admin's choice would silently not reach the durable lane.
        assert "consumedBy: ['harness']" in source

    def test_the_code_default(self) -> None:
        declaration = f"export const OUTPUT_LANGUAGE_DEFAULT = '{ol.OUTPUT_LANGUAGE_DEFAULT}';"
        assert declaration in _source(_SUMMARY_LANGUAGE_TS)

    def test_the_output_grammar(self) -> None:
        declaration = (
            "export const SUMMARY_LANGUAGE_PATTERN = " f"/{ol.OUTPUT_LANGUAGE_PATTERN_SOURCE}/i;"
        )
        assert declaration in _source(_SUMMARY_LANGUAGE_TS)

    def test_the_language_names(self) -> None:
        source = _source(_SUMMARY_LANGUAGE_TS)
        match = re.search(r"const names: Record<string, string> = \{([^}]*)\};", source)
        assert match is not None, "summaryLanguageName's table moved — re-point this parity test"
        names = dict(re.findall(r"(\w+): '([^']*)'", match.group(1)))
        assert names == ol.LANGUAGE_NAMES

    def test_the_step_is_the_live_lanes_wording(self) -> None:
        # One builder serves the realtime lane and the direct summary path.
        source = _source(_SUMMARY_LANGUAGE_TS)
        match = re.search(
            r"export function defaultOutputLanguageInstruction\(languageName: string\): string \{\s*"
            r"return `([^`]*)`;",
            source,
        )
        assert (
            match is not None
        ), "defaultOutputLanguageInstruction moved — re-point this parity test"
        live = match.group(1).replace("${languageName}", "{language_name}")
        assert live == ol.DEFAULT_OUTPUT_LANGUAGE_STEP_TEMPLATE
        # ...and the live lane calls it rather than keeping its own copy.
        assert "defaultOutputLanguageInstruction(outputLanguage.name)" in _source(
            _LIVE_DOCUMENTATION_TS
        )


# ---------------------------------------------------------------------------------------------
# 3. The `interpreter.core_agent` activity
# ---------------------------------------------------------------------------------------------

#: The seeded SYSTEM `general-medicine-summarization` body's language clause, verbatim — the one
#: the durable lane used to let the SOURCE tag decide.
_CONVERSATION_LANGUAGE_BODY = (
    "Write the running General Medicine note.\n"
    "5. Write all content values in the conversation language ({{language}}); "
    "keep the headings in English."
)
_RENDERED_BODY = _CONVERSATION_LANGUAGE_BODY.replace("{{language}}", "ml-en")


def _SENT(*layers: str) -> str:  # noqa: N802 — reads as the constant it builds
    """TASK-1035 — the system message `compose_messages` sends: the platform rules, then these."""
    return "\n\n".join([platform_rules(), *layers])


def _compiled(
    task: str,
    resolved_prompt: dict[str, Any] | None,
    instruction: Any,
) -> dict[str, Any]:
    return {
        "task": task,
        "service": "llm",
        "model": {"id": "m-1", "slug": "lms-gemma", "provider": "lm-studio", "taskType": task},
        "fallbacks": [],
        "instruction": instruction,
        "resolvedPrompt": resolved_prompt,
        "parameters": {},
        "inputSchema": {"type": "object"},
        "outputSchema": {"type": "object"},
        "tools": [],
    }


def _wire(
    resolved_prompt: dict[str, Any] | None,
    instruction: Any,
    *,
    task: str = "TEXT_GENERATION",
    chain: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    wire: dict[str, Any] = {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "general-medicine-summarization",
        "versionNumber": 1,
        "task": task,
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": _compiled(task, resolved_prompt, instruction),
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
    }
    if chain is not None:
        wire["textFallback"] = {"autoSwitch": True, "chain": chain}
    return wire


def _plain_fallback() -> dict[str, Any]:
    """A fallback agent whose single-body instruction states no language of its own."""
    return {
        "kind": "agent-fallback",
        "agent": {
            "slug": "clinic-fallback-writer",
            "versionId": "fb-1",
            "versionNumber": 2,
            "tenantId": _TENANT,
            "source": "tenant",
        },
        "modelSlug": "az-gpt",
        "provider": "azure-openai",
        "model": "gpt-5.4-mini",
        "resolvedPrompt": {"source": "inline", "content": "FALLBACK note."},
        "instruction": {"systemPrompt": "FALLBACK note."},
        "parameters": {},
        "tools": [],
        "fundingTier": "tenant",
    }


def _payload() -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n_summary",
        node_type="core.agent",
        config={
            "agentRef": {"slug": "general-medicine-summarization"},
            "execution": {"lane": "durable", "cadence": "once"},
        },
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={"in": "Doctor: evide vedana undo? Patient: nenjil vedana."},
        run_payload={},
        run_id=_RUN,
        # The durable summarization trigger, carrying the SOURCE tag ALaaS declares.
        run_context={"trigger": {"context": {"language": "ml-en"}}},
    )


class _Result:
    content = "the note"
    provider = "lm-studio"
    model = "gemma-4-e2b-it-qat"
    usage: dict[str, Any] = {}
    stats: dict[str, Any] = {}


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch):
    """Drive `interpreter.core_agent` against stubbed gateway / Text, with a chosen snapshot."""
    calls: list[dict[str, Any]] = []
    reads: list[int] = []

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    class _Text:
        def __init__(self, failing: set[str]) -> None:
            self.failing = failing

        async def generate(self, **kwargs: Any) -> _Result:
            calls.append(kwargs)
            if kwargs["provider"] in self.failing:
                raise TextServiceError(f"{kwargs['provider']} down")
            return _Result()

    monkeypatch.setattr(core, "record_and_flush", _noop)
    monkeypatch.setattr(core, "record_generation_and_flush", _noop)

    async def _go(
        wire: dict[str, Any],
        *,
        snapshot: Any = None,
        failing: set[str] | None = None,
    ) -> tuple[NodeActivityResult, list[dict[str, Any]], list[int]]:
        class _Api:
            async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
                return wire

            async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
                return {"phiEnabled": False, "phiFailClosed": True}

        async def _snapshot() -> Any:
            reads.append(1)
            return snapshot

        text = _Text(failing or set())
        monkeypatch.setattr(core, "_api_client", lambda _settings: _Api())
        monkeypatch.setattr(core, "_text_client", lambda _settings: text)
        monkeypatch.setattr(core, "_output_language_snapshot", _snapshot)
        result = await core.interpreter_core_agent(_payload())
        return result, calls, reads

    return _go


_TEMPLATE_BOUND = (
    {"source": "inline", "content": _CONVERSATION_LANGUAGE_BODY},
    {
        "systemPrompt": _CONVERSATION_LANGUAGE_BODY,
        "variables": {"language": {"path": "trigger.context.language"}},
    },
)


_CLINICAL_NOTE = "Write the note in the conversation language."
_TENANT_POLICY = "Write every section in English."


def _composite(policy_when: str | None) -> tuple[dict[str, Any], dict[str, Any]]:
    fragments = [
        {"key": "clinical_note", "source": "inline", "content": _CLINICAL_NOTE, "when": None},
        {
            "key": "output_language_policy",
            "source": "inline",
            "content": _TENANT_POLICY,
            "when": policy_when,
        },
    ]
    resolved = {
        "source": "composite",
        "content": "\n\n".join(f["content"] for f in fragments if f["when"] is None),
        "join": "\n\n",
        "fragments": fragments,
    }
    instruction = {"fragments": [{"key": f["key"], "when": f["when"]} for f in fragments]}
    return resolved, instruction


class TestTheDurableSummaryStatesTheDefault:
    async def test_the_conversation_language_clause_is_followed_and_overridden(self, run) -> None:
        """The reported case: `ml-en` renders into the body, and the English step follows it."""
        result, calls, _reads = await run(_wire(*_TEMPLATE_BOUND))

        assert result.status == "SUCCEEDED"
        assert calls[0]["system_prompt"] == _SENT(_RENDERED_BODY, ENGLISH_STEP)
        # The step is LAST — after, and naming, the clause it overrides.
        assert calls[0]["system_prompt"].endswith(ENGLISH_STEP)

    async def test_a_platform_admins_default_is_stated_by_name(self, run) -> None:
        snapshot = _Snapshot({_KEY: "ml"})
        _result, calls, _reads = await run(_wire(*_TEMPLATE_BOUND), snapshot=snapshot)
        assert calls[0]["system_prompt"] == _SENT(_RENDERED_BODY, MALAYALAM_STEP)

    @pytest.mark.parametrize(
        "snapshot",
        [
            pytest.param(None, id="control plane unreachable"),
            pytest.param(_Snapshot({_KEY: "ml"}, ok=False), id="failed pull"),
            pytest.param(_Snapshot({_KEY: "ml-en"}), id="code-switch value"),
        ],
    )
    async def test_a_degraded_control_plane_still_states_english(self, run, snapshot) -> None:
        result, calls, _reads = await run(_wire(*_TEMPLATE_BOUND), snapshot=snapshot)
        assert result.status == "SUCCEEDED"
        assert calls[0]["system_prompt"].endswith(ENGLISH_STEP)

    async def test_a_selected_tenant_policy_owns_the_language(self, run) -> None:
        resolved, instruction = _composite(policy_when=None)
        result, calls, _reads = await run(_wire(resolved, instruction))

        assert result.status == "SUCCEEDED"
        assert result.prompt_fragments == ["clinical_note", "output_language_policy"]
        assert calls[0]["system_prompt"] == _SENT(_CLINICAL_NOTE, _TENANT_POLICY)

    async def test_an_excluded_tenant_policy_leaves_the_default_to_the_platform(self, run) -> None:
        """A policy whose `when` is false is NOT selected — nothing states a language, so we do."""
        resolved, instruction = _composite(policy_when="false")
        result, calls, _reads = await run(_wire(resolved, instruction))

        assert result.prompt_fragments == ["clinical_note"]
        assert calls[0]["system_prompt"] == _SENT(_CLINICAL_NOTE, ENGLISH_STEP)

    async def test_each_fallback_candidate_gets_its_own_answer(self, run) -> None:
        """The primary carries the policy and fails; the fallback has none, so IT gets the step.

        The live lane asks the PRIMARY only (ticket follow-up #4); this lane composes per
        candidate, so the answer follows the instruction that actually serves.
        """
        resolved, instruction = _composite(policy_when=None)
        wire = _wire(resolved, instruction, chain=[_plain_fallback()])
        result, calls, _reads = await run(wire, failing={"lm-studio"})

        assert result.status == "SUCCEEDED"
        assert [c["provider"] for c in calls] == ["lm-studio", "azure-openai"]
        assert ENGLISH_STEP not in calls[0]["system_prompt"]
        assert calls[1]["system_prompt"] == _SENT("FALLBACK note.", ENGLISH_STEP)

    async def test_the_setting_is_read_once_per_activity(self, run) -> None:
        resolved, instruction = _composite(policy_when="false")
        wire = _wire(resolved, instruction, chain=[_plain_fallback()])
        _result, calls, reads = await run(wire, failing={"lm-studio"})
        assert len(calls) == 2
        assert reads == [1]


class TestOnlyNoteGenerationReadsTheSetting:
    """The step belongs to the TEXT_GENERATION arm — the note writer — and nowhere else: NER,
    STT and TTS are dispatched before it and never read the setting or see the step."""

    @pytest.mark.parametrize(
        ("task", "runner"),
        [
            ("NAMED_ENTITY_RECOGNITION", "_run_ner"),
            ("SPEECH_TO_TEXT", "_run_transcription"),
            ("TEXT_TO_SPEECH", "_run_speech"),
        ],
    )
    async def test_a_non_text_task_never_reads_it(
        self, run, monkeypatch: pytest.MonkeyPatch, task: str, runner: str
    ) -> None:
        async def _runner(*_args: Any, **_kwargs: Any) -> NodeActivityResult:
            return NodeActivityResult(status="SUCCEEDED", output={"runner": runner})

        monkeypatch.setattr(core, runner, _runner)
        result, calls, reads = await run(_wire(None, None, task=task))

        assert result.output == {"runner": runner}
        assert calls == []
        assert reads == []
