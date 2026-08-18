"""One answer to "may this internal caller in?".

`stt` was the only one of the six Python services with NO inbound authentication
at all: `create_app` installed CORS, request logging and request ids, and nothing
that looked at a credential — so every `/internal/*` route on :8861, including
`POST /internal/streaming/drain` (scale this worker down) and
`POST /internal/cache/clear` (evict every loaded model), was reachable by
anything that could open a socket to the port.

The decision itself lives here rather than inside the middleware for the same
reason it does in `apps/tts`: a WebSocket handler cannot use a
``BaseHTTPMiddleware``, so any future socket on this service must be able to make
the identical call. (`stt` has no WebSocket endpoint today — the streaming socket
is the gateway's, and audio reaches this service over Redis Streams — so there is
currently exactly one caller.)

### The dev bypass is a decision, not the absence of one

"No token configured ⇒ let everything through" is a real affordance: `pnpm
stt:dev` and the hermetic CI suites run without a token and must keep working.
But an UNSET credential in a deployed environment is a misconfiguration, and a
misconfiguration must fail CLOSED — otherwise a Vault template that failed to
render silently republishes exactly the open surface this module was added to
close. So the bypass is conditioned on actually being in local development.
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
    environment — ``DEPLOYMENT_ENVIRONMENT`` first (the k8s-side spelling), then
    ``NODE_ENV`` — exactly as ``stt.main`` already does for service registration.
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
