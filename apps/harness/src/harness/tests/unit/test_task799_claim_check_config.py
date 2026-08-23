"""TASK-799 A.2 — the claim-check TUNING knobs.

The brief asks for `min_bytes` and `ttl_seconds` to move to `global-kv`. Only one of them
could: **`ttl_seconds` has no reader anywhere in `apps/harness`**. Its own comment says
so — *"Advisory blob lifetime (a bucket lifecycle rule enforces expiry out-of-band)"* —
i.e. the expiry is enforced by object-store infrastructure, and the field is documentation
wearing a config costume. Migrating it would have moved a phantom onto the control plane
and given an admin a slider wired to nothing, so it is DELETED instead (plan §3.3).

`min_bytes` is real: it is read at `temporal/activities.py` `_offload_text` and decides
whether a clinical blob is written out-of-band or left inline in Temporal history. It must
be retunable without a redeploy — the safe value depends on the history budget an
encounter is actually consuming — so it becomes a `global-kv` key on the PULL route, with
the env value as the bootstrap floor beneath it.

The **storage LOCATION** knobs (`bucket`, `endpoint_url`, `region`, `secure`) are NOT
migrated here; see the report and the field comments — routing them through the existing
`storage.platformDefault.*` / `TenantStorageConfig` cascade needs a `db-config` resolver
on the pull route that does not exist yet.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.core.config import ClaimCheckConfig
from harness.core.effective_config import EffectiveConfigSnapshot
from harness.temporal.claim_check import CLAIM_CHECK_MIN_BYTES_KEY, resolve_min_bytes


def _snapshot(value: Any) -> EffectiveConfigSnapshot:
    return EffectiveConfigSnapshot(
        raw={"settings": {CLAIM_CHECK_MIN_BYTES_KEY: {"value": value, "dataType": "number"}}},
        ok=True,
    )


class TestTtlSecondsDeleted:
    def test_the_advisory_ttl_knob_is_gone(self) -> None:
        assert "ttl_seconds" not in ClaimCheckConfig.model_fields


class TestResolveMinBytes:
    def test_no_snapshot_keeps_the_bootstrap_value(self) -> None:
        base = ClaimCheckConfig()
        assert resolve_min_bytes(None, base.min_bytes) == base.min_bytes

    def test_a_failed_pull_keeps_the_bootstrap_value(self) -> None:
        base = ClaimCheckConfig()
        assert resolve_min_bytes(EffectiveConfigSnapshot(ok=False), base.min_bytes) == base.min_bytes

    def test_a_resolved_value_wins(self) -> None:
        assert resolve_min_bytes(_snapshot(4096), 65_536) == 4096

    @pytest.mark.parametrize("bad", [None, 0, -1, "4096", True, 1.5])
    def test_a_non_positive_integer_is_refused(self, bad: Any) -> None:
        """Refused, not coerced. `min_bytes <= 0` would offload EVERY payload, including
        a two-word one, turning the history-budget guard into a per-field round trip."""
        assert resolve_min_bytes(_snapshot(bad), 65_536) == 65_536
