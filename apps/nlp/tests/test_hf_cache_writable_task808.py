"""TASK-808 — the image must give huggingface_hub a writable cache directory.

`hope-python-base` creates the non-root `hope` user with ``--no-create-home``,
so ``$HOME`` (/home/hope) does not exist in the container. huggingface_hub
defaults its cache to ``~/.cache/huggingface``, which therefore resolves to an
uncreatable path and EVERY weight download fails. On `hope-v2-dev` that
surfaced as::

    Token classification model load failed: PermissionError at /home/hope
    when downloading blaze999/Medical-NER

and ``/classify/tokens`` never became usable.

`core/config.py` reads ``HF_HOME`` with an EMPTY default and only re-exports it
into ``os.environ`` when it is non-empty, so the service cannot supply this for
itself — the image has to. `apps/guardrail`, `apps/tts` and `apps/stt` already
do; `apps/nlp` was the one that did not.

This asserts the Dockerfile, not the runtime, because that is where the defect
lived and where a future edit would reintroduce it.
"""

import re
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"


def _production_stage() -> str:
    text = DOCKERFILE.read_text(encoding="utf-8")
    marker = "AS production"
    index = text.find(marker)
    assert index != -1, "apps/nlp/Dockerfile no longer has a stage named `production`"
    return text[index:]


def test_production_stage_sets_hf_home() -> None:
    match = re.search(r"HF_HOME=(\S+)", _production_stage())
    assert match, (
        "apps/nlp/Dockerfile's production stage does not set HF_HOME. Without it "
        "huggingface_hub writes to ~/.cache/huggingface, and $HOME does not exist "
        "in hope-python-base, so every model download fails with PermissionError."
    )
    assert match.group(1).startswith("/app/"), (
        f"HF_HOME={match.group(1)} is outside /app. The `hope` user owns /app; "
        "anywhere else is not writable in the running container."
    )


def test_hf_cache_directory_is_created_and_owned_by_hope() -> None:
    stage = _production_stage()
    hf_home = re.search(r"HF_HOME=(\S+)", stage).group(1)
    assert f"mkdir -p {hf_home}" in stage, (
        f"HF_HOME points at {hf_home} but the Dockerfile never creates it."
    )
    assert re.search(r"chown -R hope:hope\s+/app/\.cache", stage), (
        "the HF cache directory is created but never chowned to hope:hope, so the "
        "non-root runtime user still cannot write into it."
    )
