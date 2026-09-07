"""TASK-892 D-1 — PyTorch must size its pool from the cgroup, not the node.

Measured in `hope-nlp-6845fc5d4b-tv765` (ticket §2.2): the container held a
2-CPU CFS quota on a 48-core node, `torch.get_num_threads()` reported 48, and
the cgroup recorded 7,292 s frozen on the quota against 573 s executing. On
BERT-base FFN shapes that configuration measured 583.3 ms/layer against
50.0 ms at 8 threads — an 11.7x penalty, which is the right order of magnitude
for the 20.3 s mean NER response.

The half that is easy to get wrong is PLACEMENT, not arithmetic. OMP_NUM_THREADS
is read by the OpenMP runtime when torch is IMPORTED, so a configuration hook
that runs after the first `import torch` is a silent no-op that still looks
green. `apps/nlp` has two entry paths and neither runs `nlp/main.py` in the
container — the image's ENTRYPOINT is
`python -m uvicorn --factory nlp.app:get_app`. The hook therefore lives in
`nlp/__init__.py`, the one module Python guarantees to execute before any
`nlp.*` submodule in BOTH paths, and the subprocess cases below are the proof:
they start a process the way the container starts one and read the number back
out of torch itself.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from hope_env.cpu import effective_cpu_quota
from hope_worktree_guard import declared_source_roots

from nlp.core.config import settings
from nlp.torch_runtime import TorchThreadingPlan, configure_torch_threading

SERVICE_DIR = Path(__file__).resolve().parents[1]

# What a fresh process reports after doing nothing but importing the package.
_PROBE = (
    "import nlp, os, sys, json, torch;"
    "print(json.dumps({"
    "'threads': torch.get_num_threads(),"
    "'interop': torch.get_num_interop_threads(),"
    "'omp': os.environ.get('OMP_NUM_THREADS'),"
    "'mkl': os.environ.get('MKL_NUM_THREADS'),"
    "'torch_imported_by_package': 'torch' in sys.modules,"
    "}))"
)


def _probe(**env: str) -> dict[str, object]:
    """Run the import probe in a fresh interpreter, in THIS worktree's source."""
    roots = [str(p) for p in declared_source_roots(SERVICE_DIR)]
    environment = {
        **os.environ,
        # Same roots the suite itself runs on, so the subprocess cannot resolve
        # `nlp` / `hope_env` out of the primary checkout via the conda env's
        # editable `.pth` files.
        "PYTHONPATH": os.pathsep.join(roots),
        **env,
    }
    for key, value in env.items():
        if value == "":
            environment.pop(key, None)
    completed = subprocess.run(  # noqa: S603
        [sys.executable, "-c", _PROBE],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
        env=environment,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout.strip().splitlines()[-1])


@pytest.fixture()
def clean_thread_env(monkeypatch):
    for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(settings.service, "torch_num_threads", 0, raising=False)
    monkeypatch.setattr(settings.service, "torch_num_interop_threads", 0, raising=False)
    return monkeypatch


class TestPlan:
    def test_auto_sizes_from_the_cgroup_aware_resolver(self, clean_thread_env) -> None:
        plan = configure_torch_threading()
        assert isinstance(plan, TorchThreadingPlan)
        assert plan.threads == effective_cpu_quota()
        assert plan.threads >= 1

    def test_exports_omp_and_mkl_for_the_openmp_runtime(self, clean_thread_env) -> None:
        plan = configure_torch_threading()
        assert os.environ["OMP_NUM_THREADS"] == str(plan.threads)
        assert os.environ["MKL_NUM_THREADS"] == str(plan.threads)

    def test_the_nlp_setting_overrides_auto_detection(self, clean_thread_env) -> None:
        clean_thread_env.setattr(settings.service, "torch_num_threads", 3, raising=False)
        plan = configure_torch_threading()
        assert plan.threads == 3
        assert plan.source == "override"

    def test_an_operator_set_omp_num_threads_is_never_overwritten(self, clean_thread_env) -> None:
        # The interim `overlays/dev` mitigation (ticket A5) sets this on the
        # container. Once the image ships the hook, that value must still win —
        # otherwise the fix silently reverts an operator's tuning.
        clean_thread_env.setenv("OMP_NUM_THREADS", "2")
        clean_thread_env.setattr(settings.service, "torch_num_threads", 7, raising=False)
        plan = configure_torch_threading()
        assert plan.threads == 2
        assert plan.source == "OMP_NUM_THREADS"
        assert os.environ["OMP_NUM_THREADS"] == "2"

    def test_interop_defaults_to_one(self, clean_thread_env) -> None:
        # More than one inter-op thread buys nothing for sequential encoder
        # inference and costs another pool contending for the same quota.
        assert configure_torch_threading().interop_threads == 1

    def test_the_interop_setting_is_honoured(self, clean_thread_env) -> None:
        clean_thread_env.setattr(settings.service, "torch_num_interop_threads", 2, raising=False)
        assert configure_torch_threading().interop_threads == 2

    def test_it_is_idempotent(self, clean_thread_env) -> None:
        # It runs at package import and may run again from a test or a worker
        # child; a second call must not raise, and must not drift.
        first = configure_torch_threading()
        second = configure_torch_threading()
        assert (first.threads, first.interop_threads) == (second.threads, second.interop_threads)

    def test_it_never_raises_when_torch_cannot_be_reconfigured(
        self, clean_thread_env, monkeypatch
    ) -> None:
        # `torch.set_num_interop_threads` raises once parallel work has started.
        # A boot-path helper that let that escape would turn a tuning miss into
        # a failed service start.
        import torch

        def _boom(_: int) -> None:
            raise RuntimeError("cannot set number of interop threads after parallel work started")

        monkeypatch.setattr(torch, "set_num_interop_threads", _boom)
        plan = configure_torch_threading()
        assert plan.threads >= 1


class TestPlacement:
    """The load-bearing half: does the hook actually precede the torch import?"""

    def test_importing_only_the_package_configures_torch(self) -> None:
        result = _probe(NLP_TORCH_NUM_THREADS="3", OMP_NUM_THREADS="", MKL_NUM_THREADS="")
        assert result["threads"] == 3
        assert result["interop"] == 1
        assert result["omp"] == "3"
        assert result["mkl"] == "3"
        assert result["torch_imported_by_package"] is True

    def test_an_operator_override_survives_the_package_import(self) -> None:
        result = _probe(NLP_TORCH_NUM_THREADS="7", OMP_NUM_THREADS="2", MKL_NUM_THREADS="")
        assert result["threads"] == 2
        assert result["omp"] == "2"

    def test_the_package_init_calls_the_hook_at_module_scope(self) -> None:
        # Guards the placement against a future refactor that moves the call
        # into a function nobody invokes on the container's entry path.
        source = (SERVICE_DIR / "src" / "nlp" / "__init__.py").read_text(encoding="utf-8")
        assert "configure_torch_threading()" in source

    def test_the_container_entrypoint_still_goes_through_the_package(self) -> None:
        # `python -m uvicorn --factory nlp.app:get_app` imports the `nlp`
        # package before `nlp.app`, which is the whole reason `__init__.py` is
        # a sound hook. If the ENTRYPOINT ever stops naming an `nlp.*` module,
        # this assumption dies with it.
        dockerfile = (SERVICE_DIR / "Dockerfile").read_text(encoding="utf-8")
        assert "nlp.app:get_app" in dockerfile
