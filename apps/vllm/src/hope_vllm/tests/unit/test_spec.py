"""C-1: `ResolvedServingSpec` — the pydantic mirror of `packages/types/src/serving-spec.ts`.

The gateway resolves `model=<slug>` for the calling tenant (tenant row first, then SYSTEM)
into ONE shape, and the committed fixture `tests/contracts/resolved-serving-spec.fixture.json`
is the cross-language lock both sides parse. The mirror is STRICT (`extra='forbid'`, every
key required, nullable where the TS type says `| null`) — unlike the spike's `ResolvedAsrSpec`
slice, this contract belongs to this service alone, so an unknown key is a drift to catch,
not an evolution to tolerate.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from hope_vllm.spec import ResolvedServingSpec
from hope_vllm.tests.conftest import serving_spec_payload

FIXTURE = Path(__file__).resolve().parents[6] / "tests/contracts/resolved-serving-spec.fixture.json"


def fixture() -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(FIXTURE.read_text())
    return payload


def test_the_committed_fixture_parses() -> None:
    spec = ResolvedServingSpec.model_validate(fixture())
    assert spec.slug == "arcaai-whisper-large-ml-en-vllm"
    assert spec.kind == "asr"
    assert spec.runtime_key == "00000000-0000-0000-0001-000000000026:v1"
    assert spec.tenant_id == "00000000-0000-0000-0000-000000000000"
    assert spec.local_path is not None and spec.local_path.startswith("/mnt/models-bucket/")
    assert spec.source_uri == "hf:arcaai/whisper-large-ml-en"
    assert spec.source_revision is None
    assert spec.checksum is None
    assert spec.format == "SAFETENSOR"
    assert spec.compute_type == "float16"
    assert spec.quantization is None
    assert spec.max_model_len is None
    assert spec.engine.vram_gib == 5
    assert spec.engine.max_num_seqs == 64
    assert spec.engine.enforce_eager is None


def test_it_round_trips_to_the_exact_wire_keys() -> None:
    """`to_camel('vram_gib')` is `vramGib`; the wire says `vramGiB` — pinned explicitly."""
    raw = fixture()
    dumped = ResolvedServingSpec.model_validate(raw).model_dump(by_alias=True)
    assert dumped == raw
    assert "vramGiB" in dumped["engine"]


def test_the_conftest_builder_is_the_fixture_shape() -> None:
    assert set(serving_spec_payload()) == set(fixture())
    assert set(serving_spec_payload()["engine"]) == set(fixture()["engine"])  # type: ignore[arg-type]


@pytest.mark.parametrize("where", ["top", "engine"])
def test_an_unknown_key_is_refused(where: str) -> None:
    raw = fixture()
    (raw if where == "top" else raw["engine"])["apiKey"] = "leaked"
    with pytest.raises(ValidationError):
        ResolvedServingSpec.model_validate(raw)


@pytest.mark.parametrize(
    "key",
    [
        "slug",
        "kind",
        "runtimeKey",
        "tenantId",
        "localPath",
        "sourceUri",
        "sourceRevision",
        "checksum",
        "format",
        "computeType",
        "quantization",
        "maxModelLen",
        "engine",
    ],
)
def test_every_key_is_required(key: str) -> None:
    raw = fixture()
    raw.pop(key)
    with pytest.raises(ValidationError):
        ResolvedServingSpec.model_validate(raw)


@pytest.mark.parametrize("key", ["vramGiB", "maxNumSeqs", "enforceEager"])
def test_every_engine_key_is_required(key: str) -> None:
    raw = fixture()
    raw["engine"].pop(key)
    with pytest.raises(ValidationError):
        ResolvedServingSpec.model_validate(raw)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("kind",), "embedding"),
        (("format",), "GGUF"),
        (("computeType",), "int4"),
        (("quantization",), "bnb"),
        (("maxModelLen",), 0),
        (("engine", "vramGiB"), 0),
        (("engine", "vramGiB"), -1),
        (("engine", "maxNumSeqs"), 0),
        (("slug",), ""),
        (("runtimeKey",), ""),
        (("tenantId",), ""),
    ],
)
def test_out_of_contract_values_are_refused(path: tuple[str, ...], value: object) -> None:
    raw = fixture()
    target = raw
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    with pytest.raises(ValidationError):
        ResolvedServingSpec.model_validate(raw)


@pytest.mark.parametrize("kind", ["asr", "llm", "tts"])
def test_every_serving_kind_parses(kind: str) -> None:
    raw = fixture()
    raw["kind"] = kind
    assert ResolvedServingSpec.model_validate(raw).kind == kind


def test_fractional_gib_is_allowed() -> None:
    raw = fixture()
    raw["engine"]["vramGiB"] = 2.5
    assert ResolvedServingSpec.model_validate(raw).engine.vram_gib == 2.5


def test_the_spec_is_frozen_and_hashable_by_value() -> None:
    a = ResolvedServingSpec.model_validate(fixture())
    b = ResolvedServingSpec.model_validate(copy.deepcopy(fixture()))
    assert a == b
    with pytest.raises(ValidationError):
        a.slug = "other"  # type: ignore[misc]
