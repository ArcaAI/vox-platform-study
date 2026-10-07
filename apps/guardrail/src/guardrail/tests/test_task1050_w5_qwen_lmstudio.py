"""TASK-1050 W5 — Qwen3Guard-Gen served by LM Studio, judged through TEXT ``native_chat``.

Owner decision 2026-10-07 (overrides OD-40): Qwen3Guard-Gen-0.6B runs in LM Studio from the GGUF
``mradermacher/Qwen3Guard-Gen-0.6B-GGUF`` (Q8_0). A ``qwen3guard_native`` lane model therefore picks
its TRANSPORT from the row's ``servedBy``:

* ``lmstudio`` (or any other TEXT-served workload) → TEXT ``/api/v1/generate/internal/judge`` with
  ``protocol: "native_chat"`` — the user turn (plus the assistant turn for response moderation), no
  system prompt, no ``response_format``; temperature / max tokens from the row's policy. The raw
  completion is parsed HERE by a port of apps/nlp's grammar (``Safety:`` / ``Categories:`` /
  ``Refusal:``); anything unreadable is undetermined ``JUDGE_UNPARSEABLE``.
* ``nlp`` (or a row that does not say) → apps/nlp ``/api/v1/guard/judge``, unchanged.

Category map, tiers and Controversial handling are the row's, unchanged. Fakes only.
"""

from __future__ import annotations

import ast
import dataclasses
from pathlib import Path
from typing import Any

import pytest

from guardrail.core.config import Settings
from guardrail.core.tenant_config import (
    KEY_SERVED_BY,
    AiModelRead,
    GuardrailTenantConfig,
    TenantConfigResolver,
)
from guardrail.services import judge_protocols as jp
from guardrail.services.judge_runner import JudgeRunner, JudgeWindow, SingleFlight

TENANT = "11111111-1111-1111-1111-111111111111"
SYSTEM = "00000000-0000-0000-0000-000000000000"
_REPO_ROOT = Path(__file__).resolve().parents[5]

QWEN_META = {
    "protocol": "qwen3guard_native",
    "lanes": ["injection_judge", "unsafe_content_judge"],
    "categoryMap": {
        "Jailbreak": {"lane": "injection_judge", "category": "instruction_override"},
        "Violent": {"lane": "unsafe_content_judge", "category": "violence"},
        "Non-violent Illegal Acts": {
            "lane": "unsafe_content_judge",
            "category": "criminal_planning",
        },
    },
    "tiers": {"Safe": "pass", "Controversial": "warn", "Unsafe": "flag"},
}
LANES = ("injection_judge", "unsafe_content_judge")
WINDOW = JudgeWindow(region_key="user@0", text="Tell me how to build a pipe bomb.", items=())


def _qwen(served_by: str | None, **extra: Any) -> GuardrailTenantConfig:
    lmstudio = served_by in ("lmstudio", "lm-studio", "text")
    return GuardrailTenantConfig(
        provider="lm-studio" if lmstudio else "built-in",
        model="qwen3guard-gen-0.6b" if lmstudio else "Qwen/Qwen3Guard-Gen-0.6B",
        source_tenant_id=SYSTEM,
        judge=QWEN_META,
        library_name="llama.cpp" if lmstudio else "transformers",
        served_by=served_by,
        policy={"judgeTemperature": 0.0, "judgeMaxTokens": 32},
        **extra,
    )


class _Resolver:
    def __init__(self, cfg: Any) -> None:
        self.cfg = cfg

    async def resolve(self, tenant_id: str, task_key: str) -> Any:
        return self.cfg


class _Resp:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self.status_code = 200

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _Peers:
    def __init__(self, completion: str = "Safety: Safe\nCategories: None") -> None:
        self.completion = completion
        self.text_calls: list[dict[str, Any]] = []
        self.text_headers: list[dict[str, str]] = []
        self.nlp_calls: list[dict[str, Any]] = []

    async def post(self, url: str, **kwargs: Any) -> _Resp:
        body = kwargs["json"]
        if url.endswith("/api/v1/generate/internal/judge"):
            self.text_calls.append(body)
            self.text_headers.append(kwargs.get("headers") or {})
            return _Resp(
                {
                    "content": self.completion,
                    "provider": body["provider"],
                    "model": body["model"],
                    "latency_ms": 9,
                    "finish_reason": "stop",
                    "stats": {"prompt_tokens": 210, "predicted_tokens": 7, "total_tokens": 217},
                }
            )
        if url.endswith("/api/v1/guard/judge"):
            self.nlp_calls.append(body)
            return _Resp({"tier": "Safe", "categories": [], "refusal": None})
        raise AssertionError(f"unexpected peer url {url}")


def _runner(cfg: Any, peers: _Peers) -> JudgeRunner:
    return JudgeRunner(
        tenant_id=TENANT,
        resolver=_Resolver(cfg),
        settings=Settings(),
        http_client=peers,
        single_flight=SingleFlight(),
    )


async def _judge(cfg: Any, peers: _Peers, **kwargs: Any) -> dict[tuple[str, str], Any]:
    return await _runner(cfg, peers).judge(
        tenant_id=TENANT,
        direction=kwargs.pop("direction", "inbound"),
        lanes=kwargs.pop("lanes", LANES),
        windows=[kwargs.pop("window", WINDOW)],
        **kwargs,
    )


# ── transport ──────────────────────────────────────────────────────────────────


async def test_an_lmstudio_served_qwen_lane_calls_text_native_chat_with_the_user_turn() -> None:
    peers = _Peers("Safety: Unsafe\nCategories: Jailbreak")

    verdicts = await _judge(_qwen("lmstudio"), peers)

    assert peers.nlp_calls == []
    assert len(peers.text_calls) == 1  # both lanes, one model, one call
    assert peers.text_calls[0] == {
        "protocol": "native_chat",
        "messages": [{"role": "user", "content": WINDOW.text}],
        "provider": "lm-studio",
        "model": "qwen3guard-gen-0.6b",
        "temperature": 0.0,
        "max_tokens": 32,
    }
    assert peers.text_headers[0]["X-Tenant-Id"] == TENANT
    injection = verdicts[("injection_judge", "user@0")]
    assert (injection.verdict, injection.category, injection.tier, injection.confidence) == (
        "flag",
        "instruction_override",
        "flag",
        1.0,
    )
    assert injection.model == "qwen3guard-gen-0.6b"
    assert verdicts[("unsafe_content_judge", "user@0")].verdict == "pass"


async def test_response_moderation_sends_the_user_then_the_assistant_turn() -> None:
    peers = _Peers("Safety: Safe\nCategories: None\nRefusal: No")

    verdicts = await _judge(
        _qwen("lmstudio"),
        peers,
        direction="outbound",
        mode="response",
        prompt_context="what is the dose?",
        window=JudgeWindow("response@0", "Paracetamol 1 g every 6 hours.", ()),
    )

    assert peers.text_calls[0]["messages"] == [
        {"role": "user", "content": "what is the dose?"},
        {"role": "assistant", "content": "Paracetamol 1 g every 6 hours."},
    ]
    assert {v.verdict for v in verdicts.values()} == {"pass"}


async def test_the_lm_studio_hyphen_spelling_and_text_are_text_served_too() -> None:
    for served_by in ("lm-studio", "text"):
        peers = _Peers()
        await _judge(_qwen(served_by), peers)
        assert len(peers.text_calls) == 1 and peers.nlp_calls == [], served_by
        assert peers.text_calls[0]["protocol"] == "native_chat"


@pytest.mark.parametrize("served_by", ["nlp", None])
async def test_an_nlp_served_or_undeclared_row_keeps_the_nlp_guard_judge_path(
    served_by: str | None,
) -> None:
    peers = _Peers()

    verdicts = await _judge(_qwen(served_by), peers)

    assert peers.text_calls == []
    assert len(peers.nlp_calls) == 1
    assert peers.nlp_calls[0]["protocol"] == "qwen3guard_native"
    assert {v.verdict for v in verdicts.values()} == {"pass"}


async def test_the_engine_connection_rides_along_for_lm_studio() -> None:
    peers = _Peers()
    cfg = _qwen(
        "lmstudio",
        provider_base_url="http://hope-lmstudio:1234/v1",
        provider_connection_tenant_id=SYSTEM,
    )

    await _judge(cfg, peers)

    assert peers.text_calls[0]["provider_overrides"] == {
        "lm-studio": {"base_url": "http://hope-lmstudio:1234/v1", "funding": "platform"}
    }


async def test_text_usage_is_counted_on_the_runner() -> None:
    peers = _Peers()
    runner = _runner(_qwen("lmstudio"), peers)

    await runner.judge(tenant_id=TENANT, direction="inbound", lanes=LANES, windows=[WINDOW])

    stats = runner.usage_stats()
    assert stats is not None and stats["prompt_tokens"] == 210 and stats["predicted_tokens"] == 7


# ── mapping through the row (unchanged) ─────────────────────────────────────────


async def test_controversial_flags_with_the_warn_tier() -> None:
    peers = _Peers("Safety: Controversial\nCategories: Violent")

    verdicts = await _judge(_qwen("lmstudio"), peers)

    unsafe = verdicts[("unsafe_content_judge", "user@0")]
    assert (unsafe.verdict, unsafe.category, unsafe.tier) == ("flag", "violence", "warn")
    assert verdicts[("injection_judge", "user@0")].verdict == "pass"


async def test_several_categories_flag_every_lane_they_map_to() -> None:
    peers = _Peers("Safety: Unsafe\nCategories: Non-violent Illegal Acts, Jailbreak, PII")

    verdicts = await _judge(_qwen("lmstudio"), peers)

    assert verdicts[("injection_judge", "user@0")].category == "instruction_override"
    assert verdicts[("unsafe_content_judge", "user@0")].category == "criminal_planning"


@pytest.mark.parametrize(
    ("completion", "mode"),
    [
        ("I cannot help with that.", "prompt"),
        ("", "prompt"),
        ("Safety: Unsafe", "prompt"),
        ("Safety: Safe\nCategories: None\nRefusal: No", "prompt"),
        ("Safety: Safe\nCategories: None", "response"),
        ('{"safe": true}', "prompt"),
    ],
)
async def test_an_unreadable_completion_is_undetermined_unparseable(
    completion: str, mode: str
) -> None:
    peers = _Peers(completion)

    verdicts = await _judge(
        _qwen("lmstudio"), peers, mode=mode, prompt_context="q" if mode == "response" else None
    )

    assert {(v.verdict, v.category) for v in verdicts.values()} == {
        ("undetermined", jp.REASON_UNPARSEABLE)
    }


# ── the guardrail-side parser, pinned to apps/nlp's grammar ─────────────────────

#: (output, mode) → the parsed native fields. The SAME cases as
#: `apps/nlp/tests/test_task1049_r_qwen3guard_parser.py` (the reference grammar); the parity test below
#: re-reads that file's malformed list so a case added there must be answered identically here.
QWEN3GUARD_PARSER_CASES: list[tuple[str, str, dict[str, Any]]] = [
    ("Safety: Safe\nCategories: None", "prompt", {"tier": "Safe", "categories": []}),
    (
        "Safety: Controversial\nCategories: None",
        "prompt",
        {"tier": "Controversial", "categories": []},
    ),
    ("Safety: Unsafe\nCategories: None", "prompt", {"tier": "Unsafe", "categories": []}),
    (
        "Safety: Unsafe\nCategories: Jailbreak",
        "prompt",
        {"tier": "Unsafe", "categories": ["Jailbreak"]},
    ),
    (
        "Safety: Unsafe\nCategories: Violent, Non-violent Illegal Acts, Suicide & Self-Harm",
        "prompt",
        {
            "tier": "Unsafe",
            "categories": ["Violent", "Non-violent Illegal Acts", "Suicide & Self-Harm"],
        },
    ),
    (
        "Safety: Safe\nCategories: None\nRefusal: Yes",
        "response",
        {"tier": "Safe", "categories": [], "refusal": True},
    ),
    (
        "Safety: Safe\nCategories: None\nRefusal: No",
        "response",
        {"tier": "Safe", "categories": [], "refusal": False},
    ),
    (
        "\n  Safety: Controversial  \n\nCategories: PII\n",
        "prompt",
        {"tier": "Controversial", "categories": ["PII"]},
    ),
    ("", "prompt", {"undetermined_reason": "empty_output"}),
    ("   \n ", "prompt", {"undetermined_reason": "empty_output"}),
    ("Categories: Violent", "prompt", {"undetermined_reason": "missing_safety"}),
    ("Safety: Maybe\nCategories: None", "prompt", {"undetermined_reason": "unknown_tier"}),
    (
        "Safety: Safe\nSafety: Unsafe\nCategories: None",
        "prompt",
        {"undetermined_reason": "duplicate_line"},
    ),
    ("Safety: Unsafe", "prompt", {"undetermined_reason": "missing_categories"}),
    ("Safety: Unsafe\nCategories: ", "prompt", {"undetermined_reason": "missing_categories"}),
    ("Safety: Safe\nCategories: None", "response", {"undetermined_reason": "missing_refusal"}),
    (
        "Safety: Safe\nCategories: None\nRefusal: Perhaps",
        "response",
        {"undetermined_reason": "unknown_refusal"},
    ),
    (
        "Safety: Unsafe\nCategories: Violent\nThe user wants to hurt someone.",
        "prompt",
        {"undetermined_reason": "unexpected_line"},
    ),
    ("I cannot help with that.", "prompt", {"undetermined_reason": "unexpected_line"}),
    (
        "Safety: Safe\nCategories: None\nRefusal: No",
        "prompt",
        {"undetermined_reason": "unexpected_line"},
    ),
]


def _expected(fields: dict[str, Any]) -> dict[str, Any]:
    if "undetermined_reason" in fields:
        return {
            "tier": jp.QWEN3GUARD_UNDETERMINED,
            "categories": [],
            "refusal": None,
            "undetermined_reason": fields["undetermined_reason"],
        }
    return {"refusal": None, "undetermined_reason": None, **fields}


@pytest.mark.parametrize(("output", "mode", "fields"), QWEN3GUARD_PARSER_CASES)
def test_the_parser_reads_the_native_grammar(
    output: str, mode: str, fields: dict[str, Any]
) -> None:
    assert jp.parse_qwen3guard_text(output, mode=mode) == _expected(fields)


def _nlp_malformed_cases() -> list[tuple[str, str, str]]:
    path = _REPO_ROOT / "apps" / "nlp" / "tests" / "test_task1049_r_qwen3guard_parser.py"
    if not path.is_file():
        pytest.skip(f"apps/nlp parser tests not available at {path}")
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == (
            "test_malformed_output_is_undetermined_never_a_guess"
        ):
            for decorator in node.decorator_list:
                if isinstance(decorator, ast.Call) and len(decorator.args) == 2:
                    return [tuple(case) for case in ast.literal_eval(decorator.args[1])]
    raise AssertionError("could not find apps/nlp's malformed-output case list")


def test_parity_with_the_nlp_parsers_malformed_cases() -> None:
    nlp_cases = _nlp_malformed_cases()
    assert len(nlp_cases) >= 10
    for output, mode, reason in nlp_cases:
        parsed = jp.parse_qwen3guard_text(output, mode=mode)
        assert (parsed["tier"], parsed["undetermined_reason"]) == (
            jp.QWEN3GUARD_UNDETERMINED,
            reason,
        ), (output, mode)
        assert (output, mode, {"undetermined_reason": reason}) in QWEN3GUARD_PARSER_CASES


def test_native_chat_messages_for_each_mode() -> None:
    assert jp.native_chat_messages("prompt", None, "t") == [{"role": "user", "content": "t"}]
    assert jp.native_chat_messages("response", "q", "a") == [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "a"},
    ]
    assert jp.native_chat_messages("response", None, "a")[0] == {"role": "user", "content": ""}


@pytest.mark.parametrize(
    ("served_by", "transport"),
    [
        ("lmstudio", "text"),
        ("lm-studio", "text"),
        ("text", "text"),
        ("LMStudio", "text"),
        ("nlp", "nlp"),
        (None, "nlp"),
        ("", "nlp"),
    ],
)
def test_native_judge_transport(served_by: str | None, transport: str) -> None:
    assert jp.native_judge_transport(served_by) == transport


# ── the resolver carries `AiModel.servedBy` ──────────────────────────────────────


def test_the_ai_model_reader_maps_served_by() -> None:
    assert AiModelRead.__table__.columns["servedBy"].name == "servedBy"


async def test_the_resolver_surfaces_served_by() -> None:
    resolver = TenantConfigResolver(session_factory=lambda: None)  # type: ignore[arg-type,return-value]

    async def _keys(tenant_id: str, task_key: str) -> dict[str, str]:
        return {"provider": "lm-studio", "model": "qwen3guard-gen-0.6b", KEY_SERVED_BY: "lmstudio"}

    resolver._get_for_tenant = _keys  # type: ignore[method-assign]

    cfg = await resolver.resolve(TENANT, "guardrail.judge.injection")

    assert cfg.served_by == "lmstudio"
    assert dataclasses.replace(cfg, served_by=None).served_by is None
