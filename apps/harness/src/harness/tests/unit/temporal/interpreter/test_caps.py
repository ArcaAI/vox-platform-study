"""RED-first tests for the interpreter's platform caps module (Task 4).

Caps are a defense-in-depth re-clamp (see
compiledConfig already carries clamped values from the TypeScript compiler; this module clamps
again, independently, tighten-only, with no I/O (pure module constants, no GlobalSetting read).
"""

from __future__ import annotations

from harness.temporal.interpreter import caps


class TestClampTimeout:
    def test_below_cap_passes_through(self):
        assert caps.clamp_timeout(30) == 30

    def test_above_cap_is_clamped(self):
        assert caps.clamp_timeout(900) < 10_000
        assert caps.clamp_timeout(10_000) == caps.MAX_NODE_TIMEOUT_SECONDS

    def test_never_widens(self):
        # tighten-only: clamping the platform max itself is a no-op, never an increase.
        assert caps.clamp_timeout(caps.MAX_NODE_TIMEOUT_SECONDS) == caps.MAX_NODE_TIMEOUT_SECONDS


class TestClampAttempts:
    def test_below_cap_passes_through(self):
        assert caps.clamp_attempts(2) == 2

    def test_above_cap_is_clamped(self):
        assert caps.clamp_attempts(999) == caps.MAX_NODE_ATTEMPTS


class TestStructuralBounds:
    def test_constants_are_positive(self):
        assert caps.MAX_STAGES > 0
        assert caps.MAX_NODES_PER_STAGE > 0
        assert caps.MAX_TOTAL_NODES > 0
        assert caps.MAX_TOTAL_SECONDS > 0

    def test_total_nodes_is_a_tighter_bound_than_the_stage_product(self):
        # A config filling every stage to the per-stage cap must still be rejected by
        # MAX_TOTAL_NODES alone if it tries to also max out MAX_STAGES (execution-semantics.md
        # "a tighter, independent ceiling so the two bounds are not redundant").
        assert caps.MAX_TOTAL_NODES < caps.MAX_STAGES * caps.MAX_NODES_PER_STAGE
