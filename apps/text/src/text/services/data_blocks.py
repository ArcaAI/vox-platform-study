"""The context of a composed request: its ``EXTERNAL_DATA`` blocks (TASK-1036 OD-1).

``composeMessages`` (``packages/workflow-contract/src/compose-messages.ts``) puts the
platform rules, the agent instruction, the language step and the output contract in the
SYSTEM message, and wraps everything per-encounter in::

    <<<EXTERNAL_DATA section="<key>">>>
    --- <label> ---
    <body>
    <<<END_EXTERNAL_DATA>>>

Every egress screen speaks REGIONS (TASK-1047 FC-5): each block body is a region keyed
by its section name, and caller text outside any block is keyed by the caller's choice
(``user`` for the user side). Only the markers themselves are left out. The composer
neutralises any start or end marker inside a body, so a block cannot be forged from
inside another one.
"""

from __future__ import annotations

import re

__all__ = ["DataBlock", "external_data_blocks", "keyed_ranges"]

#: A complete block: ``name`` is its section, ``body`` everything between the
#: start-marker line and the end marker.
_BLOCK = re.compile(
    r'<<<EXTERNAL_DATA section="(?P<name>[a-z0-9_]+)">>>\n'
    r"(?P<body>.*?)\n<<<END_EXTERNAL_DATA>>>",
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
    return [
        DataBlock(match.start("body"), match.end("body")) for match in _BLOCK.finditer(text or "")
    ]


def keyed_ranges(text: str, *, outside: str) -> list[tuple[str, int, int]]:
    """Every stretch of caller-supplied text in ``text``, keyed: ``(key, start, end)``.

    A block body is keyed by its section name; text outside a block by ``outside``.
    Only the composer's own start and end markers are left out; blank stretches (the
    ``\\n\\n`` between blocks) are dropped and the rest trimmed. A raw caller cannot hide
    content next to a block, because anything outside one is screened like anything
    inside.
    """
    text = text or ""
    ranges: list[tuple[str, int, int]] = []
    cursor = 0
    for match in _BLOCK.finditer(text):
        ranges.append((outside, cursor, match.start()))  # the gap, up to the start marker
        ranges.append((match.group("name"), match.start("body"), match.end("body")))
        cursor = match.end()
    ranges.append((outside, cursor, len(text)))
    trimmed: list[tuple[str, int, int]] = []
    for key, start, end in ranges:
        piece = text[start:end]
        if not piece.strip():
            continue
        start += len(piece) - len(piece.lstrip())
        end -= len(piece) - len(piece.rstrip())
        trimmed.append((key, start, end))
    return trimmed
