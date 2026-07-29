"""LocalAgreement-2 commit policy for streaming partial hypotheses.

Stabilizes the partial transcript stream. Consecutive
partial ASR hypotheses for the same utterance are compared at token level
(whitespace-normalized); the longest common prefix between the latest two
hypotheses is *committed*. A committed token position is frozen at the
agreed token: the committed prefix grows only while the latest hypothesis
keeps agreeing with it, and rolls back to the last still-agreeing token
when a later hypothesis revises an already committed word — the settled
surface is never silently replaced with different text.

The policy is pure (no I/O, no session knowledge). The session manager
owns one instance per session, calls :meth:`update` per partial, resets
on each final, and publishes ``stable_chars = len(committed)`` alongside
the full partial text.

Comparison normalizes case and strips leading/trailing punctuation from
each token so ``"Hello,"`` agrees with ``"hello"``. The committed *surface*
is re-rendered from the latest hypothesis for the *agreed* tokens only, so
``stable_chars`` stays a valid prefix index into the published text without
ever changing an already-settled word's meaning.
"""

from __future__ import annotations

import re

_EDGE_PUNCTUATION_RE = re.compile(r"^[\W_]+|[\W_]+$", re.UNICODE)


def _normalize_token(token: str) -> str:
    """Lowercase and strip edge punctuation for comparison purposes."""
    lowered = token.lower()
    stripped = _EDGE_PUNCTUATION_RE.sub("", lowered)
    # A token that is pure punctuation normalizes to itself so two identical
    # punctuation tokens still agree.
    return stripped or lowered


class LocalAgreementPolicy:
    """LocalAgreement-2: commit the agreed prefix of the last two hypotheses."""

    def __init__(self) -> None:
        self._prev_norm_tokens: list[str] | None = None
        # Frozen identity of the committed prefix (normalized tokens). The
        # committed count is ``len(self._committed_norm_tokens)``.
        self._committed_norm_tokens: list[str] = []
        self._committed_text = ""
        self._tentative_text = ""

    @property
    def committed_text(self) -> str:
        """Committed (stable) prefix of the most recent hypothesis."""
        return self._committed_text

    @property
    def tentative_text(self) -> str:
        """Uncommitted tail of the most recent hypothesis."""
        return self._tentative_text

    def update(self, hypothesis: str) -> tuple[str, str]:
        """Fold a new partial hypothesis into the policy.

        Returns ``(committed, tentative)`` where ``committed`` is a prefix
        of the current hypothesis and ``tentative`` is the remainder. A
        committed token position is frozen: the committed prefix only grows
        while the latest hypothesis keeps agreeing with it, and rolls back
        to the last still-agreeing token when a later hypothesis revises an
        already committed word — it is never silently replaced with
        different text.
        """
        tokens = (hypothesis or "").split()
        norm_tokens = [_normalize_token(t) for t in tokens]

        # LocalAgreement-2: length of the prefix agreed by the last two
        # hypotheses.
        agreement = 0
        if self._prev_norm_tokens is not None:
            for prev_tok, cur_tok in zip(self._prev_norm_tokens, norm_tokens, strict=False):
                if prev_tok != cur_tok:
                    break
                agreement += 1
        self._prev_norm_tokens = norm_tokens

        # How much of the already-committed prefix the latest hypothesis
        # still agrees with. A shorter value means a committed word was
        # revised (or dropped) — the committed surface must roll back to that
        # point rather than re-slice the stale count, which would silently
        # change the settled region's meaning.
        consistent = 0
        for committed_tok, cur_tok in zip(self._committed_norm_tokens, norm_tokens, strict=False):
            if committed_tok != cur_tok:
                break
            consistent += 1

        if consistent < len(self._committed_norm_tokens):
            # Contradiction inside the committed region: roll back only, never
            # extend past the divergence this round.
            committed_count = consistent
        else:
            # Committed prefix intact: safe to extend by freshly-agreed tokens.
            committed_count = max(len(self._committed_norm_tokens), agreement)

        self._committed_norm_tokens = norm_tokens[:committed_count]
        # NB: ``stable_chars = len(committed)`` is a valid CHARACTER index into
        # the published text only because upstream ``inference.py::_sanitize_text``
        # whitespace-normalizes it (single spaces, stripped) before publish, so
        # this single-space join aligns with it. A caller feeding un-sanitized
        # text into the policy would misalign the settled/tentative boundary.
        self._committed_text = " ".join(tokens[:committed_count])
        self._tentative_text = " ".join(tokens[committed_count:])
        return self._committed_text, self._tentative_text

    def reset(self) -> None:
        """Clear all state (call when an utterance is finalized)."""
        self._prev_norm_tokens = None
        self._committed_norm_tokens = []
        self._committed_text = ""
        self._tentative_text = ""
