#!/usr/bin/env bash
###############################################################################
# HOPE Observability Stack — Deployment Script
#
# Run this ON VM 400 (10.10.1.100) to deploy the full observability stack.
#
# Prerequisites:
#   - Docker and Docker Compose installed
#   - This repo cloned or files copied to /opt/observability/
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
###############################################################################

set -euo pipefail

DEPLOY_DIR="/opt/observability"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== HOPE Observability Stack Deployment ==="
echo "Target: ${DEPLOY_DIR}"
echo ""

# Step 1: Create directory structure
echo "[1/7] Creating directory structure..."
sudo mkdir -p "${DEPLOY_DIR}"/{configs,data}
sudo mkdir -p "${DEPLOY_DIR}/configs"/{otel,prometheus,loki,tempo,grafana}
sudo mkdir -p "${DEPLOY_DIR}/configs/grafana"/{provisioning/datasources,provisioning/dashboards,provisioning/alerting,dashboards}
sudo mkdir -p "${DEPLOY_DIR}/data"/{prometheus,loki,tempo,grafana}
sudo chown -R "$(whoami):$(whoami)" "${DEPLOY_DIR}"

# Step 2: Copy configuration files
echo "[2/7] Copying configuration files..."
cp "${SCRIPT_DIR}/configs/otel/otel-collector-config.yaml" "${DEPLOY_DIR}/configs/otel/"
cp "${SCRIPT_DIR}/configs/prometheus/prometheus.yml" "${DEPLOY_DIR}/configs/prometheus/"
cp "${SCRIPT_DIR}/configs/loki/loki-config.yaml" "${DEPLOY_DIR}/configs/loki/"
cp "${SCRIPT_DIR}/configs/tempo/tempo-config.yaml" "${DEPLOY_DIR}/configs/tempo/"
cp "${SCRIPT_DIR}/configs/grafana/grafana.ini" "${DEPLOY_DIR}/configs/grafana/"
cp -r "${SCRIPT_DIR}/configs/grafana/provisioning/"* "${DEPLOY_DIR}/configs/grafana/provisioning/"
cp "${SCRIPT_DIR}/configs/grafana/dashboards/"*.json "${DEPLOY_DIR}/configs/grafana/dashboards/" 2>/dev/null || echo "  (no dashboard JSONs yet — build in Grafana UI and export)"
cp "${SCRIPT_DIR}/docker-compose.observability.yml" "${DEPLOY_DIR}/"

# Step 3: Set up environment
echo "[3/7] Setting up environment..."
if [ ! -f "${DEPLOY_DIR}/.env" ]; then
  cp "${SCRIPT_DIR}/.env.example" "${DEPLOY_DIR}/.env"
  echo "  IMPORTANT: Edit ${DEPLOY_DIR}/.env and set GRAFANA_ADMIN_PASSWORD"
  echo "  Run: nano ${DEPLOY_DIR}/.env"
fi

# Step 4: Pull Docker images
echo "[4/7] Pulling Docker images..."
cd "${DEPLOY_DIR}"
docker compose -f docker-compose.observability.yml pull

# Step 5: Deploy
echo "[5/7] Starting containers..."
docker compose -f docker-compose.observability.yml up -d

# Step 6: Wait for health checks
echo "[6/7] Waiting for containers to become healthy..."
MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  HEALTHY=$(docker compose -f docker-compose.observability.yml ps --format json 2>/dev/null | grep -c '"healthy"' || true)
  TOTAL=5
  echo "  Healthy: ${HEALTHY}/${TOTAL} (${ELAPSED}s elapsed)"
  if [ "$HEALTHY" -ge "$TOTAL" ]; then
    break
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

# Step 7: Verify
echo "[7/7] Verifying services..."
echo ""

verify() {
  local name=$1 url=$2
  if curl -sf -o /dev/null "${url}"; then
    echo "  [OK] ${name}"
  else
    echo "  [FAIL] ${name} — ${url}"
  fi
}

verify "Prometheus" "http://localhost:9090/-/healthy"
verify "Loki" "http://localhost:3100/ready"
verify "Tempo" "http://localhost:3200/ready"
verify "OTel Collector" "http://localhost:13133/"
verify "Grafana" "http://localhost:3000/api/health"

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Next steps:"
echo "  1. Set GRAFANA_ADMIN_PASSWORD in ${DEPLOY_DIR}/.env (if not done)"
echo "  2. Access Grafana at http://10.10.1.100:3000"
echo "  3. Configure services on VM 200 to point OTLP endpoint to http://10.10.1.100:4317"
echo "  4. Verify Prometheus targets at http://10.10.1.100:9090/targets"
