"""TASK-985 QW-10 (c) — n-gram repeat guard with rewind.

Immediate word/phrase repetition is the single most frequent error class in the
owner's transcript corpus (TASK-985 §2.5 class 1: 54 exact repeats across 49 of
221 finals, 22 %). Nothing in the pipeline removes it today:

* ``WhisperCppAsrAdapter._collapse_repeats`` deliberately spares DOUBLES, so the
  commonest form survives;
* ``StreamingInferenceWorker._sanitize_text`` collapses SENTENCE repeats only,
  and only once a segment already holds more than two sentences;
* the force-emit boundary de-dup fires at a seam, never inside one decode.

This module is the missing middle: a bounded, deterministic scan of ONE decode's
own tokens that finds an n-gram repeated immediately more times than a decoder
plausibly should, and rewinds the output to the first occurrence.

Why "rewind" and not "cap the run"
----------------------------------
A greedy decode that has entered a loop does not recover inside the segment —
every further copy is the same artifact. Keeping the first occurrence keeps every
word the speaker actually said (the loop's content IS the first copy) and drops
only the machine's repetitions, so the guard costs no reference words. That
matters here because DELETION is already this system's dominant error class
(TASK-985 §2.3: 51-53 deletions of ~61 reference words per clip), and a guard
that can delete content would be the wrong trade however good its repetition
numbers looked.

Why the thresholds are generous
-------------------------------
Clinical speech legitimately repeats: "no, no", "yes yes", a drug name said
twice for confirmation. The defaults below (QW-10 (c)) therefore allow a short
n-gram to recur many times before the guard calls it a loop, and tighten as the
n-gram grows — a four-word phrase emitted three times in a row is a decoder
artifact in a way "no no no" is not.

The guard is deliberately NOT a disfluency remover and NOT a spell-checker; it
only ever deletes an EXACT immediate repetition of something it has already kept.

Pure text functions, import-cheap by design — the streaming worker imports this
on the decode path. Findings are RETURNED, not logged: the caller owns the
session id, so it owns the log line (the same contract as
``postprocessing.lexicon``).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field

#: Repeats ALLOWED before an n-gram is judged a loop, by n-gram length
#: (TASK-985 QW-10 (c): "1-2-grams up to 8 repeats, 3-grams up to 4, longer up
#: to 3"). A "repeat" is an occurrence AFTER the first, so `8` admits nine
#: consecutive copies and rewinds the tenth.
DEFAULT_MAX_REPEATS: Mapping[int, int] = {1: 8, 2: 8, 3: 4}
#: Allowance for every n-gram longer than the table above.
DEFAULT_LONG_NGRAM_MAX_REPEATS = 3
#: Longest n-gram the scan considers. Above this the cost grows with no observed
#: benefit: a loop of more than six tokens is already caught at a shorter period
#: (a repeated 8-gram repeats its own 4-gram).
DEFAULT_MAX_NGRAM = 6

_WHITESPACE = re.compile(r"\s+")
#: Characters that belong to the sentence rather than the word. Stripped for the
#: comparison only — the kept copy is returned with its punctuation intact.
_EDGE_PUNCT = ".,!?;:।॥\"')]}"


def max_repeats_for(n: int, table: Mapping[int, int] | None = None) -> int:
    """Allowed consecutive repeats for an n-gram of length *n*."""
    source = DEFAULT_MAX_REPEATS if table is None else table
    if n in source:
        return int(source[n])
    return DEFAULT_LONG_NGRAM_MAX_REPEATS


@dataclass(frozen=True)
class RepeatGuardConfig:
    """What the guard is allowed to remove.

    Every field is overridable so the orchestrator can run the guard as a
    measured ARM rather than a fixed behaviour; the defaults are QW-10 (c)'s.

    ``stock_phrases`` is the "bag of hallucinations" — phrases the decoder emits
    from silence, held as tenant configuration (never a literal in this module:
    a stock phrase is clinical-domain content, and a hardcoded list here would be
    configuration wearing a code costume). Empty by default, which makes that
    half of the guard a no-op until a tenant names one.
    """

    enabled: bool = True
    max_ngram: int = DEFAULT_MAX_NGRAM
    max_repeats: Mapping[int, int] = field(default_factory=lambda: dict(DEFAULT_MAX_REPEATS))
    long_ngram_max_repeats: int = DEFAULT_LONG_NGRAM_MAX_REPEATS
    stock_phrases: tuple[str, ...] = ()

    def allowance(self, n: int) -> int:
        if n in self.max_repeats:
            return int(self.max_repeats[n])
        return int(self.long_ngram_max_repeats)


@dataclass(frozen=True)
class RepeatFinding:
    """One rewind the guard performed."""

    #: The n-gram as it was kept (first occurrence, original casing).
    ngram: str
    #: Tokens in the n-gram.
    length: int
    #: Consecutive repeats observed AFTER the first occurrence.
    repeats: int
    #: Tokens removed.
    dropped_tokens: int


@dataclass(frozen=True)
class RepeatGuardReport:
    """Everything the caller needs to log and count."""

    findings: tuple[RepeatFinding, ...] = ()
    stock_phrases_removed: tuple[str, ...] = ()

    @property
    def changed(self) -> bool:
        return bool(self.findings or self.stock_phrases_removed)

    @property
    def dropped_tokens(self) -> int:
        return sum(f.dropped_tokens for f in self.findings)


def _norm(token: str) -> str:
    return token.lower().strip(_EDGE_PUNCT)


def _normalize_phrase(phrase: str) -> tuple[str, ...]:
    return tuple(_norm(t) for t in _WHITESPACE.split(phrase.strip()) if _norm(t))


def collapse_repeats(
    text: str,
    config: RepeatGuardConfig | None = None,
) -> tuple[str, RepeatGuardReport]:
    """Rewind immediate n-gram loops in *text*.

    Returns ``(text, report)``. ``text`` is returned unchanged — the same object
    — when the guard is off or finds nothing, so the fast path allocates nothing.

    The scan is a single left-to-right pass over the tokens. At each position the
    SHORTEST n-gram whose repeat run exceeds its allowance wins, because the
    shortest period that tiles a run IS that run's period: "chest pain" repeated
    ten times is a 2-gram loop, and calling it a 4-gram loop repeated four times
    would apply the tighter long-n-gram allowance to it AND leave two copies
    standing. A longer n-gram can only match when the shorter ones do not tile,
    so "a b c d" x 5 is still reported as a 4-gram. Cost is bounded by
    ``O(tokens x max_ngram)``.
    """
    cfg = config or RepeatGuardConfig()
    if not cfg.enabled:
        return text, RepeatGuardReport()
    stripped = (text or "").strip()
    if not stripped:
        return text, RepeatGuardReport()

    tokens = _WHITESPACE.split(stripped)
    if len(tokens) < 2:
        return text, RepeatGuardReport()

    normed = [_norm(t) for t in tokens]
    max_ngram = max(1, min(int(cfg.max_ngram), len(tokens) // 2))

    out: list[str] = []
    findings: list[RepeatFinding] = []
    i = 0
    while i < len(tokens):
        best_n = 0
        best_runs = 0
        # Shortest period first — see the docstring: the shortest n-gram that
        # tiles the run is the run's true period.
        for n in range(1, min(max_ngram, len(tokens) - i) + 1):
            runs = 0
            j = i + n
            while j + n <= len(tokens) and normed[j : j + n] == normed[i : i + n]:
                runs += 1
                j += n
            if runs > cfg.allowance(n):
                best_n = n
                best_runs = runs
                break
        if best_n:
            kept = tokens[i : i + best_n]
            out.extend(kept)
            findings.append(
                RepeatFinding(
                    ngram=" ".join(kept),
                    length=best_n,
                    repeats=best_runs,
                    dropped_tokens=best_n * best_runs,
                )
            )
            i += best_n * (best_runs + 1)
            continue
        out.append(tokens[i])
        i += 1

    cleaned = " ".join(out)
    cleaned, removed = _remove_stock_phrases(cleaned, cfg.stock_phrases)
    report = RepeatGuardReport(findings=tuple(findings), stock_phrases_removed=removed)
    if not report.changed:
        return text, report
    return cleaned, report


def _remove_stock_phrases(
    text: str,
    phrases: Sequence[str] | Iterable[str],
) -> tuple[str, tuple[str, ...]]:
    """Delete configured stock hallucinations that make up a WHOLE segment.

    Deliberately whole-segment only. A configured phrase appearing INSIDE a
    longer utterance is far more likely to be speech than an artifact, and
    excising it mid-sentence would corrupt the surrounding clause — the same
    posture as the filler gate, which also refuses to edit within a segment.
    """
    candidates = tuple(p for p in (phrases or ()) if p and p.strip())
    if not candidates:
        return text, ()
    subject = _normalize_phrase(text)
    if not subject:
        return text, ()
    for phrase in candidates:
        if _normalize_phrase(phrase) == subject:
            return "", (phrase.strip(),)
    return text, ()


def config_from_mapping(raw: Mapping[str, object] | None) -> RepeatGuardConfig | None:
    """Build a config from a resolved-spec block, or ``None`` when absent.

    ``None`` means "the spec said nothing", which the caller reads as "use the
    module default" — absent is never "off", the same posture as the decode
    profile (``AsrSpecModelProfileDecoding``). A malformed member is ignored
    rather than failing a session: the guard is an enhancement, never a gate.
    """
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        # A typed config object from the spec layer reads the same way as the
        # wire dict it came from; a value that is neither is "said nothing".
        attrs = getattr(raw, "__dict__", None)
        if not isinstance(attrs, Mapping):
            return None
        raw = attrs
    base = RepeatGuardConfig()
    enabled = raw.get("enabled")
    max_ngram = raw.get("maxNgram", raw.get("max_ngram"))
    long_max = raw.get("longNgramMaxRepeats", raw.get("long_ngram_max_repeats"))
    table_raw = raw.get("maxRepeats", raw.get("max_repeats"))
    stock_raw = raw.get("stockPhrases", raw.get("stock_phrases"))

    table: dict[int, int] = dict(base.max_repeats)
    if isinstance(table_raw, Mapping):
        for key, value in table_raw.items():
            try:
                n = int(key)
                allowed = int(value)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                continue
            if n >= 1 and allowed >= 0:
                table[n] = allowed

    stock: tuple[str, ...] = ()
    if isinstance(stock_raw, (list, tuple)):
        stock = tuple(str(p) for p in stock_raw if isinstance(p, str) and p.strip())

    return RepeatGuardConfig(
        enabled=bool(enabled) if isinstance(enabled, bool) else base.enabled,
        max_ngram=int(max_ngram)
        if isinstance(max_ngram, int) and not isinstance(max_ngram, bool) and max_ngram >= 1
        else base.max_ngram,
        max_repeats=table,
        long_ngram_max_repeats=int(long_max)
        if isinstance(long_max, int) and not isinstance(long_max, bool) and long_max >= 0
        else base.long_ngram_max_repeats,
        stock_phrases=stock,
    )
