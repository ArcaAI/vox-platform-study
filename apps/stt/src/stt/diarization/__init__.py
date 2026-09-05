"""Speaker diarization -- embedding extraction + session-scoped identification."""

from .dto import SpeakerEmbedding, SpeakerIdentification
from .embedding_service import (
    EmbeddingService,
    create_embedding_service,
)
from .preseed import seed_voice_profiles
from .pyannote_embedding import PyannoteEmbeddingService
from .speaker_tracker import SpeakerTracker
from .speechbrain_embedding import SpeechBrainEmbeddingService
from .streaming_sortformer import (
    SortformerBackend,
    SortformerModelUnavailableError,
    StreamingDiarizationResult,
    StreamingSortformerDiarizer,
    load_default_backend,
)

__all__ = [
    "EmbeddingService",
    "PyannoteEmbeddingService",
    "SpeechBrainEmbeddingService",
    "create_embedding_service",
    "seed_voice_profiles",
    "SpeakerTracker",
    "SpeakerEmbedding",
    "SpeakerIdentification",
    # Streaming Sortformer diarizer scaffold (self-hosted, NeMo).
    "SortformerBackend",
    "SortformerModelUnavailableError",
    "StreamingDiarizationResult",
    "StreamingSortformerDiarizer",
    "load_default_backend",
]
