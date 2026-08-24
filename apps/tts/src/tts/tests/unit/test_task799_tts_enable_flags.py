"""TASK-799 lane H — the five engine/provider `*_ENABLED` flags, half-migrated.

WHAT "HALF-MIGRATED" MEANS HERE, AND WHY IT IS THE CORRECT END STATE FOR NOW
-----------------------------------------------------------------------------
Closing a config path is a THREE-step change, and only two of the three steps
live in this repository:

    1. seed the `GlobalSetting` rows            → `seed/11d-tts-engine-flags.ts`
    2. update the k8s manifests to stop setting them
                                                → `arca/hope-v2-deployment`, NOT here
    3. close the env read (`moved_alias`)       → this repo, but ONLY after (2)

Doing (3) before (2) reproduces a real outage: `hope-tts` answered
`/health/ready` with 503 forever, its Service carried no endpoints, and
`TTS_URL` resolved to nothing — the condition `test_keyless_readiness_task642`
exists to pin. `TTS_KOKORO_ENABLED=true` in the live ConfigMap is what makes a
keyless deployment Ready at all.

So this lane does (1) and the READ half of (3): the flags are now SERVED by the
control plane, while `TTS_*_ENABLED` stays a live bootstrap fallback. The
precedence rule that makes both true at once is the subject of this module:

    a control-plane entry overrides env  ⇔  it is a real DATABASE opinion
                                            (`source == "db"`)

An entry sourced `env-fallback` is the gateway reporting that NO row answered
and it resolved the descriptor default. For a key whose env path is closed that
default IS the value, so it must be applied. For these five it is not: the
operator's `TTS_KOKORO_ENABLED=true` is the live value, and overwriting it with
a descriptor default of `False` is precisely the 503 above. Hence
`ENV_BOOTSTRAP_KEYS`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tts.core.config import Settings
from tts.core.control_plane import (
    CONTROL_PLANE_KEYS,
    ENV_BOOTSTRAP_KEYS,
    apply_control_plane,
)

#: (dotted settings path, registry key, the env var that still bootstraps it).
FLAGS: list[tuple[str, str, str]] = [
    ("azure.enabled", "tts.azure.enabled", "TTS_AZURE_ENABLED"),
    ("sarvam.enabled", "tts.sarvam.enabled", "TTS_SARVAM_ENABLED"),
    ("kokoro.enabled", "tts.kokoro.enabled", "TTS_KOKORO_ENABLED"),
    ("indic_parler.enabled", "tts.parler.enabled", "TTS_PARLER_ENABLED"),
    ("indic_f5.enabled", "tts.indicf5.enabled", "TTS_INDICF5_ENABLED"),
]


def _snapshot(block: dict[str, object]) -> dict[str, object]:
    return {"service": "tts", "settings": block}


def _entry(value: object, source: str) -> dict[str, object]:
    return {"value": value, "dataType": "boolean", "source": source}


class TestTheFlagsAreOnTheControlPlane:
    @pytest.mark.parametrize(("path", "key", "_env"), FLAGS)
    def test_the_flag_is_a_declared_control_plane_key(self, path: str, key: str, _env: str) -> None:
        assert CONTROL_PLANE_KEYS.get(path) == key

    @pytest.mark.parametrize(("path", "key", "_env"), FLAGS)
    def test_a_seeded_row_wins_over_the_env_default(self, path: str, key: str, _env: str) -> None:
        """A `db`-sourced value is the platform's decision and takes effect."""
        settings = Settings()
        applied = apply_control_plane(settings, _snapshot({key: _entry(True, "db")}))

        assert path in applied
        group, field = path.split(".")
        assert getattr(getattr(settings, group), field) is True


class TestEnvStaysTheBootstrapFallback:
    """The half that makes the readiness regression structurally impossible."""

    @pytest.mark.parametrize(("path", "key", "env_var"), FLAGS)
    def test_an_env_fallback_entry_never_overwrites_the_env_value(
        self, path: str, key: str, env_var: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """No row ⇒ the gateway serves the descriptor default, labelled
        `env-fallback`. That is an ABSENCE of opinion, not an opinion of
        `False`, and it must leave the operator's ConfigMap value standing."""
        monkeypatch.setenv(env_var, "true")
        settings = Settings()
        group, field = path.split(".")
        assert getattr(getattr(settings, group), field) is True

        applied = apply_control_plane(settings, _snapshot({key: _entry(False, "env-fallback")}))

        assert path not in applied
        assert getattr(getattr(settings, group), field) is True

    def test_kokoro_specifically_survives_an_unseeded_control_plane(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The named outage, pinned by name.

        `TTS_KOKORO_ENABLED=true` + a control plane with no seeded row is
        exactly the state of a deployment that upgrades before the manifests in
        `arca/hope-v2-deployment` are touched. It must still register kokoro.
        """
        monkeypatch.setenv("TTS_KOKORO_ENABLED", "true")
        settings = Settings()
        apply_control_plane(
            settings,
            _snapshot({"tts.kokoro.enabled": _entry(False, "env-fallback")}),
        )
        assert settings.kokoro.enabled is True

    @pytest.mark.parametrize(("path", "key", "_env"), FLAGS)
    def test_every_flag_is_declared_as_an_env_bootstrap_key(
        self, path: str, key: str, _env: str
    ) -> None:
        assert key in ENV_BOOTSTRAP_KEYS

    def test_no_key_whose_env_path_is_closed_is_declared_a_bootstrap_key(self) -> None:
        """The gate is narrow ON PURPOSE.

        For a migrated knob the env path is dead (`moved_alias`), so an
        `env-fallback` value is the ONLY value there will ever be and skipping
        it would strand the field on a stale bootstrap. Widening this set to
        every key would do exactly that.
        """
        assert ENV_BOOTSTRAP_KEYS <= set(CONTROL_PLANE_KEYS.values())
        assert ENV_BOOTSTRAP_KEYS == {key for _, key, _ in FLAGS}


class TestReadinessCannotRegressAtRuntime:
    """WHEN a served flag takes effect, and why that answers the readiness question.

    `apply_control_plane` runs on the READ-TRIGGERED refresh path
    (`effective_config.refresh_model_cache_retention`), not at boot — this
    service's boot contract is that construction performs no I/O, and a
    gateway call on the startup path would put `hope-tts` back to failing to
    start whenever the gateway is down.

    Provider REGISTRATION, however, happens once in the lifespan from
    `Settings`. So a served flag converges on the next restart, exactly as the
    env var always did — what changes is that flipping it is now a SUPER_ADMIN
    write instead of a manifest change in another repository.

    The safety consequence is the one worth pinning: because nothing outside
    boot registration reads these fields, an overlay arriving mid-process can
    NEVER deregister a live provider. Readiness cannot regress at runtime, only
    at a restart the operator asked for.
    """

    def test_the_enable_flags_are_read_only_by_boot_registration(self) -> None:
        """Grep the source, not the behaviour — the invariant IS "one reader".

        A second reader (a `/providers` handler, the router, a provider factory)
        would make a served value take effect mid-process, and a value of
        `False` arriving while the engine is registered would then remove the
        only route a keyless deployment has. That is the 503-forever outage,
        reintroduced from a new direction.
        """
        src = Path(__file__).resolve().parents[2]
        readers: list[str] = []
        for path in src.rglob("*.py"):
            if "tests" in path.parts:
                continue
            for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                for group in ("azure", "sarvam", "kokoro", "indic_parler", "indic_f5"):
                    if f"settings.{group}.enabled" in line:
                        readers.append(f"{path.relative_to(src)}:{lineno}")

        assert readers, "expected boot registration to read the flags"
        assert {r.split(":")[0] for r in readers} == {
            "main.py"
        }, f"the enable flags must be read ONLY by boot registration; also read at: {readers}"


class TestTheLicensingGateHasARealHome:
    def test_indicf5_is_governed_rather_than_comment_enforced(self) -> None:
        """`tts.indicf5.enabled` gates CC-BY-NC weights.

        Until this lane the restriction was enforced only by a docstring. Being
        a control-plane key makes enabling it a SUPER_ADMIN write against a
        `locked` row with an audit trail — which is the whole point of moving
        this one.
        """
        assert CONTROL_PLANE_KEYS["indic_f5.enabled"] == "tts.indicf5.enabled"
        assert Settings().indic_f5.enabled is False
