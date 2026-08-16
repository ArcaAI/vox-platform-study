"""Summarization-palette node activities (TASK-720 Task 5).

One module per node type, mirroring `contracts/palette.md`'s node table:
``context_binding`` (N-1), ``template_ref`` (N-2), ``text_generate`` (N-3), ``guardrail_check``
(N-4), ``deliver`` (N-5). Each exports exactly one ``@activity.defn(name="interpreter.<key>")``
callable, registered in ``..registry.NODE_REGISTRY`` and ``..activities.NODE_ACTIVITIES``.
"""

from __future__ import annotations
