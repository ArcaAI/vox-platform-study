#!/usr/bin/env python3
"""
Env-key consumer inventory (TASK-616 E4.1 prerequisite).

Answers one question per key: **which services actually read this?**

Why this exists
---------------
`hope-config` is a single ConfigMap consumed by 11 workloads via `envFrom`.
Appendix E4.1 wants it split into a platform map plus per-service maps, but
splitting a shared `envFrom` map has a SILENT failure mode: a service that loses
a key it reads gets an undefined variable, not an error. `check-config-refs.py`
in the deployment repo cannot help — it only sees explicit `configMapKeyRef`s,
never `envFrom` keys.

So the split cannot be done safely by reading manifests. It needs the consumer
side: what each service's own configuration code looks for.

How the keys are derived
------------------------
Python services: by ASKING pydantic, not by parsing source. The settings classes
combine `env_prefix`, `env_prefix_target="all"` and `AliasChoices`, so the env
var a field reads is not textually present in the file — `SMR_GATEWAY_URL` comes
from a field named `gateway_url` with alias `GATEWAY_URL` under prefix `SMR_`.
`EnvSettingsSource._extract_field_info` returns exactly what pydantic will look
up, including nested settings models.

TypeScript: literal `process.env.X` reads.

  ⚠️ KNOWN BLIND SPOT — the TS side finds only literal `process.env.NAME`
  reads. A key consumed through an indirection (a config service, a destructured
  env object, a computed key) is invisible. `CORS_ALLOWED_ORIGINS` proved this:
  it is referenced in `apps/api/src/cors.config.ts` but never as `process.env.
  CORS_ALLOWED_ORIGINS`. Treat a TS "no consumer" result as "no LITERAL read
  found", and confirm by grepping the bare key before acting on it.

Usage
-----
    scripts/env-consumer-inventory.py [--configmap <rendered.yaml>] [--json]

With `--configmap`, cross-references a rendered ConfigMap and classifies each
key as platform (>1 consumer), per-service (exactly 1), or unread.
"""

from __future__ import annotations

import argparse
import importlib
import inspect
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PY_SERVICES = ["stt", "smr", "guardrail", "nlp", "harness", "tts"]
CONDA_PY = Path.home() / "miniconda3/envs/arcaenv/bin/python"

# Extraction runs INSIDE each service's own interpreter/import path, so it is a
# separate script body executed via -c rather than an import here.
_EXTRACT = r"""
import sys, importlib, inspect, json
from pydantic_settings import BaseSettings
from pydantic_settings.sources import EnvSettingsSource
try:
    mod = importlib.import_module(sys.argv[1])
except Exception as e:
    print(json.dumps({"__error__": f"{type(e).__name__}: {e}"})); sys.exit(0)
out, seen = {}, set()
def walk(cls):
    if cls in seen or not (inspect.isclass(cls) and issubclass(cls, BaseSettings)):
        return
    seen.add(cls)
    try:
        src = EnvSettingsSource(cls)
    except Exception:
        return
    for fname, field in cls.model_fields.items():
        try:
            for (_n, env_name, _c) in src._extract_field_info(field, fname):
                out.setdefault(env_name.upper(), []).append(f"{cls.__name__}.{fname}")
        except Exception:
            pass
        ann = field.annotation
        if inspect.isclass(ann) and issubclass(ann, BaseSettings):
            walk(ann)
for _, obj in vars(mod).items():
    if inspect.isclass(obj) and issubclass(obj, BaseSettings) and obj is not BaseSettings:
        walk(obj)
print(json.dumps(out, sort_keys=True))
"""

TS_ENV_RE = re.compile(r"""process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[['"]([A-Z][A-Z0-9_]+)""")


def python_service_keys(svc: str) -> set[str]:
    if not CONDA_PY.exists():
        print(f"  ! conda env python not found at {CONDA_PY}", file=sys.stderr)
        return set()
    res = subprocess.run(
        [str(CONDA_PY), "-c", _EXTRACT, f"{svc}.core.config"],
        cwd=REPO / "apps" / svc,
        capture_output=True,
        text=True,
    )
    try:
        data = json.loads(res.stdout or "{}")
    except json.JSONDecodeError:
        print(f"  ! {svc}: could not parse extractor output", file=sys.stderr)
        return set()
    if "__error__" in data:
        print(f"  ! {svc}: {data['__error__']}", file=sys.stderr)
        return set()
    return set(data)


def ts_keys(*roots: Path) -> set[str]:
    found: set[str] = set()
    for root in roots:
        for path in root.rglob("*.ts*"):
            if "node_modules" in path.parts or path.suffix not in (".ts", ".tsx"):
                continue
            try:
                for m in TS_ENV_RE.finditer(path.read_text(errors="ignore")):
                    found.add(m.group(1) or m.group(2))
            except OSError:
                pass
    return found


def build() -> dict[str, list[str]]:
    consumers: dict[str, set[str]] = {}

    def add(svc: str, keys: set[str]) -> None:
        for k in keys:
            consumers.setdefault(k, set()).add(svc)

    for svc in PY_SERVICES:
        keys = python_service_keys(svc)
        print(f"  {svc:14} {len(keys):4} env vars", file=sys.stderr)
        add(svc, keys)

    # The gateway's surface includes the shared packages it imports.
    api = ts_keys(REPO / "apps/api/src", *(REPO / "packages").glob("*/src"))
    print(f"  {'api':14} {len(api):4} env vars (incl. shared packages)", file=sys.stderr)
    add("api", api)

    for app in ("admin-console", "compat-playground"):
        d = REPO / "apps" / app / "src"
        if d.is_dir():
            keys = ts_keys(d)
            print(f"  {app:14} {len(keys):4} env vars", file=sys.stderr)
            add(app, keys)

    return {k: sorted(v) for k, v in sorted(consumers.items())}


def classify(consumers: dict[str, list[str]], configmap_path: str) -> None:
    import yaml

    data = None
    with open(configmap_path) as fh:
        for doc in yaml.safe_load_all(fh):
            if doc and doc.get("kind") == "ConfigMap" and doc["metadata"]["name"] == "hope-config":
                data = doc["data"]
    if data is None:
        sys.exit(f"no ConfigMap/hope-config in {configmap_path}")

    keys = set(data)
    read = set(consumers)
    unread = sorted(keys - read)
    platform = [(k, consumers[k]) for k in sorted(keys & read) if len(consumers[k]) > 1]
    per_svc = [(k, consumers[k][0]) for k in sorted(keys & read) if len(consumers[k]) == 1]

    print(f"\nConfigMap keys: {len(keys)}   distinct env vars read by code: {len(read)}")
    print(f"\nNO LITERAL CONSUMER ({len(unread)}) — verify by grepping the bare key before deleting:")
    for k in unread:
        print(f"    {k:38} = {str(data[k])[:40]}")
    print(f"\nPLATFORM candidates — read by >1 service ({len(platform)}):")
    for k, s in platform:
        print(f"    {k:38} {','.join(s)}")
    print(f"\nPER-SERVICE candidates — read by exactly 1 ({len(per_svc)}):")
    for k, s in per_svc:
        print(f"    {k:38} {s}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--configmap", help="rendered YAML containing ConfigMap/hope-config")
    ap.add_argument("--json", action="store_true", help="emit the raw consumer map")
    args = ap.parse_args()

    print("Extracting env-var consumers...", file=sys.stderr)
    consumers = build()

    if args.json:
        print(json.dumps(consumers, indent=2))
    if args.configmap:
        classify(consumers, args.configmap)
    if not args.json and not args.configmap:
        print(f"\n{len(consumers)} distinct env vars across all services.")
        print("Pass --configmap <rendered.yaml> to classify, or --json for the raw map.")


if __name__ == "__main__":
    main()
