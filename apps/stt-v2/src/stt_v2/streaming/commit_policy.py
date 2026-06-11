"""LocalAgreement-2 commit policy for streaming partial hypotheses.

TASK-351 P1-1 — stabilizes the partial transcript stream. Consecutive
partial ASR hypotheses for the same utterance are compared at token level
(whitespace-normalized); the longest common prefix between the latest two
hypotheses is *committed*. Committed text is monotonic: the committed
token count never shrinks, even when a later hypothesis revises earlier
words.

The policy is pure (no I/O, no session knowledge). The session manager
owns one instance per session, calls :meth:`update` per partial, resets
on each final, and publishes ``stable_chars = len(committed)`` alongside
the full partial text.

Comparison normalizes case and strips leading/trailing punctuation from
each token so ``"Hello,"`` agrees with ``"hello"``. The committed/tentative
*surface* text is always taken from the latest hypothesis, which keeps
``stable_chars`` a valid index into the published text.
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
        self._committed_count = 0
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
        of the (whitespace-normalized) hypothesis and ``tentative`` is the
        remainder. The committed token count never shrinks across updates.
        """
        tokens = (hypothesis or "").split()
        norm_tokens = [_normalize_token(t) for t in tokens]

        if self._prev_norm_tokens is not None:
            agreement = 0
            for prev_tok, cur_tok in zip(
                self._prev_norm_tokens, norm_tokens, strict=False
            ):
                if prev_tok != cur_tok:
                    break
                agreement += 1
            if agreement > self._committed_count:
                self._committed_count = agreement

        self._prev_norm_tokens = norm_tokens

        visible = min(self._committed_count, len(tokens))
        self._committed_text = " ".join(tokens[:visible])
        self._tentative_text = " ".join(tokens[visible:])
        return self._committed_text, self._tentative_text

    def reset(self) -> None:
        """Clear all state (call when an utterance is finalized)."""
        self._prev_norm_tokens = None
        self._committed_count = 0
        self._committed_text = ""
        self._tentative_text = ""
