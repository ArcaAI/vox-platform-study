"""Worker-pool admin introspection response model (TASK-725 Tasks 3 & 6)."""

from __future__ import annotations

from pydantic import BaseModel


class WorkerPoolStatus(BaseModel):
    """Per-pool (per `task_type`) status — what a k8s liveness/readiness probe
    AND a human operator both read. KEDA/HPA manifests in the deployment repo
    may poll the underlying Prometheus metric instead of this endpoint
    directly, but this shape is kept stable for a future admin-console screen
    (out of scope here)."""

    task_type: str
    queue_depth: int
    # Task 6: true while the control plane is draining — new submissions to
    # this pool are being rejected (WorkerPoolQueue.submit raises
    # ShutdownError), but already-claimed work on a worker pod is unaffected
    # (workers are a separate process/pod — see design-notes.md §(d)).
    draining: bool
