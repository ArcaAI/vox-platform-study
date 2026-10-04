"""The context of a composed request: its ``EXTERNAL_DATA`` blocks (TASK-1036 OD-1).

``composeMessages`` (``packages/workflow-contract/src/compose-messages.ts``) puts the
platform rules, the agent instruction, the language step and the output contract in the
SYSTEM message, and wraps everything per-encounter in::

    <<<EXTERNAL_DATA section="<key>">>>
    --- <label> ---
    <body>
    <<<END_EXTERNAL_DATA>>>

The egress guardrails (inbound PII/safety screen, medical-relevance judge, and the
``pii_leak`` source of the output screen) scope to that context and to the response —
never to the platform's own instructions. The composer neutralises any start or end
marker inside a body, so a block cannot be forged from inside another one.
"""

from __future__ import annotations

import re

__all__ = ["DataBlock", "external_data_blocks", "context_text"]

#: A complete block; group 1 is everything between the start-marker line and the end marker.
_BLOCK = re.compile(
    r'<<<EXTERNAL_DATA section="[a-z0-9_]+">>>\n(.*?)\n<<<END_EXTERNAL_DATA>>>',
    re.DOTALL,
)

#: Joins the texts of one request into the single string a guardrail sees.
JOIN = "\n\n"


class DataBlock:
    """One block's body, located by offsets in the text it was found in."""

    __slots__ = ("start", "end")

    def __init__(self, start: int, end: int) -> None:
        self.start = start
        self.end = end


def external_data_blocks(text: str) -> list[DataBlock]:
    """Every complete ``EXTERNAL_DATA`` block body in ``text``, in order."""
    return [DataBlock(match.start(1), match.end(1)) for match in _BLOCK.finditer(text or "")]


def context_text(user_text: str) -> str:
    """The block bodies of ``user_text`` joined; with no blocks, ``user_text`` itself."""
    blocks = external_data_blocks(user_text)
    if not blocks:
        return user_text
    return JOIN.join(user_text[block.start : block.end] for block in blocks)
