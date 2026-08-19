"""The unfilled-secret sentinel, and the one rule for reading past it.

``CHANGE_ME`` is what ``scripts/env-sync.mts`` writes into ``.env.sample`` for every secret and
what ``scripts/generate-env-file.sh`` leaves behind for any credential it cannot synthesize. It
means **"no operator has filled this in"** — it is the ABSENCE of a value, not a value.

Everything that reads secrets already agreed on that, except the services:
``scripts/vault-seed-secrets.sh`` skips it explicitly ("writing the literal string would make an
unconfigured provider look configured"), and ``generate-env-file.sh`` only overwrites a key that
still holds it. The Python settings did not, and the gap had teeth, because the sentinel is a
non-empty string and every fallback in this codebase is written as a truthiness check::

    return self.internal_access_token.get_secret_value() or legacy.get_secret_value()

With ``INTERNAL_ACCESS_TOKEN=CHANGE_ME`` that expression returns ``"CHANGE_ME"``. The legacy
fallback — the thing that would have worked — is never reached, and the service confidently
presents the literal string ``CHANGE_ME`` as its ``X-Service-Token`` on every outbound call.
Nothing accepts it, so every internal hop 401s. Observed 2026-08-19: the whole workflow
substrate was unreachable from the gateway for exactly this reason, and the failure reads as an
auth problem rather than a configuration one, which is what made it expensive to find.

An EMPTY value already had well-defined, documented behaviour (``.env.sample``: "Empty
everywhere = auth disabled (local dev / hermetic CI)"), so mapping the sentinel onto empty is
not a new policy — it restores the one that was already written down.
"""

from __future__ import annotations

from typing import Protocol

__all__ = ["PLACEHOLDER_SENTINEL", "is_placeholder", "real_secret", "first_real_secret"]

#: The literal `env-sync.mts` / `generate-env-file.sh` write for an unfilled secret.
PLACEHOLDER_SENTINEL = "CHANGE_ME"


class _SecretLike(Protocol):
    """Structural type for pydantic's ``SecretStr`` without importing pydantic here —
    ``hope_env`` is the shared env-loading package and stays dependency-light."""

    def get_secret_value(self) -> str: ...


def is_placeholder(value: str | None) -> bool:
    """True when ``value`` is the unfilled-secret sentinel.

    Compared after stripping, because a hand-edited env file routinely leaves trailing
    whitespace and ``KEY=CHANGE_ME `` is no more configured than ``KEY=CHANGE_ME``.
    """
    return value is not None and value.strip() == PLACEHOLDER_SENTINEL


def real_secret(value: str | _SecretLike | None) -> str:
    """The secret's value, or ``""`` when it is absent or still the sentinel.

    Accepts a plain ``str``, a pydantic ``SecretStr``, or ``None``, so a caller never has to
    unwrap before asking. Returning ``""`` — rather than raising — is deliberate: it puts an
    unfilled secret back on the ALREADY-DEFINED empty path (auth disabled in dev, legacy token
    used as fallback) instead of inventing a third behaviour.
    """
    if value is None:
        return ""
    raw = value.get_secret_value() if hasattr(value, "get_secret_value") else value
    if not isinstance(raw, str):
        return ""
    return "" if is_placeholder(raw) else raw


def first_real_secret(*values: str | _SecretLike | None) -> str:
    """The first genuinely-configured value, or ``""`` if none is.

    The shape every outbound peer call needs: ``first_real_secret(shared, legacy)`` presents the
    canonical token when it is set and falls back to the per-service one when it is not — which
    is what the plain ``or`` chain was meant to express before the sentinel defeated it.
    """
    for value in values:
        resolved = real_secret(value)
        if resolved:
            return resolved
    return ""
