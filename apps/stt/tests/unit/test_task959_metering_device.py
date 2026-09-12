"""TASK-959 — the device a request occupied decides WHICH compute unit it bills.

`device` rides the batch completion callback and every streaming usage segment,
and the gateway maps it to a unit: `cuda`/`mps` -> `GPU_SECOND`, `cpu` ->
`CPU_SECOND` (TASK-959 §10.2). So the normalisation below is a billing
decision, not cosmetics — `"cuda:0"` reaching the wire unnormalised is a value
the gateway cannot map, and an unmappable value bills nothing at all.

The one deliberate asymmetry: anything the service cannot resolve to a real
accelerator normalises to `cpu`, the CHEAPER unit — the ticket's rule is
"never nothing", and under-billing the platform is the safe direction.
"""

from __future__ import annotations

import pytest

from stt.core.metering import (
    BYTE_SOURCE_APP,
    BYTE_SOURCE_WIRE,
    DEVICE_CPU,
    DEVICE_CUDA,
    DEVICE_MPS,
    normalize_device,
)


class TestNormalizeDevice:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            # The shape every CUDA execution profile and torch loader actually
            # carries — an ordinal the ledger must not see.
            ("cuda:0", DEVICE_CUDA),
            ("cuda:1", DEVICE_CUDA),
            ("cuda", DEVICE_CUDA),
            ("CUDA:0", DEVICE_CUDA),
            ("mps", DEVICE_MPS),
            ("MPS", DEVICE_MPS),
            ("cpu", DEVICE_CPU),
        ],
    )
    def test_accelerators_normalise_to_the_three_wire_values(self, raw, expected):
        assert normalize_device(raw) == expected

    @pytest.mark.parametrize(
        "raw",
        [
            # Every cloud ASR loader stamps this: the vendor's hardware is not
            # ours, and what the request occupied HERE is the calling CPU.
            "cloud",
            # whisper.cpp with GPU and parakeet.cpp both stamp "auto" — the
            # process never resolved a concrete device.
            "auto",
            "",
            None,
            "xpu",
        ],
    )
    def test_anything_unresolvable_bills_the_cheaper_cpu_unit(self, raw):
        assert normalize_device(raw) == DEVICE_CPU

    def test_non_string_devices_degrade_instead_of_raising(self):
        """`LoadedModel.device` is typed `str` but torch objects leak into it."""
        assert normalize_device(object()) == DEVICE_CPU


class TestByteSourceVocabulary:
    def test_the_two_declared_sources_are_the_wire_values(self):
        """`byteSource` says whether the count is the real wire or an
        application-level proxy, so a later exact figure cannot silently change
        the meaning of old rows (TASK-959 §4.2)."""
        assert (BYTE_SOURCE_WIRE, BYTE_SOURCE_APP) == ("wire", "app")
