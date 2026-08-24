"""TASK-799 lane D — apps/nlp's env surface.

Five reductions, each of a different kind:

* D.1a — the nine `NLP_INFERENCE_*` queue/batch knobs become ONE control-plane
  group. They are platform-scope service geometry with no tenant opinion, which
  is exactly the class D-1 puts on the PULL route. `NLP_INFERENCE_DEVICE` and
  `NLP_INFERENCE_DEVICE_CPU_ONLY_MODULES` stay in env: they are host FACTS (what
  hardware this process has, and which submodules the installed torch build
  crashes on), not platform policy.
* D.1b — four fields the control plane was ALREADY authoritative for
  (`inference.maxConcurrent`, `peerCall.maxConcurrent`,
  `modelCache.{ttlSeconds,maxModels}`) still carried an env path. A second way to
  set a value the control plane owns is a way for the two to disagree.
* D.1c — `NLP_EXTERNAL_TEXT_BASE_URL` duplicated the repo-wide `TEXT_URL`
  (guardrail already aliases it), and two legacy service tokens duplicated
  `INTERNAL_ACCESS_TOKEN`.
* D.1d — nine `LOG_*` file/rotation knobs move to a `global-kv` group, and the
  `LOG_CONSOLE_JSON_FORMAT` / `LOG_FILE_JSON_FORMAT` split defaults are made
  explicit rather than accidental.
* D.1e — `core/model_source.py` is deleted: ~400 lines whose only importer was
  its own test, and whose error text told operators to set S3 credential
  variables that no settings class has ever declared.
"""

from __future__ import annotations

import pytest

from nlp.core.config import ExternalTextConfig, NLPServiceConfig
from nlp.core.effective_config import EffectiveConfigSnapshot


def _snapshot(**values: object) -> EffectiveConfigSnapshot:
    """A wire-shaped snapshot carrying the GENERIC `settings` map."""
    return EffectiveConfigSnapshot(
        raw={"settings": {k: {"value": v} for k, v in values.items()}}, ok=True
    )


class TestBatchGeometryRidesTheControlPlane:
    """D.1a — nine knobs, one group, no env path."""

    _GONE = (
        "NLP_INFERENCE_BATCH_MAX_SIZE",
        "NLP_INFERENCE_BATCH_LINGER_MS",
        "NLP_INFERENCE_QUEUE_MAX_DEPTH",
        "NLP_INFERENCE_QUEUE_MAX_WAIT_SECONDS",
        "NLP_INFERENCE_MAX_INFLIGHT_BATCHES",
        "NLP_INFERENCE_INTERACTIVE_BATCH_MAX_SIZE",
        "NLP_INFERENCE_INTERACTIVE_BATCH_LINGER_MS",
        "NLP_INFERENCE_INTERACTIVE_QUEUE_MAX_DEPTH",
        "NLP_INFERENCE_INTERACTIVE_QUEUE_MAX_WAIT_SECONDS",
    )

    @pytest.mark.parametrize("name", _GONE)
    def test_env_can_no_longer_move_the_geometry(
        self, name: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Each field keeps its bootstrap-floor value as the runtime carrier;
        what is gone is the env PATH that let a host override the platform."""
        baseline = NLPServiceConfig()
        field = name.removeprefix("NLP_").lower()

        monkeypatch.setenv(name, "77")
        assert getattr(NLPServiceConfig(), field) == getattr(baseline, field)

    def test_the_device_knobs_STAY_in_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Deliberately NOT migrated. `inference_device` is a HOST fact — which
        accelerator this pod has — and `..._cpu_only_modules` is a
        runtime-compatibility fact about the installed torch/gliner2 build (a
        submodule that SIGABRTs on MPS). Neither is platform policy, and serving
        either from the control plane would push one host's hardware onto all."""
        monkeypatch.setenv("NLP_INFERENCE_DEVICE", "mps")
        monkeypatch.setenv("NLP_INFERENCE_DEVICE_CPU_ONLY_MODULES", "foo.bar")

        config = NLPServiceConfig()
        assert config.inference_device == "mps"
        assert config.inference_device_cpu_only_modules == "foo.bar"

    def test_the_snapshot_reads_the_generic_settings_map(self) -> None:
        served = _snapshot(
            **{
                "nlp.inference.batchMaxSize": 32,
                "nlp.inference.batchLingerMs": 9,
                "nlp.inference.queueMaxDepth": 512,
                "nlp.inference.queueMaxWaitSeconds": 30,
                "nlp.inference.maxInflightBatches": 4,
                "nlp.interactiveInference.batchMaxSize": 3,
                "nlp.interactiveInference.batchLingerMs": 1,
                "nlp.interactiveInference.queueMaxDepth": 128,
                "nlp.interactiveInference.queueMaxWaitSeconds": 5,
            }
        ).batching()

        assert served["bulk"] == {
            "max_batch_size": 32,
            "linger_ms": 9,
            "max_queue": 512,
            "max_wait_s": 30.0,
        }
        assert served["interactive"] == {
            "max_batch_size": 3,
            "linger_ms": 1,
            "max_queue": 128,
            "max_wait_s": 5.0,
        }
        assert served["max_inflight_batches"] == 4

    def test_no_opinion_yields_nothing_rather_than_a_guess(self) -> None:
        """A failed fetch must leave the running geometry alone. Coercing an
        absent queue bound into a real number is how a bounded queue silently
        becomes an unbounded one."""
        assert EffectiveConfigSnapshot(raw={}, ok=False).batching() == {}

    def test_a_partial_opinion_carries_only_what_was_served(self) -> None:
        served = _snapshot(**{"nlp.inference.batchMaxSize": 16}).batching()
        assert served == {"bulk": {"max_batch_size": 16}}

    @pytest.mark.parametrize("bad", [0, -1, None, "8", True])
    def test_a_nonsensical_bound_is_never_adopted(self, bad: object) -> None:
        assert _snapshot(**{"nlp.inference.queueMaxDepth": bad}).batching() == {}


class TestAlreadyAuthoritativeKnobsLoseTheirEnvPath:
    """D.1b — one owner per value."""

    @pytest.mark.parametrize(
        ("name", "field"),
        [
            ("NLP_INFERENCE_MAX_CONCURRENT", "inference_max_concurrent"),
            ("NLP_PEER_CALL_MAX_CONCURRENT", "peer_call_max_concurrent"),
            ("NLP_MODEL_CACHE_TTL_SECONDS", "model_cache_ttl_seconds"),
            ("NLP_MODEL_CACHE_MAX_MODELS", "model_cache_max_models"),
        ],
    )
    def test_env_can_no_longer_move_it(
        self, name: str, field: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        baseline = getattr(NLPServiceConfig(), field)
        monkeypatch.setenv(name, "99")
        assert getattr(NLPServiceConfig(), field) == baseline


class TestPeerAddressAndTokenAreNotDuplicated:
    """D.1c — one name per concept."""

    def test_the_peer_base_url_reads_the_repo_wide_TEXT_URL(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`NLP_EXTERNAL_TEXT_BASE_URL` was a second name for `TEXT_URL`, which
        every other service already uses for the same address (guardrail aliases
        it). Two names for one endpoint is how half a fleet gets redirected."""
        monkeypatch.setenv("TEXT_URL", "http://text.internal:8862")
        assert ExternalTextConfig().base_url == "http://text.internal:8862"

    def test_the_retired_name_no_longer_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TEXT_URL", "http://text.internal:8862")
        monkeypatch.setenv("NLP_EXTERNAL_TEXT_BASE_URL", "http://stale:9999")
        assert ExternalTextConfig().base_url == "http://text.internal:8862"

    @pytest.mark.parametrize("legacy", ["NLP_SERVICE_TOKEN", "NLP_EXTERNAL_TEXT_SERVICE_TOKEN"])
    def test_the_legacy_per_service_tokens_are_gone(
        self, legacy: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Owner decision D-D: ONE shared `INTERNAL_ACCESS_TOKEN` for every
        internal hop. The legacy names were kept as a migration fallback; the
        migration is done, and a second accepted credential is a second thing to
        rotate and a second way to be silently unauthenticated."""
        monkeypatch.setenv(legacy, "legacy-secret")
        monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "shared-secret")

        config = NLPServiceConfig()
        assert config.accepted_service_tokens == ("shared-secret",)

    def test_the_shared_token_is_what_outbound_calls_present(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "shared-secret")
        assert NLPServiceConfig().peer_service_token() == "shared-secret"


class TestLoggingSinksAreConfigured:
    """D.1d — the file/rotation knobs, and the JSON-format mismatch."""

    def test_the_two_json_switches_are_declared_together(self) -> None:
        """They were sibling toggles with OPPOSITE defaults and no explanation:
        `LOG_FILE_JSON_FORMAT` defaulted True, `LOG_CONSOLE_JSON_FORMAT` False.
        The split is intentional (files are machine-read, consoles are
        human-read) — so it is now declared in one place instead of inferred
        from two scattered `os.getenv` calls."""
        from nlp.core.logging import LOG_SINK_DEFAULTS

        assert LOG_SINK_DEFAULTS["file_json_format"] is True
        assert LOG_SINK_DEFAULTS["console_json_format"] is False

    def test_every_file_rotation_knob_has_a_declared_default(self) -> None:
        from nlp.core.logging import LOG_SINK_DEFAULTS

        for key in (
            "file_enabled",
            "file_max_size",
            "file_max_files",
            "file_separate_error",
            "console_enabled",
            "rotation_when",
            "rotation_interval",
            "rotation_backup_count",
            "use_daily_rotation",
        ):
            assert key in LOG_SINK_DEFAULTS, f"{key} has no declared default"

    def test_the_control_plane_can_move_them(self) -> None:
        served = _snapshot(
            **{
                "nlp.logging.fileEnabled": True,
                "nlp.logging.rotationBackupCount": 14,
            }
        ).logging()
        assert served == {"file_enabled": True, "rotation_backup_count": 14}

    def test_no_opinion_leaves_the_declared_defaults(self) -> None:
        assert EffectiveConfigSnapshot(raw={}, ok=False).logging() == {}


class TestModelSourceIsDeleted:
    """D.1e — dead code that instructed operators to set phantom variables."""

    def test_the_module_is_gone(self) -> None:
        with pytest.raises(ModuleNotFoundError):
            import nlp.core.model_source  # noqa: F401
