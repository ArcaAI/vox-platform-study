"""TASK-959 §10.2 — `usage_detail` carries compute time and network bytes.

Four new fields on the one object the gateway meters from:

| Field | Meaning |
|---|---|
| `total_ms` | wall clock, always present (= `GenerationStats.total_ms`) |
| `engine_ms` | the engine's OWN time, when it reports one; else absent |
| `request_bytes` / `response_bytes` | body bytes on the wire; absent off the pool |

`engine_ms` is derived from `engine_native`, which is the only place a native
timing survives: llama.cpp reports `timings.prompt_ms + predicted_ms`
(milliseconds), Ollama reports `total_duration - load_duration` (nanoseconds).
Deriving it by SHAPE rather than by provider name is deliberate — a self-hosted
server registered under a new key still gets its native time, and a provider
that reports no timings gets `None` rather than a client clock wearing an
engine's label.

The three optional fields are OMITTED when `None`, never serialized as `null`,
so a gateway that predates them sees an unchanged shape.
"""

from __future__ import annotations

from text.models.stats import GenerationStats, stats_from_llama_cpp, stats_from_ollama_response
from text.models.usage import build_usage_detail, engine_ms_from_stats


def _detail(**kwargs: object):  # type: ignore[no-untyped-def]
    base = {
        "task_id": "t-1",
        "request_id": "r-1",
        "provider": "lm-studio",
        "model": "m",
        "prompt_tokens": 10,
        "completion_tokens": 20,
    }
    base.update(kwargs)
    return build_usage_detail(**base)  # type: ignore[arg-type]


class TestTotalMs:
    def test_total_ms_is_carried_verbatim(self) -> None:
        assert _detail(total_ms=1234).total_ms == 1234

    def test_total_ms_defaults_to_zero_and_is_always_on_the_wire(self) -> None:
        dumped = _detail().model_dump(mode="json")
        assert dumped["total_ms"] == 0

    def test_total_ms_is_never_negative(self) -> None:
        assert _detail(total_ms=-5).total_ms == 0


class TestEngineMsDerivation:
    def test_llama_cpp_sums_prefill_and_decode(self) -> None:
        stats = stats_from_llama_cpp(
            provider="llama-cpp",
            model="m",
            data={
                "timings": {
                    "prompt_n": 7,
                    "predicted_n": 11,
                    "prompt_ms": 120.5,
                    "predicted_ms": 880.25,
                },
                "stopped_eos": True,
            },
            total_ms=1500,
        )
        # 120.5 + 880.25 = 1000.75 → 1001 ms
        assert engine_ms_from_stats(stats) == 1001

    def test_ollama_subtracts_load_time_and_converts_from_nanoseconds(self) -> None:
        stats = stats_from_ollama_response(
            provider="ollama",
            model="m",
            data={
                "total_duration": 2_500_000_000,
                "load_duration": 500_000_000,
                "eval_count": 9,
                "eval_duration": 1_000_000_000,
                "prompt_eval_count": 3,
                "done_reason": "stop",
            },
            total_ms=2600,
        )
        # (2.5s - 0.5s) = 2000 ms
        assert engine_ms_from_stats(stats) == 2000

    def test_ollama_without_a_load_duration_still_reports(self) -> None:
        stats = GenerationStats(engine_native={"total_duration": 1_000_000_000})
        assert engine_ms_from_stats(stats) == 1000

    def test_a_cloud_provider_reports_no_engine_time(self) -> None:
        stats = GenerationStats(
            provider="openai", engine_native={"usage": {"prompt_tokens": 1}}, total_ms=900
        )
        assert engine_ms_from_stats(stats) is None

    def test_no_engine_native_at_all_is_none(self) -> None:
        assert engine_ms_from_stats(GenerationStats(total_ms=900)) is None

    def test_accepts_a_dumped_stats_dict_from_the_streaming_path(self) -> None:
        """The streaming `usage` chunk is a `GenerationStats` DUMP, not the model."""
        dumped = GenerationStats(
            engine_native={"timings": {"prompt_ms": 10, "predicted_ms": 20}}
        ).model_dump()
        assert engine_ms_from_stats(dumped) == 30

    def test_a_nonsense_shape_degrades_to_none_and_never_raises(self) -> None:
        assert engine_ms_from_stats({"engine_native": {"timings": "not-a-dict"}}) is None
        assert engine_ms_from_stats({"engine_native": {"total_duration": "soon"}}) is None
        assert engine_ms_from_stats(None) is None
        assert engine_ms_from_stats("garbage") is None

    def test_a_negative_derivation_is_refused_rather_than_reported(self) -> None:
        """A load longer than the total is a broken engine report, not -1s of work."""
        stats = GenerationStats(
            engine_native={"total_duration": 1_000_000, "load_duration": 9_000_000}
        )
        assert engine_ms_from_stats(stats) is None


class TestBytesOnTheDetail:
    def test_bytes_are_carried_when_the_adapter_was_on_the_pool(self) -> None:
        detail = _detail(request_bytes=512, response_bytes=4096)
        assert (detail.request_bytes, detail.response_bytes) == (512, 4096)

    def test_zero_bytes_is_a_real_observation_and_survives_serialization(self) -> None:
        dumped = _detail(request_bytes=0, response_bytes=0).model_dump(mode="json")
        assert dumped["request_bytes"] == 0
        assert dumped["response_bytes"] == 0


class TestOmittedWhenNone:
    def test_the_optional_compute_and_byte_fields_are_absent_not_null(self) -> None:
        dumped = _detail().model_dump(mode="json")
        for field in ("engine_ms", "request_bytes", "response_bytes"):
            assert field not in dumped, f"{field} must be omitted, never null"

    def test_json_serialization_omits_them_too(self) -> None:
        raw = _detail().model_dump_json()
        assert "engine_ms" not in raw
        assert "request_bytes" not in raw

    def test_present_fields_are_kept(self) -> None:
        dumped = _detail(engine_ms=7, request_bytes=1, response_bytes=2).model_dump(mode="json")
        assert dumped["engine_ms"] == 7
        assert dumped["request_bytes"] == 1
        assert dumped["response_bytes"] == 2

    def test_the_pre_existing_fields_keep_their_null_shape(self) -> None:
        """Only the NEW fields are omitted — an older consumer reading
        `connection_id` or `service_tier` must see exactly what it saw before."""
        dumped = _detail().model_dump(mode="json")
        assert dumped["connection_id"] is None
        assert dumped["service_tier"] is None
        assert dumped["raw"] is None


class TestPeerRoundTrip:
    def test_a_forwarded_blob_keeps_its_compute_and_byte_counts(self) -> None:
        """Guardrail forwards the judge's `usage_detail` verbatim; the rebuild
        re-derives `cost_basis` but must not drop what the judge measured."""
        from text.models.usage import _usage_detail_from_blob

        blob = _detail(
            total_ms=900, engine_ms=850, request_bytes=64, response_bytes=128
        ).model_dump(mode="json")
        rebuilt = _usage_detail_from_blob(blob)
        assert rebuilt is not None
        assert rebuilt.total_ms == 900
        assert rebuilt.engine_ms == 850
        assert rebuilt.request_bytes == 64
        assert rebuilt.response_bytes == 128
