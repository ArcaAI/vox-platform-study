"""TASK-877 — punctuation is decided by the agent's spec, not by two platform keys.

Before this ticket the boot gate at ``initialize()`` read ``stt.punctuation.enabled``
(default OFF) and returned early, so ``postProcessing.punctuation.enabled: true`` on a
`ResolvedAsrSpec` was VETOED for every session; and ``stt.punctuation.modelName``
duplicated ``models.punctuation.slug``, deciding which model ran whenever the spec
did not name one.

Both are deleted. What survives is the per-model lazy load that was already there —
now keyed on the SPEC's model slug — plus the fail-safe latch: a model that cannot
load (the legacy `cadence` wrapper under the pinned transformers 5.x) degrades to
passthrough exactly once per process instead of retrying per utterance.

``stt.punctuation.{device,modelCacheDir,maxLength}`` are KEPT: placement and cache
location are platform properties of the host, not agent behaviour.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from stt.punctuation import service


@pytest.fixture(autouse=True)
def _reset() -> None:
    service._models.clear()
    service._default_model_name = None
    service._enabled = True
    service._suppression_warned = False
    service._init_done = False
    yield
    service._models.clear()
    service._default_model_name = None
    service._enabled = True
    service._suppression_warned = False
    service._init_done = False


def _settings() -> MagicMock:
    """Only the three KEPT platform knobs — the deleted two must not be consulted."""
    settings = MagicMock(
        spec=["punctuation_device", "punctuation_model_cache_dir", "punctuation_max_length"]
    )
    settings.punctuation_device = "cpu"
    settings.punctuation_model_cache_dir = None
    settings.punctuation_max_length = 300
    return settings


@patch("stt.punctuation.service.get_settings")
def test_the_spec_model_is_loaded_with_no_platform_key_in_sight(mock_settings) -> None:
    """`spec.models.punctuation.slug` reaches the loader.

    `_settings()` is `spec=`-restricted, so a surviving read of
    `punctuation_enabled` or `punctuation_model_name` raises AttributeError here
    rather than passing quietly.
    """
    mock_settings.return_value = _settings()
    loaded = MagicMock()
    with patch.dict(
        "sys.modules", {"cadence": MagicMock(PunctuationModel=MagicMock(return_value=loaded))}
    ):
        assert service.ensure_initialized("Cadence-Fast") is True
        assert service.get_model("Cadence-Fast") is loaded


@patch("stt.punctuation.service.get_settings")
def test_no_platform_kill_switch_can_veto_the_agent(mock_settings) -> None:
    """The former `stt.punctuation.enabled` default-OFF veto is gone."""
    mock_settings.return_value = _settings()
    with patch.dict("sys.modules", {"cadence": MagicMock(PunctuationModel=MagicMock())}):
        assert service.ensure_initialized("Cadence-Fast") is True


@patch("stt.punctuation.service.get_settings")
async def test_punctuate_uses_the_spec_model(mock_settings) -> None:
    mock_settings.return_value = _settings()
    model = MagicMock()
    model.punctuate.return_value = ["Hello, world."]
    with patch.dict(
        "sys.modules", {"cadence": MagicMock(PunctuationModel=MagicMock(return_value=model))}
    ):
        assert await service.punctuate("hello world", model_name="Cadence-Fast") == "Hello, world."


async def test_punctuate_passes_through_when_the_agent_bound_no_model() -> None:
    """No `models.punctuation` on the spec ⇒ nothing to load, so text passes through.

    This used to be impossible to express: the service always had a default model
    name from `stt.punctuation.modelName`.
    """
    assert await service.punctuate("hello world") == "hello world"
    assert service._models == {}


@patch("stt.punctuation.service.get_settings")
async def test_a_model_that_cannot_load_degrades_to_passthrough_once(mock_settings) -> None:
    """The legacy `cadence` wrapper cannot load under the pinned transformers 5.x.

    That was the stated reason `stt.punctuation.enabled` defaulted OFF. The latch
    below is why the kill-switch is not needed to contain it: the failure is
    absorbed once per process, not per utterance.
    """
    mock_settings.return_value = _settings()
    boom = MagicMock(side_effect=RuntimeError("FATAL: Error loading model"))
    with patch.dict("sys.modules", {"cadence": MagicMock(PunctuationModel=boom)}):
        assert await service.punctuate("hello world", model_name="Cadence") == "hello world"
        assert service._enabled is False
        # Latched: a second utterance does not re-attempt the failing load.
        assert await service.punctuate("and again", model_name="Cadence") == "and again"
    assert boom.call_count == 1


@patch("stt.punctuation.service.get_settings")
def test_initialize_without_a_model_name_warms_nothing(mock_settings) -> None:
    """Process boot has no spec, so there is no model to warm — and that is not a failure."""
    mock_settings.return_value = _settings()
    assert service.initialize() is False
    assert service._models == {}
