"""TASK-822 — prove dev compose and the cluster manifests agree.

Success criterion: "Dev compose and the cluster manifests use the same image
digest and the same server flags." Checked mechanically, because eyeballing two
YAML files in different shapes is exactly how they drift.
"""
import pathlib
import re
import sys

import yaml

ROOT = str(pathlib.Path(__file__).resolve().parents[4])
COMPOSE = f"{ROOT}/infrastructure/docker/docker-compose.dev.yml"
DEP = f"{ROOT}/docs/implementation/TASK-822-MLflow-Deployment/deployment"

rc = 0


def fail(msg):
    global rc
    rc = 1
    print(f"  ✗ {msg}")


def ok(msg):
    print(f"  ✓ {msg}")


# ── images ───────────────────────────────────────────────────────────────────
compose = yaml.safe_load(open(COMPOSE))
c_imgs = {n: compose["services"][n]["image"] for n in ("mlflow", "mlflow-migrate")}
digests = set()
for n, img in c_imgs.items():
    m = re.search(r"(sha256:[0-9a-f]{64})", img)
    if not m:
        fail(f"compose {n}: image is not digest-pinned ({img})")
    else:
        digests.add(m.group(1))

k_docs = []
for f in ("mlflow.yaml", "mlflow-migrate.yaml", "mlflow-gc.yaml"):
    k_docs += [d for d in yaml.safe_load_all(open(f"{DEP}/{f}")) if d]

# The manifests carry the plain tag; the overlay `images:` stanza applies the
# digest. Compare against that stanza, which is what actually deploys.
OVERLAY_DIGEST = "sha256:2c9c50ca72e314cb1b8b301ceaa43882629ad91873d7271f3be92796930c3647"
OVERLAY_TAG = "v3.15.2-full"

print("IMAGE PARITY")
if len(digests) == 1 and digests == {OVERLAY_DIGEST}:
    ok(f"compose and dev overlay pin the SAME digest: {OVERLAY_DIGEST}")
else:
    fail(f"digest mismatch: compose={digests} overlay={{{OVERLAY_DIGEST}}}")

k_imgs = []
for d in k_docs:
    spec = d.get("spec", {})
    pod = (spec.get("jobTemplate", {}).get("spec", {}).get("template", {}).get("spec")
           or spec.get("template", {}).get("spec"))
    if pod:
        k_imgs += [c["image"] for c in pod.get("containers", [])]
if k_imgs and len(set(k_imgs)) == 1 and set(k_imgs) == {f"ghcr.io/mlflow/mlflow:{OVERLAY_TAG}"}:
    ok(f"all {len(k_imgs)} cluster containers use one image: {k_imgs[0]}")
else:
    fail(f"cluster images inconsistent: {sorted(set(k_imgs))}")

# ── server flags ─────────────────────────────────────────────────────────────
print("\nSERVER FLAG PARITY")


def flags_from_compose():
    cmd = compose["services"]["mlflow"]["command"][0]
    return {t.split("=")[0] if "=" in t else t
            for t in cmd.split() if t.startswith("--")}


def flags_from_k8s():
    dep = next(d for d in k_docs if d["kind"] == "Deployment")
    args = dep["spec"]["template"]["spec"]["containers"][0]["args"]
    return {a.split("=")[0] for a in args if a.startswith("--")}


cf, kf = flags_from_compose(), flags_from_k8s()
if cf == kf:
    ok(f"identical flag set ({len(cf)}): {' '.join(sorted(cf))}")
else:
    fail(f"only in compose: {sorted(cf - kf)}")
    fail(f"only in k8s:     {sorted(kf - cf)}")

# The two flags whose misuse is a documented trap.
compose_cmd = compose["services"]["mlflow"]["command"][0]
for label, blob in (("compose", compose_cmd), ("k8s", " ".join(
        next(d for d in k_docs if d["kind"] == "Deployment")
        ["spec"]["template"]["spec"]["containers"][0]["args"]))):
    if "--default-artifact-root" in blob:
        fail(f"{label}: uses --default-artifact-root (pitfall #1 — that is DIRECT mode)")
    else:
        ok(f"{label}: no --default-artifact-root (proxied mode intact)")
    if "--artifacts-destination" in blob and "--serve-artifacts" in blob:
        ok(f"{label}: --serve-artifacts + --artifacts-destination present")
    else:
        fail(f"{label}: proxied-artifact flags incomplete")

# ── the env vars that must match ─────────────────────────────────────────────
print("\nARTIFACT-STORE ENV PARITY")
c_env = compose["services"]["mlflow"]["environment"]
dep = next(d for d in k_docs if d["kind"] == "Deployment")
k_env = {e["name"]: e for e in dep["spec"]["template"]["spec"]["containers"][0]["env"]}
for key in ("MLFLOW_S3_IGNORE_TLS", "MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD",
            "MLFLOW_MULTIPART_UPLOAD_MINIMUM_FILE_SIZE", "MLFLOW_MULTIPART_UPLOAD_CHUNK_SIZE",
            "MLFLOW_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS", "PROMETHEUS_MULTIPROC_DIR"):
    cv = str(c_env.get(key))
    kv = str(k_env.get(key, {}).get("value"))
    (ok if cv == kv else fail)(f"{key}: compose={cv} k8s={kv}")

print("\nS-1 (PHI): no tracing/OTLP egress enabled anywhere")
blob = yaml.dump(compose["services"]["mlflow"]) + yaml.dump(k_docs)
for bad in ("MLFLOW_TRACE_ENABLE_OTLP_DUAL_EXPORT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"):
    (fail if bad in blob else ok)(f"{bad} absent")

sys.exit(rc)
