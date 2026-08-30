#!/usr/bin/env bash
# TASK-822 — run the throwaway MLflow verification rig end to end.
#
# Isolated by construction: compose project `hope-mlflow-verify`, its own
# network and volumes, ports 55432/59000/59001/55000. It never touches the
# shared `hope-infra` / `hope-infra-dev` projects.
#
#   ./run-verification.sh          # up, verify, leave running
#   ./run-verification.sh --down   # tear down and delete volumes
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -p hope-mlflow-verify -f "$HERE/docker-compose.verify.yml")
IMAGE='ghcr.io/mlflow/mlflow:v3.15.2-full@sha256:2c9c50ca72e314cb1b8b301ceaa43882629ad91873d7271f3be92796930c3647'

if [[ "${1:-}" == "--down" ]]; then
    "${COMPOSE[@]}" down -v --remove-orphans
    exit 0
fi

banner() { printf '\n############ %s ############\n' "$1"; }

banner "0. tear down any previous rig"
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true

banner "1. bring the rig up (migrate gates the server)"
"${COMPOSE[@]}" up -d --wait --wait-timeout 300

banner "2. EVIDENCE: mlflow db upgrade against PostgreSQL 18"
docker exec mlflow-verify-postgres psql -U postgres -d mlflow -tAc 'SELECT version()'
echo "--- mlflow-migrate container log ---"
"${COMPOSE[@]}" logs --no-log-prefix mlflow-migrate
echo "--- migrate exit code ---"
docker inspect mlflow-verify-migrate --format '{{.State.ExitCode}}'
echo "--- alembic ledger in the mlflow database ---"
docker exec mlflow-verify-postgres psql -U postgres -d mlflow -c '\dt' | head -30
docker exec mlflow-verify-postgres psql -U postgres -d mlflow -tAc 'SELECT version_num FROM alembic_version'

banner "3. EVIDENCE: the mlflow tables are NOT in the Prisma database"
docker exec mlflow-verify-postgres psql -U postgres -d postgres -tAc \
    "SELECT count(*) AS mlflow_tables_in_default_db FROM information_schema.tables WHERE table_name IN ('experiments','runs','registered_models')"

banner "4. EVIDENCE: proxied artifacts from a credential-free client"
# --env-file is deliberately absent and no AWS_* is passed: the client container
# gets ONLY a tracking URI.
docker run --rm --network mlflow-verify \
    -e MLFLOW_TRACKING_URI=http://mlflow:5000 \
    -e HOME=/tmp \
    -v "$HERE/proxied_artifact_check.py:/tmp/check.py:ro" \
    --entrypoint python3 "$IMAGE" /tmp/check.py

banner "5. EVIDENCE: the artifact really landed in MinIO, server-side"
# `--entrypoint /bin/sh` is required: the mc image's entrypoint IS `mc`.
docker run --rm --network mlflow-verify --entrypoint /bin/sh minio/mc:RELEASE.2025-04-16T18-13-26Z \
    -c "mc alias set local http://minio:9000 verifyminio verify_only_not_a_secret >/dev/null && mc ls --recursive local/mlflow"

banner "6. EVIDENCE: mlflow gc hard-deletes a soft-deleted run AND its artifacts (S-7)"
"$HERE/gc_check.sh"

banner "DONE — tear the rig down with: $0 --down"
