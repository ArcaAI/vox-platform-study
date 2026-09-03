"""Routing internals for `apps/text`.

`api/endpoints/generate.py` had grown to 1,076 lines carrying four separable
concerns — usage/stats coercion, admission control, non-streaming dispatch and
streaming — which made it a single file that every parallel workstream needed to
edit at once. These modules split it by concern so ownership can be partitioned
( Wave 0.4).

The split is a MOVE, not a redesign: functions are relocated verbatim and
re-exported from `generate.py`, so `from text.api.endpoints.generate import _x`
keeps working. What a move cannot preserve is a test that patches by module
path — `mock.patch("text.api.endpoints.generate.asyncio.sleep")` names a
location, and relocating the code is precisely what changes it. Those patch
targets are repointed at the module that now owns the call.
"""
