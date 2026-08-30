#!/usr/bin/env python3
"""TASK-822 — CI guard for the R-1/R-2 invariant.

WHAT IT PROTECTS
----------------
MLflow runs in PROXIED artifact mode (R-1), so it can only ever hand a client an
HTTP URL through the tracking server — verified: `resolve_uri` rewrites every
artifact URI onto `<tracking-uri>/api/2.0/mlflow-artifacts/artifacts/...`, and no
REST payload exposes the underlying bucket.

vLLM's `runai_streamer` needs a real `s3://` URI. The two are compatible ONLY
because R-2 keeps served weights in the plain `hope-models` bucket that MLflow
merely REFERENCES via the `weights_uri` model-version tag.

If someone later "simplifies" by logging weights as MLflow artifacts, the tag
becomes an `mlflow-artifacts:/` URI, and **vLLM breaks with no error at the
MLflow layer** — the registry looks perfectly healthy. This guard is the only
thing that turns that silent break into a red pipeline.

It checks the REGISTRY (this ticket's surface), not the resolver — the
`AiModelSource.MLFLOW` resolver is TASK-818 Lane F's territory and does not exist
yet. Wire that side in when it lands.

USAGE
-----
    MLFLOW_TRACKING_URI=http://hope-mlflow:5000 ./check_weights_uri.py
    ./check_weights_uri.py --self-test      # no server needed
"""

from __future__ import annotations

import os
import sys

REQUIRED_TAGS = ("weights_uri", "weights_sha256", "format")


def check_version(name: str, version: str, tags: dict[str, str]) -> list[str]:
    """Return a list of problems for one model version. Empty list == OK."""
    where = f"{name} v{version}"
    problems: list[str] = []

    missing = [t for t in REQUIRED_TAGS if not tags.get(t)]
    if missing:
        problems.append(f"{where}: missing required tag(s): {', '.join(missing)}")

    uri = tags.get("weights_uri")
    if uri and not uri.startswith("s3://"):
        hint = ""
        if uri.startswith(("mlflow-artifacts:", "runs:/", "models:/")):
            hint = (
                "  -> weights were logged INTO MLflow's artifact store. vLLM cannot read this; "
                "in proxied mode the s3:// path is unreachable. Upload the weights to "
                "s3://hope-models/... and tag that URI instead (R-2)."
            )
        problems.append(f"{where}: weights_uri does not start with s3:// (got {uri!r}).{hint}")

    sha = tags.get("weights_sha256")
    if sha and (len(sha) != 64 or not all(c in "0123456789abcdef" for c in sha.lower())):
        problems.append(f"{where}: weights_sha256 is not a 64-char hex digest (got {sha!r})")

    return problems


def _self_test() -> int:
    cases = [
        # (label, tags, expect_ok)
        ("valid", {"weights_uri": "s3://hope-models/acme/m/1/" + "a" * 64,
                   "weights_sha256": "a" * 64, "format": "safetensors-awq"}, True),
        ("mlflow-artifacts uri", {"weights_uri": "mlflow-artifacts:/1/abc/artifacts/model",
                                  "weights_sha256": "b" * 64, "format": "gguf-q4_k_m"}, False),
        ("models:/ alias uri", {"weights_uri": "models:/clinical-summariser-awq@champion",
                                "weights_sha256": "c" * 64, "format": "safetensors-awq"}, False),
        ("missing weights_uri", {"weights_sha256": "d" * 64, "format": "gguf-q4_k_m"}, False),
        ("missing checksum", {"weights_uri": "s3://hope-models/x", "format": "gguf-q4_k_m"}, False),
        ("bad checksum", {"weights_uri": "s3://hope-models/x", "weights_sha256": "nope",
                          "format": "gguf-q4_k_m"}, False),
        ("local path", {"weights_uri": "/mnt/models/m", "weights_sha256": "e" * 64,
                        "format": "gguf-q4_k_m"}, False),
    ]
    failures = 0
    for label, tags, expect_ok in cases:
        problems = check_version("m", "1", tags)
        got_ok = not problems
        status = "PASS" if got_ok == expect_ok else "FAIL"
        if status == "FAIL":
            failures += 1
        print(f"  [{status}] {label}: expected {'ok' if expect_ok else 'rejected'}, "
              f"got {'ok' if got_ok else 'rejected'}")
        for p in problems:
            print(f"           {p}")
    print(f"self-test: {len(cases) - failures}/{len(cases)} cases passed")
    return 1 if failures else 0


def main() -> int:
    if "--self-test" in sys.argv:
        return _self_test()

    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI")
    if not tracking_uri:
        print("MLFLOW_TRACKING_URI is required (or pass --self-test)", file=sys.stderr)
        return 2

    from mlflow.tracking import MlflowClient

    client = MlflowClient(tracking_uri=tracking_uri)
    problems: list[str] = []
    checked = 0
    for rm in client.search_registered_models():
        for mv in client.search_model_versions(f"name='{rm.name}'"):
            checked += 1
            problems.extend(check_version(rm.name, mv.version, dict(mv.tags or {})))

    if problems:
        print(f"✗ {len(problems)} problem(s) across {checked} model version(s):")
        for p in problems:
            print(f"    {p}")
        return 1
    print(f"✓ {checked} model version(s) satisfy the R-1/R-2 invariant")
    return 0


if __name__ == "__main__":
    sys.exit(main())
