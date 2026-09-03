"""`nlp.dependencies._weights_source` s3:// / file:// wiring ( +
follow-on).

Two things pinned here that the resolver's own conformance suite
(`test_model_source_resolver.py`) and the credential client's own suite
(`test_model_credentials.py`) cannot see from inside those modules:

1. An `s3://` `model_name` actually reaches the resolver via the CREDENTIALED
   config builder (`nlp.models.source_resolver.config_for_model`), not the
   bare one.
2. A `file://` `model_name` deliberately does NOT — it must resolve even when
   the gateway is unreachable, because it names an on-prem path that needs no
   credential at all. Routing it through `config_for_model` would make a
   local-file resolve depend on a network call it never needed, which is
   exactly the regression this test guards against.
"""

from __future__ import annotations

from pathlib import Path

from nlp.dependencies import _weights_source


async def test_s3_uri_goes_through_the_credentialed_config_builder(monkeypatch) -> None:
    seen: dict = {}

    async def _fake_config_for_model(settings):
        seen["called"] = True
        from nlp.models.source_resolver import ModelSourceConfig

        return ModelSourceConfig(cache_dir="/tmp/cache-doesnt-matter")

    def _explode_if_credential_free_path_used(settings):  # pragma: no cover
        raise AssertionError("s3:// must not use the credential-free config builder")

    monkeypatch.setattr("nlp.models.source_resolver.config_for_model", _fake_config_for_model)
    monkeypatch.setattr(
        "nlp.models.source_resolver.config_from_settings", _explode_if_credential_free_path_used
    )

    async def _fake_resolve_model_dir(identity, *, config, allow_network=True):
        return Path("/resolved/s3/dir")

    monkeypatch.setattr("nlp.models.source_resolver.resolve_model_dir", _fake_resolve_model_dir)

    result = await _weights_source("s3://bucket/prefix", None)

    assert result == "/resolved/s3/dir"
    assert seen.get("called") is True


async def test_file_uri_never_touches_the_credentialed_config_builder(monkeypatch) -> None:
    """A pre-staged on-prem `file://` path must resolve without a gateway call."""

    def _explode_if_credentialed_path_used(settings):  # pragma: no cover
        raise AssertionError("file:// must never build a credentialed config")

    def _fake_config_from_settings(settings):
        from nlp.models.source_resolver import ModelSourceConfig

        return ModelSourceConfig(cache_dir="/tmp/cache-doesnt-matter")

    monkeypatch.setattr(
        "nlp.models.source_resolver.config_for_model", _explode_if_credentialed_path_used
    )
    monkeypatch.setattr(
        "nlp.models.source_resolver.config_from_settings", _fake_config_from_settings
    )

    async def _fake_resolve_model_dir(identity, *, config, allow_network=True):
        return Path("/resolved/file/dir")

    monkeypatch.setattr("nlp.models.source_resolver.resolve_model_dir", _fake_resolve_model_dir)

    result = await _weights_source("file:///staged/model", None)

    assert result == "/resolved/file/dir"


async def test_hf_bare_id_never_touches_the_resolver_at_all(monkeypatch) -> None:
    """Unchanged earlier behaviour: a hub id passes straight through."""

    def _explode(settings):  # pragma: no cover
        raise AssertionError("a bare hub id must never invoke the resolver")

    monkeypatch.setattr("nlp.models.source_resolver.config_for_model", _explode)
    monkeypatch.setattr("nlp.models.source_resolver.config_from_settings", _explode)

    result = await _weights_source("org/repo", None)

    assert result == "org/repo"


async def test_local_path_still_wins_over_an_s3_model_name(tmp_path: Path) -> None:
    """Mode M precedence is unchanged: a usable `model_path` wins outright,
    with no resolver call at all — even when `model_name` is an `s3://` URI."""
    staged = tmp_path / "staged"
    staged.mkdir()

    result = await _weights_source("s3://bucket/prefix", str(staged))

    assert result == str(staged)
