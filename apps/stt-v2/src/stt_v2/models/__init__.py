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
from .huggingface_loader import HuggingFaceLoader
from .nemo_adapter import NemoAsrAdapter
from .nemo_loader import NeMoLoader
from .onnx_loader import ONNXLoader

__all__ = [
    # Base
    "BaseModelLoader",
    "LoadedModel",
    # Loaders
    "AzureSpeechLoader",
    "HuggingFaceLoader",
    "ONNXLoader",
    "NeMoLoader",
    "NemoAsrAdapter",
    # Cache
    "ModelCache",
    "CacheEntry",
    "CacheStats",
    "get_model_cache",
    "clear_model_cache",
]
