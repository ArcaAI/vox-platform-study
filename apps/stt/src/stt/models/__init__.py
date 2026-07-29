"""Models domain module.

This module handles AI model loading, caching, and management.
"""

from .azure_speech_loader import AzureSpeechLoader
from .base_loader import BaseModelLoader, LoadedModel
from .cache import (
    CacheEntry,
    CacheStats,
    ModelCache,
    clear_model_cache,
    get_model_cache,
)
from .faster_whisper_loader import FasterWhisperLoader
from .huggingface_loader import HuggingFaceLoader
from .nemo_adapter import NemoAsrAdapter
from .nemo_loader import NeMoLoader
from .onnx_loader import ONNXLoader
from .openai_loader import OpenAILoader
from .sarvam_loader import SarvamLoader

__all__ = [
    # Base
    "BaseModelLoader",
    "LoadedModel",
    # Loaders
    "AzureSpeechLoader",
    "FasterWhisperLoader",
    "HuggingFaceLoader",
    "ONNXLoader",
    "OpenAILoader",
    "SarvamLoader",
    "NeMoLoader",
    "NemoAsrAdapter",
    # Cache
    "ModelCache",
    "CacheEntry",
    "CacheStats",
    "get_model_cache",
    "clear_model_cache",
]
