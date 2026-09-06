"""TASK-890 F3 — `hope_runtime_models.resolvable` reads the cache, not the hub.

The resolvability probe shipped calling `huggingface_hub.snapshot_download(...,
local_files_only=True)`. That call does not fetch, but it does `open()` the
`refs` file — and on this host `HF_HOME` is an external volume. Measured
2026-09-07: the whole 19-row stt payload cost 0.12 s in a fresh process, while in
the running service ONE `POST /api/v1/internal/models/resolvable` left the main
thread parked in that `open()` for over fifteen minutes. `sample` put 100 % of
main-thread samples in `__open` on both stt (pid 27166) and nlp (pid 27092), and
`request.start` was the last line either service ever logged: the readiness probe
had killed the services it was measuring, health endpoint included.

So the resolver is now filesystem-only and bounded, and this suite pins the three
properties that keep it that way:

  * it finds a snapshot in BOTH cache layouts in use on this host, by reading
    `models--<org>--<name>/refs/<rev>` → `snapshots/<sha>/` directly;
  * it never touches `huggingface_hub` — the stub here raises if anything does;
  * it is cheap and bounded: 30 rows in well under a second, macOS AppleDouble
    litter ignored, no recursive walk, and a memoised verdict for 60 s.

The budget and the off-loop execution are pinned in `TestTheBudget`; the route
that depends on them is pinned in `test_model_resolvable_route_task890.py`.
"""

from __future__ import annotations

import sys
import time
import types
from pathlib import Path

import pytest
from hope_runtime_models import (
    ResolvableQuery,
    check_resolvable,
    check_resolvable_many,
    clear_resolvable_cache,
)

SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"


def _never_returns(*_args, **_kwargs):
    """A filesystem read that outlives the budget — the F3 failure, simulated.

    Two seconds, not thirty: it only has to outlive the budgets used below, and
    the stranded worker thread is joined at interpreter exit.
    """
    time.sleep(2)
    raise AssertionError("unreachable: the budget must have expired long before this")


def stage_snapshot(root: Path, repo_id: str, *, revision: str = "main", sha: str = SHA) -> Path:
    """One repo in the real HuggingFace cache layout, with one materialised file."""
    storage = root / ("models--" + repo_id.replace("/", "--"))
    snapshot = storage / "snapshots" / sha
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / "config.json").write_text("{}")
    refs = storage / "refs"
    refs.mkdir(parents=True, exist_ok=True)
    (refs / revision).write_text(sha)
    return snapshot


@pytest.fixture(autouse=True)
def _fresh_cache():
    """Each test measures the filesystem, not the previous test's memory."""
    clear_resolvable_cache()
    yield
    clear_resolvable_cache()


@pytest.fixture(autouse=True)
def _no_hub(monkeypatch):
    """A hub that explodes on contact. The no-hub clause has to be falsifiable."""

    def _forbidden(*_args, **_kwargs):
        raise AssertionError("the resolvability probe must never call huggingface_hub")

    module = types.ModuleType("huggingface_hub")
    module.snapshot_download = _forbidden  # type: ignore[attr-defined]
    module.scan_cache_dir = _forbidden  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)


def _probe(uri: str, cache: Path | None, **kwargs) -> object:
    return check_resolvable(
        ResolvableQuery(id="row", source_uri=uri, **kwargs),
        hf_cache_dir=str(cache) if cache else None,
    )


class TestTheCacheLayouts:
    def test_a_staged_snapshot_resolves_to_its_own_directory(self, tmp_path):
        snapshot = stage_snapshot(tmp_path, "blaze999/Medical-NER")

        result = _probe("blaze999/Medical-NER", tmp_path)

        assert result.resolvable is True
        assert result.state == "hf_cache"
        assert result.path == str(snapshot)

    def test_the_hub_layout_under_the_same_root_also_resolves(self, tmp_path):
        """`$HF_HOME` and `$HF_HOME/hub` are BOTH live on this host.

        stt hands its resolver `HF_HOME` itself; nlp and tts load through the hub
        library, which resolves `$HF_HOME/hub`. Reading only one of them reports
        a warm cache as cold — the exact failure this whole module exists to fix
        — so a given root is tried both as-is and with `hub/` appended.
        """
        stage_snapshot(tmp_path / "hub", "fastino/GLiNER2-Guardrails-PII-Multi")

        assert _probe("fastino/GLiNER2-Guardrails-PII-Multi", tmp_path).resolvable is True

    def test_an_absent_repo_is_not_cached(self, tmp_path):
        result = _probe("openai/whisper-large-v3", tmp_path)

        assert result.resolvable is False
        assert result.state == "not_cached"
        assert result.path is None

    def test_a_commit_hash_revision_names_its_snapshot_directly(self, tmp_path):
        storage = tmp_path / "models--org--repo" / "snapshots" / SHA
        storage.mkdir(parents=True)
        (storage / "model.bin").write_text("w")
        # No `refs/` at all: a repo fetched by commit hash never has one.

        assert _probe("org/repo", tmp_path, revision=SHA).resolvable is True

    def test_a_ref_pointing_at_an_unmaterialised_snapshot_is_not_cached(self, tmp_path):
        storage = tmp_path / "models--org--repo"
        (storage / "refs").mkdir(parents=True)
        (storage / "refs" / "main").write_text(SHA)
        (storage / "snapshots").mkdir(parents=True)  # the directory exists, empty

        assert _probe("org/repo", tmp_path).resolvable is False

    def test_appledouble_litter_is_not_weights(self, tmp_path):
        """An external volume formatted elsewhere is full of `._` sidecars.

        A snapshot folder holding nothing but AppleDouble files is EMPTY, whatever
        `listdir` says, and a `._`-prefixed directory in `snapshots/` is not a
        revision.
        """
        storage = tmp_path / "models--org--repo"
        (storage / "refs").mkdir(parents=True)
        (storage / "refs" / "main").write_text(SHA)
        snapshot = storage / "snapshots" / SHA
        snapshot.mkdir(parents=True)
        (snapshot / "._config.json").write_text("apple double")
        (storage / "snapshots" / "._junk").mkdir()

        assert _probe("org/repo", tmp_path).resolvable is False

        (snapshot / "config.json").write_text("{}")
        clear_resolvable_cache()
        assert _probe("org/repo", tmp_path).resolvable is True

    def test_a_dangling_snapshot_symlink_is_not_weights(self, tmp_path):
        """Snapshot entries are symlinks into `blobs/`; a pruned blob is a miss."""
        storage = tmp_path / "models--org--repo"
        (storage / "refs").mkdir(parents=True)
        (storage / "refs" / "main").write_text(SHA)
        snapshot = storage / "snapshots" / SHA
        snapshot.mkdir(parents=True)
        (snapshot / "model.bin").symlink_to(storage / "blobs" / "gone")

        assert _probe("org/repo", tmp_path).resolvable is False


class TestItDoesNotWalk:
    def test_thirty_rows_answer_in_well_under_a_second(self, tmp_path):
        """The gateway asks about every self-hosted row in one call, every sweep."""
        for index in range(15):
            stage_snapshot(tmp_path, f"org{index}/repo")

        rows = [f"org{index}/repo" for index in range(15)] + [
            f"absent{index}/repo" for index in range(15)
        ]
        started = time.perf_counter()
        results = [_probe(uri, tmp_path) for uri in rows]
        elapsed = time.perf_counter() - started

        assert [r.resolvable for r in results] == [True] * 15 + [False] * 15
        assert elapsed < 1.0, f"30 rows took {elapsed:.3f}s — the check must stay O(1)-ish"

    def test_a_deep_cache_costs_no_more_than_a_shallow_one(self, tmp_path):
        """A recursive walk would notice 400 extra files. A layout read does not."""
        snapshot = stage_snapshot(tmp_path, "org/repo")
        for index in range(400):
            (snapshot / f"shard-{index:04d}.bin").write_text("w")
            (tmp_path / f"noise-{index:04d}").mkdir()

        started = time.perf_counter()
        assert _probe("org/repo", tmp_path).resolvable is True
        assert time.perf_counter() - started < 0.2


class TestTheMemory:
    def test_a_verdict_is_reused_within_the_ttl(self, tmp_path):
        """A sweep asks the same question every cycle; the disk is read once a minute."""
        snapshot = stage_snapshot(tmp_path, "org/repo")
        assert _probe("org/repo", tmp_path).resolvable is True

        (snapshot / "config.json").unlink()
        assert _probe("org/repo", tmp_path).resolvable is True, "the memo was not used"

        clear_resolvable_cache()
        assert _probe("org/repo", tmp_path).resolvable is False

    def test_the_memo_is_keyed_by_cache_dir(self, tmp_path):
        """Two services with different cache dirs must not inherit each other's answer."""
        stage_snapshot(tmp_path / "a", "org/repo")

        assert _probe("org/repo", tmp_path / "a").resolvable is True
        assert _probe("org/repo", tmp_path / "b").resolvable is False


class TestTheBudget:
    @pytest.mark.asyncio
    async def test_the_batch_runs_off_the_event_loop(self, tmp_path):
        """The loop must stay live while the filesystem is being read.

        This is the whole fix: the old handler called the check inline, and one
        filesystem read that never returned took the service's health probe with
        it.
        """
        import asyncio

        stage_snapshot(tmp_path, "org/repo")
        loop_ticked = False

        async def _tick():
            nonlocal loop_ticked
            await asyncio.sleep(0)
            loop_ticked = True

        task = asyncio.ensure_future(_tick())
        results = await check_resolvable_many(
            [ResolvableQuery(id="a", source_uri="org/repo")], hf_cache_dir=str(tmp_path)
        )
        await task

        assert loop_ticked
        assert [r.resolvable for r in results] == [True]

    @pytest.mark.asyncio
    async def test_a_stalled_filesystem_answers_not_measured(self, tmp_path, monkeypatch):
        """A row the budget could not reach is `None`, never `False`.

        The gateway records only a literal boolean, so `None` leaves the row
        `unknown` — "nobody looked" — instead of asserting "weights missing" on
        the strength of a stalled volume.
        """
        import hope_runtime_models.resolvable as module

        monkeypatch.setattr(module, "_check", _never_returns)

        results = await check_resolvable_many(
            [ResolvableQuery(id="a", source_uri="org/repo")],
            hf_cache_dir=str(tmp_path),
            budget_seconds=0.2,
        )

        (result,) = results
        assert result.resolvable is None
        assert result.state == "timeout"
        assert result.as_dict()["resolvable"] is None

    @pytest.mark.asyncio
    async def test_a_second_probe_does_not_queue_behind_a_stalled_one(self, tmp_path, monkeypatch):
        """One stalled probe must cost ONE abandoned thread, not one per sweep."""
        import asyncio

        import hope_runtime_models.resolvable as module

        monkeypatch.setattr(module, "_check", _never_returns)
        query = [ResolvableQuery(id="a", source_uri="org/repo")]

        first = asyncio.ensure_future(
            check_resolvable_many(query, hf_cache_dir=str(tmp_path), budget_seconds=0.2)
        )
        await asyncio.sleep(0.1)
        started = time.perf_counter()
        second = await check_resolvable_many(query, hf_cache_dir=str(tmp_path), budget_seconds=5.0)
        elapsed = time.perf_counter() - started
        await first

        assert second[0].state == "timeout"
        assert elapsed < 1.0, "the second probe waited on the stalled one instead of declining"

    @pytest.mark.asyncio
    async def test_an_empty_batch_costs_nothing(self):
        assert await check_resolvable_many([]) == []
