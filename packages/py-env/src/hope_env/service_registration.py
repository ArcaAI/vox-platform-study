"""Self-registration + heartbeat client (shared helper).

Every HOPE process registers its baked build identity with the gateway on
boot, then heartbeats every 5 minutes. Contract (frozen):
contracts/service-release.api.yaml`` ``POST /internal/service-releases`` —
idempotent upsert keyed on ``(service, gitCommitSha, releaseTag)`` for the
release and ``(serviceName, environment, instanceId)`` for the instance. A
repeat call IS the heartbeat — there is no separate heartbeat path.

THE CRITICAL RULE: registration is best-effort and must NEVER
block or fail process boot. Every function here swallows every exception,
logs a warning, and returns — nothing propagates past this module. The
5-minute heartbeat is the retry mechanism, so no aggressive retry is
attempted here.

Callers (each service's FastAPI ``lifespan``, or a worker's own startup):

    task = start_registration(
        http_client=app.state.http_client,
        gateway_url=settings.gateway_url,
        service_token=settings.service_token.get_secret_value(),
        build_info=build_info_reader.get_build_info(),
        environment=settings.environment,  # each service's own existing field
    )
    ...
    await stop_registration(task)  # on lifespan shutdown
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket

import httpx

from hope_env.build_info import _UNKNOWN_SERVICE, BuildInfo

logger = logging.getLogger(__name__)

#: Heartbeats every 5 minutes.
DEFAULT_HEARTBEAT_INTERVAL_S = 300.0

#: Bounded — this must never hang a heartbeat, let alone process boot.
DEFAULT_REGISTER_TIMEOUT_S = 5.0

#: Contract `Environment` enum (`service-release.api.yaml`). Anything that
#: doesn't map onto one of these three is treated as `dev` rather than
#: rejected — a mislabeled dev/CI process must never fail to boot over a
#: telemetry field, and `dev` is the safe (never mistaken for production) side.
_ENVIRONMENT_ALIASES: dict[str, str] = {
    "dev": "dev",
    "development": "dev",
    "test": "dev",
    "staging": "staging",
    "prod": "prod",
    "production": "prod",
}


def normalize_environment(raw: str | None) -> str:
    """Map each service's own existing `environment` convention onto the

    contract's `dev | staging | prod` enum.

    Every service already computes an environment string of its own — the
    gateway's `NODE_ENV` (`development|test|staging|production`), harness's
    `HARNESS_ENVIRONMENT` (free string, default `"development"`), nlp's
    `Environment` enum (`development|staging|production`), text/tts's
    `otel_deployment_environment` (`DEPLOYMENT_ENVIRONMENT` or `NODE_ENV`,
    default `"development"`) — none of them are spelled `dev`/`staging`/
    `prod` verbatim. This is a values-only projection of that EXISTING
    convention onto the frozen contract's enum, not a new source of truth.
    """
    return _ENVIRONMENT_ALIASES.get((raw or "").strip().lower(), "dev")


def instance_id() -> str:
    """Pod name via `HOSTNAME` (Kubernetes sets this) else `hostname:pid`."""
    hostname = os.environ.get("HOSTNAME")
    if hostname:
        return hostname
    return f"{socket.gethostname()}:{os.getpid()}"


def build_payload(
    build_info: BuildInfo, environment: str, instance_id_: str
) -> dict[str, str | None]:
    """The `RegisterInstanceRequest` wire shape: baked build-info + the two

    runtime facts only the process knows.
    """
    return {
        "service": build_info.service,
        "version": build_info.version,
        "releaseTag": build_info.release_tag,
        "gitBranch": build_info.git_branch,
        "gitCommitSha": build_info.git_commit_sha,
        "buildAt": build_info.build_at,
        "ciPipelineId": build_info.ci_pipeline_id,
        "ciPipelineUrl": build_info.ci_pipeline_url,
        "environment": normalize_environment(environment),
        "instanceId": instance_id_,
    }


async def _post_once(
    http_client: httpx.AsyncClient,
    gateway_url: str,
    service_token: str,
    payload: dict[str, str | None],
    timeout_s: float,
) -> None:
    """One POST to `/internal/service-releases`. NEVER raises."""
    url = f"{gateway_url.rstrip('/')}/internal/service-releases"
    try:
        response = await http_client.post(
            url,
            json=payload,
            headers={"X-Service-Token": service_token},
            timeout=timeout_s,
        )
        if response.status_code >= 400:
            logger.warning(
                "service_registration.rejected",
                extra={
                    "status_code": response.status_code,
                    "service": payload.get("service"),
                },
            )
    except Exception as error:  # noqa: BLE001 - must never propagate past registration
        logger.warning(
            "service_registration.request_failed",
            extra={"error": str(error), "service": payload.get("service")},
        )


async def _run(
    http_client: httpx.AsyncClient,
    gateway_url: str,
    service_token: str,
    payload: dict[str, str | None],
    interval_s: float,
    timeout_s: float,
) -> None:
    # Initial registration, then heartbeat forever on the interval. A failed
    # attempt (down gateway, timeout, 500) is swallowed inside `_post_once` —
    # the next scheduled heartbeat IS the retry, deliberately with no
    # aggressive backoff.
    await _post_once(http_client, gateway_url, service_token, payload, timeout_s)
    while True:
        await asyncio.sleep(interval_s)
        await _post_once(http_client, gateway_url, service_token, payload, timeout_s)


def start_registration(
    *,
    http_client: httpx.AsyncClient,
    gateway_url: str,
    service_token: str,
    build_info: BuildInfo,
    environment: str,
    instance_id_: str | None = None,
    interval_s: float = DEFAULT_HEARTBEAT_INTERVAL_S,
    timeout_s: float = DEFAULT_REGISTER_TIMEOUT_S,
) -> asyncio.Task[None] | None:
    """Fire-and-forget: schedule the initial registration + heartbeat loop as

    one background task and return it immediately (never awaited on the boot
    path). Cancel it with `stop_registration` on shutdown.

    Returns ``None`` — and schedules nothing — when the build info is the
    DEGRADED fallback (no ``/app/build-info.json``, ``service == "unknown"``):
    every local dev process is in that state, has no release to register, and
    the gateway rejected its payload on every heartbeat
    (``service_registration.rejected``, TASK-946). ``stop_registration`` already
    accepts ``None``, so no caller needs a branch.
    """
    if build_info.service == _UNKNOWN_SERVICE:
        logger.info(
            "service_registration.skipped_no_build_info",
            extra={"version": build_info.version, "environment": environment},
        )
        return None
    payload = build_payload(build_info, environment, instance_id_ or instance_id())
    return asyncio.create_task(
        _run(http_client, gateway_url, service_token, payload, interval_s, timeout_s),
        name="hope-service-release-registration",
    )


async def stop_registration(task: asyncio.Task[None] | None) -> None:
    """Cancel the heartbeat task cleanly and await it — no leaked task.

    Safe to call with `None` (a lifespan that never started registration
    still calls this unconditionally on shutdown) and safe to call twice.
    """
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception as error:  # noqa: BLE001 - shutdown must never raise either
        logger.warning("service_registration.stop_failed", extra={"error": str(error)})
