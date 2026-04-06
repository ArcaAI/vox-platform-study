"""Comprehensive E2E tests for internal admin/debug endpoints.

Track C of TASK-019: Covers all /internal/* endpoints with full response
schema validation, edge cases, type checks, and state verification.

Endpoints under test:
  GET  /internal/cache/stats           — Model cache statistics
  POST /internal/cache/clear           — Clear the model cache
  GET  /internal/cache/model/{slug}    — Get cached model info
  GET  /internal/pipelines/loaded      — List pipelines with loaded models
  GET  /internal/sessions              — Active streaming sessions
  POST /internal/sessions/cleanup      — Clean up expired sessions
  GET  /internal/streaming/status      — Streaming module status

Anti-pattern audit:
  #1 No mocks — all tests hit real FastAPI app via testcontainers
  #2 No test-only production code — pure HTTP contract testing
  #3 N/A — zero mocking
  #4 Full response validation — headers, types, invariants, not just field presence
  #5 No conditional silent passes — every branch asserts or uses pytest.mark.xfail

Requires:
  - Monorepo test infra running: pnpm docker:test:up
  - Conda environment: arcaenv
  - NO ML deps required (CPU-only)
"""

from datetime import datetime

import pytest

# ============================================================================
# Helpers
# ============================================================================


def _assert_json_content_type(response) -> None:
    """Assert the response Content-Type is application/json."""
    ct = response.headers.get("content-type", "")
    assert "application/json" in ct, f"Expected application/json Content-Type, got: {ct!r}"


def _assert_iso8601_timestamp(value: str) -> datetime:
    """Assert a string is a valid ISO 8601 timestamp and return parsed dt."""
    assert isinstance(value, str), f"Expected str timestamp, got {type(value)}"
    assert len(value) > 0, "Timestamp must not be empty"
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:
        pytest.fail(f"Timestamp {value!r} is not valid ISO 8601: {exc}")


# ============================================================================
# C1: Cache Stats Endpoint — GET /internal/cache/stats
# ============================================================================


@pytest.mark.e2e
class TestCacheStatsEndpointE2E:
    """Comprehensive tests for GET /internal/cache/stats."""

    async def test_cache_stats_returns_200_with_json(self, configured_app):
        """Cache stats must return 200 with JSON content-type."""
        response = await configured_app.get("/internal/cache/stats")
        assert response.status_code == 200
        _assert_json_content_type(response)

    async def test_cache_stats_returns_complete_schema(self, configured_app):
        """All required fields must be present in cache stats response."""
        response = await configured_app.get("/internal/cache/stats")
        assert response.status_code == 200
        data = response.json()

        required_fields = [
            "total_models",
            "total_memory_mb",
            "max_models",
            "max_memory_mb",
            "hits",
            "misses",
            "evictions",
            "hit_rate",
            "models",
            "timestamp",
        ]
        for field in required_fields:
            assert field in data, f"Missing required field: {field}"

    async def test_cache_stats_field_types(self, configured_app):
        """Verify types of all cache stats fields match production route."""
        response = await configured_app.get("/internal/cache/stats")
        data = response.json()

        assert isinstance(data["total_models"], int)
        assert isinstance(data["total_memory_mb"], (int, float))
        assert isinstance(data["max_models"], int)
        assert isinstance(data["max_memory_mb"], (int, float))
        assert isinstance(data["hits"], int)
        assert isinstance(data["misses"], int)
        assert isinstance(data["evictions"], int)
        assert isinstance(data["hit_rate"], (int, float))
        assert isinstance(data["models"], list)
        assert isinstance(data["timestamp"], str)

    async def test_cache_stats_hit_rate_bounded(self, configured_app):
        """hit_rate must be between 0.0 and 1.0 inclusive."""
        response = await configured_app.get("/internal/cache/stats")
        data = response.json()
        assert 0.0 <= data["hit_rate"] <= 1.0, f"hit_rate out of range: {data['hit_rate']}"

    async def test_cache_stats_counters_non_negative(self, configured_app):
        """All counter fields must be >= 0 (no negative bookkeeping)."""
        response = await configured_app.get("/internal/cache/stats")
        data = response.json()

        for field in ("total_models", "total_memory_mb", "hits", "misses", "evictions"):
            assert data[field] >= 0, f"{field} is negative: {data[field]}"

    async def test_cache_stats_fresh_app_is_empty(self, configured_app):
        """Fresh app should have zero cached models and zero memory."""
        response = await configured_app.get("/internal/cache/stats")
        data = response.json()
        assert data["total_models"] == 0
        assert data["total_memory_mb"] == 0.0
        assert data["models"] == [], "Expected empty models list on fresh app"

    async def test_cache_stats_timestamp_is_valid(self, configured_app):
        """Timestamp must be a valid ISO 8601 datetime."""
        response = await configured_app.get("/internal/cache/stats")
        _assert_iso8601_timestamp(response.json()["timestamp"])

    async def test_cache_stats_max_memory_is_positive(self, configured_app):
        """max_memory_mb should be > 0 (config-derived limit)."""
        response = await configured_app.get("/internal/cache/stats")
        data = response.json()
        assert data["max_memory_mb"] > 0, "max_memory_mb should be positive (from settings)"

    async def test_cache_stats_consistency_invariant(self, configured_app):
        """total_models must not exceed max_models."""
        response = await configured_app.get("/internal/cache/stats")
        data = response.json()
        assert (
            data["total_models"] <= data["max_models"]
        ), f"total_models ({data['total_models']}) > max_models ({data['max_models']})"

    async def test_cache_stats_wrong_method_returns_405(self, configured_app):
        """POST to cache/stats should return 405 Method Not Allowed."""
        response = await configured_app.post("/internal/cache/stats")
        assert response.status_code == 405


# ============================================================================
# C2: Cache Clear Endpoint — POST /internal/cache/clear
# ============================================================================


@pytest.mark.e2e
class TestCacheClearEndpointE2E:
    """Comprehensive tests for POST /internal/cache/clear."""

    async def test_cache_clear_returns_200_with_json(self, configured_app):
        """Cache clear must return 200 with JSON content-type."""
        response = await configured_app.post("/internal/cache/clear")
        assert response.status_code == 200
        _assert_json_content_type(response)

    async def test_cache_clear_response_schema(self, configured_app):
        """Response must include status, models_cleared, and timestamp."""
        response = await configured_app.post("/internal/cache/clear")
        assert response.status_code == 200
        data = response.json()

        assert "status" in data
        assert "models_cleared" in data
        assert "timestamp" in data

    async def test_cache_clear_field_types(self, configured_app):
        """Verify types of clear response fields."""
        response = await configured_app.post("/internal/cache/clear")
        data = response.json()

        assert isinstance(data["status"], str)
        assert isinstance(data["models_cleared"], int)
        assert isinstance(data["timestamp"], str)

    async def test_cache_clear_on_empty_cache(self, configured_app):
        """Clearing empty cache should succeed with status=ok and 0 cleared."""
        response = await configured_app.post("/internal/cache/clear")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["models_cleared"] == 0

    async def test_cache_clear_is_idempotent(self, configured_app):
        """Three consecutive clears should all succeed identically."""
        for i in range(3):
            response = await configured_app.post("/internal/cache/clear")
            assert response.status_code == 200, f"Clear #{i+1} failed"
            data = response.json()
            assert data["status"] == "ok"
            assert data["models_cleared"] == 0

    async def test_cache_clear_side_effect_verified_via_stats(self, configured_app):
        """
        Behavioral test: clear cache, then verify stats shows empty.

        This tests a real cross-endpoint side effect (Anti-Pattern #1 fix).
        """
        # Act: clear the cache
        clear_resp = await configured_app.post("/internal/cache/clear")
        assert clear_resp.status_code == 200

        # Verify: side effect visible on stats endpoint
        stats_resp = await configured_app.get("/internal/cache/stats")
        stats = stats_resp.json()
        assert stats["total_models"] == 0
        assert stats["total_memory_mb"] == 0.0
        assert stats["models"] == []

    async def test_cache_clear_timestamp_is_valid(self, configured_app):
        """Timestamp in clear response must be valid ISO 8601."""
        response = await configured_app.post("/internal/cache/clear")
        _assert_iso8601_timestamp(response.json()["timestamp"])

    async def test_cache_clear_wrong_method_returns_405(self, configured_app):
        """GET to cache/clear should return 405 Method Not Allowed."""
        response = await configured_app.get("/internal/cache/clear")
        assert response.status_code == 405


# ============================================================================
# C3: Cache Model Lookup Endpoint — GET /internal/cache/model/{slug}
# ============================================================================


@pytest.mark.e2e
class TestCacheModelLookupE2E:
    """Comprehensive tests for GET /internal/cache/model/{slug}."""

    async def test_nonexistent_model_returns_404(self, configured_app):
        """Looking up a model slug that isn't cached must return 404."""
        response = await configured_app.get("/internal/cache/model/nonexistent-slug")
        assert response.status_code == 404

    async def test_nonexistent_model_404_has_detail(self, configured_app):
        """404 response must have a 'detail' field mentioning 'not in cache'."""
        response = await configured_app.get("/internal/cache/model/nonexistent-slug")
        assert response.status_code == 404
        _assert_json_content_type(response)
        body = response.json()
        assert "detail" in body, "404 response missing 'detail' field"
        assert (
            "not in cache" in body["detail"].lower()
        ), f"Expected 'not in cache' in detail, got: {body['detail']!r}"

    async def test_nonexistent_model_detail_contains_slug(self, configured_app):
        """404 detail should echo back the requested slug for debuggability."""
        slug = "my-test-model-xyz"
        response = await configured_app.get(f"/internal/cache/model/{slug}")
        assert response.status_code == 404
        assert slug in response.json()["detail"], "404 detail should contain the requested slug"

    async def test_special_chars_in_slug_no_500(self, configured_app):
        """URL-encoded slashes in slug must not cause a 500 server error."""
        response = await configured_app.get("/internal/cache/model/model%2Fwith%2Fslashes")
        assert response.status_code in (
            404,
            400,
        ), f"Expected 404 or 400, got {response.status_code}"

    async def test_whitespace_slug_no_500(self, configured_app):
        """Whitespace-only slug after URL decode must not cause a 500."""
        response = await configured_app.get("/internal/cache/model/%20")
        assert response.status_code in (
            404,
            400,
        ), f"Expected 404 or 400, got {response.status_code}"

    async def test_very_long_slug_no_500(self, configured_app):
        """A 500-char slug must be handled gracefully (404 or 400/422)."""
        long_slug = "a" * 500
        response = await configured_app.get(f"/internal/cache/model/{long_slug}")
        assert response.status_code in (
            404,
            400,
            422,
        ), f"Expected 404/400/422, got {response.status_code}"

    async def test_slug_with_unicode_no_500(self, configured_app):
        """Unicode slug must not cause a 500."""
        response = await configured_app.get("/internal/cache/model/模型-test-🔥")
        assert response.status_code in (
            404,
            400,
        ), f"Expected 404 or 400, got {response.status_code}"


# ============================================================================
# C4: Pipelines Loaded Endpoint — GET /internal/pipelines/loaded
# ============================================================================


@pytest.mark.e2e
class TestPipelinesLoadedE2E:
    """Comprehensive tests for GET /internal/pipelines/loaded."""

    async def test_pipelines_loaded_returns_200_with_json(self, configured_app):
        """Pipelines loaded must return 200 with JSON content-type."""
        response = await configured_app.get("/internal/pipelines/loaded")
        assert response.status_code == 200
        _assert_json_content_type(response)

    async def test_pipelines_loaded_top_level_schema(self, configured_app):
        """Response must have all top-level required fields."""
        response = await configured_app.get("/internal/pipelines/loaded")
        data = response.json()

        for field in ("total_pipelines", "ready_pipelines", "pipelines", "timestamp"):
            assert field in data, f"Missing top-level field: {field}"

    async def test_pipelines_loaded_top_level_types(self, configured_app):
        """Verify types of top-level fields."""
        response = await configured_app.get("/internal/pipelines/loaded")
        data = response.json()

        assert isinstance(data["total_pipelines"], int)
        assert isinstance(data["ready_pipelines"], int)
        assert isinstance(data["pipelines"], list)
        assert isinstance(data["timestamp"], str)

    async def test_pipelines_ready_lte_total_invariant(self, configured_app):
        """ready_pipelines must be <= total_pipelines (invariant)."""
        response = await configured_app.get("/internal/pipelines/loaded")
        data = response.json()
        assert (
            data["ready_pipelines"] <= data["total_pipelines"]
        ), f"ready ({data['ready_pipelines']}) > total ({data['total_pipelines']})"

    async def test_pipelines_list_length_matches_total(self, configured_app):
        """len(pipelines) must equal total_pipelines."""
        response = await configured_app.get("/internal/pipelines/loaded")
        data = response.json()
        assert len(data["pipelines"]) == data["total_pipelines"], (
            f"pipelines list length ({len(data['pipelines'])}) != "
            f"total_pipelines ({data['total_pipelines']})"
        )

    async def test_pipelines_ready_count_matches_is_ready_flags(self, configured_app):
        """ready_pipelines must equal count of entries where is_ready=True."""
        response = await configured_app.get("/internal/pipelines/loaded")
        data = response.json()
        counted_ready = sum(1 for p in data["pipelines"] if p.get("is_ready"))
        assert data["ready_pipelines"] == counted_ready, (
            f"ready_pipelines ({data['ready_pipelines']}) != "
            f"counted is_ready=True ({counted_ready})"
        )

    async def test_pipelines_entry_required_fields(self, configured_app):
        """Each pipeline entry must have all required fields with correct types."""
        response = await configured_app.get("/internal/pipelines/loaded")
        data = response.json()

        for i, pipeline in enumerate(data["pipelines"]):
            ctx = f"Pipeline[{i}]"
            assert isinstance(pipeline.get("id"), str), f"{ctx}: 'id' must be str"
            assert isinstance(pipeline.get("slug"), str), f"{ctx}: 'slug' must be str"
            assert isinstance(pipeline.get("name"), str), f"{ctx}: 'name' must be str"
            assert isinstance(
                pipeline.get("required_models"), list
            ), f"{ctx}: 'required_models' must be list"
            assert isinstance(pipeline.get("is_ready"), bool), f"{ctx}: 'is_ready' must be bool"
            assert isinstance(
                pipeline.get("missing_models"), list
            ), f"{ctx}: 'missing_models' must be list"

    async def test_pipelines_entry_missing_models_consistency(self, configured_app):
        """
        If is_ready=True then missing_models must be empty.
        If is_ready=False then missing_models must be non-empty.
        """
        response = await configured_app.get("/internal/pipelines/loaded")
        data = response.json()

        for i, p in enumerate(data["pipelines"]):
            ctx = f"Pipeline[{i}] ({p.get('slug', '?')})"
            if p["is_ready"]:
                assert (
                    p["missing_models"] == []
                ), f"{ctx}: is_ready=True but missing_models={p['missing_models']}"
            else:
                assert (
                    len(p["missing_models"]) > 0
                ), f"{ctx}: is_ready=False but missing_models is empty"

    async def test_pipelines_loaded_timestamp_is_valid(self, configured_app):
        """Timestamp must be valid ISO 8601."""
        response = await configured_app.get("/internal/pipelines/loaded")
        _assert_iso8601_timestamp(response.json()["timestamp"])

    async def test_pipelines_loaded_wrong_method_returns_405(self, configured_app):
        """POST to pipelines/loaded should return 405."""
        response = await configured_app.post("/internal/pipelines/loaded")
        assert response.status_code == 405


# ============================================================================
# C5: Sessions Endpoint — GET /internal/sessions
# ============================================================================


@pytest.mark.e2e
class TestSessionsEndpointE2E:
    """Comprehensive tests for GET /internal/sessions."""

    async def test_sessions_returns_200_with_json(self, configured_app):
        """Sessions endpoint must return 200 with JSON content-type."""
        response = await configured_app.get("/internal/sessions")
        assert response.status_code == 200
        _assert_json_content_type(response)

    async def test_sessions_response_schema(self, configured_app):
        """Response must include all required fields."""
        response = await configured_app.get("/internal/sessions")
        data = response.json()

        for field in ("status", "active_sessions", "sessions", "timestamp"):
            assert field in data, f"Missing field: {field}"

    async def test_sessions_field_types(self, configured_app):
        """Verify types of all session response fields."""
        response = await configured_app.get("/internal/sessions")
        data = response.json()

        assert isinstance(data["status"], str)
        assert isinstance(data["active_sessions"], int)
        assert isinstance(data["sessions"], list)
        assert isinstance(data["timestamp"], str)

    async def test_sessions_active_count_matches_list_length(self, configured_app):
        """active_sessions must equal len(sessions) — no bookkeeping drift."""
        response = await configured_app.get("/internal/sessions")
        data = response.json()
        assert data["active_sessions"] == len(data["sessions"]), (
            f"active_sessions ({data['active_sessions']}) != "
            f"len(sessions) ({len(data['sessions'])})"
        )

    async def test_sessions_status_is_known_value(self, configured_app):
        """Status must be one of the known enum values."""
        response = await configured_app.get("/internal/sessions")
        data = response.json()
        assert data["status"] in (
            "running",
            "not_initialized",
        ), f"Unexpected status: {data['status']!r}"

    async def test_sessions_not_initialized_state_is_consistent(self, configured_app):
        """
        When status='not_initialized': active_sessions MUST be 0
        and sessions MUST be empty.

        This replaces the old 'if status == ...' pattern that silently
        passed when the condition was False (Anti-Pattern #5 fix).
        """
        response = await configured_app.get("/internal/sessions")
        data = response.json()

        # In E2E with testcontainers, streaming is NOT initialized
        # (no lifespan streaming startup), so we assert the full contract.
        assert data["status"] == "not_initialized", (
            "Expected 'not_initialized' since streaming module is not started "
            "in testcontainer-based E2E. If streaming IS initialized in your "
            f"setup, this test needs updating. Got: {data['status']!r}"
        )
        assert data["active_sessions"] == 0
        assert data["sessions"] == []

    async def test_sessions_timestamp_is_valid(self, configured_app):
        """Timestamp must be valid ISO 8601."""
        response = await configured_app.get("/internal/sessions")
        _assert_iso8601_timestamp(response.json()["timestamp"])


# ============================================================================
# C5b: Sessions Cleanup Endpoint — POST /internal/sessions/cleanup
# ============================================================================


@pytest.mark.e2e
class TestSessionsCleanupE2E:
    """Comprehensive tests for POST /internal/sessions/cleanup."""

    async def test_cleanup_returns_200_with_json(self, configured_app):
        """Cleanup must return 200 with JSON content-type."""
        response = await configured_app.post("/internal/sessions/cleanup")
        assert response.status_code == 200
        _assert_json_content_type(response)

    async def test_cleanup_response_schema(self, configured_app):
        """Response must include all required fields."""
        response = await configured_app.post("/internal/sessions/cleanup")
        data = response.json()

        for field in ("status", "sessions_cleaned", "max_age_seconds", "timestamp"):
            assert field in data, f"Missing field: {field}"

    async def test_cleanup_field_types(self, configured_app):
        """Verify types of all cleanup response fields."""
        response = await configured_app.post("/internal/sessions/cleanup")
        data = response.json()

        assert isinstance(data["status"], str)
        assert isinstance(data["sessions_cleaned"], int)
        assert isinstance(data["max_age_seconds"], int)
        assert isinstance(data["timestamp"], str)

    async def test_cleanup_default_max_age_is_3600(self, configured_app):
        """Without query param, max_age_seconds defaults to 3600."""
        response = await configured_app.post("/internal/sessions/cleanup")
        assert response.status_code == 200
        assert response.json()["max_age_seconds"] == 3600

    async def test_cleanup_custom_max_age_60(self, configured_app):
        """max_age_seconds=60 must be reflected in response."""
        response = await configured_app.post("/internal/sessions/cleanup?max_age_seconds=60")
        assert response.status_code == 200
        assert response.json()["max_age_seconds"] == 60

    async def test_cleanup_custom_max_age_86400(self, configured_app):
        """Large max_age (24h) must be accepted and echoed back."""
        response = await configured_app.post("/internal/sessions/cleanup?max_age_seconds=86400")
        assert response.status_code == 200
        assert response.json()["max_age_seconds"] == 86400

    async def test_cleanup_sessions_cleaned_non_negative(self, configured_app):
        """sessions_cleaned must be >= 0."""
        response = await configured_app.post("/internal/sessions/cleanup")
        data = response.json()
        assert data["sessions_cleaned"] >= 0

    async def test_cleanup_not_initialized_state_is_consistent(self, configured_app):
        """
        When streaming is not initialized: status MUST be 'not_initialized'
        and sessions_cleaned MUST be 0.

        Anti-Pattern #5 fix: no conditional assertions; we assert the
        concrete state that testcontainer-based E2E always produces.
        """
        response = await configured_app.post("/internal/sessions/cleanup")
        data = response.json()

        assert data["status"] == "not_initialized", (
            "Expected 'not_initialized' in testcontainer E2E. " f"Got: {data['status']!r}"
        )
        assert data["sessions_cleaned"] == 0

    async def test_cleanup_timestamp_is_valid(self, configured_app):
        """Timestamp must be valid ISO 8601."""
        response = await configured_app.post("/internal/sessions/cleanup")
        _assert_iso8601_timestamp(response.json()["timestamp"])

    async def test_cleanup_wrong_method_returns_405(self, configured_app):
        """GET to sessions/cleanup should return 405."""
        response = await configured_app.get("/internal/sessions/cleanup")
        assert response.status_code == 405

    async def test_cleanup_invalid_max_age_returns_422(self, configured_app):
        """Non-integer max_age_seconds should return 422 Unprocessable Entity."""
        response = await configured_app.post(
            "/internal/sessions/cleanup?max_age_seconds=not_a_number"
        )
        assert response.status_code == 422


# ============================================================================
# C6: Streaming Status Endpoint — GET /internal/streaming/status
# ============================================================================


@pytest.mark.e2e
class TestStreamingStatusE2E:
    """Comprehensive tests for GET /internal/streaming/status."""

    async def test_streaming_status_returns_200_with_json(self, configured_app):
        """Streaming status must return 200 with JSON content-type."""
        response = await configured_app.get("/internal/streaming/status")
        assert response.status_code == 200
        _assert_json_content_type(response)

    async def test_streaming_status_schema(self, configured_app):
        """Response must include status and timestamp at minimum."""
        response = await configured_app.get("/internal/streaming/status")
        data = response.json()

        assert "status" in data
        assert "timestamp" in data

    async def test_streaming_status_is_known_value(self, configured_app):
        """Status must be one of the known enum values."""
        response = await configured_app.get("/internal/streaming/status")
        data = response.json()
        assert data["status"] in (
            "running",
            "not_initialized",
        ), f"Unexpected streaming status: {data['status']!r}"

    async def test_streaming_not_initialized_full_contract(self, configured_app):
        """
        When streaming module is not started (testcontainer E2E):
        - status must be 'not_initialized'
        - message must be a non-empty string explaining why
        - timestamp must be present

        Anti-Pattern #5 fix: this replaces the old 'if status ==
        not_initialized: assert message' which silently passed
        when status was something else.
        """
        response = await configured_app.get("/internal/streaming/status")
        data = response.json()

        assert data["status"] == "not_initialized", (
            "Expected 'not_initialized' in testcontainer E2E. " f"Got: {data['status']!r}"
        )
        assert "message" in data, "not_initialized response must include a 'message' field"
        assert isinstance(data["message"], str)
        assert len(data["message"]) > 0, "message must not be empty"

    async def test_streaming_status_timestamp_is_valid(self, configured_app):
        """Timestamp must be valid ISO 8601."""
        response = await configured_app.get("/internal/streaming/status")
        _assert_iso8601_timestamp(response.json()["timestamp"])


# ============================================================================
# C7: Cross-Endpoint Behavioral Consistency (Anti-Pattern #1 fix)
# ============================================================================


@pytest.mark.e2e
class TestInternalEndpointConsistencyE2E:
    """
    Cross-endpoint tests verifying behavioral consistency.

    These tests call multiple endpoints in sequence and verify that the
    returned data is internally consistent. This catches bugs that
    single-endpoint tests miss (Anti-Pattern #1: testing behavior, not
    just response shapes).
    """

    async def test_sessions_and_streaming_status_agree_on_state(self, configured_app):
        """
        GET /internal/sessions and GET /internal/streaming/status should
        agree on whether streaming is initialized.
        """
        sessions_resp = await configured_app.get("/internal/sessions")
        status_resp = await configured_app.get("/internal/streaming/status")

        sessions_status = sessions_resp.json()["status"]
        streaming_status = status_resp.json()["status"]

        # Both endpoints derive state from get_session_manager() being None
        assert sessions_status == streaming_status, (
            f"State mismatch: /sessions says {sessions_status!r}, "
            f"/streaming/status says {streaming_status!r}"
        )

    async def test_clear_cache_then_stats_models_list_is_empty(self, configured_app):
        """
        After POST /internal/cache/clear, the models list from
        GET /internal/cache/stats must be empty (not just total_models=0).
        """
        await configured_app.post("/internal/cache/clear")

        stats = (await configured_app.get("/internal/cache/stats")).json()
        assert stats["total_models"] == 0
        assert (
            stats["models"] == []
        ), f"Expected empty models list after clear, got {len(stats['models'])} items"

    async def test_pipelines_total_matches_list_and_ready_is_subset(self, configured_app):
        """
        Verify three invariants at once from /internal/pipelines/loaded:
        1. total_pipelines == len(pipelines)
        2. ready_pipelines == count(is_ready=True)
        3. ready_pipelines <= total_pipelines
        """
        data = (await configured_app.get("/internal/pipelines/loaded")).json()

        total = data["total_pipelines"]
        ready = data["ready_pipelines"]
        pipeline_list = data["pipelines"]

        assert len(pipeline_list) == total
        assert sum(1 for p in pipeline_list if p["is_ready"]) == ready
        assert ready <= total

    async def test_cleanup_max_age_echoed_for_multiple_values(self, configured_app):
        """
        Verify that different max_age_seconds values are correctly echoed
        back, proving the query parameter is actually read (not hardcoded).
        """
        for max_age in (1, 60, 3600, 86400):
            resp = await configured_app.post(
                f"/internal/sessions/cleanup?max_age_seconds={max_age}"
            )
            assert resp.status_code == 200
            assert (
                resp.json()["max_age_seconds"] == max_age
            ), f"max_age_seconds not echoed for input={max_age}"

    async def test_all_internal_get_endpoints_return_json(self, configured_app):
        """
        Smoke test: every internal GET endpoint must return 200
        with application/json content-type.
        """
        get_endpoints = [
            "/internal/cache/stats",
            "/internal/pipelines/loaded",
            "/internal/sessions",
            "/internal/streaming/status",
        ]
        for endpoint in get_endpoints:
            response = await configured_app.get(endpoint)
            assert response.status_code == 200, f"{endpoint} returned {response.status_code}"
            _assert_json_content_type(response)
