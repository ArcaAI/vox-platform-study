"""The internal service credential must never be absent SILENTLY (TASK-892 C3/D-3).

`INTERNAL_ACCESS_TOKEN` is the one shared credential this service presents on
every internal call and accepts inbound as `X-Service-Token`. In `hope-v2-dev`
it was absent from `hope-secrets` while the container bound it `optional: true`,
so the pod started happily, every `GET /internal/effective-config?service=nlp`
answered 401, and the service ran on COMPILED DEFAULTS instead of its resolved
tenant -> SYSTEM configuration. Rule 09 §Tenant-first resolution makes that a
correctness fault; the pod reported nothing at all.

An EMPTY value is treated identically to an absent one. That is the whole point:
an empty `X-Service-Token` is this service's documented dev-mode auth bypass, so
an empty string is the single most dangerous value the variable can carry, and
`hope-secrets` already holds one empty service-token key (ticket §2.6, D-6). The
unfilled `CHANGE_ME` sentinel counts as absent too — every outbound call already
treats it that way via `hope_env.real_secret`, so a gate that accepted it would
disagree with the calls it is guarding.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

from hope_env import real_secret

from nlp.core.config import NLPServiceConfig, settings
from nlp.core.logging import get_logger

__all__ = [
    "INTERNAL_ACCESS_TOKEN_VAR",
    "MissingInternalAccessToken",
    "assert_internal_access_token",
    "is_deployed",
]

INTERNAL_ACCESS_TOKEN_VAR = "INTERNAL_ACCESS_TOKEN"

_TRUTHY = frozenset({"true", "1"})

_MESSAGE = (
    f"{INTERNAL_ACCESS_TOKEN_VAR} is unset or empty. This service cannot authenticate to "
    "the gateway, so every internal call (effective-config, service-release registration) "
    "will be rejected with 401 and the process will run on compiled defaults instead of "
    "its resolved tenant configuration. Set the shared internal token; an EMPTY value is "
    "not a dev bypass."
)

logger = get_logger(__name__)


class MissingInternalAccessToken(RuntimeError):
    """A deployed process has no usable internal service credential."""


def is_deployed(environ: Mapping[str, str] | None = None) -> bool:
    """Is this a DEPLOYED process, i.e. one that must fail closed?

    `NODE_ENV=production` is the unambiguous signal. A truthy `CI` is the other
    one, because it means the same thing a pod means — host environment only, no
    env file (`hope_env.load_env`).

    `NODE_ENV=test` overrides both. `.gitlab/ci/test.yml` sets `NODE_ENV: "test"`
    AND `CI: "true"` on every Python job, so without this carve-out a fail-closed
    posture would abort the hermetic suite that proves the posture works — and a
    unit test run is not a deployment however its host is shaped. The run declares
    itself; we believe the declaration.
    """
    env = os.environ if environ is None else environ
    node_env = env.get("NODE_ENV", "").strip().lower()
    if node_env == "production":
        return True
    if node_env == "test":
        return False
    return env.get("CI", "").strip().lower() in _TRUTHY


def assert_internal_access_token(
    service: NLPServiceConfig | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> None:
    """Refuse to start (deployed) or complain loudly once (local dev).

    :raises MissingInternalAccessToken: when deployed with no usable token.
    """
    config = settings.service if service is None else service
    if real_secret(config.internal_access_token).strip():
        return

    if is_deployed(environ):
        raise MissingInternalAccessToken(_MESSAGE)

    logger.error(_MESSAGE)
