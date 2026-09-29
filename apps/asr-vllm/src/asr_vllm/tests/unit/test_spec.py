"""The request `spec` IS the gateway's `ResolvedAsrSpec`; this service parses its own slice.

Pinned contract (TASK-1010 phase B, lane L1): `runtimeKey` + `models.asr`, where the ASR
model carries the two OPTIONAL vLLM serving facts `quantization` / `maxModelLen`. Unknown
keys are IGNORED (the shared spec evolves; `apps/stt` is its strict mirror), while the
registry identity — `runtimeKey`, `models.asr.tenantId`, `models.asr.checksum` — must be
present.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from asr_vllm.spec import ResolvedVllmAsrSpec
from asr_vllm.tests.conftest import DROP, SYSTEM_TENANT_ID, spec_payload

FIXTURE = Path(__file__).resolve().parents[6] / "tests/contracts/resolved-asr-spec.fixture.json"


def parse(payload: dict[str, Any]) -> ResolvedVllmAsrSpec:
    return ResolvedVllmAsrSpec.model_validate(payload)


def _fixture_specs() -> list[tuple[str, dict[str, Any]]]:
    """Every spec the fixture EXPECTS the gateway to emit: each case + its fallback chain."""
    cases = json.loads(FIXTURE.read_text())
    out: list[tuple[str, dict[str, Any]]] = []
    for name, case in cases.items():
        if name.startswith("$"):
            continue
        expected = case["expected"]
        out.append((name, expected))
        for i, entry in enumerate((expected.get("fallback") or {}).get("chain") or []):
            out.append((f"{name}.fallback.chain[{i}]", entry))
    return out


FIXTURE_SPECS = _fixture_specs()
SAFETENSOR_SPECS = [
    (n, s) for n, s in FIXTURE_SPECS if s["models"]["asr"]["format"] == "SAFETENSOR"
]
OTHER_SPECS = [(n, s) for n, s in FIXTURE_SPECS if s["models"]["asr"]["format"] != "SAFETENSOR"]


# ── the slice this service uses ─────────────────────────────────────────────


def test_parses_the_runtime_key_and_the_asr_row() -> None:
    spec = parse(
        spec_payload(quantization="fp8", maxModelLen=448, checksum="ab" * 32, computeType=None)
    )
    assert spec.runtime_key == "agent-version-0001"
    model = spec.model
    assert model.slug == "arcaai-whisper-large-ml-en-vllm"
    assert model.format == "SAFETENSOR"
    assert model.tenant_id == SYSTEM_TENANT_ID
    assert model.checksum == "ab" * 32
    assert model.source_uri == "taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16"
    assert model.source_revision == "main"
    assert model.local_path == "/mnt/models-bucket/hf/whisper-turbo-ml-en-fp16"
    assert model.compute_type is None
    assert model.quantization == "fp8"
    assert model.max_model_len == 448


def test_the_two_serving_facts_are_optional() -> None:
    """Omit-when-absent on the wire: a row that declares neither still parses."""
    model = parse(spec_payload(quantization=DROP, maxModelLen=DROP)).model
    assert model.quantization is None and model.max_model_len is None
    model = parse(spec_payload(quantization=None, maxModelLen=None)).model
    assert model.quantization is None and model.max_model_len is None


def test_keys_this_service_does_not_use_are_ignored() -> None:
    """`extra='ignore'`: the shared spec grows (STT is its strict mirror), this slice doesn't."""
    payload = spec_payload(someFutureModelField={"x": 1})
    payload["someFutureTopLevelBlock"] = [1, 2, 3]
    assert parse(payload).runtime_key == "agent-version-0001"


def test_a_null_checksum_is_a_declared_absence_and_parses() -> None:
    """HF-only rows carry `checksum: null` until published; the KEY is what must be there."""
    assert parse(spec_payload(checksum=None)).model.checksum is None


@pytest.mark.parametrize(
    ("where", "key"),
    [("spec", "runtimeKey"), ("model", "tenantId"), ("model", "checksum")],
)
def test_the_registry_identity_must_be_present(where: str, key: str) -> None:
    payload = spec_payload(**{key: DROP})
    with pytest.raises(ValidationError):
        parse(payload)


@pytest.mark.parametrize(
    "override",
    [
        {"runtimeKey": ""},
        {"tenantId": ""},
        {"format": "WHISPER_CPP"},  # a GGUF row cannot load in vLLM — fail closed
        {"format": "FASTER_WHISPER"},
        {"quantization": "int4"},  # not a value the registry can hold
        {"maxModelLen": 0},
        {"localPath": None, "sourceUri": ""},  # nowhere to load from
    ],
)
def test_a_spec_this_engine_cannot_serve_is_refused(override: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        parse(spec_payload(**override))


def test_a_spec_without_models_asr_is_refused() -> None:
    payload = spec_payload()
    payload["models"] = {}
    with pytest.raises(ValidationError):
        parse(payload)


def test_equal_specs_compare_equal_on_the_slice_only() -> None:
    """The pool's runtime-key drift check compares the slice, not the ignored blocks."""
    a = spec_payload()
    b = copy.deepcopy(a)
    b["agent"] = {"slug": "renamed"}
    assert parse(a) == parse(b)
    assert parse(a) != parse(spec_payload(localPath="/elsewhere"))


# ── the committed cross-language fixture (read-only) ───────────────────────


@pytest.mark.parametrize(
    ("name", "expected"), SAFETENSOR_SPECS, ids=[n for n, _ in SAFETENSOR_SPECS]
)
def test_every_safetensor_spec_in_the_contract_fixture_parses(
    name: str, expected: dict[str, Any]
) -> None:
    spec = parse(expected)
    assert spec.runtime_key == expected["runtimeKey"]
    assert spec.model.tenant_id == expected["models"]["asr"]["tenantId"]


@pytest.mark.parametrize(("name", "expected"), OTHER_SPECS, ids=[n for n, _ in OTHER_SPECS])
def test_every_other_format_in_the_contract_fixture_is_refused(
    name: str, expected: dict[str, Any]
) -> None:
    with pytest.raises(ValidationError, match="format"):
        parse(expected)


@pytest.mark.parametrize(("name", "expected"), FIXTURE_SPECS, ids=[n for n, _ in FIXTURE_SPECS])
def test_the_whole_shared_shape_is_tolerated(name: str, expected: dict[str, Any]) -> None:
    """Every real emitted shape parses once its ASR row is one vLLM can serve.

    Only the row's two ENGINE facts are rewritten (a GGUF row's `q8_0` is not a vLLM
    dtype); every other block and key is the fixture's own, untouched.
    """
    payload = copy.deepcopy(expected)
    payload["models"]["asr"].update(format="SAFETENSOR", computeType=None)
    assert parse(payload).runtime_key == expected["runtimeKey"]
