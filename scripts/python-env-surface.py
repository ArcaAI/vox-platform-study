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

So there are two gates, and they fail for different reasons:

  * `pnpm env:python-surface --check`  (needs Python, runs in `lint-python`)
        the manifest is stale — a pydantic field was added/renamed/removed and
        the manifest was not regenerated.
  * `pnpm env:sync --check`            (needs no Python, runs in `env-drift-check`)
        an artifact generated FROM the manifest is stale — `.env.sample`,
        `turbo.json#globalEnv` or the docs table.

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


def _git_tracked_python_files() -> list[str]:
    listed = subprocess.run(
        ["git", "ls-files", "*.py"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    return [f for f in listed if f and "node_modules" not in f]


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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the manifest is stale")
    args = parser.parse_args()

    # The services read `.env.<NODE_ENV>` at import time through `hope_env`; a
    # host env file must not be able to change what this manifest DECLARES.
    os.environ["CI"] = "true"

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
