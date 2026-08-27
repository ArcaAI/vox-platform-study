"""TASK-817 (F-2) — guardrail's image must not advertise a model cache it has no use for.

Guardrail hosted a GLiNER ONNX runtime and MiniCheck weights until TASK-735
Phase 3 moved both to `apps/nlp`. The move took the models, the engines and the
dependencies — `pyproject.toml` no longer installs `transformers`,
`huggingface_hub`, `torch`, `onnxruntime` or `gliner2-onnx` — but it left the
Dockerfile's `HF_HOME`, its `TRANSFORMERS_OFFLINE` companion, the `mkdir`/`chown`
that provisioned the cache directory, and a header comment instructing the
operator to "Mount a persistent volume at /app/.hf-cache to avoid
re-downloading".

Nothing in the image can read any of it. `core/dependencies.py` states the
post-move position outright: "Guardrail holds ZERO resident model weights."

This is not cosmetic. TASK-817 exists because `hope-nlp` — the service that DOES
load weights — has no persistent cache, and the single most likely way to get
that wrong is to wire a volume to the wrong place (F-4: three services already
use three different env vars and three mount paths for one shared directory).
A Dockerfile that tells an operator guardrail needs a model cache is an active
false lead while exactly that class of mistake is being fixed.

Asserted against the Dockerfile rather than the runtime because that is where
the dead configuration lives and where a copy-paste from a sibling service would
reintroduce it.
"""

import re
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[3] / "Dockerfile"

#: Every HuggingFace cache knob. A service that loads no weights should name none
#: of them — `HF_HOME` was the one that survived, but a future edit is as likely
#: to reach for `HF_HUB_CACHE` (which `apps/tts` uses) or `TRANSFORMERS_CACHE`.
HF_CACHE_ENV_VARS = (
    "HF_HOME",
    "HF_HUB_CACHE",
    "HUGGINGFACE_CACHE_DIR",
    "TRANSFORMERS_CACHE",
    "TRANSFORMERS_OFFLINE",
    "HF_HUB_OFFLINE",
)


def _dockerfile() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def _instructions() -> str:
    """The Dockerfile with comment lines stripped.

    What must not exist is a DECLARATION. A comment naming these variables is
    the opposite — it is the note telling the next reader not to reintroduce
    them, and scanning it would make this test forbid its own remedy.
    """
    return "\n".join(
        line for line in _dockerfile().splitlines() if not line.lstrip().startswith("#")
    )


def test_dockerfile_declares_no_huggingface_cache_env() -> None:
    text = _instructions()
    found = [name for name in HF_CACHE_ENV_VARS if re.search(rf"\b{name}\b", text)]
    assert not found, (
        f"apps/guardrail/Dockerfile still declares {', '.join(found)}. Guardrail has "
        "held zero model weights since TASK-735 Phase 3 and installs no huggingface "
        "library, so nothing in the image can read these. They imply a model cache "
        "that does not exist."
    )


def test_dockerfile_provisions_no_model_cache_directory() -> None:
    text = _instructions()
    assert ".hf-cache" not in text, (
        "apps/guardrail/Dockerfile still creates/chowns or documents /app/.hf-cache. "
        "Nothing writes to it — the directory and the 'mount a persistent volume "
        "here' instruction both outlived the models they were added for."
    )
