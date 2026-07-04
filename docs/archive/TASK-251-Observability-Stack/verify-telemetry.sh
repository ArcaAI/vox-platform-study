#!/usr/bin/env bash
###############################################################################
# HOPE Observability Stack — Telemetry Verification Script
#
# Run this on VM 400 (10.10.1.100) after deploying the stack and configuring
# services on VM 200.
#
# Checks: Prometheus targets, Loki log ingestion, Tempo traces, OTel Collector.
#
# Usage:
#   chmod +x verify-telemetry.sh
#   ./verify-telemetry.sh
###############################################################################

set -euo pipefail

PROM_URL="http://localhost:9090"
LOKI_URL="http://localhost:3100"
TEMPO_URL="http://localhost:3200"
OTEL_URL="http://localhost:13133"
GRAFANA_URL="http://localhost:3000"

PASS=0
FAIL=0
WARN=0

check() {
  local name=$1 result=$2
  if [ "$result" = "ok" ]; then
    echo "  [PASS] $name"
    PASS=$((PASS + 1))
  elif [ "$result" = "warn" ]; then
    echo "  [WARN] $name"
    WARN=$((WARN + 1))
  else
    echo "  [FAIL] $name"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== HOPE Observability — Telemetry Verification ==="
echo ""

# --- Stack Health ---
echo "--- Stack Health ---"

curl -sf "${PROM_URL}/-/healthy" > /dev/null && check "Prometheus healthy" "ok" || check "Prometheus healthy" "fail"
curl -sf "${LOKI_URL}/ready" > /dev/null && check "Loki ready" "ok" || check "Loki ready" "fail"
curl -sf "${TEMPO_URL}/ready" > /dev/null && check "Tempo ready" "ok" || check "Tempo ready" "fail"
curl -sf "${OTEL_URL}/" > /dev/null && check "OTel Collector healthy" "ok" || check "OTel Collector healthy" "fail"
curl -sf "${GRAFANA_URL}/api/health" > /dev/null && check "Grafana healthy" "ok" || check "Grafana healthy" "fail"

echo ""

# --- Prometheus Targets ---
echo "--- Prometheus Scrape Targets ---"

TARGETS_JSON=$(curl -sf "${PROM_URL}/api/v1/targets" 2>/dev/null || echo '{}')

for JOB in "api-gateway" "stt-v2" "smr" "nlp" "node-exporter"; do
  HEALTH=$(echo "$TARGETS_JSON" | python3 -c "
import json, sys
try:
  data = json.load(sys.stdin)
  targets = data.get('data', {}).get('activeTargets', [])
  for t in targets:
    if t.get('labels', {}).get('job') == '${JOB}':
      print(t.get('health', 'unknown'))
      sys.exit(0)
  print('not_found')
except: print('error')
" 2>/dev/null)

  if [ "$HEALTH" = "up" ]; then
    check "Prometheus target: ${JOB}" "ok"
  elif [ "$HEALTH" = "not_found" ]; then
    check "Prometheus target: ${JOB} (not configured)" "warn"
  else
    check "Prometheus target: ${JOB} (${HEALTH})" "fail"
  fi
done

echo ""

# --- Loki Log Ingestion ---
echo "--- Loki Log Ingestion ---"

for SERVICE in "api-gateway" "stt-v2" "smr-v2" "hope-nlp"; do
  COUNT=$(curl -sf "${LOKI_URL}/loki/api/v1/query" \
    --data-urlencode "query=count_over_time({service_name=\"${SERVICE}\"}[1h])" \
    2>/dev/null | python3 -c "
import json, sys
try:
  data = json.load(sys.stdin)
  results = data.get('data', {}).get('result', [])
  total = sum(int(r.get('value', [0, '0'])[1]) for r in results)
  print(total)
except: print(0)
" 2>/dev/null)

  if [ "${COUNT:-0}" -gt 0 ]; then
    check "Loki logs: ${SERVICE} (${COUNT} entries in last 1h)" "ok"
  else
    check "Loki logs: ${SERVICE} (no entries in last 1h)" "warn"
  fi
done

echo ""

# --- Tempo Traces ---
echo "--- Tempo Trace Ingestion ---"

for SERVICE in "api-gateway" "stt-v2" "smr-v2" "hope-nlp"; do
  TRACE_RESULT=$(curl -sf "${TEMPO_URL}/api/search?q=resource.service.name%3D${SERVICE}&limit=1" 2>/dev/null || echo '{}')
  TRACE_COUNT=$(echo "$TRACE_RESULT" | python3 -c "
import json, sys
try:
  data = json.load(sys.stdin)
  traces = data.get('traces', [])
  print(len(traces))
except: print(0)
" 2>/dev/null)

  if [ "${TRACE_COUNT:-0}" -gt 0 ]; then
    check "Tempo traces: ${SERVICE}" "ok"
  else
    check "Tempo traces: ${SERVICE} (none found)" "warn"
  fi
done

echo ""

# --- Summary ---
echo "=== Summary ==="
echo "  Passed: ${PASS}"
echo "  Warnings: ${WARN}"
echo "  Failed: ${FAIL}"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Some checks failed. Troubleshooting:"
  echo "  - Stack health fails: docker compose -f docker-compose.observability.yml logs"
  echo "  - Prometheus target down: check service is running and port is reachable from VM 400"
  echo "  - No Loki logs: check service OTEL_EXPORTER_OTLP_ENDPOINT points to 10.10.1.100:4317"
  echo "  - No Tempo traces: check service has OTEL_ENABLED=true / OTEL_TRACES_ENABLED=true"
  exit 1
fi
