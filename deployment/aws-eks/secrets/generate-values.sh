#!/usr/bin/env bash
# Print freshly generated values for every __GENERATE_*__ placeholder.
# Pipe into a password manager or paste into your working copy — do NOT redirect
# this into the repo.
set -euo pipefail
hex() { openssl rand -hex "$1"; }

cat <<EOF
# --- platform ---
JWT_SECRET_KEY               $(hex 32)
SESSION_SECRET_KEY           $(hex 32)
ADMIN_SESSION_SECRET         $(hex 32)
API_GATEWAY_KEY              hope_sk_$(hex 32)_$(hex 3)

# --- services ---
HARNESS_SERVICE_TOKEN          $(hex 32)
HARNESS_INTERNAL_SERVICE_TOKEN $(hex 32)
SMR_SERVICE_TOKEN              $(hex 32)
SMR_V2_SERVICE_TOKEN           $(hex 32)
GUARDRAIL_SERVICE_TOKEN        $(hex 32)
QDRANT_API_KEY                 $(hex 24)
QDRANT_READ_ONLY_API_KEY       $(hex 24)
GRAFANA_ADMIN_PASSWORD         $(openssl rand -base64 24 | tr -d '=+/' | cut -c1-32)
EOF
