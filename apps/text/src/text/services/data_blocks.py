"""The context of a composed request: its ``EXTERNAL_DATA`` blocks (TASK-1036 OD-1).

``composeMessages`` (``packages/workflow-contract/src/compose-messages.ts``) puts the
platform rules, the agent instruction, the language step and the output contract in the
SYSTEM message, and wraps everything per-encounter in::

    <<<EXTERNAL_DATA section="<key>">>>
    --- <label> ---
    <body>
    <<<END_EXTERNAL_DATA>>>

The egress guardrails inspect every text the provider receives minus only these
markers (TASK-1036 E1): the system message is not platform-only, since the agent
instruction is rendered over the request's variables into it. The composer
neutralises any start or end marker inside a body, so a block cannot be forged from
inside another one.
"""

from __future__ import annotations

import re

__all__ = ["DataBlock", "external_data_blocks", "screened_ranges"]

#: A complete block; group 1 is everything between the start-marker line and the end marker.
_BLOCK = re.compile(
    r'<<<EXTERNAL_DATA section="[a-z0-9_]+">>>\n(.*?)\n<<<END_EXTERNAL_DATA>>>',
    re.DOTALL,
)


class DataBlock:
    """One block's body, located by offsets in the text it was found in."""

    __slots__ = ("start", "end")

    def __init__(self, start: int, end: int) -> None:
        self.start = start
        self.end = end


def external_data_blocks(text: str) -> list[DataBlock]:
    """Every complete ``EXTERNAL_DATA`` block body in ``text``, in order."""
    return [DataBlock(match.start(1), match.end(1)) for match in _BLOCK.finditer(text or "")]


def screened_ranges(text: str) -> list[tuple[int, int]]:
    """Every stretch of caller-supplied text in ``text``: block bodies AND text outside blocks.

    Only the composer's own start and end markers are left out; blank gaps (the
    ``\\n\\n`` between blocks) are dropped. A raw caller cannot hide content next to a
    block, because anything outside one is screened like anything inside.
    """
    ranges: list[tuple[int, int]] = []
    cursor = 0
    for match in _BLOCK.finditer(text or ""):
        ranges.append((cursor, match.start()))  # the gap, up to the start marker
        ranges.append((match.start(1), match.end(1)))
        cursor = match.end()
    ranges.append((cursor, len(text or "")))
    trimmed: list[tuple[int, int]] = []
    for start, end in ranges:
        piece = text[start:end]
        if not piece.strip():
            continue
        start += len(piece) - len(piece.lstrip())
        end -= len(piece) - len(piece.rstrip())
        trimmed.append((start, end))
    return trimmed
