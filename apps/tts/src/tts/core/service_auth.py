"""One answer to "may this internal caller in?", shared by HTTP and WebSocket.

``ServiceAuthMiddleware`` is a ``BaseHTTPMiddleware``, and Starlette never runs
those for a WebSocket scope — so ``/api/v1/audio/stream`` has to check the token
itself. That second implementation is exactly where the two paths drifted: the WS
check read the LEGACY ``service_token`` only, so completing owner decision D-D
properly (set ``INTERNAL_ACCESS_TOKEN``, drop the legacy variable — the
documented end state) made it read an empty string and fall into its "no token
configured ⇒ allow" branch. Doing the migration CORRECTLY opened the socket while
HTTP stayed protected.

Both paths now call the two functions below, so a future divergence has to be
deliberate rather than accidental.

### The dev bypass is a decision, not the absence of one

"No token configured ⇒ let everything through" is a real affordance: ``pnpm
tts:dev`` and the hermetic CI suites run without a token and must keep working.
But an UNSET credential in a deployed environment is a misconfiguration, and a
misconfiguration must fail CLOSED — otherwise a Vault template that failed to
render, or a Secret key renamed in a manifest, silently publishes an open
synthesis surface. So the bypass is conditioned on actually being in local
development.
"""

from __future__ import annotations

import hmac
import os

#: Environment names in which an unconfigured token means "local development".
#: Anything else — including a value this list does not recognise — counts as
#: DEPLOYED and therefore fails closed. Deliberately stricter than
#: ``hope_env.normalize_environment``, whose unknown-value default is ``"dev"``:
#: that permissive default is right for labelling telemetry and wrong for an
#: authentication decision.
_LOCAL_ENVIRONMENTS = frozenset({"", "dev", "development", "test", "local"})


def is_local_environment() -> bool:
    """True when this process is running on a developer machine or in CI.

    Reads the same two variables the rest of the repo uses to name its
    environment (``stt.main``, ``tts.core.config.otel_deployment_environment``,
    ``hope_env.service_registration``): ``DEPLOYMENT_ENVIRONMENT`` first — the
    k8s-side spelling — then ``NODE_ENV``.
    """
    raw = (os.getenv("DEPLOYMENT_ENVIRONMENT") or os.getenv("NODE_ENV") or "").strip().lower()
    return raw in _LOCAL_ENVIRONMENTS


def dev_bypass_active(accepted: tuple[str, ...]) -> bool:
    """True when auth is DELIBERATELY off: nothing configured AND running local."""
    return not accepted and is_local_environment()


def token_accepted(provided: str, accepted: tuple[str, ...]) -> bool:
    """Constant-time membership test of the presented ``X-Service-Token``.

    ``False`` for an empty ``accepted`` — a deployed service with no credential
    configured accepts nobody, which is what makes the bypass above the only way
    in and keeps that path explicit.
    """
    return bool(provided) and any(hmac.compare_digest(provided, token) for token in accepted)
