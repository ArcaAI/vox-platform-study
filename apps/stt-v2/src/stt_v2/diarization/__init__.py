"""Speaker diarization — pyannote embedding extraction + Qdrant identification."""

from .dto import SpeakerEmbedding, SpeakerIdentification
from .embedding_service import EmbeddingService, get_embedding_service
from .speaker_identifier import SpeakerIdentifier, get_speaker_identifier

__all__ = [
    "EmbeddingService",
    "get_embedding_service",
    "SpeakerIdentifier",
    "get_speaker_identifier",
    "SpeakerEmbedding",
    "SpeakerIdentification",
]
