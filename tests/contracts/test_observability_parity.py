"""Python logging & tracing parity gate (TASK-987, lane P).

Hermetic, static-inspection guard that keeps the six Python services
(``stt``, ``text``, ``guardrail``, ``nlp``, ``harness``, ``tts``) on the shared
``hope_obs`` standard documented in
``docs/implementation/TASK-987-Python-Logging-And-Tracing-Standard/README.md``
§3 (R-1..R-9). Nothing here boots an app, opens a socket, or imports a
service package (several load ML weights at import time) — every assertion
reads source files and ``pyproject.toml``s as text/AST and reasons about
their *shape*.

Why each assertion exists, by finding id (see the README's §2 for the full
writeup of each):

* **F-01 / F-02 / F-11** — six services once had *six different* "is tracing
  on" contracts, four of which were silently dead in `hope-v2-dev` (three of
  NLP's correctly-set OTel variables produced zero telemetry because a
  fourth, unrelated flag gated everything). R-2 replaces all six with one
  rule: an OTLP endpoint's presence is the ONLY enable signal. This file
  asserts that rule holds by construction, not by lucky configuration —
  see ``test_no_paired_otel_enable_gates_outside_known_exception`` and
  ``test_configure_observability_call_is_not_gated_by_a_bare_enabled_flag``.
* **F-03 / F-05** — NLP shipped a JSON formatter that was never installed,
  so its logs were unparsed text and its trace-correlation fields were dead
  code. R-1/R-3 fold every service's logging chain into ``hope_obs``, so a
  service that still defines its own chain has silently forked away from a
  fix that already landed once — see
  ``test_service_defines_no_local_observability_primitives``.
* **F-04 / F-06** — request correlation and worker tracing existed in some
  services and not others. R-1/R-6 say every FastAPI app's factory function
  must actually *reach* ``hope_obs.configure_observability`` (directly or
  through a thin per-service adapter) — see
  ``test_app_factory_reaches_configure_observability``. A green test suite is
  not evidence of this: NLP's own `create_app`-shaped function never called
  it either (F-20's root cause) — the call graph has to be traced.
* **F-05 / R-5** — four of six services also exported logs over OTLP, a
  second, differently-shaped copy of the same lines Alloy already tails from
  stdout, with an open question about whether the collector's PHI allow-list
  even inspects log bodies (F-10). R-5 deletes that path outright — see
  ``test_service_constructs_no_otlp_log_exporter``.
* **F-16** — kept as institutional memory, not re-tested here: it was a
  ``packages/py-obs`` import-cost defect, fixed *inside* that package, which
  this suite deliberately never touches (§"Hard constraints" below).
* **F-17** — the sharpest finding this ticket produced: declaring ``hope-obs``
  as a dependency without copying ``packages/py-obs`` into a service's Docker
  build context breaks that service's image, and only ``apps/text`` had a
  test that could see it. Five services shipped broken and nothing but a
  `docker build` could tell. See ``test_dockerfile_copies_py_obs`` and
  ``test_pyproject_declares_hope_obs`` /
  ``test_conftest_names_hope_obs_in_source_tree_guard``.
* **F-19** — harness's Temporal client still gates its ``TracingInterceptor``
  on the pre-R-2 ``otel_enabled AND bool(otel_exporter_endpoint)`` form, a
  documented, NOT-fixed-here follow-up. This file asserts the general
  anti-pattern is absent everywhere ELSE, and separately *pins* F-19's known
  instance so a silent fix (or a silent new instance elsewhere) both go red
  — see ``test_f19_known_exception_still_has_its_documented_shape``.

Deliberate, single, NAMED exception: ``apps/nlp`` keeps its own OTel
``MeterProvider`` (seven live instruments; ``hope_obs`` has no metrics path by
design — orchestrator decision, README §6.3 lane E). That exception is
spelled out once, by service name, in ``_METER_PROVIDER_EXCEPTIONS`` below —
never as a blanket "metrics are exempt" rule, so a SECOND service growing its
own ``MeterProvider`` still fails
``test_service_defines_no_local_observability_primitives``.

Hard constraints this file honours: no ``import hope_obs`` or any
``apps.<svc>`` package (several load ML weights or require a configured
environment at import time); no network; no subprocess; nothing here mutates
anything outside this one file. A failure here means source code drifted off
the standard — go fix the SERVICE, never this test's expectations, unless the
standard itself changed (in which case update the README first).
"""

from __future__ import annotations

import ast
import re
import tomllib
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

SERVICES: tuple[str, ...] = ("stt", "text", "guardrail", "nlp", "harness", "tts")

#: STT's Dockerfile lives at a non-standard path (`docker/` subdirectory,
#: multi-stage GPU build) — a naive `apps/<svc>/Dockerfile` glob misses it
#: (the exact trap the README's F-17 finding names explicitly).
_SERVICE_DOCKERFILES: dict[str, str] = {
    "stt": "apps/stt/docker/Dockerfile",
    "text": "apps/text/Dockerfile",
    "guardrail": "apps/guardrail/Dockerfile",
    "nlp": "apps/nlp/Dockerfile",
    "harness": "apps/harness/Dockerfile",
    "tts": "apps/tts/Dockerfile",
}

#: The ONE named exception to "no local MeterProvider" (see module docstring).
#: A second entry here is not how a future service gets an exemption — it is
#: how someone silences this gate. Any addition needs the same orchestrator
#: decision nlp's did.
_METER_PROVIDER_EXCEPTIONS: frozenset[str] = frozenset({"nlp"})

#: F-19's known, deliberately-not-fixed-here instance (see module docstring
#: and `docs/implementation/TASK-987-Python-Logging-And-Tracing-Standard/README.md`
#: finding F-19). `test_no_paired_otel_enable_gates_outside_known_exception`
#: excludes exactly this (file, function) pair; the sibling test
#: `test_f19_known_exception_still_has_its_documented_shape` pins that it is
#: still there, so a fix removes BOTH the exclusion and that pin, never one
#: silently.
_F19_EXCEPTION_FILE = "apps/harness/src/harness/core/config.py"
_F19_EXCEPTION_FUNC = "otel_tracing_enabled"

_ENABLED_WORD_RE = re.compile(r"enabled", re.IGNORECASE)
_ENDPOINT_WORD_RE = re.compile(r"endpoint|otlp", re.IGNORECASE)
_REQUEST_MIDDLEWARE_NAME_RE = re.compile(
    r"request[_-]?id|request[_-]?context|access[_-]?log|request[_-]?logging",
    re.IGNORECASE,
)


# ── Source-tree helpers (pure stdlib: ast + tomllib + pathlib, no imports of
# anything under apps/ or packages/py-obs) ──────────────────────────────────


def _service_src_root(svc: str) -> Path:
    return REPO_ROOT / "apps" / svc / "src" / svc


def _iter_service_py_files(svc: str) -> list[Path]:
    """Every ``.py`` file in the service's package, excluding its own tests.

    Test files legitimately do things production code must not (e.g. reset
    `structlog.configure(...)` between cases, per
    ``apps/guardrail/src/guardrail/tests/conftest.py``'s own docstring) — a
    parity gate over PRODUCTION shape has no business reading them.
    """
    root = _service_src_root(svc)
    out = []
    for path in root.rglob("*.py"):
        parts = path.relative_to(root).parts
        if any(part in ("tests", "test") for part in parts):
            continue
        out.append(path)
    return out


def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _called_names(node: ast.AST) -> set[str]:
    """Every function/method name a `Call` inside `node` invokes, by its
    simple (last-attribute-or-bare) name — deliberately NOT import-resolved.

    This is a heuristic, not a type-checker: it is what makes a six-service,
    zero-import call-graph trace tractable, and it is precise enough for this
    codebase's actual shapes (verified against all six services' real
    ``create_app``/``get_app``/adapter chains before this file was written).
    """
    names: set[str] = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            func = n.func
            if isinstance(func, ast.Name):
                names.add(func.id)
            elif isinstance(func, ast.Attribute):
                names.add(func.attr)
    return names


def _fastapi_lifespan_targets(node: ast.AST) -> set[str]:
    """Names passed as ``FastAPI(..., lifespan=<name>)`` inside `node`.

    A `lifespan=` keyword's value is a bare reference, never a `Call` — so
    `_called_names` cannot see it, and the call graph would dead-end at
    ``get_app`` for a service (NLP) whose observability wiring lives entirely
    inside its `lifespan` context manager instead of its app factory. Without
    this, the BFS below would falsely conclude NLP never configures
    observability at all.
    """
    targets: set[str] = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            func = n.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if name == "FastAPI":
                for kw in n.keywords:
                    if kw.arg == "lifespan" and isinstance(kw.value, ast.Name):
                        targets.add(kw.value.id)
    return targets


def _build_call_graph(svc: str) -> dict[str, set[str]]:
    """``function simple name -> names it calls``, unioned across every
    function of that name anywhere in the service (module-unqualified, by
    design — see `_called_names`)."""
    graph: dict[str, set[str]] = {}
    for path in _iter_service_py_files(svc):
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                called = _called_names(node) | _fastapi_lifespan_targets(node)
                graph.setdefault(node.name, set()).update(called)
    return graph


def _reaches_configure_observability(svc: str, max_depth: int = 8) -> tuple[bool, list[str]]:
    """BFS from every function that constructs a `FastAPI(...)` app (the app
    factory, however it is named — `create_app`, `get_app`, ...) through the
    service's own call graph, looking for a call to `configure_observability`.

    Returns ``(reached, visited_function_names)`` — the visited set is the
    diagnostic payload on failure: "here is everywhere I looked".
    """
    graph = _build_call_graph(svc)
    entry_points = {name for name, called in graph.items() if "FastAPI" in called}
    visited: set[str] = set()
    frontier = set(entry_points)
    depth = 0
    while frontier and depth < max_depth:
        depth += 1
        next_frontier: set[str] = set()
        for name in frontier:
            if name in visited:
                continue
            visited.add(name)
            called = graph.get(name, set())
            if "configure_observability" in called:
                return True, sorted(visited)
            next_frontier |= called - visited
        frontier = next_frontier
    return False, sorted(visited)


def _imports_from_hope_obs(svc: str, name: str) -> bool:
    for path in _iter_service_py_files(svc):
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "hope_obs":
                if any(alias.name == name for alias in node.names):
                    return True
    return False


def _find_calls_matching(svc: str, dotted_name: str) -> list[tuple[Path, int, str]]:
    """Every `Call` whose callee, unparsed, is exactly `dotted_name` or ends
    with `.<dotted_name>` (so both `TracerProvider(...)` and
    `sdk_trace.TracerProvider(...)` are caught, module aliasing included)."""
    pattern = re.compile(rf"(^|\.){re.escape(dotted_name)}$")
    hits: list[tuple[Path, int, str]] = []
    for path in _iter_service_py_files(svc):
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                text = ast.unparse(node.func)
                if pattern.search(text):
                    hits.append((path, node.lineno, text))
    return hits


def _find_function_defs_named(svc: str, name: str) -> list[tuple[Path, int]]:
    hits: list[tuple[Path, int]] = []
    for path in _iter_service_py_files(svc):
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
                hits.append((path, node.lineno))
    return hits


def _find_request_middleware_basehttp_subclasses(svc: str) -> list[tuple[Path, int, str]]:
    """`BaseHTTPMiddleware` subclasses whose NAME suggests request-id/access
    logging — never a blanket ban on `BaseHTTPMiddleware` itself, which every
    service legitimately still uses for `ServiceAuthMiddleware`."""
    hits: list[tuple[Path, int, str]] = []
    for path in _iter_service_py_files(svc):
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                bases_text = [ast.unparse(b) for b in node.bases]
                is_base_http = any(
                    b == "BaseHTTPMiddleware" or b.endswith(".BaseHTTPMiddleware")
                    for b in bases_text
                )
                if is_base_http and _REQUEST_MIDDLEWARE_NAME_RE.search(node.name):
                    hits.append((path, node.lineno, node.name))
    return hits


def _find_paired_gate_boolops(svc: str) -> list[tuple[Path, int, str, str]]:
    """2-operand ``and`` expressions pairing an ``...enabled``-shaped operand
    with an ``...endpoint``/``...otlp``-shaped one — the F-19 anti-pattern,
    generalised. Returns ``(path, lineno, enclosing_function, expression)``.

    Deliberately requires exactly 2 operands: harness's OWN correct veto
    (``otel_enabled_flag_is_set() and not settings.otel_enabled and
    config.otlp_endpoint``) is a 3-operand ``and`` — Python folds a chained
    ``and`` into one `BoolOp` with 3 `values`, not nested pairs — so it never
    matches this shape, by construction, not by exclusion list.
    """
    hits: list[tuple[Path, int, str, str]] = []
    for path in _iter_service_py_files(svc):
        tree = _parse(path)
        for func in (n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
            for node in ast.walk(func):
                if isinstance(node, ast.BoolOp) and isinstance(node.op, ast.And) and len(node.values) == 2:
                    texts = [ast.unparse(v) for v in node.values]
                    a, b = texts
                    a_enabled, a_endpoint = bool(_ENABLED_WORD_RE.search(a)), bool(_ENDPOINT_WORD_RE.search(a))
                    b_enabled, b_endpoint = bool(_ENABLED_WORD_RE.search(b)), bool(_ENDPOINT_WORD_RE.search(b))
                    paired = (a_enabled and not a_endpoint and b_endpoint and not b_enabled) or (
                        b_enabled and not b_endpoint and a_endpoint and not a_enabled
                    )
                    if paired:
                        hits.append((path, node.lineno, func.name, " and ".join(texts)))
    return hits


def _functions_calling_configure_observability(svc: str) -> list[tuple[Path, ast.AST]]:
    out: list[tuple[Path, ast.AST]] = []
    for path in _iter_service_py_files(svc):
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if "configure_observability" in _called_names(node):
                    out.append((path, node))
    return out


def _bare_enabled_gate_before_call(func_node: ast.AST) -> list[str]:
    """Inside a function that DOES call `configure_observability`: any bare
    (non-negated) or bare-negated single-flag `if` whose body `return`s
    without ever reaching that call — F-02's exact original shape
    (`if not settings.otel_enabled: return`, checked before three otherwise-
    correct OTel variables ever got a chance to matter).

    A veto that nulls the endpoint and lets `configure_observability` run
    regardless (every real service's CURRENT shape) never matches: its `if`
    body has no `return`, or the call itself is reachable in that branch.
    """
    hits: list[str] = []
    for node in ast.walk(func_node):
        if not isinstance(node, ast.If):
            continue
        test = node.test
        if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
            inner, negated = test.operand, True
        else:
            inner, negated = test, False
        if not isinstance(inner, (ast.Name, ast.Attribute)):
            continue
        inner_text = ast.unparse(inner)
        if not _ENABLED_WORD_RE.search(inner_text) or _ENDPOINT_WORD_RE.search(inner_text):
            continue
        if not any(isinstance(stmt, ast.Return) for stmt in node.body):
            continue
        branch_calls = set()
        for stmt in node.body:
            branch_calls |= _called_names(stmt)
        if "configure_observability" in branch_calls:
            continue
        polarity = "not " if negated else ""
        hits.append(f"line {node.lineno}: `if {polarity}{inner_text}: return ...` skips configure_observability entirely")
    return hits


def _load_pyproject(svc: str) -> dict:
    path = REPO_ROOT / "apps" / svc / "pyproject.toml"
    return tomllib.loads(path.read_text(encoding="utf-8"))


# ── 1. No local logging/tracing primitives; imports come from hope_obs ─────


@pytest.mark.parametrize("svc", SERVICES)
def test_service_imports_observability_from_hope_obs(svc: str) -> None:
    """F-05/F-06: every service must import its logging/tracing entry points
    from `hope_obs`, not carry its own six-way-forked implementation.
    """
    imported = any(
        _imports_from_hope_obs(svc, name)
        for name in ("configure_logging", "configure_observability", "configure_worker_observability", "get_logger")
    )
    assert imported, (
        f"F-05/F-06: apps/{svc} has no `from hope_obs import "
        "{configure_logging,configure_observability,configure_worker_observability,get_logger}` "
        "anywhere in its production source. Every service is expected to configure logging "
        "and tracing through the shared package, not a service-local reimplementation."
    )


@pytest.mark.parametrize("svc", SERVICES)
def test_service_defines_no_local_observability_primitives(svc: str) -> None:
    """F-05: the six-forked-stacks finding. A service that still defines its
    own `structlog.configure(`, its own `TracerProvider(`, its own
    `_add_otel_context`, its own request-id/access-log `BaseHTTPMiddleware`,
    or (outside the one named nlp exception) its own `MeterProvider(` has
    silently forked back off the shared standard, and any fix landed in
    `hope_obs` will not reach it.
    """
    violations: list[str] = []

    for path, lineno, text in _find_calls_matching(svc, "structlog.configure"):
        violations.append(f"{_rel(path)}:{lineno}: local `structlog.configure(...)` call (`{text}`)")

    for path, lineno, text in _find_calls_matching(svc, "TracerProvider"):
        violations.append(f"{_rel(path)}:{lineno}: local `TracerProvider(...)` construction (`{text}`)")

    for path, lineno in _find_function_defs_named(svc, "_add_otel_context"):
        violations.append(f"{_rel(path)}:{lineno}: local `_add_otel_context` definition")

    for path, lineno, name in _find_request_middleware_basehttp_subclasses(svc):
        violations.append(
            f"{_rel(path)}:{lineno}: `{name}` is a local `BaseHTTPMiddleware` subclass for "
            "request-id/access logging (F-08 — hope_obs.RequestContextMiddleware/"
            "AccessLogMiddleware are pure-ASGI and are installed automatically by "
            "`configure_observability`; a service never adds its own)"
        )

    if svc not in _METER_PROVIDER_EXCEPTIONS:
        for path, lineno, text in _find_calls_matching(svc, "MeterProvider"):
            violations.append(
                f"{_rel(path)}:{lineno}: local `MeterProvider(...)` construction (`{text}`) — "
                f"only apps/nlp is exempted (named exception, see module docstring); a second "
                "service growing its own metrics path needs the same orchestrator decision nlp's did"
            )

    assert violations == [], (
        f"apps/{svc} defines local observability primitives that TASK-987 replaced with "
        f"`hope_obs`:\n" + "\n".join(violations)
    )


# ── 2. No OTLP log export (R-5) ─────────────────────────────────────────────


@pytest.mark.parametrize("svc", SERVICES)
def test_service_constructs_no_otlp_log_exporter(svc: str) -> None:
    """R-5/F-10: the log path is stdout -> Alloy -> Loki, single-copy, single
    shape. A service constructing its own `OTLPLogExporter` or `LoggerProvider`
    reopens the two-copies-of-every-log-line problem F-10 found (four of six
    services shipping logs twice, in two different shapes) and reopens the
    still-open question of whether the collector's PHI allow-list even
    inspects OTLP log BODIES the way it inspects span attributes.
    """
    violations: list[str] = []
    for dotted in ("OTLPLogExporter", "LoggerProvider"):
        for path, lineno, text in _find_calls_matching(svc, dotted):
            violations.append(f"{_rel(path)}:{lineno}: local `{dotted}(...)` construction (`{text}`)")

    assert violations == [], (
        f"apps/{svc} still constructs an OTLP log exporter/provider, which R-5 deleted "
        f"fleet-wide (traces and metrics stay on OTLP; logs go stdout -> Alloy -> Loki only):\n"
        + "\n".join(violations)
    )


# ── 3. The app factory actually reaches configure_observability (F-06) ─────


@pytest.mark.parametrize("svc", SERVICES)
def test_app_factory_reaches_configure_observability(svc: str) -> None:
    """F-06/F-20: a service's FastAPI app factory (`create_app`, `get_app`,
    or equivalent — traced by call graph, not by grepping a wrapper's name)
    must reach `hope_obs.configure_observability`, directly or through a thin
    per-service adapter (`setup_observability`, `setup_opentelemetry`, ...).

    This is exactly the check a green unit-test suite cannot substitute for:
    NLP's own suite was green while `nlp.app.get_app` never called it at all
    (observability was wired through the `lifespan` context manager instead)
    — a fact only a traced call graph, not a test run, would have caught.
    """
    reached, visited = _reaches_configure_observability(svc)
    assert reached, (
        f"apps/{svc}: no path from its FastAPI app factory to "
        f"`hope_obs.configure_observability` was found by tracing calls "
        f"(visited: {visited or '<no FastAPI(...)-constructing function found>'}). "
        "Either the app factory (or the lifespan/adapter it delegates to) must call "
        "`configure_observability` directly, or this service's real wiring uses a "
        "shape this parity gate does not yet recognise and needs updating."
    )
    # Belt-and-braces: the name found by the call graph must actually be the
    # real `hope_obs.configure_observability`, not a coincidentally-named
    # local function.
    assert _imports_from_hope_obs(svc, "configure_observability"), (
        f"apps/{svc}: a function named `configure_observability` is reachable from the app "
        "factory, but no file imports that name `from hope_obs` — verify it is not a "
        "locally-defined function of the same name."
    )


# ── 4. pyproject.toml + conftest.py wiring (F-17's other half) ─────────────


@pytest.mark.parametrize("svc", SERVICES)
def test_pyproject_declares_hope_obs(svc: str) -> None:
    """F-17: `hope-obs` must be a real dependency (not just importable by
    accident of `pythonpath`), sourced from the workspace, and on the
    service's own pytest `pythonpath` — the three things that keep `uv sync
    --frozen`, the editable install, and this service's OWN test collection
    all agreeing about where `hope_obs` comes from.
    """
    data = _load_pyproject(svc)

    deps = data.get("project", {}).get("dependencies", [])
    dep_names = {re.split(r"[<>=!~\[\s]", dep, maxsplit=1)[0] for dep in deps}
    assert "hope-obs" in dep_names, (
        f"F-17: apps/{svc}/pyproject.toml [project.dependencies] does not declare "
        f"'hope-obs' (found: {sorted(dep_names)}). Without it, `uv sync --frozen` never "
        "installs the shared observability package for this service."
    )

    sources = data.get("tool", {}).get("uv", {}).get("sources", {})
    assert sources.get("hope-obs") == {"workspace": True}, (
        f"F-17: apps/{svc}/pyproject.toml [tool.uv.sources] must map 'hope-obs' to "
        f"{{workspace = true}} (found: {sources.get('hope-obs')!r}), the same shape as the "
        "existing 'hope-env' entry — otherwise uv resolves it from PyPI instead of the "
        "in-repo package."
    )

    pytest_opts = data.get("tool", {}).get("pytest", {}).get("ini_options", {})
    pythonpath = pytest_opts.get("pythonpath", [])
    assert "../../packages/py-obs/src" in pythonpath, (
        f"F-17: apps/{svc}/pyproject.toml [tool.pytest.ini_options] pythonpath is missing "
        f"'../../packages/py-obs/src' (found: {pythonpath}). Without it, this service's OWN "
        "test collection cannot import `hope_obs` from source."
    )


@pytest.mark.parametrize("svc", SERVICES)
def test_conftest_names_hope_obs_in_source_tree_guard(svc: str) -> None:
    """F-17 / `.claude/rules/14-multi-agent-worktrees.md` §4: every service's
    `conftest.py` must name `hope_obs` in its `assert_source_tree([...])`
    call, or a worktree run can silently import a DIFFERENT `hope_obs` (e.g.
    a stale editable install pointing at the primary checkout) than the one
    this checkout ships, and report a green suite for code nobody ran.
    """
    conftest_files = list((REPO_ROOT / "apps" / svc).rglob("conftest.py"))
    assert conftest_files, f"apps/{svc} has no conftest.py at all."

    checked: list[str] = []
    found = False
    for path in conftest_files:
        text = path.read_text(encoding="utf-8")
        match = re.search(r"assert_source_tree\(\s*\[([^\]]*)\]", text)
        if match is None:
            continue
        checked.append(_rel(path))
        if "hope_obs" in match.group(1):
            found = True
            break

    assert found, (
        f"F-17: no conftest.py under apps/{svc} calls `assert_source_tree([...])` with "
        f"'hope_obs' in its list (conftest.py files with an assert_source_tree call: "
        f"{checked or '<none found>'}; all conftest.py files: "
        f"{[_rel(p) for p in conftest_files]})."
    )


# ── 5. Dockerfile copies packages/py-obs (F-17, the sharpest finding) ──────


@pytest.mark.parametrize("svc", SERVICES)
def test_dockerfile_copies_py_obs(svc: str) -> None:
    """F-17: declaring `hope-obs` as a workspace dependency without copying
    `packages/py-obs` into the Docker build context breaks `uv sync --frozen`
    at image-build time — and only `apps/text` had a test that could see this
    before TASK-987. Five of six services shipped broken and nothing but an
    actual `docker build` would have told anyone.
    """
    dockerfile = REPO_ROOT / _SERVICE_DOCKERFILES[svc]
    assert dockerfile.is_file(), (
        f"F-17: expected apps/{svc}'s Dockerfile at {_rel(dockerfile)} — this parity gate's "
        "path table (`_SERVICE_DOCKERFILES`) is stale and needs updating."
    )

    text = dockerfile.read_text(encoding="utf-8")
    copies_py_obs = re.search(r"^COPY\s+packages/py-obs\b", text, re.MULTILINE) is not None
    assert copies_py_obs, (
        f"F-17: {_rel(dockerfile)} declares (or should declare) 'hope-obs' as a uv workspace "
        "dependency but has no `COPY packages/py-obs ./packages/py-obs` line. The next image "
        "build fails with \"Distribution not found at: file:///app/packages/py-obs\"."
    )


# ── 6/7. Endpoint presence is the ONLY enable signal — no required-true flag,
#         no paired independently-settable gates (R-2, F-01, F-02, F-19) ───


def _rel(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def test_no_paired_otel_enable_gates_outside_known_exception() -> None:
    """F-01/F-02/F-19: no service's export decision may depend on TWO
    independently-settable variables (an `*_enabled` flag ANDed with an
    endpoint/otlp expression). Under R-2, endpoint presence alone is the
    enable signal; a deprecated flag may only VETO (`if not flag: endpoint =
    None`, letting `configure_observability` still run and no-op), never be
    a co-equal, required-true condition.

    F-19 (harness's `otel_tracing_enabled` property, still read by
    `temporal/client.py`) is the one documented, deliberately-not-fixed-here
    exception — see `test_f19_known_exception_still_has_its_documented_shape`,
    which pins that it still exists so a silent fix does not just widen this
    exclusion forever.
    """
    violations: list[str] = []
    for svc in SERVICES:
        for path, lineno, func_name, expr in _find_paired_gate_boolops(svc):
            if _rel(path) == _F19_EXCEPTION_FILE and func_name == _F19_EXCEPTION_FUNC:
                continue
            violations.append(f"{_rel(path)}:{lineno} in `{func_name}()`: `{expr}`")

    assert violations == [], (
        "F-01/F-02/F-19: found an OTel export-enable decision that ANDs an '*_enabled' flag "
        "with an endpoint/otlp expression, outside the one documented F-19 exception "
        f"({_F19_EXCEPTION_FILE}::{_F19_EXCEPTION_FUNC}). Under R-2 this makes export silently "
        "depend on the flag being true, exactly the failure mode F-01/F-02 documented:\n"
        + "\n".join(violations)
    )


def test_f19_known_exception_still_has_its_documented_shape() -> None:
    """F-19 (documented follow-up, deliberately NOT fixed by this ticket):
    harness's `otel_tracing_enabled` property still gates
    `temporal/client.py`'s `TracingInterceptor` on the pre-R-2 AND-form
    (`otel_enabled and bool(otel_exporter_endpoint)`), while the FastAPI app
    and worker correctly read `otel_exporter_endpoint` directly.

    This test does not license the pattern generally — the sibling test
    above fails on any OTHER instance of it. It exists so that the day
    someone fixes F-19 (or renames/moves the property), THIS assertion goes
    red and forces them to also update the exclusion above and the README's
    F-19 status, rather than the exclusion quietly outliving the bug it was
    carved out for.
    """
    hits = _find_paired_gate_boolops("harness")
    matching = [
        hit for hit in hits if _rel(hit[0]) == _F19_EXCEPTION_FILE and hit[2] == _F19_EXCEPTION_FUNC
    ]
    assert matching, (
        f"F-19: expected {_F19_EXCEPTION_FILE}::{_F19_EXCEPTION_FUNC} to still contain the "
        "documented `otel_enabled and bool(otel_exporter_endpoint)` AND-gate, and it no longer "
        "does. If F-19 was fixed: remove its exclusion from "
        "`test_no_paired_otel_enable_gates_outside_known_exception`, delete this test, and "
        "update the README's F-19 entry to 'fixed'."
    )


def test_configure_observability_call_is_not_gated_by_a_bare_enabled_flag() -> None:
    """F-02: NLP's `setup_opentelemetry` used to `return` at its very first
    line on a single `*_OTEL_ENABLED`-style flag, before `configure_observability`
    was ever reached — so three correctly-set OTel variables produced zero
    telemetry. A deprecated flag may still VETO (null the endpoint and let
    the call proceed, which then correctly no-ops), but it may never skip the
    call to `configure_observability` outright.
    """
    violations: list[str] = []
    for svc in SERVICES:
        for path, func in _functions_calling_configure_observability(svc):
            for hit in _bare_enabled_gate_before_call(func):
                violations.append(f"{_rel(path)} in `{func.name}()`: {hit}")

    assert violations == [], (
        "F-02: a function that calls `configure_observability` also contains a bare "
        "'*_enabled'-flag `if` that returns before reaching it — the exact shape that once "
        "made NLP's three correctly-set OTel variables produce zero telemetry:\n"
        + "\n".join(violations)
    )
