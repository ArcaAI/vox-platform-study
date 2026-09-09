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

TASK-935 — the SLIDING window (owner decision OD-1 (a))
-------------------------------------------------------
Prefix agreement assumes a GROWING buffer, and the preprocessor stops
providing one: past ``partial_window_s`` it feeds a rolling TAIL, so the next
hypothesis begins mid-utterance and shares no prefix with the previous one.
Read as prefix agreement that is a contradiction inside the committed region,
which collapsed the settled prefix to zero for the rest of every long utterance
(the live ``stable=0``).

Each hypothesis is therefore ANCHORED to the audio span it decoded
(``window_start_time`` / ``window_end_time``, which the preprocessor already
computes when it trims). While the window has not moved, nothing changes. When
it moves, the text whose audio has left the window is FROZEN — appended to an
accumulated prefix that is never re-decoded and never rolled back — and
LocalAgreement-2 continues on the overlap that is still inside the window. The
published text is then ``frozen + committed-in-window + tentative`` and
``stable_chars`` indexes the whole settled prefix, monotone through the
utterance apart from the in-window rollback above, which is unchanged.

The whole-buffer FINAL remains the persisted record. It may disagree with the
frozen text; the session manager reconciles the two (and logs the discrepancy)
via :meth:`reset` + :meth:`take_handover_text`.
"""

from __future__ import annotations

import re

_EDGE_PUNCTUATION_RE = re.compile(r"^[\W_]+|[\W_]+$", re.UNICODE)

# The window has slid once its start time moves by more than this. The
# preprocessor derives the start from a sample count, so its float noise is
# orders of magnitude below one millisecond.
_SLIDE_EPSILON_S = 1e-3

# How far PAST the proportional estimate the content search may look for the
# alignment offset. The estimate assumes a uniform speaking rate across the
# window, which a pause at either end breaks; one second of head-room absorbs
# that. It only widens the SEARCH — an offset is accepted solely because the
# text at it matches — so it can never freeze more than the audio that left.
_SLIDE_TOLERANCE_S = 1.0


def _normalize_token(token: str) -> str:
    """Lowercase and strip edge punctuation for comparison purposes."""
    lowered = token.lower()
    stripped = _EDGE_PUNCTUATION_RE.sub("", lowered)
    # A token that is pure punctuation normalizes to itself so two identical
    # punctuation tokens still agree.
    return stripped or lowered


def normalize_for_comparison(text: str) -> str:
    """Normalized token stream of *text* — the policy's notion of "agrees".

    Exposed so the final/partial handover reconciliation compares text the same
    way the commit policy does, rather than inventing a second rule.
    """
    return " ".join(_normalize_token(token) for token in text.split())


def _tokens_before(tokens: list[str], char_cut: float) -> int:
    """Count the whole tokens of *tokens* that END at or before ``char_cut``.

    Character positions are those of ``" ".join(tokens)``. A token straddling
    the cut is NOT counted, which is what makes the estimate conservative: it
    reports less text as having left the window than may actually have.
    """
    count = 0
    position = 0
    for token in tokens:
        position += len(token)
        if position > char_cut:
            break
        count += 1
        position += 1  # the joining space
    return count


class LocalAgreementPolicy:
    """LocalAgreement-2: commit the agreed prefix of the last two hypotheses."""

    def __init__(self) -> None:
        self._prev_tokens: list[str] = []
        self._prev_norm_tokens: list[str] | None = None
        # Frozen identity of the in-window committed prefix (normalized tokens).
        self._committed_norm_tokens: list[str] = []
        self._committed_tokens: list[str] = []
        self._in_window_text = ""
        self._tentative_text = ""
        # Committed text whose audio has left the partial window: settled for
        # good, never re-decoded and never rolled back (OD-1 (a)).
        self._frozen_tokens: list[str] = []
        self._frozen_text = ""
        self._window_start_time: float | None = None
        self._window_end_time: float | None = None
        self._last_slide: tuple[int, int] | None = None
        self._handover_text = ""

    @property
    def committed_text(self) -> str:
        """The whole settled prefix — frozen text plus the in-window commit."""
        return " ".join(part for part in (self._frozen_text, self._in_window_text) if part)

    @property
    def tentative_text(self) -> str:
        """Uncommitted tail of the most recent hypothesis."""
        return self._tentative_text

    @property
    def frozen_text(self) -> str:
        """Settled text whose audio has already left the partial window."""
        return self._frozen_text

    @property
    def published_text(self) -> str:
        """What the caption should carry: settled prefix + tentative tail."""
        return " ".join(part for part in (self.committed_text, self._tentative_text) if part)

    @property
    def last_slide(self) -> tuple[int, int] | None:
        """``(frozen_chars, in_window_chars)`` when the last update slid, else None."""
        return self._last_slide

    def update(
        self,
        hypothesis: str,
        *,
        window_start_time: float | None = None,
        window_end_time: float | None = None,
    ) -> tuple[str, str]:
        """Fold a new partial hypothesis into the policy.

        ``window_start_time`` / ``window_end_time`` anchor the hypothesis to the
        audio span it decoded (``AudioUtterance.start_time`` / ``end_time``).
        Omit them — as every pre-TASK-935 caller does — and the policy behaves
        exactly as it did: prefix agreement over a growing buffer.

        Returns ``(committed, tentative)`` where ``committed`` is the settled
        prefix of :attr:`published_text` and ``tentative`` is the remainder. A
        committed token position INSIDE the window is frozen: it only grows
        while the latest hypothesis keeps agreeing with it, and rolls back to
        the last still-agreeing token when a later hypothesis revises an
        already committed word — it is never silently replaced with different
        text. A token whose audio has LEFT the window is frozen outright and no
        later hypothesis can touch it.
        """
        tokens = (hypothesis or "").split()
        norm_tokens = [_normalize_token(t) for t in tokens]

        slid = self._absorb_slide(norm_tokens, window_start_time)

        # LocalAgreement-2: length of the prefix agreed by the last two
        # hypotheses (both re-anchored to the same audio span above).
        agreement = 0
        if self._prev_norm_tokens is not None:
            for prev_tok, cur_tok in zip(self._prev_norm_tokens, norm_tokens, strict=False):
                if prev_tok != cur_tok:
                    break
                agreement += 1
        self._prev_norm_tokens = norm_tokens
        self._prev_tokens = tokens

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
        self._committed_tokens = tokens[:committed_count]
        # NB: ``stable_chars = len(committed)`` is a valid CHARACTER index into
        # the published text only because upstream ``inference.py::_sanitize_text``
        # whitespace-normalizes it (single spaces, stripped) before publish, so
        # this single-space join aligns with it. A caller feeding un-sanitized
        # text into the policy would misalign the settled/tentative boundary.
        self._in_window_text = " ".join(self._committed_tokens)
        self._tentative_text = " ".join(tokens[committed_count:])
        self._window_start_time = window_start_time
        self._window_end_time = window_end_time
        self._last_slide = (len(self._frozen_text), len(self._in_window_text)) if slid else None
        return self.committed_text, self.tentative_text

    def reset(self) -> None:
        """Clear all state (call when an utterance is finalized).

        The frozen text survives as a one-shot handover value so the caller can
        reconcile it with the whole-buffer final, which arrives AFTER this reset
        (the preprocessor closes the utterance at the silence cut, before the
        final is decoded). Read it with :meth:`take_handover_text`.
        """
        self._handover_text = self._frozen_text
        self._prev_tokens = []
        self._prev_norm_tokens = None
        self._committed_norm_tokens = []
        self._committed_tokens = []
        self._in_window_text = ""
        self._tentative_text = ""
        self._frozen_tokens = []
        self._frozen_text = ""
        self._window_start_time = None
        self._window_end_time = None
        self._last_slide = None

    def take_handover_text(self) -> str:
        """Pop the frozen text left by the last :meth:`reset` (empty once read)."""
        text = self._handover_text
        self._handover_text = ""
        return text

    # -- the sliding window -------------------------------------------------

    def _absorb_slide(self, cur_norm: list[str], window_start_time: float | None) -> bool:
        """Freeze what has left the window and re-anchor the previous hypothesis.

        Returns True when the window moved. Both hypotheses must describe the
        SAME audio span before LocalAgreement-2 compares them, so the previous
        one is dropped by the same offset as the committed prefix.
        """
        prev_start = self._window_start_time
        if (
            window_start_time is None
            or prev_start is None
            or window_start_time <= prev_start + _SLIDE_EPSILON_S
        ):
            return False

        estimate, ceiling = self._slide_offsets(prev_start, window_start_time)
        anchor = self._align(cur_norm, ceiling)
        if anchor is None:
            # The engine's new window does not reproduce ANY tail of the settled
            # text, so there is nothing to align on: fall back to the timing
            # estimate, which under-freezes by construction. What is retained
            # then contradicts the new hypothesis and rolls back normally —
            # pre-TASK-935 behaviour, but only for the part still in the window.
            anchor = estimate

        freeze = min(anchor, len(self._committed_tokens))
        if freeze:
            self._frozen_tokens.extend(self._committed_tokens[:freeze])
            self._frozen_text = " ".join(self._frozen_tokens)
        self._committed_tokens = self._committed_tokens[freeze:]
        self._committed_norm_tokens = self._committed_norm_tokens[freeze:]
        if self._prev_norm_tokens is not None:
            self._prev_norm_tokens = self._prev_norm_tokens[anchor:]
        return True

    def _slide_offsets(self, prev_start: float, window_start_time: float) -> tuple[int, int]:
        """``(estimate, ceiling)`` token offsets for the audio that left the window.

        Word timings are not available (``wordTimestamps: false`` on the served
        profile), so the split is ESTIMATED proportionally: text is assumed to
        be spread evenly across the previous window's span, and the elapsed
        fraction of that span maps to a character position, snapped DOWN to a
        whole token. ``ceiling`` is the same arithmetic with
        ``_SLIDE_TOLERANCE_S`` of head-room and bounds the content search.
        """
        prev_tokens = self._prev_tokens
        prev_end = self._window_end_time
        span = (prev_end - prev_start) if prev_end is not None else 0.0
        if span <= 0.0 or not prev_tokens:
            # No usable geometry: let the content search look at the whole
            # committed prefix, and freeze nothing if it finds no anchor.
            return 0, len(prev_tokens)
        elapsed = min(max(0.0, window_start_time - prev_start), span)
        text_length = len(" ".join(prev_tokens))
        estimate = _tokens_before(prev_tokens, text_length * elapsed / span)
        ceiling = _tokens_before(
            prev_tokens, text_length * min(1.0, (elapsed + _SLIDE_TOLERANCE_S) / span)
        )
        return estimate, ceiling

    def _align(self, cur_norm: list[str], ceiling: int) -> int | None:
        """Smallest offset at which the settled text is a prefix of *cur_norm*.

        Self-verifying: an offset is accepted only because the tokens at it
        actually match, so a match can never freeze text the new window still
        reproduces. The smallest match is taken, which errs toward freezing
        LESS and keeping more of the settled text under continued verification.
        The trivial empty match (offset == len(committed)) is excluded — it
        would freeze everything on no evidence at all.
        """
        committed = self._committed_norm_tokens
        for offset in range(min(ceiling, len(committed) - 1) + 1):
            tail = committed[offset:]
            if cur_norm[: len(tail)] == tail:
                return offset
        return None
