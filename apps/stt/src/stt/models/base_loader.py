"""Base model loader interface."""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from ..pipeline.dto import AiModelConfig, AiModelFormat

logger = logging.getLogger(__name__)


class CredentialPosture(StrEnum):
    """How an ASR loader obtains the credential it authenticates with.

    This exists so the BYOK lock test can iterate the loader REGISTRY instead of
    a hand-written list of engine names.

    The four cloud loaders already fail closed — but they do so because four
    people each remembered to write the check, and three separate hand-written
    maps (``_CLOUD_ASR_OVERRIDE_FORMATS`` and ``_OVERRIDE_KEY_BY_FORMAT`` in
    ``transcription/batch_service.py``, plus the streaming set in
    ``streaming/session_manager.py``) have to agree with them. Nothing structural
    said a FIFTH cloud engine must fail closed, appear in those maps, or meter its
    funding correctly. In ``apps/text`` that exact gap let ``bedrock`` and
    ``vertex`` authenticate from the process environment for years: neither was on
    the list, so neither was ever asked to fail closed.

    A loader that declares NOTHING fails the lock test. Default-deny is the point:
    a new engine is not silently assumed credential-free.
    """

    #: Vendor credential REQUIRED. It arrives per request as a gateway-injected
    #: ``provider_overrides`` entry (tenant → SYSTEM ``AiProviderConnection``),
    #: read under the loader's declared ``override_key``. Absent it, the loader
    #: MUST raise rather than build a client that would authenticate from the
    #: process environment. There is no env fallback for any of them.
    BYOK = "byok"
    #: Runs on the platform's own hardware from local or downloaded weights
    #: (whisper.cpp, faster-whisper, NeMo, ONNX, transformers, Parakeet). No
    #: vendor credential exists to fail closed on, and none may be declared.
    SELF_HOSTED = "self_hosted"


@dataclass
class LoadedModel:
    """Container for a loaded model and its metadata."""

    model_id: str
    model_slug: str
    model: Any  # The actual model object (Transformers, ONNX, NeMo)
    tokenizer: Any | None = None  # Associated tokenizer (if applicable)
    processor: Any | None = None  # Associated processor (if applicable)
    feature_extractor: Any | None = None  # Feature extractor (for audio)
    format: AiModelFormat = AiModelFormat.SAFETENSOR
    loaded_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    memory_mb: int = 0
    device: str = "auto"
    extra: dict[str, Any] = field(default_factory=dict)

    def __repr__(self) -> str:
        return (
            f"LoadedModel(slug={self.model_slug}, format={self.format}, "
            f"device={self.device}, memory_mb={self.memory_mb})"
        )


class BaseModelLoader(ABC):
    """Abstract base class for model loaders.

    Every concrete loader must declare ``credential_posture`` (see
    ``CredentialPosture``), and a ``BYOK`` one must additionally declare the
    ``override_key`` it reads its credential from — the key the usage ledger
    meters funding under, so a mismatch mis-bills real money.

    Both are declared as plain class attributes with NO default here rather than
    as abstract members: a default would be a silent answer for a loader whose
    author never considered the question, which is the failure mode the
    registry-iterating lock test
    (``tests/unit/test_task799_byok_credentials.py``) exists to catch.
    """

    #: Declared by every concrete loader. ``None`` here so an undeclared loader
    #: FAILS the lock test rather than inheriting a permissive answer.
    credential_posture: "CredentialPosture | None" = None
    #: The ``provider_overrides`` key a BYOK loader reads its credential from.
    #: Must stay ``None`` for a SELF_HOSTED loader.
    override_key: str | None = None

    @property
    @abstractmethod
    def supported_formats(self) -> list[AiModelFormat]:
        """Return list of supported model formats."""
        ...

    @abstractmethod
    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        """
        Load model from source.

        Args:
            model_config: Model configuration from database

        Returns:
            LoadedModel instance

        Raises:
            ModelLoadError: If model cannot be loaded
        """
        ...

    @abstractmethod
    async def unload(self, loaded_model: LoadedModel) -> None:
        """
        Unload model from memory.

        Args:
            loaded_model: Previously loaded model
        """
        ...

    @abstractmethod
    def estimate_memory(self, model_config: AiModelConfig) -> int:
        """
        Estimate memory requirements for model in MB.

        Args:
            model_config: Model configuration

        Returns:
            Estimated memory in MB
        """
        ...

    def supports_format(self, format: AiModelFormat) -> bool:
        """Check if this loader supports the given format."""
        return format in self.supported_formats

    def _get_device(self, requested: str = "auto") -> str:
        """
        Determine device to use for model.

        When ``requested`` is ``"auto"``, delegates to the central
        :func:`stt.core.platform.get_device_string` which auto-detects
        the best available hardware (CUDA -> MPS -> CPU).

        Args:
            requested: Requested device (auto, cuda, cpu, mps)

        Returns:
            Resolved device string
        """
        if requested == "auto":
            from stt.core.platform import get_device_string

            return get_device_string()

        # Validate requested device is available
        if requested == "cuda":
            try:
                import torch

                if not torch.cuda.is_available():
                    logger.warning(
                        "Requested device 'cuda' unavailable, falling back to auto-detect"
                    )
                    from stt.core.platform import get_device_string

                    return get_device_string()
            except ImportError:
                pass
        elif requested == "mps":
            try:
                import torch

                if not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()):
                    logger.warning(
                        "Requested device 'mps' unavailable, falling back to auto-detect"
                    )
                    from stt.core.platform import get_device_string

                    return get_device_string()
            except ImportError:
                pass

        return requested

    def _get_torch_dtype(self, compute_type: str) -> Any:
        """
        Convert compute type string to torch dtype.

        Auto-detection selects float16 for GPU-capable backends:
        - CUDA: float16 (well-supported on all NVIDIA GPUs)
        - MPS: float16 (Apple Silicon GPU, natively supported, ~2x faster)
        - CPU: float32 (float16 is slower on CPU due to emulation)

        **Safety**: float16 is forcibly downgraded to float32 on CPU because
        PyTorch CPU kernels do not support fp16 inference — attempting it
        raises ``RuntimeError: Input type (float) and bias type (c10::Half)
        should be the same``.

        Args:
            compute_type: Compute type (float16, float32, int8, auto)

        Returns:
            torch.dtype
        """
        try:
            import torch

            has_cuda = torch.cuda.is_available()
            has_mps = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
            on_cpu = not has_cuda and not has_mps

            def _auto_dtype() -> torch.dtype:
                if has_cuda or has_mps:
                    return torch.float16
                return torch.float32

            mapping = {
                "float16": torch.float16,
                "float32": torch.float32,
                "bfloat16": torch.bfloat16,
                "int8": torch.int8,
                "auto": _auto_dtype(),
            }
            dtype = mapping.get(compute_type, torch.float32)

            # Guard: fp16 / bf16 on CPU causes dtype-mismatch crashes.
            # Silently fall back to float32 so CPU-only servers always work.
            if on_cpu and dtype in (torch.float16, torch.bfloat16):
                logger.warning(
                    "Requested dtype %s is not supported on CPU — "
                    "falling back to float32 to prevent inference errors.",
                    compute_type,
                )
                dtype = torch.float32

            return dtype
        except ImportError:
            return None


def cleanup_accelerator_memory() -> None:
    """Release GPU/accelerator memory pools after model unload.

    IMPORTANT: This must be called AFTER deleting model references and
    running gc.collect(). The empty_cache() calls only release memory
    that is no longer referenced by any tensor.

    Supports:
    - CUDA: ``torch.cuda.empty_cache()``
    - MPS (Apple Silicon): ``torch.mps.empty_cache()``
    - CPU: no-op (standard GC is sufficient)

    Safe to call on any platform — silently skips unsupported backends.
    """
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        elif hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
            torch.mps.empty_cache()
    except ImportError:
        pass
    except Exception:
        # Non-critical: log but don't fail
        logger.debug("Accelerator memory cleanup skipped (non-fatal)")
