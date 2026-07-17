"""Word-overlap dedup between consecutive transcribed chunks.

Shared by the batch chunk pipeline (stride overlap) and the streaming
force-emit boundary (carry overlap) — TASK-505 Phase 1. Pure text function;
import-cheap by design (the streaming worker must not import batch_service,
which pulls the Azure SDK at module import).
"""

from __future__ import annotations


def dedup_overlap(
    previous_text: str,
    current_text: str,
    max_overlap_words: int = 12,
) -> str:
    """Strip words duplicated at a chunk boundary from *current_text*.

    When audio is split with an overlap, the ASR engine often transcribes the
    same words at the end of chunk *N* and the start of chunk *N+1*. Finds the
    longest suffix of *previous_text* (case-insensitive, trailing punctuation
    stripped) matching a prefix of *current_text* and returns *current_text*
    with that prefix removed.
    """
    if not previous_text or not current_text:
        return current_text

    prev_words = previous_text.split()
    curr_words = current_text.split()

    if not prev_words or not curr_words:
        return current_text

    # Only look at the tail of previous and head of current
    tail = prev_words[-max_overlap_words:]
    head = curr_words[:max_overlap_words]

    # Find longest suffix of tail that matches a prefix of head
    best_overlap = 0
    for length in range(1, min(len(tail), len(head)) + 1):
        suffix = tail[-length:]
        prefix = head[:length]
        if [w.lower().rstrip(".,!?;:") for w in suffix] == [
            w.lower().rstrip(".,!?;:") for w in prefix
        ]:
            best_overlap = length

    if best_overlap > 0:
        return " ".join(curr_words[best_overlap:])
    return current_text
