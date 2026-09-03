"""`HF_HOME` is DECLARED service configuration, not shell inheritance.

The failure this pins is not hypothetical. original "validated
against real downloaded weights" claim was unsubstantiated because `HF_HOME`
was exported only in the operator's `~/.zshrc`. That file is sourced by
INTERACTIVE shells; the non-interactive shells services, CI jobs and coding
agents run in never see it. Every download therefore went to the huggingface
default (`~/.cache/huggingface`) instead of the external volume, and the
weights the throughput table claimed to measure did not exist.

So the contract is: the value reaches the process through the ONE canonical
loader (`hope_env.load_env()`, already called by `nlp.core.config`), is
declared on the settings object, and is applied to `os.environ` before any
huggingface library reads it. No new dotenv loader, no module-scope
`load_dotenv()`.
"""

from __future__ import annotations

import os
from pathlib import Path


def test_hf_home_is_declared_on_the_service_settings() -> None:
    """The value is a declared field, so it is visible and testable."""
    from nlp.core.config import NLPServiceConfig

    assert "hf_home" in NLPServiceConfig.model_fields


def test_hf_home_reads_the_unprefixed_env_var(monkeypatch) -> None:
    """`HF_HOME` is unprefixed — it belongs to the ML stack, not to `apps/nlp`."""
    from nlp.core.config import NLPServiceConfig

    monkeypatch.setenv("HF_HOME", "/tmp/hope-hf-cache-test")
    assert NLPServiceConfig().hf_home == "/tmp/hope-hf-cache-test"


def test_applying_it_exports_to_os_environ_for_the_hf_libraries(monkeypatch) -> None:
    """huggingface_hub reads `os.environ`, so a declared value must land there.

    Import ORDER is the whole point: a settings field nothing exports is
    documentation, and `huggingface_hub` snapshots its cache constants at
    import time.
    """
    from nlp.core.config import NLPServiceConfig, apply_hf_home

    monkeypatch.delenv("HF_HOME", raising=False)
    apply_hf_home(NLPServiceConfig(hf_home="/tmp/hope-hf-cache-applied"))
    assert os.environ["HF_HOME"] == "/tmp/hope-hf-cache-applied"


def test_absent_value_leaves_the_huggingface_default_alone(monkeypatch) -> None:
    """Unset means "use the HF default" — never an invented path."""
    from nlp.core.config import NLPServiceConfig, apply_hf_home

    monkeypatch.delenv("HF_HOME", raising=False)
    apply_hf_home(NLPServiceConfig(hf_home=""))
    assert "HF_HOME" not in os.environ


def test_the_env_sample_documents_it() -> None:
    """An undeclared `SERVICE_*`-class var is an ungoverned config surface."""
    sample = Path(__file__).resolve().parents[1] / ".env.sample"
    assert "HF_HOME=" in sample.read_text()
