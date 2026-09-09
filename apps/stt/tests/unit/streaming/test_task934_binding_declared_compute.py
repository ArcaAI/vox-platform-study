"""TASK-934 — the engine binding log names the quantisation that actually loaded.

Lane O taught ``resolve_engine_binding`` to prefer a declared compute type; this pins
the two ends of the wire: the whisper.cpp loader records the row's compute type on
``LoadedModel.extra`` and the session manager hands exactly that to the resolver.
"""

from __future__ import annotations

from types import SimpleNamespace

from stt.streaming.session_manager import _declared_compute_type


def test_declared_compute_type_reads_the_loader_extra() -> None:
    loaded = SimpleNamespace(extra={"provider": "whisper_cpp", "compute_type": "q8_0"})
    assert _declared_compute_type(loaded) == "q8_0"


def test_declared_compute_type_is_none_when_the_loader_recorded_nothing() -> None:
    assert _declared_compute_type(SimpleNamespace(extra={"provider": "whisper_cpp"})) is None
    assert _declared_compute_type(SimpleNamespace(extra=None)) is None
    assert _declared_compute_type(SimpleNamespace(extra={"compute_type": ""})) is None
    assert _declared_compute_type(SimpleNamespace()) is None


def test_whisper_cpp_loader_records_the_row_compute_type() -> None:
    import inspect

    from stt.models import whisper_cpp_loader

    source = inspect.getsource(whisper_cpp_loader)
    # The loader's LoadedModel.extra carries the row's compute_type (a source pin:
    # constructing a real whisper.cpp context here would need weights).
    assert '"compute_type": model_config.compute_type' in source
