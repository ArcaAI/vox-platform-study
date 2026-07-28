"""Processor registry tests."""

import pytest

from stt.processors import (
    STAGE_KINDS,
    Capability,
    CapabilityError,
    ProcessorRegistry,
    ProcessorSpec,
    get_registry,
)


def _spec(**over):
    base = {
        "kind": "asr",
        "name": "dummy",
        "lazy_target": "collections:OrderedDict",
        "capabilities": (Capability(device="cpu", compute=("float32",)),),
    }
    base.update(over)
    return ProcessorSpec(**base)


class TestSpecValidation:
    def test_unknown_kind_raises(self):
        with pytest.raises(ValueError, match="Unknown stage kind 'warp'"):
            _spec(kind="warp")

    def test_no_capabilities_raises(self):
        with pytest.raises(ValueError, match="declares no capabilities"):
            _spec(capabilities=())

    def test_bad_lazy_target_raises(self):
        with pytest.raises(ValueError, match="module:attr"):
            _spec(lazy_target="no_colon_here")


class TestRegistration:
    def test_register_and_lookup(self):
        reg = ProcessorRegistry()
        spec = _spec()
        reg.register(spec)
        assert reg.spec("asr", "dummy") is spec
        assert reg.names("asr") == ["dummy"]

    def test_duplicate_different_spec_raises(self):
        reg = ProcessorRegistry()
        reg.register(_spec())
        with pytest.raises(ValueError, match="already registered"):
            reg.register(_spec(rank=5))

    def test_identical_reregistration_is_idempotent(self):
        reg = ProcessorRegistry()
        reg.register(_spec())
        reg.register(_spec())  # same content — no error (module re-imports)
        assert reg.names("asr") == ["dummy"]

    def test_unknown_lookup_lists_registered(self):
        reg = ProcessorRegistry()
        reg.register(_spec())
        with pytest.raises(KeyError, match="Registered: dummy"):
            reg.spec("asr", "nope")

    def test_scoped_does_not_leak(self):
        reg = ProcessorRegistry()
        reg.register(_spec())
        with reg.scoped() as child:
            child.register(_spec(name="extra"))
            assert set(child.names("asr")) == {"dummy", "extra"}
        assert reg.names("asr") == ["dummy"]


class TestLazyLoad:
    def test_load_imports_target(self):
        from collections import OrderedDict

        reg = ProcessorRegistry()
        reg.register(_spec())
        assert reg.load("asr", "dummy") is OrderedDict

    def test_load_missing_attr_raises_importerror(self):
        reg = ProcessorRegistry()
        reg.register(_spec(lazy_target="collections:NoSuchThing"))
        with pytest.raises(ImportError, match="NoSuchThing"):
            reg.load("asr", "dummy")


class TestResolveBinding:
    def _reg(self):
        reg = ProcessorRegistry()
        reg.register(
            _spec(
                name="fw",
                capabilities=(
                    Capability(device="cuda", compute=("int8_float16", "float16")),
                    Capability(device="cpu", compute=("int8", "float32")),
                ),
            )
        )
        return reg

    def test_prefers_profile_device_order(self):
        b = self._reg().resolve_binding(
            "asr", "fw", devices=["cuda", "cpu"], compute_pref=["float16", "int8"]
        )
        assert (b.device, b.compute) == ("cuda", "float16")

    def test_falls_through_unsupported_device(self):
        # mps not declared (CT2) → resolver must land on cpu.
        b = self._reg().resolve_binding(
            "asr", "fw", devices=["mps", "cpu"], compute_pref=["float32"]
        )
        assert (b.device, b.compute) == ("cpu", "float32")

    def test_no_intersection_raises_with_matrix(self):
        with pytest.raises(CapabilityError, match="Declared: cuda"):
            self._reg().resolve_binding(
                "asr", "fw", devices=["mps"], compute_pref=["float16"]
            )

    def test_mode_filtering(self):
        reg = ProcessorRegistry()
        reg.register(
            _spec(
                name="batchonly",
                capabilities=(
                    Capability(device="cpu", compute=("float32",), streaming=False),
                ),
            )
        )
        assert reg.resolve_binding(
            "asr", "batchonly", devices=["cpu"], compute_pref=["float32"], mode="batch"
        ).device == "cpu"
        with pytest.raises(CapabilityError):
            reg.resolve_binding(
                "asr", "batchonly", devices=["cpu"], compute_pref=["float32"], mode="streaming"
            )

    def test_empty_compute_capability_resolves_none(self):
        # P1 review: a compute-less capability (cloud) must NOT echo the
        # caller's preference back as if the engine used it.
        reg = ProcessorRegistry()
        reg.register(_spec(name="cloud", capabilities=(Capability(device="cloud"),)))
        b = reg.resolve_binding("asr", "cloud", devices=["cloud"], compute_pref=["float16"])
        assert (b.device, b.compute) == ("cloud", None)
        b2 = reg.resolve_binding("asr", "cloud", devices=["cloud"])
        assert b2.compute is None

    def test_unmatched_compute_pref_falls_back_to_declared_default(self):
        # P1 review: compute_pref is a SOFT preference — a vocabulary mismatch
        # (profile "float16" vs an engine declaring only "float32") must fall
        # back to the engine's own default, never report "unsupported".
        reg = ProcessorRegistry()
        reg.register(
            _spec(name="nemoish", capabilities=(Capability(device="cuda", compute=("float32",)),))
        )
        b = reg.resolve_binding(
            "asr", "nemoish", devices=["cuda"], compute_pref=["float16"]
        )
        assert (b.device, b.compute) == ("cuda", "float32")

    def test_compute_pref_order_beats_rank(self):
        # Docstring contract: within a device, the caller's preference order
        # wins over capability rank.
        reg = ProcessorRegistry()
        reg.register(
            _spec(
                name="ranked",
                capabilities=(
                    Capability(device="cuda", compute=("int8",), rank=5),
                    Capability(device="cuda", compute=("float16",), rank=0),
                ),
            )
        )
        b = reg.resolve_binding(
            "asr", "ranked", devices=["cuda"], compute_pref=["float16", "int8"]
        )
        assert b.compute == "float16"


class TestManifestContents:
    """CI guard: the manifest must register the expected processors.

    Catches accidental deregistration / a spec module dropped from the
    manifest import list (a decorator that never imports never registers).
    """

    EXPECTED_ASR = {
        "safetensor",
        "onnx",
        "onnx_optimum",
        "nemo",
        "faster_whisper",
        "azure_speech",
        "parakeet_cpp",
        "sarvam",
        "openai",
        "azure_foundry",
        "whisper_cpp",
    }

    def test_asr_engines_registered(self):
        assert set(get_registry().names("asr")) == self.EXPECTED_ASR

    def test_faster_whisper_declares_batch_support(self):
        # Locks the increment-1 parity fix at the capability level.
        spec = get_registry().spec("asr", "faster_whisper")
        assert all(c.batch for c in spec.capabilities)
        assert not any(c.device == "mps" for c in spec.capabilities)

    def test_onnx_raw_is_batch_only(self):
        spec = get_registry().spec("asr", "onnx")
        assert not any(c.streaming for c in spec.capabilities)

    def test_lazy_targets_resolve(self):
        # Import every declared implementation — a renamed loader class must
        # fail HERE, not at first runtime resolve. (Heavy deps are lazy inside
        # the loader modules themselves, so this stays cheap.)
        reg = get_registry()
        for spec in reg.all_specs():
            reg.load(spec.kind, spec.name)

    def test_stage_kinds_closed_set(self):
        assert "asr" in STAGE_KINDS
        assert len(STAGE_KINDS) == 11
