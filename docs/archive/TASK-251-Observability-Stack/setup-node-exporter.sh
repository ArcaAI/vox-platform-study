#!/usr/bin/env bash
###############################################################################
# Install and configure Prometheus node_exporter on a VM.
#
# Provides CPU, memory, disk, and network metrics for Grafana dashboards.
# Run this on each VM that should be monitored (VM 200, VM 400, etc.).
#
# Usage:
#   chmod +x setup-node-exporter.sh
#   sudo ./setup-node-exporter.sh
###############################################################################

set -euo pipefail

echo "=== Installing Prometheus node_exporter ==="

if command -v node_exporter &>/dev/null || systemctl is-active --quiet prometheus-node-exporter 2>/dev/null; then
  echo "node_exporter is already installed and running."
  echo "Metrics endpoint: http://$(hostname -I | awk '{print $1}'):9100/metrics"
  exit 0
fi

if [ -f /etc/debian_version ]; then
  apt-get update -qq
  apt-get install -y -qq prometheus-node-exporter
elif [ -f /etc/redhat-release ]; then
  yum install -y node_exporter || dnf install -y golang-github-prometheus-node-exporter
else
  echo "Unsupported distro. Install node_exporter manually from:"
  echo "  https://github.com/prometheus/node_exporter/releases"
  exit 1
fi

systemctl enable --now prometheus-node-exporter

echo ""
echo "=== Verification ==="
sleep 2
if curl -sf -o /dev/null "http://localhost:9100/metrics"; then
  echo "[OK] node_exporter is running on port 9100"
  echo "Metrics endpoint: http://$(hostname -I | awk '{print $1}'):9100/metrics"
else
  echo "[FAIL] node_exporter is not responding on port 9100"
  echo "Check: systemctl status prometheus-node-exporter"
  exit 1
fi
