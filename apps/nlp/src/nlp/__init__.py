"""Medical Entity Recognition & NLP service (`apps/nlp`, port 8864).

The first statement this package executes sizes PyTorch's CPU thread pools from
the container's CFS quota. That is not a stylistic choice about where startup
code lives — `OMP_NUM_THREADS` is read by the OpenMP runtime at the moment torch
is IMPORTED, and this package's `__init__` is the only module Python guarantees
to run before any `nlp.*` submodule on BOTH entry paths: the image's
`python -m uvicorn --factory nlp.app:get_app`, and `nlp.main:main`'s worker
children. Every torch import in this service is inside an `nlp.*` module, so
nothing can beat it to the runtime.

Rationale, measurements and the placement proof: `nlp/torch_runtime.py` and
`tests/test_torch_threading_task892.py` (TASK-892 D-1).
"""

from nlp.torch_runtime import configure_torch_threading

configure_torch_threading()
