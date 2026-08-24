"""PHI-safe telemetry CI guard.

Static allow-list test: cheap, CI-stable, no OTel runtime needed. Scans the
`text` source tree for `gen_ai.*` attribute-name string literals -- the OTel
GenAI semantic-convention namespace Text stamps onto spans
(`core/observability.py` + `providers/*.py`; grepping the whole monorepo for
`gen_ai\\.` shows these are the ONLY `gen_ai.*` call-sites in HOPE today,
research-findings.md §2) -- and asserts every one found is on an explicit
ALLOW-LIST.

An allow-list (not a deny-list) fails closed: a deny-list only catches names
someone thought to ban in advance, but a NEW `gen_ai.*` attribute added later
by an unrelated change would silently pass a deny-only check. Here it fails
the build until a human adds it to `ALLOWED_GEN_AI_ATTRIBUTES` -- which is the
point where research-findings.md §2's content-bearing list gets checked.
"""

from __future__ import annotations

import re
from pathlib import Path

# The complete set of gen_ai.* attribute names Text is allowed to stamp onto
# spans today (verified against core/observability.py + providers/*.py).
# Adding a new one is a deliberate, reviewed decision -- confirm it is NOT
# content-bearing (research-findings.md §2) before adding it here.
ALLOWED_GEN_AI_ATTRIBUTES = frozenset(
    {
        # Span NAMES (the string passed to `tracer.start_as_current_span(...)`
        # in every `providers/*.py`) -- operation identifiers, not attribute
        # keys, and carry no value at all, so they cannot be content-bearing.
        # Included here because the scan below matches every `gen_ai.*`
        # string literal, not attribute-set calls specifically.
        "gen_ai.generate",
        "gen_ai.generate_stream",
        # Span attribute keys.
        "gen_ai.system",
        "gen_ai.request.model",
        "gen_ai.operation.name",
        "gen_ai.request.temperature",
        "gen_ai.request.max_tokens",
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.output_tokens",
        "gen_ai.response.finish_reason",
        "gen_ai.response.finish_reasons",
    }
)

# Content-bearing attributes that must NEVER be stamped (research-findings.md
# / "Content-bearing attributes to never set"). Exact names plus the
# prefix families the OTel GenAI spec groups under "content".
BANNED_GEN_AI_ATTRIBUTES = frozenset(
    {
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "gen_ai.system_instructions",
    }
)
BANNED_GEN_AI_PREFIXES = ("gen_ai.prompt.", "gen_ai.completion.", "gen_ai.retrieval.")

_GEN_AI_ATTR_RE = re.compile(r'[\'"](gen_ai\.[A-Za-z0-9_.]+)[\'"]')

# apps/text/src/text/tests/unit/test_phi_safe_telemetry.py -> apps/text/src/text
_TEXT_SRC_ROOT = Path(__file__).resolve().parents[2]


def _iter_python_source_files() -> list[Path]:
    return [
        path
        for path in sorted(_TEXT_SRC_ROOT.rglob("*.py"))
        if "/tests/" not in path.as_posix() and "__pycache__" not in path.as_posix()
    ]


def _scan_gen_ai_attribute_literals() -> dict[str, list[Path]]:
    """Map each found `gen_ai.*` string literal to the file(s) it appears in."""
    found: dict[str, list[Path]] = {}
    for path in _iter_python_source_files():
        text = path.read_text(encoding="utf-8")
        for match in _GEN_AI_ATTR_RE.finditer(text):
            found.setdefault(match.group(1), []).append(path)
    return found


class TestAllowListIsInternallyConsistent:
    """Sanity checks on the allow-list itself, not the source scan."""

    def test_allow_list_contains_no_banned_exact_name(self):
        assert ALLOWED_GEN_AI_ATTRIBUTES.isdisjoint(BANNED_GEN_AI_ATTRIBUTES)

    def test_allow_list_contains_no_banned_prefix(self):
        for name in ALLOWED_GEN_AI_ATTRIBUTES:
            assert not name.startswith(BANNED_GEN_AI_PREFIXES), name


class TestNoContentBearingGenAiAttributesAreStamped:
    def test_scan_actually_found_the_known_call_sites(self):
        # A scan that silently matches zero files (e.g. after a source-tree
        # move/rename) would make every assertion below vacuously pass --
        # this pins the scan to something real.
        found = _scan_gen_ai_attribute_literals()
        assert "gen_ai.usage.input_tokens" in found
        assert "gen_ai.usage.output_tokens" in found
        assert "gen_ai.system" in found

    def test_every_stamped_attribute_is_allow_listed(self):
        found = _scan_gen_ai_attribute_literals()
        unexpected = {
            name: [str(p) for p in files]
            for name, files in found.items()
            if name not in ALLOWED_GEN_AI_ATTRIBUTES
        }
        assert not unexpected, (
            "Found gen_ai.* attribute name(s) not on the PHI-safe allow-list "
            "(docs/operations/telemetry-phi-guardrails.md): "
            f"{unexpected}. If this is a legitimate new attribute, add it to "
            "ALLOWED_GEN_AI_ATTRIBUTES only after confirming it is not "
            "content-bearing (research-findings.md §2)."
        )

    def test_no_banned_content_bearing_attribute_is_stamped(self):
        found = set(_scan_gen_ai_attribute_literals())
        exact_hits = found & BANNED_GEN_AI_ATTRIBUTES
        prefix_hits = {name for name in found if name.startswith(BANNED_GEN_AI_PREFIXES)}
        assert not exact_hits, f"Content-bearing gen_ai.* attribute(s) found: {exact_hits}"
        assert not prefix_hits, f"Content-bearing gen_ai.* attribute(s) found: {prefix_hits}"
