"""Application constants."""

# Database namespaces for GlobalSetting
NAMESPACE_STT_CONFIG = "stt.config"
NAMESPACE_STT_PIPELINES = "stt.pipelines"
NAMESPACE_STT_MODELS = "stt.models"

# NOTE: there is deliberately NO `DEFAULT_TENANT_ID` here. It used to hold
# `50000000-…` labelled "system-wide", which it is not: that is the CUSTOMER
# tenant "Global" (the platform-admin playground). The runtime cascade is
# request tenant -> SYSTEM (`00000000-…`) and nothing else, so a constant
# offering a customer tenant as a default is a cross-tenant leak waiting for its
# first consumer. It had none when it was removed; do not reintroduce it.
# See `.claude/rules/00-project-context.md` §"The two reserved tenants are NOT
# two config tiers".
SYSTEM_USER_ID = "60000000-0000-0000-0000-000000000000"

# Resource status
RESOURCE_STATUS_ENABLED = "ENABLED"
RESOURCE_STATUS_DISABLED = "DISABLED"

# Model formats
MODEL_FORMAT_SAFETENSOR = "SAFETENSOR"
MODEL_FORMAT_ONNX = "ONNX"
MODEL_FORMAT_NEMO = "NEMO"
MODEL_FORMAT_PYTORCH = "PYTORCH"

# Model sources
MODEL_SOURCE_HUGGINGFACE = "HUGGINGFACE"
MODEL_SOURCE_GITHUB = "GITHUB"
MODEL_SOURCE_MLFLOW = "MLFLOW"
MODEL_SOURCE_LOCAL = "LOCAL"

# Job statuses
JOB_STATUS_QUEUED = "QUEUED"
JOB_STATUS_PROCESSING = "PROCESSING"
JOB_STATUS_COMPLETED = "COMPLETED"
JOB_STATUS_FAILED = "FAILED"
JOB_STATUS_CANCELLED = "CANCELLED"
JOB_STATUS_DEAD = "DEAD"

# Job types
JOB_TYPE_BATCH = "BATCH"
JOB_TYPE_STREAMING = "STREAMING"

# Audio formats
SUPPORTED_AUDIO_FORMATS = [
    "wav",
    "mp3",
    "flac",
    "ogg",
    "webm",
    "m4a",
    "aac",
]

# Default audio settings
DEFAULT_SAMPLE_RATE = 16000
DEFAULT_CHANNELS = 1  # Mono
