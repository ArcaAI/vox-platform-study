"""Request-scoped pseudonymization for cloud egress (TASK-1035 §5.0).

Identifiers are replaced with ``[<LABEL>_<n>]`` tokens before a prompt reaches a
cloud provider and restored in what comes back. ``LABEL`` is the uppercase snake
form of the taxonomy label; ``n`` counts per label within ONE request and is stable
per distinct value (case-insensitive, whitespace-normalised), so co-reference
survives: the same patient is ``[PATIENT_NAME_1]`` in the system prompt and in the
user prompt.

Two sources, one pass per text:

* ``known_phi`` — values the CALLER already holds (schema PHI fields, patient and
  clinician identity). Matched deterministically wherever they occur, so a value
  the detector misses is still replaced;
* GLiNER2 spans from guardrail's inbound screen, in that text's coordinates.

Where the two overlap, one replacement wins (known value first, then the longer
span), so a value is never tokenised twice.

The token → value map lives on this object and nowhere else: it is never logged,
never cached and never serialised, and it dies with the request.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass

#: A restorable token. Only tokens this request minted are restored; anything
#: else that merely looks like one is left as the model wrote it.
TOKEN_PATTERN = re.compile(r"\[([A-Z0-9]+(?:_[A-Z0-9]+)*_\d+)\]")


@dataclass(frozen=True)
class Span:
    """One detected identifier, in the coordinates of the text it was found in."""

    label: str
    start: int
    end: int


def token_label(label: str) -> str:
    """``date of-birth`` → ``DATE_OF_BIRTH``."""
    return re.sub(r"[^A-Za-z0-9]+", "_", label).strip("_").upper() or "PII"


def _normalise(value: str) -> str:
    return " ".join(value.split()).casefold()


def _value_pattern(value: str) -> re.Pattern[str]:
    """Case-insensitive, whitespace-tolerant, never matching inside a longer word."""
    parts = [re.escape(part) for part in value.split()]
    return re.compile(r"(?<!\w)" + r"\s+".join(parts) + r"(?!\w)", re.IGNORECASE)


class Pseudonymizer:
    """Mints, applies and reverses the tokens of ONE request."""

    def __init__(self, known_phi: Iterable[tuple[str, str]]) -> None:
        # Longest value first, so "John Doe" wins over a known "John".
        self._known = sorted(
            ((label, value) for label, value in known_phi if value.strip()),
            key=lambda item: len(item[1]),
            reverse=True,
        )
        self._patterns = [(label, _value_pattern(value)) for label, value in self._known]
        self._token_by_key: dict[tuple[str, str], str] = {}
        self._value_by_token: dict[str, str] = {}
        self._counter: Counter[str] = Counter()
        #: Detections by taxonomy label, counted whether or not they are replaced.
        self.detected: Counter[str] = Counter()
        #: Occurrences replaced by a token.
        self.redacted = 0

    def __repr__(self) -> str:  # the map is PHI; never let a repr print it
        return f"Pseudonymizer(tokens={len(self._value_by_token)}, redacted={self.redacted})"

    # -- detection ------------------------------------------------------------

    def _intervals(self, text: str, spans: Iterable[Span]) -> list[tuple[int, int, str]]:
        candidates: list[tuple[int, int, int, str]] = []  # (start, priority, -len, label)
        for label, pattern in self._patterns:
            for match in pattern.finditer(text):
                candidates.append((match.start(), 0, -(match.end() - match.start()), label))
        for span in spans:
            start, end = max(0, span.start), min(len(text), span.end)
            if end > start and text[start:end].strip():
                candidates.append((start, 1, -(end - start), span.label))

        chosen: list[tuple[int, int, str]] = []
        last_end = -1
        for start, _priority, neg_len, label in sorted(candidates):
            end = start - neg_len
            if start < last_end:
                continue
            chosen.append((start, end, label))
            last_end = end
        return chosen

    def count(self, text: str, spans: Iterable[Span]) -> None:
        """Detect only — the LOCAL path: counted for audit, nothing replaced."""
        for _start, _end, label in self._intervals(text, spans):
            self.detected[label] += 1

    # -- pseudonymize / restore -------------------------------------------------

    def _token(self, label: str, value: str) -> str:
        key = (token_label(label), _normalise(value))
        token = self._token_by_key.get(key)
        if token is None:
            self._counter[key[0]] += 1
            token = f"[{key[0]}_{self._counter[key[0]]}]"
            self._token_by_key[key] = token
            self._value_by_token[token] = value
        return token

    def pseudonymize(self, text: str, spans: Iterable[Span]) -> str:
        """``text`` with every detected identifier replaced by its token."""
        intervals = self._intervals(text, spans)
        if not intervals:
            return text
        out: list[str] = []
        cursor = 0
        for start, end, label in intervals:
            out.append(text[cursor:start])
            out.append(self._token(label, text[start:end]))
            cursor = end
            self.detected[label] += 1
            self.redacted += 1
        out.append(text[cursor:])
        return "".join(out)

    def restore(self, text: str) -> tuple[str, int]:
        """``text`` with this request's tokens replaced by their values, and how many."""
        restored = 0

        def _swap(match: re.Match[str]) -> str:
            nonlocal restored
            value = self._value_by_token.get(match.group(0))
            if value is None:
                return match.group(0)
            restored += 1
            return value

        return TOKEN_PATTERN.sub(_swap, text), restored

    @property
    def has_tokens(self) -> bool:
        return bool(self._value_by_token)
