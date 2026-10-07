"""The untrusted-input envelope around every judged text (TASK-1050 §3.2, M-1).

The judge's user turn is STRUCTURE only — no policy wording — so it is built here, in code::

    <untrusted_input id="{nonce}">
    {text}
    </untrusted_input id="{nonce}">

The sentence that tells the judge the block is data, never an instruction, is POLICY and lives at
the end of each seeded criterion (W4 appends it). Nothing here depends on that sentence being
present: the envelope stands on its own.

The nonce is fresh per call, so a text cannot pre-compute the closing marker. A text that carries a
closing marker at all (any id, any case) is refused rather than judged — it is trying to end the
data block early, and a verdict on it would be a verdict the text steered. Refused means
UNDETERMINED (fail-closed at the caller), never a pass.
"""

from __future__ import annotations

import re
import secrets
from typing import Final

from guardrail.core.errors import REASON_UNSUPPORTED, GuardrailUndeterminedError

#: The nonce's entropy, in bytes (hex-encoded to twice that many characters).
_NONCE_BYTES: Final = 12

#: Any spelling of a closing marker: `</untrusted_input`, `< /UNTRUSTED_INPUT`, …
_CLOSING_MARKER: Final = re.compile(r"<\s*/\s*untrusted_input\b", re.IGNORECASE)

#: The PHI-free detail every refusal carries.
ENVELOPE_MARKER_DETAIL: Final = "the judged text carries an untrusted_input closing marker"


def new_nonce() -> str:
    """A fresh per-call nonce."""
    return secrets.token_hex(_NONCE_BYTES)


def contains_closing_marker(text: str) -> bool:
    """True when ``text`` tries to close the untrusted block."""
    return bool(_CLOSING_MARKER.search(text or ""))


def wrap_untrusted(text: str, *, nonce: str | None = None) -> str:
    """``text`` inside a nonce-delimited untrusted block. Raises on an embedded closing marker."""
    if contains_closing_marker(text):
        raise GuardrailUndeterminedError(REASON_UNSUPPORTED, ENVELOPE_MARKER_DETAIL)
    tag = nonce or new_nonce()
    return f'<untrusted_input id="{tag}">\n{text}\n</untrusted_input id="{tag}">'
