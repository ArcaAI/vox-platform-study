"""Deterministic DNA redaction/rewrite engine (TASK-551).

A PURE function of ``(text, rules)`` — no I/O, no clock, no randomness — so it is
safe to run inside a Temporal activity and trivially hermetic to test.

Rule kinds (``match``):

* ``literal``  — an exact substring.
* ``regex``    — a Python regular-expression source (compiled here; a malformed
  pattern raises :class:`RedactionEngineError` so the activity fails CLOSED
  rather than passing the note through unredacted).
* ``category`` — a named built-in detector from :data:`CATEGORY_PATTERNS`
  (``email`` / ``phone`` / ``ssn`` / ``mrn`` / ``url``). An UNKNOWN category is a
  no-op, never an error (a typo must not fail the whole transform closed).

Rule actions (``type``):

* ``remove``  — delete the matched span.
* ``rewrite`` — replace the matched span with the rule's literal ``replacement``.
  A ``rewrite`` rule with NO ``replacement`` is a *semantic* rewrite handled by
  the SMR pass in the activity, NOT here — constructing one for the deterministic
  engine is a validation error.

Invariants pinned by the unit tests:

* **never-add** — the engine introduces no character that is not already in the
  original text or in a rule's own ``replacement``;
* the audit **manifest** records ``{rule_id, action, span, removed_length}`` per
  hit but **never the removed text** (no plaintext PHI in the audit trail).
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

# Built-in ``category`` detectors. Deliberately conservative, deterministic
# regexes — the PHI heavy lifting lives in the Presidio-backed guard; these give
# a doctor a few named shortcuts for their personal redaction rules.
CATEGORY_PATTERNS: dict[str, str] = {
    "email": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    "phone": r"(?<!\d)(?:\+?\d{1,2}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)",
    "ssn": r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)",
    "mrn": r"\bMRN[:#]?\s*\d{4,}\b",
    "url": r"https?://[^\s]+",
}

RuleType = Literal["remove", "rewrite"]
MatchKind = Literal["literal", "regex", "category"]


class RedactionEngineError(RuntimeError):
    """A rule could not be applied (e.g. a malformed regex reached the engine).

    Raised so the ``apply_redaction`` activity can fail CLOSED (force a FLAG)
    instead of silently delivering an unredacted note.
    """


class RedactionRule(BaseModel):
    """One personal redaction/rewrite instruction.

    Carried WITH the doctor's DNA report (personal, encrypted at rest on the
    gateway); decrypted and threaded to the workflow as a payload — the same
    trust boundary as the DNA style text today.
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    type: RuleType
    match: MatchKind
    pattern: str = Field(min_length=1)
    replacement: str | None = None
    note: str | None = None

    @model_validator(mode="after")
    def _validate(self) -> RedactionRule:
        if (
            self.type == "rewrite"
            and self.match in ("literal", "regex")
            and self.replacement is None
        ):
            # A deterministic rewrite must carry its replacement. A rewrite with no
            # replacement is a *semantic* rewrite (SMR pass in the activity); it is
            # never handed to the pure engine, so reject it here.
            raise ValueError(
                f"rewrite rule {self.id!r} with match={self.match!r} requires a 'replacement'"
            )
        return self


class RedactionHit(BaseModel):
    """A single applied edit — span coordinates + sizing ONLY, never the text."""

    model_config = ConfigDict(extra="forbid")

    rule_id: str
    action: RuleType
    match_kind: MatchKind
    start: int
    end: int
    removed_length: int


class RedactionManifest(BaseModel):
    """Audit record of a transform pass — safe to persist / put in a trajectory step.

    Contains NO removed PHI plaintext: only rule ids, actions, spans and lengths.
    """

    model_config = ConfigDict(extra="forbid")

    applied: bool = False
    total_hits: int = 0
    hits_by_rule: dict[str, int] = Field(default_factory=dict)
    hits: list[RedactionHit] = Field(default_factory=list)


class RedactionOutcome(BaseModel):
    """Result of the deterministic pass."""

    model_config = ConfigDict(extra="forbid")

    text: str
    changed: bool
    manifest: RedactionManifest


def _pattern_for(rule: RedactionRule) -> str | None:
    """The effective regex source for ``rule`` (``None`` ⇒ a no-op category)."""
    if rule.match == "literal":
        return re.escape(rule.pattern)
    if rule.match == "regex":
        return rule.pattern
    # category
    return CATEGORY_PATTERNS.get(rule.pattern)


def _compile(rule: RedactionRule) -> re.Pattern[str] | None:
    source = _pattern_for(rule)
    if source is None:
        return None
    try:
        return re.compile(source)
    except re.error as exc:  # malformed regex — fail closed upstream
        raise RedactionEngineError(f"rule {rule.id!r} has an invalid pattern: {exc}") from exc


def apply_deterministic_redaction(text: str, rules: list[RedactionRule]) -> RedactionOutcome:
    """Apply ``rules`` to ``text`` in order and return the transformed text + manifest.

    Deterministic: rules are applied sequentially; each rule matches against the
    text produced by the previous rule. Matches within one rule are
    non-overlapping and processed left-to-right. Recorded spans are in the
    coordinates of the text as that rule saw it (sufficient for audit).
    """
    working = text
    hits: list[RedactionHit] = []
    hits_by_rule: dict[str, int] = {}

    for rule in rules:
        compiled = _compile(rule)
        if compiled is None:
            continue

        pieces: list[str] = []
        cursor = 0
        count = 0
        for m in compiled.finditer(working):
            start, end = m.start(), m.end()
            if end == start:
                # zero-width match — never consume, never "add"; skip to avoid loops
                continue
            pieces.append(working[cursor:start])
            removed_len = end - start
            if rule.type == "rewrite":
                pieces.append(rule.replacement or "")
            # remove ⇒ append nothing
            cursor = end
            count += 1
            hits.append(
                RedactionHit(
                    rule_id=rule.id,
                    action=rule.type,
                    match_kind=rule.match,
                    start=start,
                    end=end,
                    removed_length=removed_len,
                )
            )
        if count:
            pieces.append(working[cursor:])
            working = "".join(pieces)
            hits_by_rule[rule.id] = hits_by_rule.get(rule.id, 0) + count

    changed = working != text
    manifest = RedactionManifest(
        applied=changed,
        total_hits=len(hits),
        hits_by_rule=hits_by_rule,
        hits=hits,
    )
    return RedactionOutcome(text=working, changed=changed, manifest=manifest)
