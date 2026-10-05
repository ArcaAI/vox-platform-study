"""Text normalisation for the deterministic coverage matcher.

Both sides of every comparison go through the same function, so a note that writes "four weeks"
for "4 weeks", "1,000 milligrams" for "1000 mg" or "5mg" for "5 mg" matches. It is deliberately
conservative:

* number words (zero–twenty, the tens, "hundred") become digits; "half" / "a half" becomes 0.5;
* thousands separators are dropped and a leading-dot decimal gains its zero — a value is never
  rounded;
* a unit word directly after a number becomes its canonical symbol, by SYNONYM only. Units are
  never converted: 1 g stays 1 g and never equals 1000 mg, because a dose stated in another unit
  must stay a mismatch.

Drug names and frequency abbreviations are left alone.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

_ONES = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9,
}  # fmt: skip
_TEENS = {
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}  # fmt: skip
_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
    "eighty": 80, "ninety": 90,
}  # fmt: skip


def _alt(words: dict[str, int] | list[str]) -> str:
    return "|".join(sorted(words, key=len, reverse=True))


_NONZERO = _alt([w for w in _ONES if w != "zero"])
_REST = rf"(?P<tens>{_alt(_TENS)})(?:[\s-]+(?P<tens_one>{_NONZERO}))?|(?P<teen>{_alt(_TEENS)})|(?P<one>{_alt(_ONES)})"
_HUNDREDS = re.compile(
    rf"\b(?:(?P<mult>{_NONZERO}|a)\s+)?(?P<hundred>hundred)(?:[\s-]+(?:and\s+)?(?:{_REST}))?\b"
)
_NUMBER_WORDS = re.compile(rf"\b(?:{_REST})\b")
_HALF = re.compile(r"\b(?:a\s+)?half\b")
_THOUSANDS = re.compile(r"(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,])")
_LEADING_DOT = re.compile(r"(?<![\w.])\.(?=\d)")

#: Unit spellings → canonical symbol. Only synonyms: no entry ever crosses a scale.
_UNIT_SYNONYMS: dict[str, tuple[str, ...]] = {
    "mmol/l": (r"mmol\s*/\s*l", r"millimoles?\s+per\s+lit(?:re|er)"),
    "mmhg": (r"mm\s*hg", r"mm\s+of\s+hg", r"millimet(?:re|er)s?\s+of\s+mercury"),
    "bpm": (r"bpm", r"beats\s+per\s+minute", r"beats\s*/\s*min"),
    "mcg": (r"mcg", r"µg", r"μg", r"ug", r"micrograms?"),
    "mg": (r"mg", r"milligrams?"),
    "g": (r"g", r"grams?"),
    "ml": (r"ml", r"millilit(?:re|er)s?"),
    "iu": (r"iu", r"units?", r"international\s+units?"),
    "kg": (r"kg", r"kilograms?"),
    "cm": (r"cm", r"centimet(?:re|er)s?"),
    "%": (r"%", r"per\s*cent"),
}
_SYNONYM_TO_UNIT = [
    (spelling, unit) for unit, spellings in _UNIT_SYNONYMS.items() for spelling in spellings
]
_UNIT_AFTER_NUMBER = re.compile(
    r"(?<=\d)\s*(?P<unit>"
    + "|".join(
        f"(?:{s})" for s, _ in sorted(_SYNONYM_TO_UNIT, key=lambda p: len(p[0]), reverse=True)
    )
    + r")(?![\w/])"
)
_UNIT_EXACT = [(re.compile(rf"(?:{s})"), unit) for s, unit in _SYNONYM_TO_UNIT]


def _number_word_value(match: re.Match[str]) -> str:
    value = 0
    if "hundred" in match.re.groupindex and match.group("hundred"):
        mult = match.group("mult")
        value = 100 * (_ONES[mult] if mult and mult != "a" else 1)
    if match.group("tens"):
        value += _TENS[match.group("tens")]
        if match.group("tens_one"):
            value += _ONES[match.group("tens_one")]
    elif match.group("teen"):
        value += _TEENS[match.group("teen")]
    elif match.group("one"):
        value += _ONES[match.group("one")]
    return str(value)


def canonical_unit(unit: str | None) -> str:
    """A unit spelling → its canonical symbol (unknown spellings are only lower-cased)."""
    lowered = re.sub(r"\s+", " ", (unit or "").strip().lower())
    for pattern, canonical in _UNIT_EXACT:
        if pattern.fullmatch(lowered):
            return canonical
    return lowered


def _canonical_unit_match(match: re.Match[str]) -> str:
    return " " + canonical_unit(match.group("unit"))


def normalise_text(text: str) -> str:
    """Lower-cased, whitespace-collapsed text with numbers and units in one spelling."""
    out = re.sub(r"\s+", " ", text).strip().lower()
    out = _HUNDREDS.sub(_number_word_value, out)
    out = _NUMBER_WORDS.sub(_number_word_value, out)
    out = _HALF.sub("0.5", out)
    out = _THOUSANDS.sub(lambda m: m.group(0).replace(",", ""), out)
    out = _LEADING_DOT.sub("0.", out)
    return _UNIT_AFTER_NUMBER.sub(_canonical_unit_match, out)


def canonical_number(value: str) -> str:
    """A stated value in one spelling: digits, no thousands separator, no trailing zeros.

    A decimal comma ("1,5") reads as a decimal point; nothing is ever rounded.
    """
    raw = normalise_text(value)
    if "," in raw:
        raw = raw.replace(",", ".")
    try:
        return format(Decimal(raw).normalize(), "f")
    except InvalidOperation:
        return raw


def contains(haystack: str, needle: str) -> bool:
    """``needle`` (normalised here) occurs in the already-normalised ``haystack``.

    A needle that starts or ends with a digit must not sit inside a longer number ("4 weeks" is
    not in "14 weeks"); a word edge keeps substring matching, so "allerg" still finds "allergic".
    """
    term = normalise_text(needle)
    if not term:
        return True
    left = r"(?<![\d.])" if term[0].isdigit() else ""
    right = r"(?!\d|\.\d)" if term[-1].isdigit() else ""
    return re.search(left + re.escape(term) + right, haystack) is not None


def contains_value(haystack: str, value: str) -> bool:
    """A bare value (normalised here) stated as a whole number in the normalised ``haystack``."""
    number = canonical_number(value)
    return re.search(rf"(?<![\d.]){re.escape(number)}(?!\d|\.\d)", haystack) is not None
