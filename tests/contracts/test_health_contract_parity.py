"""Health-check contract parity gate (TASK-990, lane PY-HEALTH).

Hermetic, static-inspection guard that keeps the six Python services
(``stt``, ``text``, ``guardrail``, ``nlp``, ``harness``, ``tts``) on the SAME
health contract the gateway implements
(``apps/api/src/modules/health/health.controller.ts``). Nothing here boots an
app, opens a socket, or imports a service package (several load ML weights at
import time) — every assertion reads source files as text/AST and reasons about
their *shape*. Sibling and model: ``test_observability_parity.py``.

Why each assertion exists, by finding id (see
``docs/implementation/TASK-990-Health-Check-Contract-Alignment/README.md``):

* **F6** — all six services called ``BuildInfoReader`` at boot to self-register
  with the gateway and then reported a SOURCE LITERAL in ``/health``: text
  ``"2.0.0"``, stt ``settings.app_version``, guardrail an inline ``"1.0.0"``,
  nlp ``settings.service.version``, harness ``__version__``, tts ``"0.1.0"``.
  Verified live: ``hope-text``'s image carried
  ``{"version": "0.0.0-dev-2-2.96bf9a52", "ciPipelineId": "1235", ...}`` in
  ``/app/build-info.json`` while its ``/health`` answered ``"2.0.0"``, so during
  a rollout you could not tell which build replied. This is the TASK-648 defect,
  fixed in the gateway and never mirrored. See
  ``test_health_reports_a_computed_version`` and
  ``test_health_module_reads_the_build_contract``.
* **F7** — the gateway has a FOUR-route contract (``/health``, ``/health/live``,
  ``/health/ready``, ``/health/startup``); all six Python services had three.
  Worse, the missing route did not 404: five of the six run a service-token
  middleware that refuses an unknown path first, so ``/api/v1/health/startup``
  answered **401** — a missing route wearing an auth error's clothes. A route is
  only half the fix; it must also be exempt. See
  ``test_all_four_contract_routes_exist`` and
  ``test_all_four_contract_routes_are_auth_exempt``.
* **F9** — the decided division of labour between the four routes, which is the
  thing that stops a probe being pointed somewhere that cannot fail:

  =================  ================================  ==============  =========
  route              purpose                           status codes    probed?
  =================  ================================  ==============  =========
  ``/health``        detailed, ops-facing              **always 200**  never
  ``/health/live``   process alive, no dependencies    200             liveness
  ``/health/ready``  dependencies (+ drain state)      200 / 503       readiness
  ``/health/startup``  initialisation complete         200 / 503       startup
  =================  ================================  ==============  =========

  ``/health`` stays 200 because a misconfigured pod must remain able to REPORT
  that it is unwell — the same rationale that keeps these paths auth-exempt
  (``apps/stt/src/stt/core/middleware/auth.py``) — and because the gateway
  answers the same way (200 with ``status: "degraded"`` in the body). The two
  probe routes that express dependency and initialisation failure must
  therefore be CAPABLE of 503, and ``/health`` must not be. See
  ``test_probe_routes_can_refuse`` and
  ``test_detailed_health_route_never_refuses``.


Hard constraints this file honours: no ``import hope_env`` and no ``apps.<svc>``
package import; no network; no subprocess; nothing here mutates anything outside
this one file. A failure here means source code drifted off the contract — go
fix the SERVICE, never this test's expectations, unless the contract itself
changed (in which case update the ticket README first).
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

#: The gateway's contract, as route suffixes. ``/health`` is the detailed
#: operator endpoint; the other three are the three kubelet probe kinds.
CONTRACT_ROUTES: tuple[str, ...] = (
    "/health",
    "/health/live",
    "/health/ready",
    "/health/startup",
)


@dataclass(frozen=True)
class ServiceHealth:
    """Where a service keeps its health surface, and under which prefixes.

    ``prefixes`` is what ``main.py``'s ``include_router(health_router, ...)``
    mounts the router at — guardrail deliberately mounts BOTH, so its probe
    paths exist twice and both spellings have to be exempt. ``auth_middleware``
    is ``None`` for the one service that runs no service-token middleware at
    all; that is pinned below rather than skipped, so a middleware appearing
    there later cannot silently leave the health surface unexempted.
    """

    health_module: str
    prefixes: tuple[str, ...]
    auth_middleware: str | None
    #: The literal this service used to report as its version (F6). Kept so the
    #: regression is guarded by NAME, not merely "is not a constant".
    retired_version_literal: str


SERVICES: dict[str, ServiceHealth] = {
    "stt": ServiceHealth(
        health_module="apps/stt/src/stt/health/api/routes.py",
        prefixes=("/api/v1",),
        auth_middleware="apps/stt/src/stt/core/middleware/auth.py",
        retired_version_literal="2.0.0",
    ),
    "text": ServiceHealth(
        health_module="apps/text/src/text/api/endpoints/health.py",
        prefixes=("/api/v1",),
        auth_middleware="apps/text/src/text/api/middleware/auth.py",
        retired_version_literal="2.0.0",
    ),
    "guardrail": ServiceHealth(
        health_module="apps/guardrail/src/guardrail/api/endpoints/health.py",
        # Dual-mounted on purpose (`guardrail.main`): `/api/health*` is the
        # historical surface, `/api/v1/health*` the fleet-wide one.
        prefixes=("/api", "/api/v1"),
        auth_middleware="apps/guardrail/src/guardrail/api/middleware/auth.py",
        retired_version_literal="1.0.0",
    ),
    "nlp": ServiceHealth(
        # NLP keeps its health routes on the monitoring router, which is
        # composed into the versioned REST router rather than mounted directly.
        health_module="apps/nlp/src/nlp/api/v1/rest/monitoring.py",
        prefixes=("/api/v1",),
        auth_middleware="apps/nlp/src/nlp/api/middleware/auth.py",
        retired_version_literal="0.1.0",
    ),
    "harness": ServiceHealth(
        health_module="apps/harness/src/harness/api/endpoints/health.py",
        prefixes=("/api/v1",),
        # The ONE service with no service-token middleware. Pinned by
        # `test_harness_is_still_the_only_service_without_auth_middleware`.
        auth_middleware=None,
        retired_version_literal="0.1.0",
    ),
    "tts": ServiceHealth(
        health_module="apps/tts/src/tts/api/endpoints/health.py",
        prefixes=("/api/v1",),
        auth_middleware="apps/tts/src/tts/api/middleware/auth.py",
        retired_version_literal="0.1.0",
    ),
}


# ── Source-tree helpers (pure stdlib: ast + pathlib) ────────────────────────


def _parse(relative_path: str) -> ast.Module:
    path = REPO_ROOT / relative_path
    assert path.is_file(), f"{relative_path} does not exist"
    return ast.parse(path.read_text(encoding="utf-8"))


def _route_decorators(tree: ast.Module) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    """``{route path: handler}`` for every ``@router.get("...")`` in the module.

    Only the module-level ``router`` counts. ``stt`` also carries an
    ``internal_router`` for admin/debug endpoints, and those are emphatically
    NOT part of the probe contract — they are not auth-exempt and must not be.
    """
    found: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call):
                continue
            func = decorator.func
            if not isinstance(func, ast.Attribute) or func.attr != "get":
                continue
            if not isinstance(func.value, ast.Name) or func.value.id != "router":
                continue
            if decorator.args and isinstance(decorator.args[0], ast.Constant):
                path = decorator.args[0].value
                if isinstance(path, str):
                    found[path] = node
    return found


def _exempt_paths(relative_path: str) -> set[str]:
    """The string literals inside the module's ``EXEMPT_PATHS`` assignment.

    Read as a literal rather than imported: importing any of these middleware
    modules drags in the service package, and several of those load ML weights
    at import time.
    """
    tree = _parse(relative_path)
    for node in ast.walk(tree):
        targets = [node.target] if isinstance(node, ast.AnnAssign) else getattr(node, "targets", [])
        if not any(isinstance(t, ast.Name) and t.id == "EXEMPT_PATHS" for t in targets):
            continue
        return {
            literal.value
            for literal in ast.walk(node)
            if isinstance(literal, ast.Constant) and isinstance(literal.value, str)
        }
    raise AssertionError(f"{relative_path} declares no EXEMPT_PATHS")


def _version_value_nodes(handler: ast.FunctionDef | ast.AsyncFunctionDef) -> list[ast.expr]:
    """Every ``"version": <expr>`` value inside the handler's dict literals."""
    values: list[ast.expr] = []
    for node in ast.walk(handler):
        if not isinstance(node, ast.Dict):
            continue
        for key, value in zip(node.keys, node.values, strict=True):
            if isinstance(key, ast.Constant) and key.value == "version":
                values.append(value)
    return values


# ── F7: the four-route contract ────────────────────────────────────────────


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_all_four_contract_routes_exist(service: str) -> None:
    spec = SERVICES[service]
    declared = set(_route_decorators(_parse(spec.health_module)))
    missing = [route for route in CONTRACT_ROUTES if route not in declared]
    assert not missing, (
        f"{service}: {spec.health_module} is missing {missing} from the health contract "
        f"{list(CONTRACT_ROUTES)}. The gateway serves all four "
        f"(apps/api/src/modules/health/health.controller.ts); a probe pointed at a route this "
        f"service does not serve fails for the wrong reason — and on five of the six it does not "
        f"even 404, because the service-token middleware answers 401 first (TASK-990 F7)."
    )


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_all_four_contract_routes_are_auth_exempt(service: str) -> None:
    spec = SERVICES[service]
    if spec.auth_middleware is None:
        pytest.skip(f"{service} runs no service-token middleware (pinned separately)")

    exempt = _exempt_paths(spec.auth_middleware)
    missing = [
        f"{prefix}{route}"
        for prefix in spec.prefixes
        for route in CONTRACT_ROUTES
        if f"{prefix}{route}" not in exempt
    ]
    assert not missing, (
        f"{service}: {spec.auth_middleware} does not exempt {missing}. The middleware refuses "
        f"an unexempted path BEFORE FastAPI can route it, so the route existing is only half the "
        f"fix — a kubelet probe carries no X-Service-Token and would be answered 401 forever "
        f"(TASK-990 F7)."
    )


def test_harness_is_still_the_only_service_without_auth_middleware() -> None:
    """Pins the ONE exception above so it cannot quietly become two — or none.

    If harness grows a service-token middleware, its four health paths need
    exempting like everyone else's, and `test_all_four_contract_routes_are_auth_exempt`
    would have silently skipped it. If another service LOSES its middleware,
    that is a security regression this gate should surface, not tolerate.
    """
    without = {svc for svc, spec in SERVICES.items() if spec.auth_middleware is None}
    assert without == {"harness"}, (
        f"services with no service-token middleware changed: {sorted(without)}. "
        "Update SERVICES and, if a service GAINED one, exempt its four health paths."
    )

    for service, spec in SERVICES.items():
        if spec.auth_middleware is None:
            continue
        assert (REPO_ROOT / spec.auth_middleware).is_file(), (
            f"{service}: {spec.auth_middleware} is gone. Either it moved (update SERVICES) or "
            "this service stopped authenticating peer traffic."
        )


# ── F9: which routes may refuse, and which may not ─────────────────────────


def _refuses_with_503(handler: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """Does this handler contain a literal 503 anywhere in its body?

    Read as an integer literal rather than by calling the handler, because
    calling it needs an app, and building one imports the service package — the
    thing this file must not do.
    """
    return any(
        isinstance(node, ast.Constant) and node.value == 503 and not isinstance(node.value, bool)
        for node in ast.walk(handler)
    )


#: The startup marker every one of the six lifespans assigns unconditionally.
#: Pinned by name so removing it is a reviewed change rather than a silent
#: downgrade of ``/health/startup`` to an always-200 route.
STARTUP_MARKER = "service_release_task"


@pytest.mark.parametrize("service", sorted(SERVICES))
@pytest.mark.parametrize("route", ["/health/ready", "/health/startup"])
def test_probe_routes_can_refuse(service: str, route: str) -> None:
    spec = SERVICES[service]
    handler = _route_decorators(_parse(spec.health_module))[route]
    assert _refuses_with_503(handler), (
        f"{service}: {route} has no 503 path in {spec.health_module}. A probe route that cannot "
        f"fail is not a probe — the kubelet reads only the status code, so a 200 carrying "
        f"'not ready' in the body never removes the pod from Service endpoints. This is the "
        f"class of defect TASK-990 F1 and F9 both named."
    )


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_detailed_health_route_never_refuses(service: str) -> None:
    """``/health`` is informational and always 200 — the decided contract.

    Not an oversight to be "fixed": a misconfigured pod has to stay able to
    REPORT that it is unwell, which is the same reason these paths are
    auth-exempt, and the gateway answers identically (200 with
    ``status: "degraded"`` in the body). The risk F9 named — a probe pointed at
    an endpoint that cannot fail — is closed on the manifest side, by a probe
    gate that rejects any probe targeting a bare ``/health``.
    """
    spec = SERVICES[service]
    handler = _route_decorators(_parse(spec.health_module))["/health"]
    assert not _refuses_with_503(handler), (
        f"{service}: /health in {spec.health_module} grew a 503 path. That route is never probed "
        f"and must stay 200 with the verdict in the body; expressing failure is /health/live, "
        f"/health/ready and /health/startup's job (TASK-990 F9)."
    )


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_startup_reads_the_shared_lifespan_marker(service: str) -> None:
    """All six assert initialisation the SAME way.

    Six bespoke markers would be six things to get wrong, and a startup handler
    that reads none at all is an always-200 route wearing a probe's name.
    """
    spec = SERVICES[service]
    handler = _route_decorators(_parse(spec.health_module))["/health/startup"]
    names = {
        node.value
        for node in ast.walk(handler)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }
    assert STARTUP_MARKER in names, (
        f"{service}: /health/startup in {spec.health_module} does not read "
        f"`app.state.{STARTUP_MARKER}`, the marker every one of the six lifespans assigns "
        f"unconditionally and no create_app does. Without it the route cannot tell an "
        f"initialised app from one assembled without a lifespan (TASK-990 F7)."
    )


# ── F6: build identity ─────────────────────────────────────────────────────


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_health_module_reads_the_build_contract(service: str) -> None:
    spec = SERVICES[service]
    tree = _parse(spec.health_module)
    imports_reader = any(
        isinstance(node, ast.ImportFrom)
        and node.module is not None
        and node.module.split(".")[0] == "hope_env"
        and any(alias.name == "BuildInfoReader" for alias in node.names)
        for node in ast.walk(tree)
    )
    assert imports_reader, (
        f"{service}: {spec.health_module} does not import BuildInfoReader from hope_env. "
        f"The running artifact's identity is baked into the image at "
        f"/app/build-info.json (docs/operations/build-info.schema.json) and that reader is the "
        f"ONE way to read it — it is also the only one that degrades instead of raising when "
        f"the file is absent, as it is in local dev (TASK-990 F6)."
    )


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_health_reports_a_computed_version(service: str) -> None:
    spec = SERVICES[service]
    handler = _route_decorators(_parse(spec.health_module))["/health"]
    values = _version_value_nodes(handler)
    assert values, (
        f"{service}: the /health handler in {spec.health_module} reports no 'version' at all. "
        f"The gateway reports one (health.controller.ts) and an operator has to be able to tell "
        f"which build answered during a rollout."
    )
    literals = [node.value for node in values if isinstance(node, ast.Constant)]
    assert not literals, (
        f"{service}: /health reports a hardcoded version {literals!r}. A literal answers the "
        f"same string for every image ever built — verified live, hope-text's image carried "
        f"0.0.0-dev-2-2.96bf9a52 while its /health said '2.0.0'. Report "
        f"BuildInfoReader().get_build_info().version instead (TASK-990 F6)."
    )
    assert all(isinstance(node, ast.Call) for node in values), (
        f"{service}: /health's version is neither a literal nor a call. It must resolve through "
        f"BuildInfoReader; a module-level name can be reassigned or shadowed by config, which is "
        f"how nlp and stt got here (a pydantic-settings field with a literal default is a "
        f"build-time fact wearing a config costume)."
    )


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_retired_version_literal_is_gone_from_the_health_module(service: str) -> None:
    """Guards the specific regression, not just the general shape.

    `test_health_reports_a_computed_version` would still pass if someone wrapped
    the old literal in a function. This checks the string itself is no longer
    used as a version anywhere in the module (docstrings are excluded, so the
    findings can still be described in prose).
    """
    spec = SERVICES[service]
    tree = _parse(spec.health_module)
    docstrings = {
        ast.get_docstring(node)
        for node in ast.walk(tree)
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef)
    }
    offenders = [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and node.value == spec.retired_version_literal
        and node.value not in docstrings
    ]
    assert not offenders, (
        f"{service}: the retired version literal {spec.retired_version_literal!r} is back in "
        f"{spec.health_module} (TASK-990 F6)."
    )


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_health_does_not_publish_build_provenance(service: str) -> None:
    """Only ``version`` crosses onto this public route.

    ``/health`` is auth-exempt on five of six services and reachable by anything
    that can open the port. Branch, commit SHA and CI pipeline id are operator
    data: useful, and belonging behind an admin-gated surface. The gateway
    surfaces ``version`` and nothing else; these six must not quietly grow the
    rest of the build contract onto an unauthenticated endpoint.
    """
    spec = SERVICES[service]
    handler = _route_decorators(_parse(spec.health_module))["/health"]
    forbidden = {
        "git_commit_sha",
        "gitCommitSha",
        "git_branch",
        "gitBranch",
        "ci_pipeline_id",
        "ciPipelineId",
        "ci_pipeline_url",
        "ciPipelineUrl",
        "release_tag",
        "releaseTag",
    }
    leaked = sorted(
        {
            key.value
            for node in ast.walk(handler)
            if isinstance(node, ast.Dict)
            for key in node.keys
            if isinstance(key, ast.Constant) and key.value in forbidden
        }
    )
    assert not leaked, (
        f"{service}: /health publishes build provenance {leaked} on a public, auth-exempt "
        f"route. Surface only `version`, as the gateway does (TASK-990 F6)."
    )


# ── Shape guards that keep the table above honest ──────────────────────────


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_health_module_exists_where_the_table_says(service: str) -> None:
    spec = SERVICES[service]
    assert (REPO_ROOT / spec.health_module).is_file(), (
        f"{service}: {spec.health_module} is gone. If the health surface moved, update SERVICES "
        "— every assertion in this file reads that path, so a stale entry silently stops "
        "guarding anything."
    )


def test_every_python_service_is_covered() -> None:
    """The six services this repo runs, and no fewer.

    Mirrors ``test_observability_parity.py``'s SERVICES tuple: a seventh Python
    service must be added to BOTH gates deliberately, not discovered later by an
    incident.
    """
    assert sorted(SERVICES) == ["guardrail", "harness", "nlp", "stt", "text", "tts"]
