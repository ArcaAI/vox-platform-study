"""TASK-778 (owner addition) — a model reference is a HUB ID **or** a LOCAL PATH.

The gliner2 loader takes either form. The catalog must therefore let a super
admin (SYSTEM tier) and a tenant admin (tenant tier) store either, and nlp must
resolve both — WITHOUT constraining the stored value to a hub-id pattern.

The load-bearing rule is the failure posture. TASK-735's resolver treated a
set-but-missing local path as a WARNING and fell through to the hub id. For the
guard plane that is wrong twice over:

* it silently downloads from the internet on an air-gapped clinical host that
  deliberately staged its weights, and
* it serves a DIFFERENT model than the admin configured, with no error anywhere.

So the guard plane fails CLOSED on an unusable path, with an attributable error.
"""

from __future__ import annotations

import pytest

from nlp.core.guard_model_reference import (
    GuardModelReferenceError,
    is_local_reference,
    resolve_guard_weights_source,
)


class TestFormDiscrimination:
    """How the two forms are told apart — deterministic, never a filesystem probe."""

    @pytest.mark.parametrize(
        "reference",
        ["/opt/models/pii", "~/models/pii", "./staged/pii", "../staged/pii", "file:///opt/pii"],
    )
    def test_path_shaped_references_are_local(self, reference: str) -> None:
        assert is_local_reference(reference) is True

    @pytest.mark.parametrize(
        "reference", ["acme/pii-detector", "bert-base-uncased", "org/Model.v2"]
    )
    def test_bare_ids_are_hub_references(self, reference: str) -> None:
        assert is_local_reference(reference) is False


class TestResolution:
    def test_a_hub_id_is_passed_through_untouched(self) -> None:
        assert resolve_guard_weights_source("acme/pii-detector", None) == "acme/pii-detector"

    def test_an_existing_local_path_reference_resolves_to_that_path(self, tmp_path) -> None:
        staged = tmp_path / "pii"
        staged.mkdir()
        assert resolve_guard_weights_source(str(staged), None) == str(staged)

    def test_the_explicit_model_path_column_still_wins(self, tmp_path) -> None:
        staged = tmp_path / "pii"
        staged.mkdir()
        assert resolve_guard_weights_source("acme/pii-detector", str(staged)) == str(staged)

    def test_a_missing_model_path_fails_closed_and_never_falls_back_to_the_hub(self) -> None:
        with pytest.raises(GuardModelReferenceError) as excinfo:
            resolve_guard_weights_source("acme/pii-detector", "/nonexistent/staged/pii")
        message = str(excinfo.value)
        assert "/nonexistent/staged/pii" in message, "the error must name the offending path"
        assert "acme/pii-detector" in message, "the error must be attributable to the model"

    def test_a_missing_path_shaped_source_uri_fails_closed(self) -> None:
        with pytest.raises(GuardModelReferenceError):
            resolve_guard_weights_source("/nonexistent/staged/pii", None)

    def test_an_unreadable_path_fails_closed(self, tmp_path) -> None:
        staged = tmp_path / "locked"
        staged.mkdir()
        staged.chmod(0o000)
        try:
            with pytest.raises(GuardModelReferenceError):
                resolve_guard_weights_source(str(staged), None)
        finally:
            staged.chmod(0o755)

    def test_an_empty_reference_fails_closed(self) -> None:
        with pytest.raises(GuardModelReferenceError):
            resolve_guard_weights_source("", None)


class TestAllowedRoots:
    """The bounding a tenant-supplied filesystem path gets when an operator asks for it."""

    def test_unset_roots_means_no_restriction(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr("nlp.core.guard_model_reference._allowed_roots", lambda: [])
        staged = tmp_path / "anywhere"
        staged.mkdir()
        assert resolve_guard_weights_source(str(staged), None) == str(staged)

    def test_a_path_outside_the_configured_roots_is_refused(self, tmp_path, monkeypatch) -> None:
        allowed = tmp_path / "allowed"
        allowed.mkdir()
        outside = tmp_path / "elsewhere"
        outside.mkdir()
        monkeypatch.setattr("nlp.core.guard_model_reference._allowed_roots", lambda: [str(allowed)])
        with pytest.raises(GuardModelReferenceError, match="outside"):
            resolve_guard_weights_source(str(outside), None)

    def test_traversal_out_of_an_allowed_root_is_refused(self, tmp_path, monkeypatch) -> None:
        allowed = tmp_path / "allowed"
        (allowed / "inner").mkdir(parents=True)
        monkeypatch.setattr("nlp.core.guard_model_reference._allowed_roots", lambda: [str(allowed)])
        with pytest.raises(GuardModelReferenceError, match="outside"):
            resolve_guard_weights_source(str(allowed / "inner" / ".." / ".." / "elsewhere"), None)
