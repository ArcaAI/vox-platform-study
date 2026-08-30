"""T0 — a deterministic matcher whose verdict does not depend on the chunking.

**Why not regex-per-chunk.** A live transcript arrives as utterances. Re-running
a regex on each arriving chunk cannot see a phrase that straddles a boundary, so
the ATTACKER picks the boundary and the guardrail's coverage is whatever the VAD
happened to do. The fix is not a bigger buffer; it is to stop restarting. This
module keeps automaton state across ``feed()`` calls, so a phrase split at its
worst possible point still matches, at the same absolute offsets it would have
matched at in one pass. That property — *chunking invariance* — is what makes T0
a guardrail rather than a lottery, and it is asserted directly in the tests.

The construction is Aho-Corasick: one pass over the alphabet-indexed goto graph
with failure links, so cost is O(stream) regardless of how many phrases are
declared and regardless of chunk sizes. Deterministic tier only — it has no
semantic coverage whatsoever, which is why T1 exists.

**The mechanism is code; the phrases are not.** How a stream is matched is a
property of the algorithm and identical for every tenant. *Which* phrases matter
is a taxonomy, and `.claude/rules/00-project-context.md` is explicit that a
taxonomy or label set is never a literal in code. So the rule set is built from
the resolved registry declaration and an ABSENT declaration raises rather than
producing an empty automaton — an automaton with no patterns reports every
stream clean, which is the most dangerous possible default.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from guardrail.core.errors import REASON_UNSUPPORTED, GuardrailUndeterminedError


@dataclass(frozen=True)
class RuleMatch:
    """One hit, at absolute stream offsets. Carries the rule id, never the text."""

    rule_id: str
    start: int
    end: int


class _Node:
    __slots__ = ("children", "fail", "outputs")

    def __init__(self) -> None:
        self.children: dict[str, _Node] = {}
        self.fail: _Node | None = None
        #: (rule_id, phrase_length) for every phrase ending at this node.
        self.outputs: list[tuple[str, int]] = []


@dataclass(frozen=True)
class DeterministicRuleSet:
    """A compiled automaton. Build once per tenant policy, share across sessions."""

    root: _Node
    rule_ids: tuple[str, ...]

    @classmethod
    def from_declaration(cls, declaration: Sequence[Any] | None) -> DeterministicRuleSet:
        """Compile the registry-declared phrase list. Absent declaration ⇒ raise.

        An empty rule set is indistinguishable, at every call site, from a clean
        stream. Refusing is the only honest answer: the deterministic taxonomy is
        configuration and has no code default.
        """
        entries = list(declaration or [])
        if not entries:
            raise GuardrailUndeterminedError(
                REASON_UNSUPPORTED,
                "the realtime deterministic rule set is unresolved (failMode=closed): "
                "declare `labelTaxonomy.realtime.deterministicPatterns` on the "
                "guardrail.safety model row — an empty automaton reports every stream "
                "clean and is not a default",
            )

        root = _Node()
        ids: list[str] = []
        for entry in entries:
            rule_id = str(entry.get("id") or "").strip()
            phrase = str(entry.get("phrase") or "").strip().casefold()
            if not rule_id or not phrase:
                raise GuardrailUndeterminedError(
                    REASON_UNSUPPORTED,
                    "every declared deterministic pattern needs a non-empty `id` and "
                    "`phrase`; a malformed rule is a policy defect, not a pass",
                )
            node = root
            for char in phrase:
                node = node.children.setdefault(char, _Node())
            node.outputs.append((rule_id, len(phrase)))
            ids.append(rule_id)

        # Breadth-first failure links: the classic Aho-Corasick construction.
        root.fail = root
        queue: deque[_Node] = deque()
        for child in root.children.values():
            child.fail = root
            queue.append(child)
        while queue:
            current = queue.popleft()
            for char, child in current.children.items():
                fallback = current.fail or root
                while fallback is not root and char not in fallback.children:
                    fallback = fallback.fail or root
                child.fail = fallback.children.get(char, root)
                if child.fail is child:
                    child.fail = root
                # Flatten the output links so matching never walks the fail chain.
                child.outputs.extend(child.fail.outputs)
                queue.append(child)

        return cls(root=root, rule_ids=tuple(sorted(set(ids))))


class StreamMatcher:
    """The PERSISTENT half. One per session; feed it the stream as it arrives.

    Holds the current automaton node and the absolute character offset, so the
    result of ``feed(a); feed(b)`` is byte-for-byte the result of ``feed(a + b)``.
    """

    __slots__ = ("_rules", "_node", "_offset", "_matches")

    def __init__(self, rules: DeterministicRuleSet) -> None:
        self._rules = rules
        self._node = rules.root
        self._offset = 0
        self._matches: list[RuleMatch] = []

    @property
    def consumed_chars(self) -> int:
        return self._offset

    @property
    def matches(self) -> tuple[RuleMatch, ...]:
        """Everything matched since the session began."""
        return tuple(self._matches)

    def feed(self, chunk: str) -> tuple[RuleMatch, ...]:
        """Advance the automaton; return the matches completed by THIS chunk.

        EAGER, and returning a concrete tuple rather than a generator, on
        purpose. A lazily-evaluated scan does nothing at all unless the caller
        iterates it — which means a safety check silently becomes a no-op at any
        call site that only wanted the state advanced. That is not a failure mode
        a guardrail may have.
        """
        root = self._rules.root
        found: list[RuleMatch] = []
        for char in chunk or "":
            folded = char.casefold()
            # A casefold may expand (eg. 'ß' -> 'ss'); step each produced char so
            # the automaton stays consistent, and charge the OFFSET once so
            # offsets remain indices into the caller's original text.
            for step in folded or "\x00":
                node = self._node
                while step not in node.children and node is not root:
                    node = node.fail or root
                self._node = node.children.get(step, root)
            self._offset += 1
            for rule_id, length in self._node.outputs:
                match = RuleMatch(
                    rule_id=rule_id, start=self._offset - length, end=self._offset
                )
                self._matches.append(match)
                found.append(match)
        return tuple(found)


def summarise(matches: Iterable[RuleMatch]) -> dict[str, int]:
    """Rule id → hit count. An audit record, so: counts, never the matched text."""
    counts: dict[str, int] = {}
    for match in matches:
        counts[match.rule_id] = counts.get(match.rule_id, 0) + 1
    return counts
