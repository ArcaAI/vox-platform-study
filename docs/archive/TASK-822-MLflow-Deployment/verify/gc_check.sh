#!/usr/bin/env bash
# TASK-822 — S-7: prove `mlflow gc` is a REAL hard-delete of run + artifacts,
# and prove the documented trap: without MLFLOW_TRACKING_URI, gc silently
# leaves the artifacts behind while still reporting success.
set -euo pipefail

IMAGE='ghcr.io/mlflow/mlflow:v3.15.2-full@sha256:2c9c50ca72e314cb1b8b301ceaa43882629ad91873d7271f3be92796930c3647'
BSU='postgresql://postgres:verify_only_not_a_secret@postgres:5432/mlflow'
MC='minio/mc:RELEASE.2025-04-16T18-13-26Z'

# NOTE `--entrypoint /bin/sh`: the mc image's entrypoint IS `mc`, so a bare
# `/bin/sh -c ...` is parsed as mc arguments and fails with
# "`/bin/sh` is not a recognized command".
mc_ls() {
    docker run --rm --network mlflow-verify --entrypoint /bin/sh "$MC" -c \
        "mc alias set local http://minio:9000 verifyminio verify_only_not_a_secret >/dev/null && mc ls --recursive local/mlflow 2>/dev/null | wc -l"
}

echo "--- create a run with an artifact, then soft-delete it ---"
RUN_ID=$(docker run --rm --network mlflow-verify \
    -e MLFLOW_TRACKING_URI=http://mlflow:5000 -e HOME=/tmp \
    --entrypoint python3 "$IMAGE" -c '
import mlflow, pathlib
mlflow.set_experiment("task-822-gc-check")
with mlflow.start_run() as r:
    p = pathlib.Path("/tmp/gc-victim.txt"); p.write_text("delete me" * 200)
    mlflow.log_artifact(str(p))
    rid = r.info.run_id
mlflow.MlflowClient().delete_run(rid)   # soft delete -> lifecycle_stage=deleted
print(rid)
' | tail -1)
echo "run_id = $RUN_ID"

BEFORE=$(mc_ls)
echo "objects in bucket BEFORE gc: $BEFORE"

echo
echo "--- 6a. THE TRAP: gc WITHOUT MLFLOW_TRACKING_URI (proxied artifacts unresolvable) ---"
docker run --rm --network mlflow-verify --entrypoint mlflow "$IMAGE" \
    gc --backend-store-uri "$BSU" --run-ids "$RUN_ID" 2>&1 | tail -5 || echo "(gc exited non-zero)"
AFTER_TRAP=$(mc_ls)
echo "objects in bucket AFTER credential-less gc: $AFTER_TRAP"
if [ "$AFTER_TRAP" -eq "$BEFORE" ]; then
    echo ">> CONFIRMED: nothing was deleted. In 3.15.2 this is a LOUD failure —"
    echo ">> MlflowException 'Tracking URL is not set' and a non-zero exit, better"
    echo ">> than the docs' 'deletion will be bypassed ... gc will continue'."
    echo ">> Consequence for the CronJob: MLFLOW_TRACKING_URI is MANDATORY, and a"
    echo ">> CronJob missing it fails every run rather than half-deleting. Keep the"
    echo ">> failed-job history (>0) so that failure is visible."
else
    echo ">> Artifacts were removed even without the tracking URI (differs from the docs)."
fi

echo
echo "--- 6b. gc WITH MLFLOW_TRACKING_URI (the shipped CronJob configuration) ---"
docker run --rm --network mlflow-verify \
    -e MLFLOW_TRACKING_URI=http://mlflow:5000 -e HOME=/tmp \
    --entrypoint mlflow "$IMAGE" \
    gc --backend-store-uri "$BSU" --run-ids "$RUN_ID" 2>&1 | tail -5
AFTER=$(mc_ls)
echo "objects in bucket AFTER correct gc: $AFTER"

echo
echo "--- run row gone from the backend store? ---"
docker exec mlflow-verify-postgres psql -U postgres -d mlflow -tAc \
    "SELECT count(*) FROM runs WHERE run_uuid = '$RUN_ID'"
echo "(0 = hard-deleted)"

echo
echo "--- 6c. P-13: erasure is REAL, not a delete marker ---"
# With bucket versioning ON, `mc ls` would show the object gone while the bytes
# survive as a non-current version. Listing --versions is the only way to tell
# the difference, so the erasure claim is checked the way it can actually fail.
#
# The filtering happens on the HOST, not in the mc container: that image has no
# `grep`, so an in-container `... | grep X || echo "clean"` always takes the
# `||` branch and passes vacuously.
docker run --rm --network mlflow-verify --entrypoint /bin/sh "$MC" -c \
    "mc alias set local http://minio:9000 verifyminio verify_only_not_a_secret >/dev/null; mc version info local/mlflow"
ALL_VERSIONS=$(docker run --rm --network mlflow-verify --entrypoint /bin/sh "$MC" -c \
    "mc alias set local http://minio:9000 verifyminio verify_only_not_a_secret >/dev/null; mc ls --recursive --versions local/mlflow 2>/dev/null")
echo "all object versions still in the bucket:"
echo "${ALL_VERSIONS:-  (bucket empty)}" | sed 's/^/    /'
if printf '%s' "$ALL_VERSIONS" | grep -q "$RUN_ID"; then
    echo ">> FAIL: versions of the gc-ed run survive — erasure was a delete marker."
    exit 1
fi
echo ">> PASS: no version of $RUN_ID remains. Erasure is real."
