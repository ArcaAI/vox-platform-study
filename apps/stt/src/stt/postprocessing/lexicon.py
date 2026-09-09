"""TASK-935 (R-2) — deterministic clinical-vocabulary correction.

The served fine-tune hears "ceftriaxone" as "septrioxone" live and
"sephotrioxone" offline, on every run (TASK-934 §2.2). Prompt biasing does not
reach a token sequence the weights never learned and whisper.cpp exposes no
logit bias, so the recall has to be recovered AFTER the decode. Owner decision
OD-2 (a) bounds that stage: **only the configured terms**, matched by a bounded
phonetic + edit distance, on partials and finals alike. OD-5 (a) fixes where the
terms come from — the ONE existing ``hotwords`` list (model profile
``decoding.hotwords`` / agent ``instruction.hotwords``, already folded onto the
wire by the resolver), so an admin who names a term gets it both biased in the
decode and corrected after it, and there is no second list to drift.

**What this module may never become.** It is not a spell-checker and not a
medical dictionary: a word the tenant did not name cannot be rewritten by it. A
general lexicon is a data product with its own governance (OD-2 (b), declined).

Pure text functions, import-cheap by design — the streaming worker imports this
on the partial path. Corrections are RETURNED, not logged: the caller owns the
session id, so it owns the log line.

Matching rule
-------------
For each configured term the hypothesis is scanned with a window of the term's
own token count. A window matches when BOTH gates hold, and the gates are
deliberately different in kind — one hears the word, the other reads it:

1. **Phonetic.** The window and the term must agree under a compact
   Metaphone-class key (see :func:`phonetic_keys`) — either the keys are EQUAL,
   or they are within ``max_distance`` of each other (normalised Levenshtein).
2. **Grapheme.** The normalised Levenshtein distance between the window's text
   and the term, ``lev / max(len)``, must be within the ceiling that the
   strength of the phonetic agreement earns: ``max_distance`` for keys that
   merely agree, and twice that (capped at :data:`EXACT_KEY_GRAPHEME_CEILING`)
   for keys that are equal.

The relaxed ceiling is not a loosening of the bound, it is the reason the stage
works on the case it was built for. Both observed mishearings must be reachable
and "oxygen" must survive a configured "oxycodone":

===============  ==============  =============  ==============  ======
term             hypothesis      key distance   grapheme        verdict
===============  ==============  =============  ==============  ======
ceftriaxone      septrioxone     0.143          0.273 ≤ 0.34    correct
ceftriaxone      sephotrioxone   0.000 (equal)  0.385 ≤ 0.50    correct
oxycodone        oxygen          0.167          0.556 > 0.34    keep
===============  ==============  =============  ==============  ======

"sephotrioxone" is 0.385 away on characters — outside the 0.34 bound — and is
recovered ONLY because "PH" and "CEF" are the same sound: its key is
``SFTRKSN``, ceftriaxone's exactly. Dropping the phonetic gate to a single
grapheme bound wide enough for it (≥ 0.39) also admits "oxygen" → "oxycodone"
at 0.556 long before that. The cap at half the characters is the hard floor: no
correction this stage makes ever rewrites more than half of a token.

Cost
----
The scan is O(distinct windows × terms), not O(tokens × terms): a window's
verdict depends only on its own text, so clinical prose — which repeats words
heavily — pays for each distinct word once. Terms are pre-keyed and pre-masked
at construction, grouped by token count, ordered by length so a candidate
bisects straight to the reachable lengths, and reachable-by-EXACT-key terms are
a dict lookup rather than a scan. Measured on the development Mac (M-series,
CPython 3.11) for the worst partial the stage can be handed — 200 tokens against
the full 256-term ceiling — **2.0 ms** on a realistic formulary and **10.6 ms**
on a degenerate list whose 256 terms share one phonetic key. A real hotword list
is single digits (the served model row carries six), which is microseconds.

The key is a LATIN consonant skeleton, so a Malayalam word keys to the empty
string — and an empty key agrees with nothing, on either side. On this
Malayalam-English platform the stage is therefore a deliberate no-op in
Malayalam rather than an edit-distance free-for-all in a script it cannot hear:
a Malayalam hotword still biases the decoder, it is simply never corrected after
it. Code-switched lines correct their Latin tokens and leave the rest alone.

Guards that decide what is NOT touched: a window that already IS a configured
term (so a term is never consumed by its neighbour in the list, and the stage is
idempotent), a token shorter than :data:`MIN_TOKEN_CHARS`, and a phrase window
with punctuation inside it. Casing and edge punctuation belong to the sentence
and are carried over; the token count never changes (a phrase replaces a phrase).
"""

from __future__ import annotations

import re
from bisect import bisect_left, bisect_right
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import NamedTuple

#: Default normalised-Levenshtein bound (TASK-935 §3.1 lane V).
DEFAULT_MAX_DISTANCE = 0.34
#: Hard ceiling on the grapheme distance an EXACT phonetic match may relax to.
#: At 0.5 a correction can never rewrite more than half of the original token.
EXACT_KEY_GRAPHEME_CEILING = 0.5
#: Bounds on the configured list. A lexicon is an enhancement, never a gate:
#: excess terms are dropped, they never fail a session.
MAX_TERMS = 256
MAX_TERM_CHARS = 64
#: Below this many characters a token carries too little signal to be snapped.
MIN_TOKEN_CHARS = 4

_WHITESPACE = re.compile(r"(\s+)")
#: Leading / trailing characters that belong to the sentence, not to the word.
_EDGE = re.compile(r"^(\W*)(.*?)(\W*)$", re.DOTALL)

_VOWELS = frozenset("AEIOUY")


class Correction(NamedTuple):
    """One applied correction.

    ``span`` is a half-open range of WORD indices in the hypothesis (word 1 of
    "intravenous septrioxone and" is ``(1, 2)``); ``score`` is the exact
    normalised grapheme distance that admitted it — smaller is a closer match.
    """

    span: tuple[int, int]
    original: str
    replacement: str
    score: float


def phonetic_keys(word: str) -> tuple[str, str]:
    """Return ``(primary, secondary)`` consonant-skeleton keys for *word*.

    A compact Metaphone-class key, hand-written here rather than vendored: it
    keeps the transformations that decide clinical mishearings — ``PH``/``F``,
    ``C`` before ``E/I/Y`` as ``S`` (with ``K`` as the secondary, which is what
    gives "ceftriaxone" both ``SFTRKSN`` and ``KFTRKSN``), ``X`` as ``KS``,
    ``CH``/``SH`` as ``X``, silent ``GH``, ``Q`` as ``K``, ``Z`` as ``S`` —
    drops vowels except word-initially, and collapses doubled sounds. It is NOT
    Double Metaphone: the full algorithm's language-origin heuristics decide
    surnames, which is not the job here, and would be ~400 lines of vendored
    behaviour this module would then own.

    Non-alphabetic characters are ignored, so "covid-19" keys on "covid".
    The secondary differs from the primary only where ``C``/``G`` before a front
    vowel is genuinely ambiguous; otherwise both are the same string.
    """
    letters = "".join(character for character in word.upper() if character.isalpha())
    if not letters:
        return ("", "")
    primary: list[str] = []
    secondary: list[str] = []

    def emit(sound: str, alternate: str | None = None) -> None:
        if not primary or primary[-1] != sound:
            primary.append(sound)
        other = sound if alternate is None else alternate
        if not secondary or secondary[-1] != other:
            secondary.append(other)

    index = 0
    length = len(letters)
    while index < length:
        char = letters[index]
        following = letters[index + 1] if index + 1 < length else ""
        after = letters[index + 2] if index + 2 < length else ""
        if char in _VOWELS:
            if index == 0:
                emit("A")
            index += 1
        elif char == "B":
            if not (index == length - 1 and index > 0 and letters[index - 1] == "M"):
                emit("P")
            index += 1
        elif char == "C":
            if following == "H":
                emit("X")
                index += 2
            elif following in "EIY":
                emit("S", "K")
                index += 1
            else:
                emit("K")
                index += 1
        elif char == "D":
            if following == "G" and after in "EIY":
                emit("J")
                index += 3
            else:
                emit("T")
                index += 1
        elif char == "G":
            if following == "H":
                if after in _VOWELS:
                    emit("K")
                index += 2
            elif following in "EIY":
                emit("J", "K")
                index += 1
            else:
                emit("K")
                index += 1
        elif char == "H":
            if index > 0 and letters[index - 1] in _VOWELS and following in _VOWELS:
                emit("H")
            index += 1
        elif char == "K":
            if not (index > 0 and letters[index - 1] == "C"):
                emit("K")
            index += 1
        elif char == "P":
            if following == "H":
                emit("F")
                index += 2
            else:
                emit("P")
                index += 1
        elif char == "Q":
            emit("K")
            index += 1
        elif char == "S":
            if following == "H":
                emit("X")
                index += 2
            elif following == "I" and after in "OA":
                emit("X")
                index += 1
            else:
                emit("S")
                index += 1
        elif char == "T":
            if following == "H":
                emit("0")
                index += 2
            elif following == "I" and after in "OA":
                emit("X")
                index += 1
            else:
                emit("T")
                index += 1
        elif char == "V":
            emit("F")
            index += 1
        elif char == "W":
            if following in _VOWELS:
                emit("W")
            index += 1
        elif char == "X":
            emit("K")
            emit("S")
            index += 1
        elif char == "Z":
            emit("S")
            index += 1
        elif char in "FJLMNR":
            emit(char)
            index += 1
        else:  # pragma: no cover — the alphabet above is exhaustive for A-Z
            index += 1
    return ("".join(primary), "".join(secondary))


def _letter_mask(text: str) -> int:
    """Bitmask of the ASCII letters present in *text* (cheap distance floor)."""
    mask = 0
    for character in text:
        position = ord(character) - 97
        if 0 <= position < 26:
            mask |= 1 << position
    return mask


def _mask_floor(left: int, right: int) -> int:
    """Lower bound on the edit distance implied by two letter masks.

    Every distinct letter present on one side and absent on the other occupies a
    position that must be edited; one substitution can serve both sides at once,
    so the bound is the larger of the two counts, never their sum.
    """
    return max((left & ~right).bit_count(), (right & ~left).bit_count())


def _levenshtein_within(left: str, right: str, cutoff: int) -> int:
    """Levenshtein distance, abandoned once it provably exceeds *cutoff*.

    Returns ``cutoff + 1`` for any pair further apart than that. The exact
    distance beyond the bound is never needed, and paying for it is what makes
    an O(tokens × terms) stage too slow for a partial.
    """
    if left == right:
        return 0
    if cutoff <= 0:
        return cutoff + 1
    rows, columns = len(left), len(right)
    if abs(rows - columns) > cutoff:
        return cutoff + 1
    beyond = cutoff + 1
    previous = [column if column <= cutoff else beyond for column in range(columns + 1)]
    for row in range(1, rows + 1):
        current = [beyond] * (columns + 1)
        current[0] = row if row <= cutoff else beyond
        source = left[row - 1]
        best = beyond
        for column in range(max(1, row - cutoff), min(columns, row + cutoff) + 1):
            cost = 0 if source == right[column - 1] else 1
            value = min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost)
            if value > cutoff:
                value = beyond
            current[column] = value
            if value < best:
                best = value
        if best > cutoff:
            return beyond
        previous = current
    return previous[columns]


@dataclass(frozen=True)
class _Token:
    """One whitespace-delimited chunk, split into sentence and word."""

    #: Index into the whitespace-preserving parts list.
    part: int
    prefix: str
    core: str
    suffix: str

    @property
    def folded(self) -> str:
        return self.core.lower()

    @property
    def correctable(self) -> bool:
        return any(character.isalpha() for character in self.core)


@dataclass(frozen=True)
class _Term:
    """A configured term, pre-keyed at construction (the loop must stay cheap)."""

    text: str
    folded: str
    words: int
    keys: tuple[str, ...]
    key_masks: tuple[int, ...]
    mask: int


class LexiconCorrector:
    """Snap hypothesis tokens onto the tenant's configured clinical terms.

    ``terms`` is the resolved hotwords list; ``max_distance`` is the normalised
    Levenshtein bound (0.1–0.5 on the agent schema). Construction is where every
    per-term cost is paid — phonetic keys, letter masks, the by-token-count index
    — so :meth:`correct` stays O(tokens × terms) with a small constant.
    """

    def __init__(
        self,
        terms: Sequence[str] | Iterable[str],
        max_distance: float = DEFAULT_MAX_DISTANCE,
    ) -> None:
        self._max_distance = max(0.0, float(max_distance))
        self._relaxed = min(self._max_distance * 2, EXACT_KEY_GRAPHEME_CEILING)
        accepted: list[str] = []
        compiled: list[_Term] = []
        seen: set[str] = set()
        for raw in terms:
            if len(compiled) >= MAX_TERMS:
                break
            if not isinstance(raw, str):
                continue
            text = " ".join(raw.split())
            if not text or len(text) > MAX_TERM_CHARS:
                continue
            words = [_EDGE.match(word).group(2) for word in text.split()]  # type: ignore[union-attr]
            if not all(word and any(c.isalpha() for c in word) for word in words):
                continue
            folded = " ".join(word.lower() for word in words)
            if folded in seen:
                continue
            seen.add(folded)
            accepted.append(text)
            keys = _distinct_keys(folded)
            compiled.append(
                _Term(
                    text=" ".join(words),
                    folded=folded,
                    words=len(words),
                    keys=keys,
                    key_masks=tuple(_letter_mask(key) for key in keys),
                    mask=_letter_mask(folded),
                )
            )
        self._terms: tuple[str, ...] = tuple(accepted)
        self._compiled: tuple[_Term, ...] = tuple(compiled)
        self._configured: frozenset[str] = frozenset(term.folded for term in compiled)
        #: Terms grouped by token count — a window is only ever compared with terms
        #: of its own width, so the grouping is the first filter and it is free.
        #: Within a group they are ordered by length, which is what lets a candidate
        #: bisect straight to the only lengths an edit distance could reach
        #: (``lev >= |len(a) - len(b)|``, so a term half again as long cannot match).
        by_width: dict[int, list[_Term]] = {}
        for term in compiled:
            by_width.setdefault(term.words, []).append(term)
        self._by_width: dict[int, tuple[_Term, ...]] = {}
        self._lengths: dict[int, tuple[int, ...]] = {}
        #: Terms reachable by an EXACT phonetic key, per width — the relaxed ceiling
        #: is the only path that needs them and a dict answers it without a scan.
        self._by_key: dict[int, dict[str, tuple[_Term, ...]]] = {}
        for width, group in by_width.items():
            group.sort(key=lambda term: len(term.folded))
            self._by_width[width] = tuple(group)
            self._lengths[width] = tuple(len(term.folded) for term in group)
            keyed: dict[str, list[_Term]] = {}
            for term in group:
                for key in term.keys:
                    if key:
                        keyed.setdefault(key, []).append(term)
            self._by_key[width] = {key: tuple(terms) for key, terms in keyed.items()}
        self._widths: tuple[int, ...] = tuple(sorted(self._by_width, reverse=True))

    @property
    def terms(self) -> tuple[str, ...]:
        """The terms actually in force, after the bounds were applied."""
        return self._terms

    @property
    def max_distance(self) -> float:
        return self._max_distance

    @property
    def enabled(self) -> bool:
        """A corrector with no terms is a no-op; callers may skip it entirely."""
        return bool(self._compiled)

    def correct(self, text: str) -> tuple[str, list[Correction]]:
        """Return *text* with configured terms restored, plus what changed.

        The input is returned UNCHANGED — same object, same whitespace — when
        nothing matched, which is the overwhelmingly common case on a partial.
        """
        if not self._compiled or not text or not text.strip():
            return text, []
        parts = _WHITESPACE.split(text)
        tokens = _tokenize(parts)
        if not tokens:
            return text, []

        keys_by_token: dict[str, tuple[tuple[str, ...], tuple[int, ...]]] = {}
        memo: dict[str, tuple[_Term, int, float] | None] = {}
        corrections: list[Correction] = []
        index = 0
        count = len(tokens)
        while index < count:
            match = self._best_at(tokens, index, keys_by_token, memo)
            if match is None:
                index += 1
                continue
            term, width, score = match
            window = tokens[index : index + width]
            original = " ".join(token.core for token in window)
            replacement = _apply_case(window[0].core, term.text)
            parts[window[0].part] = window[0].prefix + replacement + window[-1].suffix
            for part in range(window[0].part + 1, window[-1].part + 1):
                parts[part] = ""
            corrections.append(
                Correction(
                    span=(index, index + width),
                    original=original,
                    replacement=replacement,
                    score=score,
                )
            )
            index += width
        if not corrections:
            return text, []
        return "".join(parts), corrections

    def _best_at(
        self,
        tokens: Sequence[_Token],
        index: int,
        keys_by_token: dict[str, tuple[tuple[str, ...], tuple[int, ...]]],
        memo: dict[str, tuple[_Term, int, float] | None],
    ) -> tuple[_Term, int, float] | None:
        """The closest admissible term at word *index*, or ``None``.

        Wider windows are considered first so a phrase term is never pre-empted
        by a single word inside it; within one width the smallest grapheme
        distance wins.

        The gate order here is chosen for COST, not for meaning — both gates must
        hold either way. The phonetic comparison runs first because its operands
        are consonant skeletons half the length of the words, filtered by an O(1)
        letter-mask floor, so it discards nearly every pair before anything pays
        for a full edit-distance table.
        """
        for width in self._widths:
            if index + width > len(tokens):
                continue
            window = tokens[index : index + width]
            folded = _window_text(window)
            if folded is None or folded in self._configured:
                continue
            # A window's verdict depends only on its folded text, and clinical
            # prose repeats words heavily — so the scan is paid once per DISTINCT
            # window, not once per token.
            if folded in memo:
                remembered = memo[folded]
                if remembered is not None:
                    return remembered
                continue
            cached = keys_by_token.get(folded)
            if cached is None:
                keys = _distinct_keys(folded)
                cached = (keys, tuple(_letter_mask(key) for key in keys))
                keys_by_token[folded] = cached
            keys, key_masks = cached
            mask = _letter_mask(folded)
            length = len(folded)
            relaxed = self._relaxed
            strict = self._max_distance
            best: tuple[_Term, float] | None = None

            # Path A — the keys are EQUAL. A dict answers "which terms sound exactly
            # like this?" without touching the other 255, and these are the only
            # terms the relaxed grapheme ceiling applies to.
            by_key = self._by_key[width]
            for key in keys:
                for term in by_key.get(key, ()):
                    other = len(term.folded)
                    longest = length if length > other else other
                    cutoff = int(relaxed * longest)
                    if abs(length - other) > cutoff:
                        continue
                    distance = _levenshtein_within(folded, term.folded, cutoff)
                    if distance <= cutoff:
                        score = distance / longest
                        if best is None or score < best[1]:
                            best = (term, score)

            # Path B — the keys merely agree, so the strict ceiling stands. Only the
            # lengths inside that ceiling's band can match at all
            # (``lev >= |len(a) - len(b)|``), and the scan is bounded to them.
            group = self._by_width[width]
            lengths = self._lengths[width]
            first = bisect_left(lengths, length - int(strict * length))
            last = bisect_right(lengths, int(length / (1 - strict)))
            for position in range(first, last):
                other = lengths[position]
                longest = length if length > other else other
                cutoff = int(strict * longest)
                if abs(length - other) > cutoff:
                    continue
                term = group[position]
                if _mask_floor(mask, term.mask) > cutoff:
                    continue
                distance = _levenshtein_within(folded, term.folded, cutoff)
                if distance > cutoff:
                    continue
                score = distance / longest
                if best is not None and score >= best[1]:
                    continue
                if self._keys_agree(keys, key_masks, term):
                    best = (term, score)
            if best is None:
                memo[folded] = None
                continue
            found = (best[0], width, best[1])
            memo[folded] = found
            return found
        return None

    def _keys_agree(
        self,
        keys: tuple[str, ...],
        key_masks: tuple[int, ...],
        term: _Term,
    ) -> bool:
        """Is any candidate key within ``max_distance`` of any of *term*'s keys?

        Exact equality is handled by the caller's dict path, so this is the
        "merely agrees" half of the phonetic gate — the one that recovers
        "septrioxone" (``SPTRKSN`` against ``SFTRKSN``, one sound apart).
        """
        bound = self._max_distance
        for position, key in enumerate(keys):
            if not key:
                continue
            key_mask = key_masks[position]
            for other, other_mask in zip(term.keys, term.key_masks, strict=True):
                if not other:
                    continue
                if key == other:
                    return True
                longest = len(key) if len(key) > len(other) else len(other)
                cutoff = int(bound * longest)
                if abs(len(key) - len(other)) > cutoff:
                    continue
                if _mask_floor(key_mask, other_mask) > cutoff:
                    continue
                if _levenshtein_within(key, other, cutoff) <= cutoff:
                    return True
        return False


def _distinct_keys(text: str) -> tuple[str, ...]:
    """Phonetic keys of a (possibly multi-word) string, primary and secondary."""
    words = text.split()
    primary = " ".join(phonetic_keys(word)[0] for word in words)
    secondary = " ".join(phonetic_keys(word)[1] for word in words)
    return (primary,) if primary == secondary else (primary, secondary)


def _tokenize(parts: list[str]) -> list[_Token]:
    """Split the whitespace-preserving *parts* into correctable word tokens."""
    tokens: list[_Token] = []
    for position in range(0, len(parts), 2):
        chunk = parts[position]
        if not chunk:
            continue
        matched = _EDGE.match(chunk)
        if matched is None:  # pragma: no cover — the pattern matches anything
            continue
        prefix, core, suffix = matched.group(1), matched.group(2), matched.group(3)
        if not core:
            continue
        tokens.append(_Token(part=position, prefix=prefix, core=core, suffix=suffix))
    return tokens


def _window_text(window: Sequence[_Token]) -> str | None:
    """The folded text of a candidate window, or ``None`` when it is ineligible.

    A phrase window may not straddle punctuation: "comunity, aquired" is two
    clauses, not a mis-heard phrase, and replacing it would swallow the comma.
    """
    for position, token in enumerate(window):
        if not token.correctable:
            return None
        if len(window) == 1:
            break
        if position > 0 and token.prefix:
            return None
        if position < len(window) - 1 and token.suffix:
            return None
    if len(window) == 1 and len(window[0].core) < MIN_TOKEN_CHARS:
        return None
    return " ".join(token.folded for token in window)


def _apply_case(sample: str, replacement: str) -> str:
    """Carry *sample*'s casing onto *replacement* (the sentence owns the shape)."""
    if len(sample) > 1 and sample.isupper():
        return replacement.upper()
    if sample[:1].isupper():
        return replacement[:1].upper() + replacement[1:]
    return replacement
