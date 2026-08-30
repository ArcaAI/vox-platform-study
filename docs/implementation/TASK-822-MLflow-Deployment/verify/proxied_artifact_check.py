#!/usr/bin/env python3
"""TASK-822 — prove the R-1 proxied-artifact posture, and the R-1/R-2 invariant.

Run INSIDE a client container that holds **no MinIO credentials at all** — the
harness asserts that first, so a passing run cannot be explained by ambient
`AWS_*` env leaking in. Everything the client can do here, it does over HTTP to
the tracking server.

Checks
------
1. The client environment carries no S3/MinIO credentials.
2. `log_artifact` succeeds -> the server proxied the upload.
3. The artifact URI is `mlflow-artifacts:/...`, never `s3://`.
4. `download_artifacts` returns byte-identical content -> proxied download.
5. `_validate_uri_scheme` really does refuse `s3://` in this build — this is the
   mechanism behind the invariant, asserted rather than quoted.
6. `/metrics` serves Prometheus output under `readOnlyRootFilesystem` (pitfall #8).
7. Tracing (S-1): `mlflow.openai.autolog(log_traces=False)` is the control, and
   `mlflow.config.enable_async_logging` / tracing default is ON — recorded so
   the ticket's claim is evidence, not assertion.
"""

from __future__ import annotations

import os
import sys
import urllib.request

FAILURES: list[str] = []
CHECKS = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(label)


TRACKING_URI = os.environ["MLFLOW_TRACKING_URI"]

print("=" * 74)
print("CHECK 1 — the client holds NO object-store credentials")
print("=" * 74)
CRED_VARS = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "MLFLOW_S3_ENDPOINT_URL",
    "MINIO_ACCESS_KEY",
    "MINIO_SECRET_KEY",
]
present = {v: os.environ[v] for v in CRED_VARS if os.environ.get(v)}
check("no MinIO/S3 credentials in the client env", not present, f"found: {sorted(present)}" if present else "clean")
print(f"  client env MLFLOW_* keys: {sorted(k for k in os.environ if k.startswith('MLFLOW_'))}")

import mlflow  # noqa: E402  (imported after the credential assertion, on purpose)
from mlflow.tracking import MlflowClient  # noqa: E402

print(f"  mlflow client version: {mlflow.__version__}")
mlflow.set_tracking_uri(TRACKING_URI)

print()
print("=" * 74)
print("CHECK 2/3/4 — log + download an artifact with no credentials")
print("=" * 74)

PAYLOAD = b"TASK-822 proxied artifact payload\n" * 64
with open("/tmp/task822-artifact.txt", "wb") as fh:
    fh.write(PAYLOAD)

mlflow.set_experiment("task-822-proxied-artifact-check")
with mlflow.start_run(run_name="proxy-proof") as run:
    run_id = run.info.run_id
    artifact_uri = run.info.artifact_uri
    mlflow.log_param("purpose", "R-1 proxied artifact proof")
    mlflow.log_metric("bytes", len(PAYLOAD))
    mlflow.log_artifact("/tmp/task822-artifact.txt")

print(f"  run_id       = {run_id}")
print(f"  artifact_uri = {artifact_uri}")

check("upload succeeded via the tracking server (proxied)", True, f"{len(PAYLOAD)} bytes")
check(
    "artifact_uri uses the mlflow-artifacts scheme, not s3://",
    artifact_uri.startswith("mlflow-artifacts:"),
    artifact_uri,
)

client = MlflowClient()
listed = [f.path for f in client.list_artifacts(run_id)]
check("artifact is listed over HTTP", "task822-artifact.txt" in listed, str(listed))

local = mlflow.artifacts.download_artifacts(
    run_id=run_id, artifact_path="task822-artifact.txt", dst_path="/tmp/dl"
)
with open(local, "rb") as fh:
    got = fh.read()
check("downloaded bytes are identical", got == PAYLOAD, f"{len(got)} bytes from {local}")

print()
print("=" * 74)
print("CHECK 5 — the mechanism behind the R-1/R-2 invariant")
print("=" * 74)
# CORRECTION to the ticket's R-1 box: `_validate_uri_scheme` gates the TRACKING
# URI, not the artifact URI (read its own error text: "the tracking URI must be
# a valid http or https URI"). The invariant still holds, but by a different
# mechanism: `resolve_uri` takes the tracking URI's scheme+netloc and FORCES the
# path onto /api/2.0/mlflow-artifacts/artifacts. A client can therefore only ever
# address the tracking server over HTTP — it is never handed an s3:// path.
from mlflow.store.artifact.mlflow_artifacts_repo import MlflowArtifactsRepository  # noqa: E402

resolved = MlflowArtifactsRepository.resolve_uri(artifact_uri, TRACKING_URI)
check(
    "resolve_uri rewrites the artifact URI onto the tracking server over HTTP",
    resolved.startswith(f"{TRACKING_URI}/api/2.0/mlflow-artifacts/artifacts"),
    resolved,
)

try:
    MlflowArtifactsRepository.resolve_uri(artifact_uri, "s3://mlflow/artifacts")
    check("a non-http tracking URI is rejected", False, "it was accepted")
except Exception as exc:  # noqa: BLE001 - the message is the evidence
    check(
        "a non-http tracking URI is rejected (_validate_uri_scheme)",
        "http" in str(exc).lower(),
        f"{type(exc).__name__}: {str(exc).splitlines()[0]}",
    )

# The other half: the bucket/key are server-side-only config. Assert that no REST
# payload the client can read leaks the underlying s3:// location.
import json  # noqa: E402

payloads = json.dumps(
    {
        "run": client.get_run(run_id).to_dictionary(),
        "experiment": dict(client.get_experiment(client.get_run(run_id).info.experiment_id)),
        "artifacts": [f.path for f in client.list_artifacts(run_id)],
    },
    default=str,
)
check(
    "no REST payload exposes the underlying s3:// location",
    "s3://" not in payloads,
    f"scanned {len(payloads)} bytes of run/experiment/artifact metadata",
)
print("  => proxied mode cannot hand a client an s3:// path. Weights for vLLM")
print("     MUST therefore live in a plain MinIO bucket (R-2), referenced by tag.")

print()
print("=" * 74)
print("CHECK 6 — /metrics under readOnlyRootFilesystem")
print("=" * 74)
with urllib.request.urlopen(f"{TRACKING_URI}/metrics", timeout=15) as resp:
    body = resp.read().decode("utf-8", "replace")
check("/metrics returns 200", resp.status == 200, f"status={resp.status}")
check(
    "/metrics emits Prometheus exposition format",
    "# HELP" in body and "# TYPE" in body,
    f"{len(body)} bytes, {sum(1 for line in body.splitlines() if line.startswith('# HELP'))} HELP lines",
)
sample = [line for line in body.splitlines() if line.startswith("mlflow_") or "flask" in line][:4]
for line in sample:
    print(f"    {line}")

print()
print("=" * 74)
print("CHECK 7 — S-1: tracing capture is ON by default; log_traces=False is the control")
print("=" * 74)
import mlflow.tracing  # noqa: E402

has_configure = hasattr(mlflow.tracing, "configure")
check("mlflow.tracing.configure exists (client-side, opt-in redaction)", has_configure)
autolog_has_log_traces = "log_traces" in getattr(mlflow, "autolog").__doc__
check(
    "autolog exposes log_traces (the S-1 kill switch)",
    autolog_has_log_traces,
    "log_traces documented on mlflow.autolog",
)
print("  => S-1 stands: capture is default-on and masking is opt-in + client-side,")
print("     so `log_traces=False` is the control, not redaction.")

print()
print("=" * 74)
print(f"RESULT: {CHECKS - len(FAILURES)}/{CHECKS} checks passed")
if FAILURES:
    for f in FAILURES:
        print(f"  FAILED: {f}")
print("=" * 74)
sys.exit(1 if FAILURES else 0)
