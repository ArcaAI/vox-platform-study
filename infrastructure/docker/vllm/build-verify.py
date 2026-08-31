#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""TASK-823 — GPU-free build verification + provenance for the HOPE vLLM image.

Two subcommands, run as two separate Dockerfile layers so the assertion never
reads its own output as the source of truth:

  record   measure what is actually installed and write
           /opt/hope/vllm-build-info.json
  assert   read that file back and prove the image is what it claims to be

This file is COPIED INTO the image on purpose. `.gitlab/ci/build.yml`'s
verify-vllm-plugin job re-runs `assert` against the PUSHED image, so the CI gate
and the Dockerfile's own gate agree by construction instead of by maintenance.

WHAT THIS CAN AND CANNOT PROVE
------------------------------
Build runners have NO GPU and buildkit exposes no device, so every assertion
here is answerable on a GPU-less machine:

  * the compiled CUDA extension EXISTS on disk (a pure-Python install would
    otherwise pass silently),
  * the plugin is DISCOVERABLE through the exact machinery vLLM uses --
    importlib.metadata.entry_points(group="vllm.general_plugins"), see
    vllm/plugins/__init__.py::load_plugins_by_group in v0.28.0 -- and resolves
    to the value the plugin declares,
  * that entry point LOADS (the same `plugin.load()` call vLLM makes),
  * vllm/torch were not moved by installing the plugin.

It deliberately does NOT prove: that a GPU exists, that the CUDA kernels can
execute, that any weights load, or that `vllm serve` comes up. Those need a
device and belong at pod start, not here.

This is the lesson from the sibling lmstudio image (TASK-824): its build
asserted with `lms runtime ls`, which is HARDWARE-FILTERED, so it reported "no
runtimes" on a GPU-less runner while the CUDA engine sat on disk. Never assert
a host capability to verify an image's contents.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import pathlib
import re
import sys

BUILD_INFO_PATH = pathlib.Path("/opt/hope/vllm-build-info.json")

# The group vLLM enumerates for general plugins (vllm/plugins/__init__.py:
# DEFAULT_PLUGINS_GROUP), and the entry point vllm-gguf-plugin declares in its
# pyproject.toml ([project.entry-points."vllm.general_plugins"]).
PLUGIN_GROUP = "vllm.general_plugins"
PLUGIN_NAME = "gguf"
PLUGIN_VALUE = "vllm_gguf_plugin:register"

SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def _version(dist: str) -> str:
    from importlib.metadata import version

    return version(dist)


def _measured() -> dict[str, str]:
    """Read versions from the INSTALLED packages.

    A measurement, not a restatement of the build ARGs. `vllm_gguf_plugin`'s
    own version is `base_version` from its pyproject (0.0.5 at the pinned
    commit) and does NOT encode the git SHA -- which is precisely why the SHA
    is recorded as its own field below.
    """
    return {
        "vllm": _version("vllm"),
        "torch": _version("torch"),
        "vllm_gguf_plugin": _version("vllm-gguf-plugin"),
    }


def cmd_record(args: argparse.Namespace) -> int:
    info = {
        "baseImage": os.environ.get("BASE_IMAGE", ""),
        "plugin": {
            "repo": os.environ.get("VLLM_GGUF_PLUGIN_REPO", ""),
            "commitSha": os.environ.get("VLLM_GGUF_PLUGIN_SHA", ""),
        },
        "measured": _measured(),
        # In effect at compile time. The base image pre-sets this, which is the
        # only reason the CUDA extension can be built on a GPU-less runner --
        # torch would otherwise try to query a device to pick an architecture.
        "torchCudaArchList": os.environ.get("TORCH_CUDA_ARCH_LIST", ""),
    }
    BUILD_INFO_PATH.parent.mkdir(parents=True, exist_ok=True)
    BUILD_INFO_PATH.write_text(json.dumps(info, indent=2, sort_keys=True) + "\n")
    BUILD_INFO_PATH.chmod(0o644)
    print(BUILD_INFO_PATH.read_text(), end="")
    return 0


def _fail(msg: str) -> None:
    print(f"FATAL: {msg}", file=sys.stderr)
    raise SystemExit(1)


def cmd_assert(args: argparse.Namespace) -> int:
    if not BUILD_INFO_PATH.is_file():
        _fail(f"{BUILD_INFO_PATH} is missing — the image carries no provenance.")
    info = json.loads(BUILD_INFO_PATH.read_text())
    print(json.dumps(info, indent=2, sort_keys=True))

    recorded_sha = info.get("plugin", {}).get("commitSha", "")
    if not SHA_RE.match(recorded_sha):
        _fail(
            f"recorded plugin commit {recorded_sha!r} is not a 40-char SHA. "
            "The image must be pinned to an immutable commit, never a branch or tag."
        )

    # ── 1. the pin is the pin that was asked for ────────────────────────────
    if args.expect_sha:
        if not SHA_RE.match(args.expect_sha):
            _fail(f"--expect-sha {args.expect_sha!r} is not a 40-char SHA.")
        if args.expect_sha != recorded_sha:
            _fail(
                "plugin commit MISMATCH.\n"
                f"  requested: {args.expect_sha}\n"
                f"  in image : {recorded_sha}"
            )
        print(f"OK: plugin pinned to the requested commit {recorded_sha}")

    # ── 2. the CUDA extension actually compiled ─────────────────────────────
    # find_spec does NOT execute the package, so this stage answers even when
    # the import in stage 4 would fail — which keeps the failure messages
    # distinguishable.
    spec = importlib.util.find_spec("vllm_gguf_plugin")
    if spec is None or not spec.submodule_search_locations:
        _fail("vllm_gguf_plugin is not importable — the install did not land.")
    pkg_dir = pathlib.Path(list(spec.submodule_search_locations)[0])
    # py_limited_api=True in the plugin's setup.py, so the artifact is abi3.
    sos = sorted(p.name for p in pkg_dir.glob("_C_gguf*.so"))
    if not sos:
        _fail(
            f"no compiled _C_gguf*.so in {pkg_dir}. The GGUF CUDA kernels were "
            "NOT built — a pure-Python install would fail only at inference time."
        )
    print(f"OK: compiled CUDA extension present: {', '.join(sos)}")

    # ── 3. vLLM can DISCOVER the plugin ─────────────────────────────────────
    # Metadata only: exactly what vllm/plugins/__init__.py enumerates, with no
    # import and no device.
    from importlib.metadata import entry_points

    discovered = list(entry_points(group=PLUGIN_GROUP))
    print(f"entry points in group {PLUGIN_GROUP}:")
    for ep in discovered:
        print(f"  - {ep.name} -> {ep.value}")
    match = [ep for ep in discovered if ep.name == PLUGIN_NAME]
    if not match:
        _fail(
            f"no {PLUGIN_NAME!r} entry point in group {PLUGIN_GROUP!r}. The "
            "package is installed but vLLM would never load it — importing it "
            "by hand is NOT the same thing as being registered."
        )
    ep = match[0]
    if ep.value != PLUGIN_VALUE:
        _fail(f"entry point {PLUGIN_NAME} is {ep.value!r}, expected {PLUGIN_VALUE!r}.")
    print(f"OK: {PLUGIN_NAME} -> {ep.value} is discoverable in {PLUGIN_GROUP}")

    # ── 4. that entry point LOADS ───────────────────────────────────────────
    # The same call vLLM makes (`plugin.load()`). It imports vllm_gguf_plugin
    # and resolves `register`; it does NOT call register() and touches no
    # device. If this ever fails for a GPU-absence reason rather than a real
    # one, narrow it to stages 2+3 and say so here — do not delete it silently.
    fn = ep.load()
    if not callable(fn):
        _fail(f"{ep.value} resolved to {type(fn).__name__}, which is not callable.")
    print(f"OK: {ep.value} loads and is callable")

    # ── 5. the tested runtime was not replaced ──────────────────────────────
    recorded = info.get("measured", {})
    now = _measured()
    drift = {
        k: (recorded.get(k), now[k]) for k in ("vllm", "torch") if recorded.get(k) != now[k]
    }
    if drift:
        _fail(
            "the base image's tested runtime was REPLACED after the plugin "
            f"install: {drift}. The image is not the runtime it claims to be."
        )
    print(f"OK: vllm={now['vllm']} torch={now['torch']} unchanged since install")
    print(f"    vllm_gguf_plugin={now['vllm_gguf_plugin']} @ {recorded_sha}")

    print(
        "\nNOTE: this proves the image CONTENTS and the plugin's REGISTRATION "
        "only.\n      GPU presence, kernel execution and weight loading are "
        "runtime facts\n      and are asserted at pod start, where a device "
        "actually exists."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("record", help="measure and write the provenance file")
    a = sub.add_parser("assert", help="prove the image is what it claims to be")
    a.add_argument(
        "--expect-sha",
        default="",
        help="40-char plugin commit SHA the caller requested; compared against "
        "the one recorded in the provenance file.",
    )
    args = parser.parse_args()
    return cmd_record(args) if args.cmd == "record" else cmd_assert(args)


if __name__ == "__main__":
    raise SystemExit(main())
