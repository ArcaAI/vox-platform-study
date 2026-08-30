"""`apps/text` routes to models. It must never be able to SERVE one.

TASK-818 AC-9. The 2026-08-29 audit established that this service cannot host a
model today — no inference runtime in its dependency closure, no weight handling,
no process spawning. That is a property worth keeping, and the only way to keep it
is to fail the build the moment it stops being true.

This is a REGRESSION FENCE, not a discovery test. Every assertion below passed on
the day it was written. If one fails, someone has moved `apps/text` from a router
towards a server — which is a charter change, not a bug fix, and belongs in an
owner decision rather than a green pipeline.

Sibling fences: `test_no_model_default_d7.py` (no adapter carries a model id) and
`test_task799_config_surface.py` (no provider/engine/credential in settings). This
file covers the runtime itself.
"""

from __future__ import annotations

import ast
import importlib.util
import tomllib
from collections.abc import Iterator
from pathlib import Path

import pytest

# `text/` package root: .../apps/text/src/text
_SRC = Path(__file__).resolve().parents[2]
_PYPROJECT = _SRC.parents[1] / "pyproject.toml"

#: Third-party inference runtimes. Presence of ANY of these means weights could be
#: loaded in-process. `llama_cpp` here is the PyPI package (`llama-cpp-python`), NOT
#: `text.providers.llama_cpp`, which is an httpx client to an external server.
_INFERENCE_RUNTIMES = (
    "torch",
    "transformers",
    "onnxruntime",
    "llama_cpp",
    "vllm",
    "ctranslate2",
    "sentence_transformers",
    "gguf",
)

#: Calls and constants that only appear when something materialises model weights.
_WEIGHT_HANDLING = (
    "from_pretrained",
    "save_pretrained",
    "AutoModel",
    "AutoTokenizer",
    "snapshot_download",
    "hf_hub_download",
    "HF_HOME",
    "TRANSFORMERS_CACHE",
    ".safetensors",
    ".gguf",
)

#: A router owns no child process. An engine does.
_PROCESS_SPAWNING = (
    "subprocess",
    "multiprocessing",
    "Popen",
    "create_subprocess_exec",
    "create_subprocess_shell",
    "os.system",
    "os.execv",
)


def _source_files() -> Iterator[Path]:
    """Every production module in `text/`.

    Tests are excluded on purpose: this file names every banned token, and a naive
    scan would flag itself.
    """
    for path in sorted(_SRC.rglob("*.py")):
        if "tests" in path.parts:
            continue
        yield path


def _imported_top_level_modules(path: Path) -> set[str]:
    """Top-level module names this file imports, via AST rather than text search.

    A comment or a docstring mentioning `torch` is documentation. `import torch` is
    a capability. Only the second one matters, so parse rather than grep.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


class TestNoInferenceRuntimeIsReachable:
    """Layer one: the capability cannot be imported, because it is not installed."""

    @pytest.mark.parametrize("runtime", _INFERENCE_RUNTIMES)
    def test_runtime_is_not_installed(self, runtime: str) -> None:
        assert importlib.util.find_spec(runtime) is None, (
            f"{runtime!r} is importable from apps/text. An inference runtime in the "
            "closure means this service can load weights in-process. Route to "
            "apps/text's configured backends instead (vLLM, LM Studio, or a cloud "
            "provider) — see TASK-818."
        )

    @pytest.mark.parametrize("runtime", _INFERENCE_RUNTIMES)
    def test_runtime_is_not_a_declared_dependency(self, runtime: str) -> None:
        pyproject = tomllib.loads(_PYPROJECT.read_text(encoding="utf-8"))
        declared = list(pyproject["project"].get("dependencies", []))
        for extra in pyproject["project"].get("optional-dependencies", {}).values():
            declared.extend(extra)

        # `llama-cpp-python` and `llama_cpp` are the same package, spelled two ways.
        needle = runtime.replace("_", "-")
        offenders = [
            spec
            for spec in declared
            if spec.split("[")[0].split(">")[0].split("=")[0].split("<")[0].strip()
            in {runtime, needle, f"{needle}-python"}
        ]
        assert not offenders, f"{runtime!r} declared in apps/text/pyproject.toml: {offenders}"


class TestNoModuleImportsAnInferenceRuntime:
    """Layer two: no source file reaches for one, even if it were installed."""

    def test_no_production_module_imports_a_runtime(self) -> None:
        offenders: list[str] = []
        for path in _source_files():
            hit = _imported_top_level_modules(path) & set(_INFERENCE_RUNTIMES)
            if hit:
                offenders.append(f"{path.relative_to(_SRC)}: {sorted(hit)}")
        assert not offenders, "inference runtime imported in apps/text:\n" + "\n".join(offenders)


class TestNoWeightHandling:
    """Layer three: nothing downloads, caches or opens model weights."""

    @pytest.mark.parametrize("token", _WEIGHT_HANDLING)
    def test_no_module_handles_weights(self, token: str) -> None:
        offenders = [
            str(path.relative_to(_SRC))
            for path in _source_files()
            if token in path.read_text(encoding="utf-8")
        ]
        assert not offenders, (
            f"{token!r} appears in apps/text: {offenders}. Weights belong in MinIO and "
            "are loaded by the inference services (TASK-823 / TASK-824), never here."
        )


class TestNoProcessSpawning:
    """Layer four: a router owns no child process."""

    @pytest.mark.parametrize("token", _PROCESS_SPAWNING)
    def test_no_module_spawns_a_process(self, token: str) -> None:
        offenders = [
            str(path.relative_to(_SRC))
            for path in _source_files()
            if token in path.read_text(encoding="utf-8")
        ]
        assert not offenders, (
            f"{token!r} appears in apps/text: {offenders}. If a model server needs "
            "starting, it is a deployment concern (a container), not a call site."
        )


class TestEnginesAreOwnedByInfrastructure:
    """Layer five: every engine adapter reaches an EXTERNAL address, fail-closed.

    `providers/{vllm,llama_cpp,ollama,tei_embed}.py` are named after engines but are
    HTTP clients. The property that keeps them clients is that none carries an
    endpoint of its own — `require_base_url` raises when the caller supplies none.
    """

    def test_self_hosted_adapters_require_a_caller_supplied_base_url(self) -> None:
        from text.core.connection import require_base_url

        adapters = ("llama_cpp", "ollama", "tei_embed")
        missing = [
            name
            for name in adapters
            if "require_base_url" not in (_SRC / "providers" / f"{name}.py").read_text("utf-8")
        ]
        assert not missing, (
            f"self-hosted adapters not using require_base_url: {missing}. An adapter "
            "that can default its own endpoint is one edit away from embedding one."
        )
        assert callable(require_base_url)
