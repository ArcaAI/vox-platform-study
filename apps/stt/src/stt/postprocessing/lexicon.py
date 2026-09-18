"""TASK-935 (R-2) / TASK-985 (M-31) — deterministic clinical-vocabulary correction.

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
own token count. Three gates decide a window, and they are deliberately
different in kind — one asks whether the candidate is a word at all, one hears
it, one reads it:

0. **Vocabulary (TASK-985).** A window whose EVERY token is a known ordinary
   word of the language is never rewritten, at any distance, on any path. This
   is a hard refusal, not a score penalty: a spurious drug or lab name inserted
   into a clinical record is a patient-safety event, while a missed correction
   is a legible mis-spelling a clinician reads past. The words come from an
   INJECTED :class:`ProtectedVocabulary` and the default is empty, so the gate
   is armed by configuration, never by a word list hardcoded here — a language's
   vocabulary is a versioned asset, and a module that ships one owns it forever.
   **Until a deployment supplies one the gate is inert**, and the six ordinary
   words the committed corpus catches the served term list rewriting — "certain",
   "creatine" (a DIFFERENT substance from creatinine), "creating", "creation",
   "creative", "isopropyl" — keep being rewritten. That half of M-31 closes when
   the asset arrives, not here.
1. **Phonetic.** The window and the term must agree under a compact
   Metaphone-class key (see :func:`phonetic_keys`) — their normalised key
   distance must be within ``max_distance``. Equal keys are distance 0.
2. **Grapheme.** The normalised Levenshtein distance between the window's text
   and the term, ``lev / max(len)``, must be within the ceiling that the
   CLOSENESS of the phonetic agreement earned it.

Why the relaxation is graded (TASK-985 M-31)
--------------------------------------------
The relaxation used to be a BINARY switch on exact key equality: equal keys
earned ``EXACT_KEY_GRAPHEME_CEILING``, everything else fell to ``max_distance``.
That cliff is what lost the real mishearing. "Atorvacetam" keys ``ATRFSTM``
against atorvastatin's ``ATRFSTN`` — one terminal nasal, the most confusable
consonant pair in speech and one the compact key deliberately never collapses —
and that single edit cost it ALL relaxation, dropping it onto the strict path
where ``int(0.34 × 12) = 4`` rejected its 5 edits by one. Meanwhile "creating"
is also one key-edit from "creatinine" and sailed through the same strict path
purely because its term is two characters shorter (``int(0.34 × 10) = 3``
against a distance of exactly 3).

So the bound was never the lever: keeping "Atorvacetam" needs ``b >= 0.4167``
and dropping "creating" needs ``b < 0.30``, which is unsatisfiable. Tightening
the bound would have killed the true positives the stage exists for. Two changes
fix the mechanism instead:

* the ceiling is now a CONTINUOUS function of the key distance ``k`` —
  ``strict + (relaxed - strict) × (1 - k / strict)``, clamped to
  ``[strict, relaxed]`` — so equal keys still earn the full relaxed ceiling and
  a one-nasal miss earns most of it instead of none;
* the vocabulary gate above supplies the axis that actually separates
  "Atorvacetam" (not a word) from "creating" (a word), which no distance can.

The graded ceiling only ever ADMITS more than the binary switch did, which is
why it ships ON by default and the word gate does not: swept over the 1102-word
ordinary-English corpus committed beside this module's tests, grading and the
binary switch rewrite **exactly the same six words** — grading costs nothing an
ordinary vocabulary can see, and buys back the mishearing. It is not a
widening of the outer envelope either: the hard half-token ceiling is unchanged,
and the candidates grading admits are the ones the binary switch already granted
0.5 to whenever their keys happened to land exactly equal.

The BOUNDS themselves are unchanged pending calibration — this lane fixed the
mechanism, not the constants. ``relaxed_max_distance`` exists so the
strict × relaxed cross-product can be swept offline before either moves.

================  ==============  ========  ========  ==========  ============
term              hypothesis      key dist  ceiling   grapheme    verdict
================  ==============  ========  ========  ==========  ============
ceftriaxone       septrioxone     0.143     0.433     0.273       correct
ceftriaxone       sephotrioxone   0.000     0.500     0.385       correct
atorvastatin      Atorvacetam     0.143     0.433     0.417       correct
oxycodone         oxygen          0.167     0.422     0.556       keep (bound)
creatinine        creating        0.200     0.406     0.300       keep (word)
================  ==============  ========  ========  ==========  ============

"sephotrioxone" is 0.385 away on characters and is recovered ONLY because "PH"
and "CEF" are the same sound: its key is ``SFTRKSN``, ceftriaxone's exactly.
"oxygen" survives a configured "oxycodone" on the bound alone at every ceiling
this module can earn, and is protected a second time by the word gate. The cap
at half the characters is the hard floor: no correction this stage makes ever
rewrites more than half of a token.

Cost
----
The scan is O(distinct windows × terms), not O(tokens × terms): a window's
verdict depends only on its own text, so clinical prose — which repeats words
heavily — pays for each distinct word once. Terms are pre-keyed and pre-masked
at construction, grouped by token count, ordered by length so a candidate
bisects straight to the reachable lengths, and reachable-by-EXACT-key terms are
a dict lookup rather than a scan. The phonetic comparison now runs BEFORE the
word-level edit distance (it has to — it decides the ceiling), which is also the
cheaper order: consonant skeletons are half the length of the words and are
filtered by an O(1) letter-mask floor first — so on the worst partial the stage
can be handed (200 tokens against the 256-term ceiling, all sharing one phonetic
key) it is measurably FASTER than the binary matcher it replaces. The merging
path costs the other direction — it tries windows no term's width asks for — and
is bought back by refusing a width whose first token opens no term's squash.

The key is a LATIN consonant skeleton, so a Malayalam word keys to the empty
string — and an empty key agrees with nothing, on either side. On this
Malayalam-English platform the fuzzy path is therefore a deliberate no-op in
Malayalam rather than an edit-distance free-for-all in a script it cannot hear:
a Malayalam hotword still biases the decoder, it is simply never corrected by
distance. The one path that DOES cross scripts is the space-agnostic one below,
and it does so only on an exact match, where there is no distance to be wrong
about.

Guards that decide what is NOT touched: a window whose every token is an
ordinary word, a window that already IS a configured term (so a term is never
consumed by its neighbour in the list, and the stage is idempotent), a token
shorter than :data:`MIN_TOKEN_CHARS` on the fuzzy path, and a phrase window with
punctuation inside it. Casing and edge punctuation belong to the sentence and
are carried over.

The space-agnostic path (TASK-985)
----------------------------------
``MIN_TOKEN_CHARS`` blocks a two- or three-letter token from ever being snapped,
which is right for a distance match — one edit on "bp" is half the token — and
wrong for a match that has no distance at all. So a window is ALSO compared to
the terms with its spaces and internal punctuation squashed out, and that
comparison is EXACT: "b.p." and "cef tri axone" reach their terms, "pb" does
not. Tokens may be MERGED this way (the term replaces the whole window); they
are never split, so a one-token window never becomes a phrase.
"""

from __future__ import annotations

import re
import unicodedata
from bisect import bisect_left, bisect_right
from collections.abc import Iterable, MutableMapping, Sequence
from dataclasses import dataclass
from typing import NamedTuple, Protocol

#: Default normalised-Levenshtein bound (TASK-935 §3.1 lane V).
DEFAULT_MAX_DISTANCE = 0.34
#: Hard ceiling on the grapheme distance a phonetic match may relax to.
#: At 0.5 a correction can never rewrite more than half of the original token.
EXACT_KEY_GRAPHEME_CEILING = 0.5
#: Bounds on the configured list. A lexicon is an enhancement, never a gate:
#: excess terms are dropped, they never fail a session.
MAX_TERMS = 256
MAX_TERM_CHARS = 64
#: Below this many characters a token carries too little signal to be snapped by
#: DISTANCE. The space-agnostic path, which is exact, is not bound by it.
MIN_TOKEN_CHARS = 4
#: Widest window the space-agnostic path will try to merge. Four tokens is the
#: longest transliterated abbreviation observed ("വി പി ഡി" is three).
SPACE_AGNOSTIC_MAX_WINDOW = 4

#: The stages a :class:`Correction` can be attributed to. A bounded label set:
#: a metric that counts them must never carry an unbounded label.
STAGES: tuple[str, ...] = ("exact", "space_agnostic", "graded", "phonetic")
#: Why a candidate window was refused. Also a bounded label set. ``no_term``
#: means the window had no reachable candidate at that width at all, which is
#: the overwhelmingly common case and not an interesting rejection.
REJECTION_REASONS: tuple[str, ...] = (
    "protected_word",
    "grapheme",
    "phonetic",
    "min_chars",
    "punctuation",
    "already_term",
    "no_term",
)
#: The key :meth:`LexiconCorrector.correct` uses for the DENOMINATOR. A counter
#: of corrections with no denominator cannot tell 25 % from 0.5 %.
TOKENS_SCANNED = "tokens_scanned"

_WHITESPACE = re.compile(r"(\s+)")

#: Frozensets, NOT string literals. ``"" in "EIY"`` is True in Python — it is a
#: substring test — so a word-FINAL ``C`` or ``G`` (where the following letter is
#: the empty string) used to take the front-vowel branch: "creating" keyed
#: ``KRTNJ``/``KRTNK`` rather than ``KRTNK``, and "tonic" ended in ``S``. The
#: same held for the ``SI``/``TI`` and ``DG`` lookaheads. Set membership answers
#: False for the empty string, which is the only reason these are frozensets.
_VOWELS = frozenset("AEIOUY")
_FRONT_VOWELS = frozenset("EIY")
_SIBILANT_FOLLOWERS = frozenset("OA")


class ProtectedVocabulary(Protocol):
    """"Is this an ordinary word of the language?" — the gate's only question.

    Deliberately the narrowest possible interface: a membership test over FOLDED
    (lower-cased) surface forms. It is injected, and the default is empty,
    because the word list itself is neither code nor configuration — it is a
    versioned, digest-addressed language asset delivered beside the model
    weights, unioned with the tenant's own short ``protect`` / ``unprotect``
    delta before it ever reaches this module (TASK-985 ST-7). Nothing here
    hardcodes an English word, and nothing here reads a database.
    """

    def __contains__(self, word: str, /) -> bool: ...


class Correction(NamedTuple):
    """One applied correction.

    ``span`` is a half-open range of WORD indices in the hypothesis (word 1 of
    "intravenous septrioxone and" is ``(1, 2)``); ``score`` is the exact
    normalised grapheme distance that admitted it — smaller is a closer match,
    and the space-agnostic path is always 0.0. ``stage`` is one of
    :data:`STAGES` and is, with ``replacement``, the only field safe to log
    above DEBUG: ``original`` is decoder output over patient speech, and the
    log is the one place a transcript can be read without decrypting a
    ``ContextItem``.
    """

    span: tuple[int, int]
    original: str
    replacement: str
    score: float
    stage: str = "phonetic"


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
            elif following in _FRONT_VOWELS:
                emit("S", "K")
                index += 1
            else:
                emit("K")
                index += 1
        elif char == "D":
            if following == "G" and after in _FRONT_VOWELS:
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
            elif following in _FRONT_VOWELS:
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
            elif following == "I" and after in _SIBILANT_FOLLOWERS:
                emit("X")
                index += 1
            else:
                emit("S")
                index += 1
        elif char == "T":
            if following == "H":
                emit("0")
                index += 2
            elif following == "I" and after in _SIBILANT_FOLLOWERS:
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


def _is_word_character(character: str) -> bool:
    """Does *character* belong to the WORD, rather than to the sentence?

    Alphanumeric, or a combining mark. The mark clause is the load-bearing half
    on this platform: ``\\W`` — and ``str.isalnum`` — are False for the Mn/Mc
    categories, so the regex this replaced stripped a Malayalam word's own vowel
    sign off as if it were a comma. "ബി പി" tokenised as two cores "ബ" and "പ"
    with "ി" as trailing punctuation, which made every multi-token Malayalam
    window look like it straddled punctuation and be refused.
    """
    return character.isalnum() or unicodedata.category(character)[0] == "M"


def _split_edges(chunk: str) -> tuple[str, str, str]:
    """Split *chunk* into ``(prefix, core, suffix)``.

    The prefix and suffix are the leading and trailing characters that belong to
    the sentence — quotes, brackets, commas, the full stop. Punctuation INSIDE
    the chunk stays in the core: "b.p" is one word with a stop in it, and the
    space-agnostic path is what reads it.
    """
    start, end = 0, len(chunk)
    while start < end and not _is_word_character(chunk[start]):
        start += 1
    while end > start and not _is_word_character(chunk[end - 1]):
        end -= 1
    return chunk[:start], chunk[start:end], chunk[end:]


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


#: A window's verdict: the term it snaps to, or the reason it was refused.
_Match = tuple[_Term, int, float, str]
_Verdict = _Match | str


class LexiconCorrector:
    """Snap hypothesis tokens onto the tenant's configured clinical terms.

    ``terms`` is the resolved hotwords list; ``max_distance`` is the normalised
    Levenshtein bound (0.1–0.5 on the agent schema). Construction is where every
    per-term cost is paid — phonetic keys, letter masks, the by-token-count index
    — so :meth:`correct` stays O(tokens × terms) with a small constant.

    ``protected_vocabulary`` arms the word gate (TASK-985 M-31): a set, mapping
    or any object answering ``in`` over FOLDED words, or a list/tuple of words
    which is folded and frozen for you. The default is ``None`` — no gate —
    because this module owns no word list; see :class:`ProtectedVocabulary`.

    ``relaxed_max_distance`` overrides the relaxed ceiling (default: twice
    ``max_distance``, capped at :data:`EXACT_KEY_GRAPHEME_CEILING`, never below
    ``max_distance``). It exists for offline calibration of the strict × relaxed
    pair; production passes the resolved spec's single ``max_distance``.

    ``graded_relaxation`` is the TASK-985 ceiling and is ON. Turning it off
    restores the binary exact-key switch exactly as it shipped, which is what the
    control arm of the bound calibration needs — not a posture any deployment
    should adopt, since the arm it disables is the one that recovers
    "Atorvacetam".
    """

    def __init__(
        self,
        terms: Sequence[str] | Iterable[str],
        max_distance: float = DEFAULT_MAX_DISTANCE,
        *,
        relaxed_max_distance: float | None = None,
        protected_vocabulary: ProtectedVocabulary | Sequence[str] | None = None,
        graded_relaxation: bool = True,
    ) -> None:
        self._max_distance = max(0.0, float(max_distance))
        relaxed = (
            self._max_distance * 2
            if relaxed_max_distance is None
            else max(0.0, float(relaxed_max_distance))
        )
        # Never below the strict bound: a "relaxation" that tightens is a bug
        # waiting for someone to configure max_distance above the hard ceiling.
        self._relaxed = max(min(relaxed, EXACT_KEY_GRAPHEME_CEILING), self._max_distance)
        self._protected = _as_vocabulary(protected_vocabulary)
        self._graded = graded_relaxation
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
            words = [_split_edges(word)[1] for word in text.split()]
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
        #: of its own width on the FUZZY paths, so the grouping is the first filter
        #: and it is free. Within a group they are ordered by length, which is what
        #: lets a candidate bisect straight to the only lengths an edit distance
        #: could reach (``lev >= |len(a) - len(b)|``, so a term half again as long
        #: cannot match).
        by_width: dict[int, list[_Term]] = {}
        for term in compiled:
            by_width.setdefault(term.words, []).append(term)
        self._by_width: dict[int, tuple[_Term, ...]] = {}
        self._lengths: dict[int, tuple[int, ...]] = {}
        #: Terms reachable by an EXACT phonetic key, per width — key equality is
        #: the only distance that earns the full relaxed ceiling and a dict answers
        #: it without a scan.
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
        #: Terms by their SQUASHED form (spaces and inner punctuation removed) —
        #: the space-agnostic path, exact by construction. First term wins, so a
        #: list carrying both "BP" and "B P" keeps the one the admin wrote first.
        self._by_squash: dict[str, _Term] = {}
        for term in compiled:
            self._by_squash.setdefault(_squash(term.folded), term)
        #: Every proper prefix of a squashed term. A window can only ever MERGE
        #: into a term whose squash it equals, so a window whose first token is
        #: not one of these prefixes cannot match at any width above one — which
        #: is what stops the merging path from costing every ordinary word three
        #: extra window builds on the partial path.
        self._squash_prefixes: frozenset[str] = frozenset(
            squashed[:size] for squashed in self._by_squash for size in range(1, len(squashed))
        )
        #: Widths to try, widest first. A width with no terms of its own is still
        #: worth trying: the space-agnostic path MERGES, so "cef tri axone" is a
        #: three-token window against a one-token term.
        widths = set(by_width)
        if compiled:
            widths.update(range(1, SPACE_AGNOSTIC_MAX_WINDOW + 1))
        self._widths: tuple[int, ...] = tuple(sorted(widths, reverse=True))

    @property
    def terms(self) -> tuple[str, ...]:
        """The terms actually in force, after the bounds were applied."""
        return self._terms

    @property
    def max_distance(self) -> float:
        return self._max_distance

    @property
    def relaxed_max_distance(self) -> float:
        """The widest grapheme ceiling any candidate can earn."""
        return self._relaxed

    @property
    def protected(self) -> bool:
        """Is the ordinary-word gate armed? (Is a vocabulary configured?)"""
        return self._protected is not None

    @property
    def graded(self) -> bool:
        """Is the ceiling a function of key distance, or the old binary switch?"""
        return self._graded

    @property
    def enabled(self) -> bool:
        """A corrector with no terms is a no-op; callers may skip it entirely."""
        return bool(self._compiled)

    def correct(
        self,
        text: str,
        *,
        stats: MutableMapping[str, int] | None = None,
    ) -> tuple[str, list[Correction]]:
        """Return *text* with configured terms restored, plus what changed.

        The input is returned UNCHANGED — same object, same whitespace — when
        nothing matched, which is the overwhelmingly common case on a partial.

        Pass ``stats`` to collect the counters the stage has never had (there is
        no Prometheus metric for it today, only a DEBUG log): :data:`TOKENS_SCANNED`
        is incremented by the token count — the denominator — and each refused
        CANDIDATE WINDOW increments one of :data:`REJECTION_REASONS`. A window is
        counted once per width tried, so ``no_term`` dominates and is the one to
        drop at the metric; ``protected_word`` is the interesting one, because it
        is the only way the word gate's effect is ever visible in production.
        """
        if not self._compiled or not text or not text.strip():
            return text, []
        parts = _WHITESPACE.split(text)
        tokens = _tokenize(parts)
        if not tokens:
            return text, []
        if stats is not None:
            stats[TOKENS_SCANNED] = stats.get(TOKENS_SCANNED, 0) + len(tokens)

        keys_by_token: dict[str, tuple[tuple[str, ...], tuple[int, ...]]] = {}
        squash_by_token: dict[str, str] = {}
        memo: dict[str, _Verdict] = {}
        corrections: list[Correction] = []
        index = 0
        count = len(tokens)
        while index < count:
            match = self._best_at(tokens, index, keys_by_token, squash_by_token, memo, stats)
            if match is None:
                index += 1
                continue
            term, width, score, stage = match
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
                    stage=stage,
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
        squash_by_token: dict[str, str],
        memo: dict[str, _Verdict],
        stats: MutableMapping[str, int] | None,
    ) -> _Match | None:
        """The closest admissible term at word *index*, or ``None``.

        Wider windows are considered first so a phrase term is never pre-empted
        by a single word inside it; within one width the smallest grapheme
        distance wins.
        """
        for width in self._widths:
            if index + width > len(tokens):
                continue
            if width > 1 and width not in self._by_width:
                # A width no term has: reachable ONLY by merging, so the window's
                # first token must open some term's squash. One set lookup, and
                # ordinary prose never pays for the rest of this width.
                head = _token_squash(tokens[index], squash_by_token)
                if head not in self._squash_prefixes:
                    continue
            window = tokens[index : index + width]
            folded = _window_text(window)
            if folded is None:
                _bump(stats, "punctuation")
                continue
            if folded in self._configured:
                _bump(stats, "already_term")
                continue
            # A window's verdict depends only on its folded text, and clinical
            # prose repeats words heavily — so the scan is paid once per DISTINCT
            # window, not once per token. The folded text carries its own width
            # (a two-token window has a space in it), so one memo serves them all.
            verdict = memo.get(folded)
            if verdict is None:
                verdict = self._evaluate(window, folded, width, keys_by_token, squash_by_token)
                memo[folded] = verdict
            if isinstance(verdict, str):
                _bump(stats, verdict)
                continue
            return verdict
        return None

    def _evaluate(
        self,
        window: Sequence[_Token],
        folded: str,
        width: int,
        keys_by_token: dict[str, tuple[tuple[str, ...], tuple[int, ...]]],
        squash_by_token: dict[str, str],
    ) -> _Verdict:
        """Decide one candidate window: the term it snaps to, or why it did not."""
        # The space-agnostic path is exact, so MIN_TOKEN_CHARS does not bind it and
        # a non-Latin script is safe (there is no distance to be wrong about).
        # A window's squash is its tokens' squashes joined — the space between them
        # is the one thing squashing drops — so it is assembled from a per-token
        # cache rather than rescanning the same words at four different widths.
        merged = self._by_squash.get(_window_squash(window, squash_by_token))
        group = self._by_width.get(width, ())
        if merged is None and not group:
            return "no_term"

        # Gate 0 — the window is ordinary language. Refused on every path, at every
        # distance, ahead of every match. It runs only once a candidate exists, so
        # the counter it feeds measures refusals rather than empty widths.
        if self._is_protected(window):
            return "protected_word"

        if merged is not None and merged.words <= width:
            # ``words <= width`` merges tokens but never SPLITS one: a hypothesis
            # word may become a term, never a phrase.
            return (merged, width, 0.0, "exact" if width == 1 else "space_agnostic")

        if not group:
            return "no_term"
        if width == 1 and len(window[0].core) < MIN_TOKEN_CHARS:
            return "min_chars"

        cached = keys_by_token.get(folded)
        if cached is None:
            keys = _distinct_keys(folded)
            cached = (keys, tuple(_letter_mask(key) for key in keys))
            keys_by_token[folded] = cached
        keys, key_masks = cached
        mask = _letter_mask(folded)
        length = len(folded)
        strict = self._max_distance
        widest = self._relaxed if self._graded else strict
        best: tuple[_Term, float, float] | None = None
        agreed = False

        # Path A — the keys are EQUAL. A dict answers "which terms sound exactly
        # like this?" without touching the other 255, and key distance 0 is what
        # earns the full relaxed ceiling on any setting of the grading switch.
        exact_ceiling = self._ceiling_for(0.0)
        by_key = self._by_key.get(width, {})
        for key in keys:
            if not key:
                continue
            for term in by_key.get(key, ()):
                agreed = True
                other = len(term.folded)
                longest = length if length > other else other
                cutoff = int(exact_ceiling * longest)
                if abs(length - other) > cutoff:
                    continue
                distance = _levenshtein_within(folded, term.folded, cutoff)
                if distance <= cutoff:
                    score = distance / longest
                    if best is None or score < best[1]:
                        best = (term, score, exact_ceiling)

        # Path B — the keys merely agree, and HOW closely decides the ceiling. Only
        # the lengths inside the widest ceiling's band can match at all
        # (``lev >= |len(a) - len(b)|``), and the scan is bounded to them.
        lengths = self._lengths[width]
        first = bisect_left(lengths, length - int(widest * length))
        last = bisect_right(lengths, int(length / (1 - widest))) if widest < 1 else len(lengths)
        for position in range(first, last):
            other = lengths[position]
            longest = length if length > other else other
            widest_cutoff = int(widest * longest)
            # O(1) floors first, against the widest ceiling anything could earn.
            if abs(length - other) > widest_cutoff:
                continue
            term = group[position]
            if _mask_floor(mask, term.mask) > widest_cutoff:
                continue
            key_distance = self._key_distance(keys, key_masks, term)
            if key_distance is None:
                continue
            agreed = True
            ceiling = self._ceiling_for(key_distance)
            cutoff = int(ceiling * longest)
            distance = _levenshtein_within(folded, term.folded, cutoff)
            if distance > cutoff:
                continue
            score = distance / longest
            if best is None or score < best[1]:
                best = (term, score, ceiling)

        if best is None:
            return "grapheme" if agreed else "phonetic"
        term, score, ceiling = best
        return (term, width, score, "graded" if ceiling > strict else "phonetic")

    def _ceiling_for(self, key_distance: float) -> float:
        """The grapheme ceiling a candidate earns for sounding *this* close.

        Equal keys (0.0) earn the relaxed ceiling; a candidate at the phonetic
        bound earns the strict one; in between the relaxation is proportional.
        With grading off it collapses back to the binary switch it replaced —
        the control arm, and the only shape in which "Atorvacetam" is missed.
        """
        strict = self._max_distance
        relaxed = self._relaxed
        if not self._graded or relaxed <= strict or strict <= 0.0:
            return relaxed if key_distance <= 0.0 else strict
        earned = strict + (relaxed - strict) * (1.0 - key_distance / strict)
        if earned <= strict:
            return strict
        return relaxed if earned > relaxed else earned

    def _key_distance(
        self,
        keys: tuple[str, ...],
        key_masks: tuple[int, ...],
        term: _Term,
    ) -> float | None:
        """Closest normalised key distance within the bound, or ``None``.

        This IS the phonetic gate — a candidate further than ``max_distance``
        from every one of the term's keys is refused here and never reaches a
        grapheme comparison. It returns the distance rather than a boolean
        because the distance is what buys the relaxation: "septrioxone"
        (``SPTRKSN`` against ``SFTRKSN``, one sound apart) earns most of it,
        and equal keys earn all of it.
        """
        bound = self._max_distance
        best: float | None = None
        for position, key in enumerate(keys):
            if not key:
                continue
            key_mask = key_masks[position]
            for other, other_mask in zip(term.keys, term.key_masks, strict=True):
                if not other:
                    continue
                if key == other:
                    return 0.0
                longest = len(key) if len(key) > len(other) else len(other)
                cutoff = int(bound * longest)
                if cutoff <= 0:
                    continue
                if abs(len(key) - len(other)) > cutoff:
                    continue
                if _mask_floor(key_mask, other_mask) > cutoff:
                    continue
                distance = _levenshtein_within(key, other, cutoff)
                if distance > cutoff:
                    continue
                score = distance / longest
                if best is None or score < best:
                    best = score
        return best

    def _is_protected(self, window: Sequence[_Token]) -> bool:
        """Is EVERY token of *window* an ordinary word of the language?

        Every, not any: "comunity aquired" has one word and one non-word, and a
        phrase that is half misheard is exactly what this stage exists to snap.
        A tenant whose formulary genuinely contains an ordinary word removes it
        upstream, through the dictionary's ``unprotect`` list — never here.
        """
        protected = self._protected
        if protected is None:
            return False
        for token in window:
            if token.folded not in protected:
                return False
        return True


def _as_vocabulary(
    source: ProtectedVocabulary | Sequence[str] | None,
) -> ProtectedVocabulary | None:
    """Normalise the injected vocabulary; ``None`` stays ``None`` (gate off).

    A list or tuple is folded and frozen, because ``in`` over a list is O(n) and
    the gate runs per token. Everything else — a set, a mapping, a bloom filter,
    a memory-mapped index — is used AS GIVEN, both because it already answers
    ``in`` in constant time and because a caller handing over a 300 000-word
    asset must not have it copied. Used as given also means used as spelled: a
    set is queried with folded words, so it must hold folded words.
    """
    if source is None:
        return None
    if isinstance(source, list | tuple):
        return frozenset(word.lower() for word in source if isinstance(word, str) and word)
    return source


def _bump(stats: MutableMapping[str, int] | None, reason: str) -> None:
    if stats is not None:
        stats[reason] = stats.get(reason, 0) + 1


def _squash(text: str) -> str:
    """*text* with its spaces and punctuation removed, and NOTHING else.

    The space-agnostic key: "b.p." and "b p" both squash to "bp", "cef tri axone"
    to "ceftriaxone". It is script-agnostic, which is the point — a transliterated
    abbreviation squashes too, and doing so is safe because this key is only ever
    compared for EQUALITY.

    Combining marks are KEPT, which is why this is not simply ``isalnum``:
    ``str.isalnum`` is False for the Mn/Mc categories, so an Indic vowel sign
    would be dropped and "കി" would squash to the same key as "കാ" — turning an
    "exact" match into a skeleton match in the one script the fuzzy path
    deliberately refuses to touch.
    """
    return "".join(
        character
        for character in text
        if character.isalnum() or unicodedata.category(character)[0] == "M"
    )


def _token_squash(token: _Token, cache: dict[str, str]) -> str:
    """One token's squashed text, computed once per distinct token."""
    folded = token.folded
    squashed = cache.get(folded)
    if squashed is None:
        squashed = _squash(folded)
        cache[folded] = squashed
    return squashed


def _window_squash(window: Sequence[_Token], cache: dict[str, str]) -> str:
    """The window's squashed text, assembled from the per-token cache."""
    if len(window) == 1:
        return _token_squash(window[0], cache)
    return "".join(_token_squash(token, cache) for token in window)


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
        prefix, core, suffix = _split_edges(chunk)
        if not core:
            continue
        tokens.append(_Token(part=position, prefix=prefix, core=core, suffix=suffix))
    return tokens


def _window_text(window: Sequence[_Token]) -> str | None:
    """The folded text of a candidate window, or ``None`` when it is ineligible.

    A phrase window may not straddle punctuation: "comunity, aquired" is two
    clauses, not a mis-heard phrase, and replacing it would swallow the comma.
    The :data:`MIN_TOKEN_CHARS` floor is NOT applied here — it bounds the fuzzy
    paths only, and the space-agnostic path (exact) is not subject to it.
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
    return " ".join(token.folded for token in window)


def _apply_case(sample: str, replacement: str) -> str:
    """Carry *sample*'s casing onto *replacement* (the sentence owns the shape)."""
    if len(sample) > 1 and sample.isupper():
        return replacement.upper()
    if sample[:1].isupper():
        return replacement[:1].upper() + replacement[1:]
    return replacement
