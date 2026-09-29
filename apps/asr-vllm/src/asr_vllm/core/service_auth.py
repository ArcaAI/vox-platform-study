"""May this internal caller in? — the fleet's ``X-Service-Token`` decision.

Copied from the ``apps/tts`` exemplar (``tts/core/service_auth.py``), which documents
why each rule exists: constant-time comparison, and an empty credential is a DEV bypass
only when the process is demonstrably local — in a deployed environment it fails closed,
so a Vault template that failed to render never publishes an open decode surface.
"""

from __future__ import annotations

import hmac
import os

#: Environment names in which an unconfigured token means "local development".
#: Anything else — including an unrecognised value — counts as DEPLOYED.
_LOCAL_ENVIRONMENTS = frozenset({"", "dev", "development", "test", "local"})


def is_local_environment() -> bool:
    raw = (os.getenv("DEPLOYMENT_ENVIRONMENT") or os.getenv("NODE_ENV") or "").strip().lower()
    return raw in _LOCAL_ENVIRONMENTS


def dev_bypass_active(accepted: tuple[str, ...]) -> bool:
    """True when auth is DELIBERATELY off: nothing configured AND running local."""
    return not accepted and is_local_environment()


def token_accepted(provided: str, accepted: tuple[str, ...]) -> bool:
    """Constant-time membership test; ``False`` for an empty ``accepted``."""
    return bool(provided) and any(hmac.compare_digest(provided, token) for token in accepted)
