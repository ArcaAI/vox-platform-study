"""Processor registry package.

MANIFEST: every spec module must be imported here — a decorator/registration
that is never imported never registers (the classic registry blind spot). A
CI test asserts the expected registry contents so accidental deregistration
fails the build.
"""

from . import asr_capabilities  # noqa: F401  (registers ASR engine specs)
from .base import (
    STAGE_KINDS,
    Capability,
    CapabilityError,
    HardwareBinding,
    ProcessorSpec,
)
from .registry import ProcessorRegistry, get_registry, register_processor

__all__ = [
    "STAGE_KINDS",
    "Capability",
    "CapabilityError",
    "HardwareBinding",
    "ProcessorRegistry",
    "ProcessorSpec",
    "get_registry",
    "register_processor",
]
