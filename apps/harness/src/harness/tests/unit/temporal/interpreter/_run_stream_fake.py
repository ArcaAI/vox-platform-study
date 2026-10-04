"""A Redis stand-in that executes the run-protocol v2 SEQUENCER (``RUN_APPEND_LUA``) in Python.

Only the socket is faked: the producer under test still builds the real ``EVAL`` arguments
(``run_protocol.build_run_append``) and hands them to ``register_script(...)(keys=, args=)`` the
way redis-py does. The fake refuses any script other than the frozen Lua bytes, then performs the
script's documented steps — dedupe hit, closed stream, ``INCR`` + ``XADD`` with ``seq`` first,
``HSET`` of the dedupe key, the same ``EXPIRE`` on all three keys for a terminal append — so a
test reads back exactly the entries a real Redis would hold (``events(run_id)``).
"""

from __future__ import annotations

from typing import Any

from harness.temporal.interpreter.run_protocol import (
    RUN_APPEND_LUA,
    RUN_STREAM_CLOSED_ERROR,
    parse_stored_run_event,
    run_events_key,
)


class FakeScriptError(Exception):
    """What redis-py raises for an ``error_reply`` (a ``ResponseError``)."""


class FakeRunStreamRedis:
    def __init__(self) -> None:
        self.counters: dict[str, int] = {}
        self.streams: dict[str, list[tuple[str, list[str]]]] = {}
        self.hashes: dict[str, dict[str, str]] = {}
        self.expiry: dict[str, int] = {}
        self.calls: list[tuple[list[str], list[str]]] = []
        self._ids = 0

    def register_script(self, script: str) -> Any:
        assert script == RUN_APPEND_LUA, "only the frozen sequencer may append run events"
        return self._run

    async def _run(self, keys: list[str] | None = None, args: list[str] | None = None) -> list[Any]:
        keys = list(keys or [])
        args = [str(a) for a in (args or [])]
        self.calls.append((keys, args))
        seq_key, events_key, dedupe_key = keys
        max_len, retention, dedupe, *fields = args
        assert int(max_len) >= 1
        if dedupe:
            prior = self.hashes.get(dedupe_key, {}).get(dedupe)
            if prior is not None:
                seq, stream_id = prior.split(" ", 1)
                return [int(seq), stream_id, 1]
        if events_key in self.expiry:
            raise FakeScriptError(RUN_STREAM_CLOSED_ERROR)
        seq = self.counters.get(seq_key, 0) + 1
        self.counters[seq_key] = seq
        self._ids += 1
        stream_id = f"{self._ids}-0"
        self.streams.setdefault(events_key, []).append((stream_id, ["seq", str(seq), *fields]))
        if dedupe:
            self.hashes.setdefault(dedupe_key, {})[dedupe] = f"{seq} {stream_id}"
        if int(retention) > 0:
            for key in keys:
                self.expiry[key] = int(retention)
        return [seq, stream_id, 0]

    def entries(self, run_id: str) -> list[list[str]]:
        return [fields for _id, fields in self.streams.get(run_events_key(run_id), [])]

    def events(self, run_id: str) -> list[dict[str, Any]]:
        """Every stored entry read back through the protocol's own parser (invalid ones fail)."""
        out = []
        for fields in self.entries(run_id):
            parsed = parse_stored_run_event(run_id, fields)
            assert parsed["kind"] == "event", parsed
            out.append(parsed["event"])
        return out

    def all_events(self) -> list[dict[str, Any]]:
        """Every stored event of every run, in append order per run (one run per test, usually)."""
        out: list[dict[str, Any]] = []
        for key in self.streams:
            out.extend(self.events(key.split(":")[2]))
        return out

    def terminal(self) -> dict[str, Any]:
        """The ONE terminal event (`run.completed` / `run.failed` / `run.cancelled`) stored."""
        (event,) = [
            e
            for e in self.all_events()
            if e["type"] in ("run.completed", "run.failed", "run.cancelled")
        ]
        return event


class ExplodingRunStreamRedis:
    """Every append fails — the mirror must never fail a run."""

    def register_script(self, script: str) -> Any:
        async def _boom(keys: Any = None, args: Any = None) -> Any:
            raise RuntimeError("redis is down")

        return _boom
