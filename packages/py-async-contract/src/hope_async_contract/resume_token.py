"""Resume-token convention.

Opaque, transport-assigned, consumer-echoed: ``base64url(JSON({v, t, c}))``.
Uses the SAME base64url alphabet (``-``/``_``, no padding) as the TypeScript
twin (``resume-token.ts``), so a token minted by one language decodes
correctly in the other — exercised by ``tests/test_parity.py``.
"""

from __future__ import annotations

import base64
import json

#: The well-known Redis "from the beginning" sentinel — also Text's ``stream.py:35`` default.
RESUME_FROM_BEGINNING = "0-0"


def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _base64url_decode(value: str) -> bytes | None:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding)
    except (ValueError, TypeError):
        return None


def encode_resume_token(transport: str, cursor: str) -> str:
    """Wrap a transport-native cursor into an opaque resume token.

    Callers on a non-resumable transport (BullMQ, Temporal) MUST NOT call
    this — forbids a synthetic token where the transport cannot resume.
    """
    wire = {"v": 1, "t": transport, "c": cursor}
    return _base64url_encode(json.dumps(wire).encode("utf-8"))


def decode_resume_token(token: str) -> dict[str, str] | None:
    """Decode an opaque resume token. Returns ``None`` for anything malformed — never raises."""
    if not token:
        return None
    raw = _base64url_decode(token)
    if raw is None:
        return None
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    transport = parsed.get("t")
    cursor = parsed.get("c")
    if (
        parsed.get("v") != 1
        or not isinstance(transport, str)
        or not isinstance(cursor, str)
    ):
        return None
    return {"transport": transport, "cursor": cursor}
