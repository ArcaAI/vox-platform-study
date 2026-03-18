"""Qdrant vector store for speaker embeddings."""

from .client import QdrantClientManager, get_qdrant_client
from .speaker_store import SpeakerEmbeddingStore, get_speaker_store

__all__ = [
    "QdrantClientManager",
    "get_qdrant_client",
    "SpeakerEmbeddingStore",
    "get_speaker_store",
]
