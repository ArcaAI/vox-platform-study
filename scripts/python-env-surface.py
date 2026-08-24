#!/usr/bin/env python
"""`pnpm env:python-surface` — emit the six Python services' DECLARED env surface.

── WHY THIS EXISTS ───────────────────────────────────────────────────────────
`scripts/env-sync.mts` is the repo's one env drift gate. Until TASK-799 Phase 1.5
it globbed only `*.ts,*.tsx,*.mts,*.cts,*.mjs,*.js` — no `*.py` — and inlined the
six Python services' `.env.sample` files verbatim without validating them. The
generator header called that a "declared boundary, not an oversight", and the
stated reason was real: pydantic-settings is a Python schema and the TypeScript
generator cannot import it.

The reason was real; the conclusion was not. A boundary that makes 243 of 297
Python env vars invisible to CI means "the config migration is finished" can
never be falsified. This script closes it WITHOUT asking TypeScript to import
Python: it runs where Python already runs (the `lint-python` CI job, `pnpm
<svc>:*` locally), introspects each service's pydantic-settings classes, and
writes the result to a COMMITTED JSON manifest. `env-sync.mts` then reads that
manifest as just another declaration source, exactly like it reads
`HOPE_SETTINGS_REGISTRY`.

So there are THREE gates, and they fail for different reasons:

  * `pnpm env:python-surface --check`  (needs pydantic + all six services)
        the manifest is stale — a pydantic field was added/renamed/removed and
        the manifest was not regenerated. NOT in CI: it can only run where all
        six services import, and no validate-stage job carries that.
  * `pnpm env:sync --check`            (needs no Python, runs in `env-drift-check`)
        an artifact generated FROM the manifest is stale — `.env.sample`,
        `turbo.json#globalEnv` or the docs table. Catches an env var that is
        READ but not DECLARED.
  * `pnpm env:python-dead`             (stdlib only, runs in `python-dead-settings`)
        the opposite direction — an env var that is DECLARED but never READ.
        A settings field an operator can set while nothing consumes the value.
        See the section that introduces it, further down this file.

── WHY INTROSPECTION AND NOT A REGEX ─────────────────────────────────────────
A pydantic-settings field's env name is not textually present in the source. It
is `env_prefix + field_name`, unless a `validation_alias` overrides it, in which
case `populate_by_name` decides whether the prefixed form ALSO stays reachable,
and `AliasChoices` contributes several names in precedence order. Only pydantic
knows. `EnvSettingsSource._extract_field_info` is the exact function the runtime
itself uses to resolve a field, so this manifest cannot disagree with what the
service actually reads.

Bare `os.environ` / `os.getenv` reads are NOT introspectable and are NOT covered
here — `env-sync.mts` scans `*.py` for those with a regex, which is sound
because for a bare read the name IS textually present.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field as dataclass_field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "scripts" / "generated" / "python-env-surface.json"


@dataclass(frozen=True)
class ServiceSpec:
    """One Python deployable and the modules that declare its settings."""

    name: str
    """Service directory under `apps/`."""
    port: int
    title: str
    modules: tuple[str, ...]
    """Modules to import; every `BaseSettings` subclass DEFINED in one is walked."""


# The six Python services. A module is listed here because it DEFINES settings
# classes (`grep -rln BaseSettings apps/*/src`), not because it is important.
SERVICES: tuple[ServiceSpec, ...] = (
    ServiceSpec("guardrail", 8863, "Safety Engine", ("guardrail.core.config",)),
    ServiceSpec(
        "harness",
        8866,
        "Clinical Documentation Harness",
        ("harness.core.config", "harness.eval.config", "harness.sensors.config"),
    ),
    ServiceSpec("nlp", 8864, "Medical NLP", ("nlp.core.config",)),
    ServiceSpec("stt", 8861, "Speech-to-Text", ("stt.core.config.settings",)),
    ServiceSpec("text", 8862, "Text Generation & Summarization", ("text.core.config",)),
    ServiceSpec("tts", 8865, "Text-to-Speech", ("tts.core.config",)),
)


# ── Fields that are NOT env-reachable despite being declared ──────────────────
#
# `apps/nlp` wraps every env/dotenv/secrets_dir source in
# `_ModelIdentityFilteredSource` (`nlp/core/config.py:30`), which DROPS the
# model-identity keys so `*_MODEL_NAME` / `*_TOKENIZER_NAME` can no longer select
# a model from the environment — model identity comes from the DB
# (`AiTaskDefault` x `AiModel`), per `00-project-context.md` §Configuration
# Principles. Emitting those names here would document an env knob that the
# service deliberately ignores, which is the F-03 "operator-facing file that
# lies" defect in a new costume.
#
# The frozenset is IMPORTED from the service rather than restated, so a change
# to the filter moves this manifest with it.
def _nlp_model_identity_fields() -> frozenset[str]:
    module = importlib.import_module("nlp.core.config")
    return frozenset(getattr(module, "_MODEL_IDENTITY_FIELDS"))


NOT_ENV_REACHABLE: dict[str, Any] = {}


@dataclass
class EnvField:
    name: str
    """Canonical env var name — the one an operator should set."""
    aliases: list[str] = dataclass_field(default_factory=list)
    """Also accepted, in precedence order after `name`. Compat surface."""
    service: str = ""
    cls: str = ""
    field: str = ""
    prefix: str = ""
    required: bool = False
    secret: bool = False
    data_type: str = "string"
    default: Any = None
    description: str = ""


def _type_name(annotation: Any) -> str:
    text = str(annotation)
    if "SecretStr" in text:
        return "secret"
    if "bool" in text:
        return "boolean"
    if "int" in text:
        return "number"
    if "float" in text:
        return "number"
    if "list" in text or "List" in text or "tuple" in text:
        return "list"
    if "dict" in text or "Dict" in text:
        return "json"
    return "string"


def _field_comments(cls: type) -> dict[str, str]:
    """Map field name → the `#` comment block written immediately above it.

    Only `apps/stt` uses `Field(description=...)`; the other five services
    document every knob with a comment block above the assignment, and those
    comments are the ONLY operator documentation those fields have. pydantic
    cannot see them, so the generated `.env.sample` would be a bare list of
    names — strictly worse operator documentation than the hand-maintained
    files it replaces. Reading them out of the AST keeps the prose and still
    makes it generated.
    """
    import ast
    import inspect
    import textwrap

    try:
        source = textwrap.dedent(inspect.getsource(cls))
    except (OSError, TypeError):
        return {}

    lines = source.splitlines()
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {}

    body = tree.body[0].body if tree.body and hasattr(tree.body[0], "body") else []
    out: dict[str, str] = {}
    for node in body:
        if not isinstance(node, (ast.AnnAssign, ast.Assign)):
            continue
        target = node.target if isinstance(node, ast.AnnAssign) else (node.targets or [None])[0]
        if not isinstance(target, ast.Name):
            continue
        collected: list[str] = []
        index = node.lineno - 2  # 1-based lineno → 0-based, one line up
        while index >= 0:
            stripped = lines[index].strip()
            if not stripped.startswith("#"):
                break
            text = stripped.lstrip("#").strip()
            # A bare rule (`# ────────────`) separates groups and says nothing;
            # a titled rule (`# ── Model weight cache root ────`) is the group's
            # NAME and is the only description some fields have — keep the title,
            # drop the decoration.
            if text and set(text) <= {"─", "-", "=", "━"}:
                break
            text = text.strip("─━=- ").strip()
            if not text:
                break
            collected.append(text)
            index -= 1
        if collected:
            joined = " ".join(reversed(collected)).strip()
            if joined:
                out[target.id] = joined
    return out


def _is_nested_model(annotation: Any) -> bool:
    """True when the annotation is a pydantic model — i.e. sub-config composition."""
    from pydantic import BaseModel

    try:
        return isinstance(annotation, type) and issubclass(annotation, BaseModel)
    except TypeError:
        return False


def _default_of(info: Any) -> Any:
    """A JSON-safe rendering of the field's declared default."""
    from pydantic_core import PydanticUndefined

    value = info.default
    # `Field(default_factory=lambda: [...])` leaves `.default` undefined; the
    # list IS the default and must be documented, or the generated sample would
    # show an empty value for `HARNESS_PHI_LOCAL_PROVIDERS` — a PHI allow-list.
    if value is PydanticUndefined and info.default_factory is not None:
        try:
            value = info.default_factory()  # type: ignore[call-arg]
        except TypeError:
            return None
    if value is PydanticUndefined or value is None:
        return None
    if hasattr(value, "get_secret_value"):
        # Never emit a secret's value, even a placeholder one baked into code.
        return None
    # Rendered into an env FILE, where pydantic parses `true`/`false` — not
    # Python's `True`/`False` repr. Emitting the repr would make every generated
    # line differ cosmetically from the hand-maintained one it replaces.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (str, int, float)):
        return value
    # A complex field is parsed as JSON by pydantic-settings, so its default must
    # render as JSON — `[]`, not the empty string. Getting this wrong is not
    # cosmetic: `CORS_ORIGINS=` makes `json.loads("")` raise and the service
    # fails to boot, which is precisely the "sample that does not produce a
    # working env" defect B.4 exists to close.
    if isinstance(value, (list, tuple, set)):
        return json.dumps(list(value))
    if isinstance(value, dict):
        return json.dumps(value)
    # StrEnum / IntEnum and friends.
    if hasattr(value, "value"):
        return value.value
    return str(value)


def collect(spec: ServiceSpec) -> list[EnvField]:
    from pydantic_settings import BaseSettings
    from pydantic_settings.sources import EnvSettingsSource

    excluded = NOT_ENV_REACHABLE.get(spec.name, frozenset())
    out: list[EnvField] = []

    for module_name in spec.modules:
        module = importlib.import_module(module_name)
        for attr in sorted(dir(module)):
            obj = getattr(module, attr)
            if not (isinstance(obj, type) and issubclass(obj, BaseSettings)):
                continue
            if obj is BaseSettings or obj.__module__ != module.__name__:
                continue
            source = EnvSettingsSource(obj)
            prefix = obj.model_config.get("env_prefix") or ""
            comments = _field_comments(obj)
            for field_name, info in obj.model_fields.items():
                if field_name in excluded:
                    continue
                # A field whose annotation is itself a settings/model class is
                # COMPOSITION (`Settings.azure: AzureOpenAIConfig`), not a knob.
                # pydantic would accept `TEXT_AZURE` as a JSON blob for it, but
                # no operator sets a whole sub-config that way and the sub-class's
                # own scalar fields are walked separately — emitting the parent
                # name would document a knob nobody uses and nothing reads.
                if _is_nested_model(info.annotation):
                    continue
                names: list[str] = []
                for _key, env_name, _complex in source._extract_field_info(info, field_name):
                    upper = env_name.upper()
                    # `apps/text` enforces BYOK-only vendor credentials by pointing
                    # the field's `validation_alias` at a name NOTHING can ever set
                    # (`TEXT_AZURE_API_KEY__ENV_REMOVED_TASK_602`, config.py:94).
                    # The name is a tombstone, not a knob: emitting it would
                    # advertise an env credential path that TASK-602 deliberately
                    # closed, and `test_task602_byok_credentials.py` asserts stays
                    # closed.
                    if upper.endswith("__ENV_REMOVED_TASK_602"):
                        continue
                    if upper not in names:
                        names.append(upper)
                if not names:
                    continue
                out.append(
                    EnvField(
                        name=names[0],
                        aliases=names[1:],
                        service=spec.name,
                        cls=obj.__name__,
                        field=field_name,
                        prefix=prefix,
                        required=info.is_required(),
                        secret=_type_name(info.annotation) == "secret",
                        data_type=_type_name(info.annotation),
                        default=_default_of(info),
                        description=(
                            info.description or comments.get(field_name, "")
                        ).strip().replace("\n", " "),
                    )
                )
    return out


def build() -> dict[str, Any]:
    services: dict[str, Any] = {}
    for spec in SERVICES:
        sys.path.insert(0, str(ROOT / "apps" / spec.name / "src"))
        try:
            if spec.name == "nlp":
                NOT_ENV_REACHABLE["nlp"] = _nlp_model_identity_fields()
            fields = collect(spec)
        finally:
            sys.path.pop(0)
        services[spec.name] = {
            "port": spec.port,
            "title": spec.title,
            "fields": [
                {
                    "name": f.name,
                    "aliases": f.aliases,
                    "class": f.cls,
                    "field": f.field,
                    "prefix": f.prefix,
                    "required": f.required,
                    "secret": f.secret,
                    "dataType": f.data_type,
                    "default": f.default,
                    "description": f.description,
                }
                for f in sorted(fields, key=lambda f: (f.cls, f.name))
            ],
        }

    distinct: set[str] = set()
    for payload in services.values():
        for entry in payload["fields"]:
            distinct.add(entry["name"])
            distinct.update(entry["aliases"])

    bare = scan_bare_reads()
    # A name pydantic already declares is not a "bare" read — report only what
    # lives OUTSIDE the settings classes, which is the set nothing documented.
    bare = {name: files for name, files in bare.items() if name not in distinct}
    distinct.update(bare)

    return {
        "$comment": (
            "GENERATED FILE — DO NOT EDIT BY HAND. Produced by "
            "`pnpm env:python-surface` from the services' pydantic-settings "
            "declarations plus an AST scan of non-pydantic reads. "
            "`pnpm env:python-surface --check` fails when it is stale; "
            "`pnpm env:sync` consumes it to generate every "
            "apps/<svc>/.env.sample, turbo.json#globalEnv and the docs table."
        ),
        "distinctNames": len(distinct),
        "services": services,
        "bareReads": bare,
    }


#: Directories a filesystem walk must skip. `git ls-files` gets this for free by
#: listing only TRACKED files; the fallback below has to say it out loud.
_WALK_SKIP_DIRS = frozenset(
    {
        ".git",
        ".claude",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        "dist",
        "build",
        ".next",
        "htmlcov",
        ".turbo",
    }
)


def _git_tracked_python_files() -> list[str]:
    """Every Python file in the repo, preferring git's tracked-file list.

    `git ls-files` is the accurate answer — it excludes ignored and generated
    files by construction. But the subprocess spawn dies with SIGABRT under a
    sandboxed interpreter, which made `pnpm env:python-surface` unrunnable both
    locally and inside every agent worktree; a drift gate nobody can regenerate
    is a gate that rots. So git is TRIED, and a filesystem walk is the fallback.

    The walk is deliberately not a silent equivalent: it skips the ignore set
    above rather than pretending to know what git tracks, and an untracked
    scratch file under `apps/` would be picked up where git would omit it. That
    is the safe direction for a DRIFT gate — surfacing an extra read is a false
    alarm a human resolves, missing one is the blind spot this file exists to
    close.
    """
    try:
        listed = subprocess.run(
            ["git", "ls-files", "*.py"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.splitlines()
        return [f for f in listed if f and "node_modules" not in f]
    except (OSError, subprocess.SubprocessError):
        walked: list[str] = []
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in _WALK_SKIP_DIRS]
            for name in filenames:
                if name.endswith(".py"):
                    walked.append(os.path.relpath(os.path.join(dirpath, name), ROOT))
        return sorted(walked)


def _is_test_file(path: str) -> bool:
    """Mirror `env-sync.mts`'s `isTestFile`: a test's env is a fixture, not config."""
    parts = path.split("/")
    if any(p in {"tests", "test", "__tests__", "__mocks__"} for p in parts[:-1]):
        return True
    name = parts[-1]
    return name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py"


# Direct env reads: `os.environ["X"]`, `os.environ.get("X")`, `os.getenv("X")`.
_DIRECT_READERS = {("os", "getenv"), ("os", "environ", "get")}


def _dotted(node: Any) -> tuple[str, ...]:
    """Flatten `os.environ.get` into `('os','environ','get')`; () when not a name chain."""
    import ast

    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return tuple(reversed(parts))
    return ()


def scan_bare_reads() -> dict[str, list[str]]:
    """Every env var read OUTSIDE pydantic-settings, name → files that read it.

    Two forms, because both are live in this repo:

    1. **Direct** — `os.getenv("LOG_LEVEL")`, `os.environ["X"]`. A regex would do;
       `env-sync.mts` runs one over `*.py` as an independent second opinion.
    2. **Through a one-line helper** — `_env_int("HARNESS_LLM_MAX_ATTEMPTS", 5)`
       (`harness/core/llm_concurrency.py:66`), `_get_env_bool("LOG_FILE_ENABLED",
       False)` (`nlp/core/logging.py:89`). No regex over the CALL SITE can know
       `_env_int` reads the environment. These are exactly the reads a hand
       audit misses: `HARNESS_LLM_*` were declared in `apps/harness/.env.sample`
       and looked like phantoms until this scan proved them real.

    Helpers are DISCOVERED, not listed: a function qualifies when its body reads
    `os.environ` / `os.getenv` keyed by its own first parameter. Adding another
    such helper needs no change here.
    """
    import ast

    reads: dict[str, set[str]] = {}
    ENV_NAME = __import__("re").compile(r"^[A-Z][A-Z0-9_]{2,}$")

    for rel in _git_tracked_python_files():
        if _is_test_file(rel):
            continue
        try:
            tree = ast.parse((ROOT / rel).read_text())
        except (SyntaxError, UnicodeDecodeError):
            continue

        # Pass 0 — module-level `NAME = "ENV_VAR"` constants, so a read written
        # as `os.environ.get(SECRETS_DIR_ENV_VAR)` (py-env/settings_sources.py:84)
        # or `os.environ.get(_ALLOWED_ROOTS_ENV, "")` (nlp/core/guard_model_
        # reference.py:92) resolves to the name it actually reads.
        constants: dict[str, str] = {}
        for node in tree.body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
                if isinstance(node.value.value, str):
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            constants[target.id] = node.value.value

        # Pass 1 — which local functions are env readers keyed by their arg?
        helpers: set[str] = set()
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            args = node.args.args or node.args.posonlyargs
            # A method's first arg is `self`/`cls`; the KEY is then the second.
            key_names = {a.arg for a in args[:2]}
            for inner in ast.walk(node):
                keyed: Any = None
                if isinstance(inner, ast.Call) and _dotted(inner.func) in _DIRECT_READERS:
                    keyed = inner.args[0] if inner.args else None
                elif isinstance(inner, ast.Subscript) and _dotted(inner.value) == ("os", "environ"):
                    keyed = inner.slice
                if isinstance(keyed, ast.Name) and keyed.id in key_names:
                    helpers.add(node.name)
                    break

        # Pass 2 — collect literal names at every direct read and helper call.
        for node in ast.walk(tree):
            literal: Any = None
            if isinstance(node, ast.Call):
                dotted = _dotted(node.func)
                callee = dotted[-1] if dotted else ""
                if dotted in _DIRECT_READERS or callee in helpers:
                    literal = node.args[0] if node.args else None
            elif isinstance(node, ast.Subscript) and _dotted(node.value) == ("os", "environ"):
                literal = node.slice
            name = None
            if isinstance(literal, ast.Constant) and isinstance(literal.value, str):
                name = literal.value
            elif isinstance(literal, ast.Name):
                name = constants.get(literal.id)
            if name and ENV_NAME.match(name):
                reads.setdefault(name, set()).add(rel)

    return {name: sorted(files) for name, files in sorted(reads.items())}


# ── The declared-but-never-read check (TASK-799 Phase 3.2) ────────────────────
#
# A settings field nobody reads is CONFIG THEATRE: an operator sets it, nothing
# happens, and nobody finds out. Phases 0-2 of TASK-799 deleted ~95 of them, all
# found by hand — which is why they accumulated at all (assessment RC-3:
# "migrations were executed per-item by hand, so coverage equals the set that
# existed on the day someone ran the sweep"). This is the check that stops the
# next ~95 from accumulating.
#
# ── WHY THIS HALF IS AST AND THE MANIFEST HALF IS INTROSPECTION ───────────────
# The manifest above needs pydantic because an env NAME is not textually present
# in the source (`env_prefix` + field name, unless `validation_alias` overrides
# it...). This check needs no env name at all: it asks whether a FIELD is read,
# and both the field name and the read ARE textually present. So it is a pure
# AST pass over the standard library — which matters for three reasons:
#
#   * it runs on a bare `python:3.11-slim` CI runner with ZERO installs, where
#     importing all six services (torch, presidio, qdrant-client, ...) is not
#     affordable in a validate-stage job;
#   * it cannot go stale. A manifest-driven version would miss a dead field
#     added without regenerating the manifest — which is exactly the hole the
#     check exists to close;
#   * it needs no conda env, so it runs from any worktree.
#
# ── THE RULE: WHAT COUNTS AS A READ ───────────────────────────────────────────
# Field `F` declared on settings class `C` in service `S` counts as READ when the
# non-test Python source under `apps/S/` contains either:
#
#   (R1) an ATTRIBUTE LOAD `<anything>.F` that is NOT the callee of a call.
#        The "not the callee" half is load-bearing, and was learned from this
#        ticket's own false positives: `stt` had a live
#        `resolve_worker_concurrency()` function AND a live
#        `worker_concurrency()` snapshot METHOD while the settings FIELD of that
#        name was genuinely dead. A substring grep credits the field for both;
#        this rule credits neither, because `snapshot.worker_concurrency()` is a
#        method INVOCATION and `resolve_worker_concurrency` is a bare Name, never
#        an attribute.
#        A Store context (`settings.F = v`) is a WRITE and is not a read either
#        — that is what the control-plane overlay does, and a value written and
#        never read is precisely the defect being hunted.
#
#   (R2) a STRING LITERAL exactly equal to `"F"`, located OUTSIDE the body of
#        class `C`. That is how an indirect read is spelled in this repo:
#        `getattr(settings, "streaming_max_concurrent", 0)`
#        (`stt/streaming/execution_profile.py`), the `(metric, attr)` table in
#        `harness/eval/ci.py`, and the field -> dotted-key overlay table in
#        `stt/core/control_plane.py`. The "OUTSIDE class C" qualifier is what
#        makes the rule sharp rather than merely permissive: `@field_validator
#        ("rrf_k")` inside `RetrievalConfig` NAMES the field without consuming
#        it, and so does `validation_alias=moved_alias("storage_provider")`.
#        Without that qualifier every validated or alias-carrying field is
#        credited by its own declaration and the check finds nothing at all.
#
# Two deliberate limitations, both chosen to UNDER-report rather than cry wolf,
# because a gate that produces false positives gets disabled:
#
#   * Matching is by NAME within a service, not by resolved receiver type. Two
#     classes in one service that both declare `enabled` are credited by a single
#     read. Making that precise needs type inference over the receiver
#     expression, which is not worth it while a sweep's payload is a handful of
#     fields.
#   * A field named by bare string in an indirection table is credited even if
#     nothing downstream `getattr`s it, because telling those apart needs
#     dataflow. `apps/tts`'s overlay table happens to be keyed by DOTTED path
#     ("azure.max_concurrent") rather than bare field name, which is the only
#     reason its three genuinely-unread fields surface — luck, not design.
#     Stated here so the next reader does not mistake it for a guarantee.
#
# Tests are NOT scanned (the same `_is_test_file` rule the bare-read scan uses):
# a field read only by its own test is config theatre with a witness, and should
# surface here rather than hide behind it.

#: `"<service>:<Class>.<field>"` -> why the field is declared and deliberately
#: never read.
#:
#: An explicit, reviewed allow-list, NOT a looser rule. The assessment's lesson
#: (RC-3, F-13) is that "this is dead" written in a code comment was treated as
#: sufficient and the deletion never happened; an entry here is a line a reviewer
#: sees in a diff. It is also SELF-CLEANING — an entry naming a field that no
#: longer exists, or that something now reads, FAILS the check — so the list
#: cannot decay into a permanent amnesty.
#:
#: EMPTY is the correct steady state. Reach for an entry only when a field must
#: exist unread (a compatibility tombstone; a value consumed by a generator
#: rather than by the service), or when the finding is real but the file belongs
#: to a lane that is not yours — a HANDOFF, and the self-cleaning rule turns it
#: into a one-line deletion for whoever fixes it. "No time to delete it" is not
#: a reason; deleting it is the cheaper action.
_TTS_CONTROL_PLANE_HANDOFF = (
    "REAL FINDING, not an exemption. `tts/core/control_plane.py` WRITES this "
    "field from the control plane (its table is keyed by dotted path, "
    "'azure.max_concurrent'), and nothing in apps/tts then READS it — so the "
    "registry key, the descriptor and the overlay all exist to move a value "
    "that lands nowhere. Found by `pnpm env:python-dead` during TASK-799 Phase "
    "3.2, whose lane owned apps/{text,stt,guardrail,harness} and NOT apps/tts. "
    "Fix is to wire it at the provider or drop the field, the overlay entry and "
    "the descriptor together; then delete this line, which the staleness rule "
    "will demand anyway."
)

INTENTIONALLY_UNREAD: dict[str, str] = {
    "tts:AzureSpeechConfig.max_concurrent": _TTS_CONTROL_PLANE_HANDOFF,
    "tts:SarvamConfig.max_concurrent": _TTS_CONTROL_PLANE_HANDOFF,
    "tts:SarvamConfig.use_streaming": _TTS_CONTROL_PLANE_HANDOFF,
}


#: Base classes that make a `ClassDef` a settings class. Locally-defined
#: subclasses are added as they are discovered, so a class extending another
#: settings class in the same module is walked too.
_SETTINGS_BASES = frozenset({"BaseSettings"})

#: A string literal is only a candidate field reference if it could BE a field
#: name. Anything with a dot, space or dash is a log event, a dotted config key
#: or prose.
_PY_IDENT = __import__("re").compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass(frozen=True)
class DeclaredField:
    """One pydantic-settings field, as the AST sees it."""

    service: str
    cls: str
    name: str
    where: str

    @property
    def key(self) -> str:
        return f"{self.service}:{self.cls}.{self.name}"


def _settings_field_declarations(tree: Any, rel: str, service: str) -> list[DeclaredField]:
    """Every `BaseSettings` field declared in one parsed module.

    `model_config`, private (`_`-prefixed) attributes and `ClassVar`s are
    configuration OF the settings class, not knobs ON it.
    """
    import ast

    local_settings_classes: set[str] = set()
    out: list[DeclaredField] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        bases = {b.id for b in node.bases if isinstance(b, ast.Name)}
        bases |= {b.attr for b in node.bases if isinstance(b, ast.Attribute)}
        if not (bases & (_SETTINGS_BASES | local_settings_classes)):
            continue
        local_settings_classes.add(node.name)
        for item in node.body:
            if not isinstance(item, ast.AnnAssign) or not isinstance(item.target, ast.Name):
                continue
            field_name = item.target.id
            if field_name.startswith("_") or field_name == "model_config":
                continue
            if item.annotation and ast.unparse(item.annotation).startswith("ClassVar"):
                continue
            out.append(DeclaredField(service, node.name, field_name, f"{rel}:{item.lineno}"))
    return out


@dataclass
class _Reads:
    """Read evidence for one service."""

    #: attribute name -> `file:line` sites (R1).
    attributes: dict[str, set[str]] = dataclass_field(default_factory=dict)
    #: literal -> (enclosing class chain, `file:line`) occurrences (R2).
    literals: dict[str, list[tuple[tuple[str, ...], str]]] = dataclass_field(
        default_factory=dict
    )

    def add_module(self, tree: Any, rel: str) -> None:
        import ast

        # An attribute that IS a call's callee is a method INVOCATION, not a
        # field read — collected first so the walk below can exclude them.
        callees = {
            id(node.func)
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        evidence = self

        class Walker(ast.NodeVisitor):
            def __init__(self) -> None:
                self.stack: list[str] = []

            def visit_ClassDef(self, node: ast.ClassDef) -> None:
                self.stack.append(node.name)
                self.generic_visit(node)
                self.stack.pop()

            def visit_Attribute(self, node: ast.Attribute) -> None:
                if isinstance(node.ctx, ast.Load) and id(node) not in callees:
                    evidence.attributes.setdefault(node.attr, set()).add(f"{rel}:{node.lineno}")
                self.generic_visit(node)

            def visit_Constant(self, node: ast.Constant) -> None:
                if isinstance(node.value, str) and _PY_IDENT.match(node.value):
                    evidence.literals.setdefault(node.value, []).append(
                        (tuple(self.stack), f"{rel}:{node.lineno}")
                    )
                self.generic_visit(node)

        Walker().visit(tree)

    def reads(self, field: DeclaredField) -> bool:
        if field.name in self.attributes:
            return True
        return any(
            field.cls not in stack for stack, _ in self.literals.get(field.name, ())
        )


def scan_service_settings(service: str) -> tuple[list[DeclaredField], _Reads]:
    """Declared settings fields and read evidence for one `apps/<service>` tree."""
    import ast

    declared: list[DeclaredField] = []
    evidence = _Reads()
    for dirpath, dirnames, filenames in os.walk(ROOT / "apps" / service):
        dirnames[:] = [d for d in dirnames if d not in _WALK_SKIP_DIRS]
        for filename in sorted(filenames):
            if not filename.endswith(".py"):
                continue
            path = Path(dirpath) / filename
            rel = os.path.relpath(path, ROOT)
            if _is_test_file(rel):
                continue
            try:
                tree = ast.parse(path.read_text())
            except (OSError, SyntaxError, UnicodeDecodeError):
                continue
            declared.extend(_settings_field_declarations(tree, rel, service))
            evidence.add_module(tree, rel)
    return declared, evidence


@dataclass
class DeadFieldReport:
    scanned: int = 0
    dead: list[DeclaredField] = dataclass_field(default_factory=list)
    excused: list[DeclaredField] = dataclass_field(default_factory=list)
    stale_allow_entries: list[str] = dataclass_field(default_factory=list)


#: A synthetic module exercising every discrimination the rule above claims to
#: make. It is checked on EVERY run, before the real scan.
#:
#: The failure this defends against is the worst one a gate can have: a rule
#: that silently stops discriminating and reports "every field is read" forever.
#: That green is indistinguishable from a real green, and the ~95 dead fields
#: this check exists to prevent would accumulate underneath it. Six lines of
#: fixture make it impossible.
_CANARY_SOURCE = '''
class Cfg(BaseSettings):
    live_by_attribute: int = 1
    live_by_literal: int = 2
    dead_but_validated: int = 3
    dead_with_namesakes: int = 4

    @field_validator("dead_but_validated")
    def _v(cls, v): return v

def read_it(cfg):
    return cfg.live_by_attribute

def use_literal(cfg):
    return getattr(cfg, "live_by_literal")

def dead_with_namesakes(default):
    return default

class Snapshot:
    def dead_with_namesakes(self):
        return dead_with_namesakes(4)

def invoke_the_method(snapshot):
    return snapshot.dead_with_namesakes()
'''

#: field -> is it expected to read as LIVE?
_CANARY_EXPECTED = {
    "live_by_attribute": True,  # R1: plain attribute load
    "live_by_literal": True,  # R2: getattr with a string literal
    "dead_but_validated": False,  # its only literal is inside the declaring class
    "dead_with_namesakes": False,  # a live function AND a live method share the name
}


def _assert_rule_is_live() -> None:
    """Fail loudly if the read rule has stopped discriminating."""
    import ast

    tree = ast.parse(_CANARY_SOURCE)
    declared = _settings_field_declarations(tree, "<canary>", "<canary>")
    evidence = _Reads()
    evidence.add_module(tree, "<canary>")

    actual = {field.name: evidence.reads(field) for field in declared}
    if actual != _CANARY_EXPECTED:
        raise AssertionError(
            "The declared-but-never-read RULE is broken — refusing to report a "
            "result.\n"
            f"  expected: {_CANARY_EXPECTED}\n"
            f"  actual:   {actual}\n"
            "Fix the rule (see `_CANARY_SOURCE` and the section that documents "
            "R1/R2) before trusting any output from this check."
        )


def find_dead_fields() -> DeadFieldReport:
    _assert_rule_is_live()
    report = DeadFieldReport()
    for spec in SERVICES:
        declared, evidence = scan_service_settings(spec.name)
        report.scanned += len(declared)
        for field in declared:
            if evidence.reads(field):
                continue
            bucket = report.excused if field.key in INTENTIONALLY_UNREAD else report.dead
            bucket.append(field)
    excused_keys = {f.key for f in report.excused}
    report.stale_allow_entries = sorted(set(INTENTIONALLY_UNREAD) - excused_keys)
    return report


def _env_names_by_field() -> dict[str, str]:
    """Best-effort `service:Class.field` -> env var, for a friendlier message.

    Read from the committed manifest so the report can name the variable an
    operator would have set. Missing or stale, the check still works — it just
    prints the field alone. The check must never DEPEND on the manifest; that
    dependency is the staleness hole it was designed to avoid.
    """
    try:
        payload = json.loads(MANIFEST.read_text())
    except (OSError, ValueError):
        return {}
    return {
        f"{service}:{entry['class']}.{entry['field']}": entry["name"]
        for service, body in payload.get("services", {}).items()
        for entry in body.get("fields", [])
    }


def report_dead_fields() -> int:
    report = find_dead_fields()
    env_names = _env_names_by_field()

    # stderr, so the allow-list detail cannot interleave ahead of, or behind,
    # the failure block below — they would otherwise land on two streams and a
    # CI log would show the reasons AFTER the failure they do not explain.
    for key in sorted(f.key for f in report.excused):
        print(
            f"allow-listed  {key}\n              {INTENTIONALLY_UNREAD[key]}",
            file=sys.stderr,
        )

    if report.stale_allow_entries:
        print(
            "\nenv:python-dead FAILED — INTENTIONALLY_UNREAD carries stale entries.\n"
            "Each names a field that no longer exists, or one that something now "
            "reads.\nDelete the entry.",
            file=sys.stderr,
        )
        for key in report.stale_allow_entries:
            print(f"  stale: {key}", file=sys.stderr)
        return 1

    if report.dead:
        print(
            f"\nenv:python-dead FAILED — {len(report.dead)} settings field(s) are "
            "DECLARED and NEVER READ.\n"
            "An operator can set each of these and nothing happens: the value is "
            "parsed,\nvalidated, and dropped. Delete the field together with its "
            "documentation, or\nwire it to the code that was supposed to consume "
            "it. If it must exist unread,\nadd it to `INTENTIONALLY_UNREAD` in "
            "scripts/python-env-surface.py with a reason.",
            file=sys.stderr,
        )
        for field in sorted(report.dead, key=lambda f: f.key):
            env = env_names.get(field.key)
            print(
                f"  {field.key}{f'   env: {env}' if env else ''}\n"
                f"      declared at {field.where}",
                file=sys.stderr,
            )
        return 1

    print(
        f"env:python-dead OK — {report.scanned} declared settings fields across "
        f"{len(SERVICES)} Python services; every one is read "
        f"({len(report.excused)} allow-listed)."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the manifest is stale")
    parser.add_argument(
        "--dead",
        action="store_true",
        help=(
            "fail if any settings field is declared and never read "
            "(needs no pydantic and no conda env — see the section above)"
        ),
    )
    args = parser.parse_args()

    # The services read `.env.<NODE_ENV>` at import time through `hope_env`; a
    # host env file must not be able to change what this manifest DECLARES.
    os.environ["CI"] = "true"

    # A pure AST pass: it must run BEFORE anything imports a service, so it stays
    # usable on a runner where those imports would fail.
    if args.dead:
        return report_dead_fields()

    payload = build()
    rendered = json.dumps(payload, indent=2, sort_keys=False) + "\n"

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    on_disk = MANIFEST.read_text() if MANIFEST.exists() else ""

    if args.check:
        if on_disk != rendered:
            print(
                "env:python-surface --check FAILED — "
                f"{MANIFEST.relative_to(ROOT)} is stale.\n"
                "A pydantic-settings field was added, renamed or removed without "
                "regenerating the manifest.\n"
                "Run `pnpm env:python-surface && pnpm env:sync` and commit the result.",
                file=sys.stderr,
            )
            return 1
        print(
            f"env:python-surface --check OK — {payload['distinctNames']} distinct "
            f"env names declared across {len(payload['services'])} Python services."
        )
        return 0

    MANIFEST.write_text(rendered)
    print(f"updated  {MANIFEST.relative_to(ROOT)}")
    print(
        f"\nPython declared surface: {payload['distinctNames']} distinct env names "
        f"across {len(payload['services'])} services "
        f"({sum(len(s['fields']) for s in payload['services'].values())} fields)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
