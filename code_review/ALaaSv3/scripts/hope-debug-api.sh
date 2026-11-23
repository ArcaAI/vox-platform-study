#!/usr/bin/env bash
set -euo pipefail

# hope-debug-api.sh
# DEV-ONLY helper: generate HOPE auth token(s) and call HOPE API Gateway endpoints for debugging.
# Reads local dev env/credentials when available. Do NOT commit this script's output containing secrets.
#
# Examples:
#   ./hope-debug-api.sh login
#   ./hope-debug-api.sh service-token
#   ./hope-debug-api.sh curl --jwt "$(cat /tmp/jwt)" GET /api/v1/health
#   ./hope-debug-api.sh open-consultation --jwt "$JWT"
#   ./hope-debug-api.sh call --mode login --method GET --path /api/v1/consultations/<id>
#
# Prereqs: curl, jq (recommended), HOPE API running on localhost:8868 for API calls.

HOPE_BASE_URL="${HOPE_BASE_URL:-http://localhost:8868}"
ALAAS_ENV_FILE="${ALAAS_ENV_FILE:-/Users/apple/repos/VOX/ALaaSv3.0/apps/audio-stream-svc/.env}"
PROJECT_HOPE_ENV_FILE="${PROJECT_HOPE_ENV_FILE:-/Users/apple/repos/VOX/project-hope/.env.dev}"

usage() {
  cat <<'EOF'
Usage:
  hope-debug-api.sh login [--username U] [--password P] [--tenant-key K]
  hope-debug-api.sh service-token [--client-id ID] [--client-secret S] [--working-tenant-id T]
  hope-debug-api.sh open-consultation (--jwt JWT | --service-token ST) [--patient-id PID] [--department-id DID] [--clinician-user-id UID] [--context-json JSON]
  hope-debug-api.sh stream-session (--jwt JWT | --service-token ST) --consultation-id CID [--language-mode MODE]
  hope-debug-api.sh call (--mode login|service-token|jwt|service-token-raw)
                     [--username U --password P --tenant-key K]
                     [--client-id ID --client-secret S --working-tenant-id T]
                     [--jwt JWT] [--service-token ST]
                     --method METHOD --path /api/v1/... [--data JSON] [--if-match VERSION]

Notes:
  - DEV ONLY. Prints tokens/responses; do not share/commit.
  - Default login creds (local seed): super_admin / password123 (no tenantKey needed for global super_admin).
  - Service token creds default from ALaaS .env: HOPE_SVC_CLIENT_ID/SECRET/WORKING_TENANT_ID.
  - 'call --mode login' logs in, then performs the API call with Authorization: Bearer <jwt>.
  - 'call --mode service-token' exchanges service token, then performs call with X-Service-Account-Token.
  - Paths should be API paths like /api/v1/consultations/open or full URL not required (base is HOPE_BASE_URL).
EOF
}

have_jq() { command -v jq >/dev/null 2>&1; }

read_env_var() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 1
  grep -E "^${key}=" "$file" | head -1 | cut -d= -f2-
}

json_pretty_or_cat() {
  if have_jq; then jq . 2>/dev/null || cat; else cat; fi
}

auth_header_args() {
  local mode="$1" value="$2"
  case "$mode" in
    jwt) printf '%s\n' "-H" "Authorization: Bearer ${value}" ;;
    service) printf '%s\n' "-H" "X-Service-Account-Token: ${value}" ;;
    *) echo "Unknown auth mode: $mode" >&2; return 2 ;;
  esac
}

cmd_login() {
  local username="${USERNAME:-super_admin}" password="${PASSWORD:-password123}" tenant_key="${TENANT_KEY:-}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --username) username="$2"; shift 2;;
      --password) password="$2"; shift 2;;
      --tenant-key) tenant_key="$2"; shift 2;;
      -h|--help) usage; exit 0;;
      *) echo "Unknown arg: $1" >&2; usage; exit 2;;
    esac
  done
  local body
  if [[ -n "$tenant_key" ]]; then
    body=$(printf '{"username":"%s","password":"%s","tenantKey":"%s"}' "$username" "$password" "$tenant_key")
  else
    body=$(printf '{"username":"%s","password":"%s"}' "$username" "$password")
  fi
  echo "# POST ${HOPE_BASE_URL}/api/v1/auth/login" >&2
  local resp
  resp=$(curl -sS -X POST "${HOPE_BASE_URL}/api/v1/auth/login" -H 'Content-Type: application/json' -d "$body")
  echo "$resp" | json_pretty_or_cat
  if have_jq; then
    local token
    token=$(echo "$resp" | jq -r '.token // empty')
    if [[ -n "$token" ]]; then
      echo >&2
      echo "JWT_TOKEN=$token" >&2
    fi
  fi
}

cmd_service_token() {
  local client_id="${CLIENT_ID:-}" client_secret="${CLIENT_SECRET:-}" working_tenant_id="${WORKING_TENANT_ID:-}"
  client_id="${client_id:-$(read_env_var "$ALAAS_ENV_FILE" HOPE_SVC_CLIENT_ID || true)}"
  client_secret="${client_secret:-$(read_env_var "$ALAAS_ENV_FILE" HOPE_SVC_CLIENT_SECRET || true)}"
  working_tenant_id="${working_tenant_id:-$(read_env_var "$ALAAS_ENV_FILE" HOPE_WORKING_TENANT_ID || true)}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --client-id) client_id="$2"; shift 2;;
      --client-secret) client_secret="$2"; shift 2;;
      --working-tenant-id) working_tenant_id="$2"; shift 2;;
      -h|--help) usage; exit 0;;
      *) echo "Unknown arg: $1" >&2; usage; exit 2;;
    esac
  done
  if [[ -z "$client_id" || -z "$client_secret" ]]; then
    echo "Missing clientId/clientSecret. Set --client-id/--client-secret or ensure $ALAAS_ENV_FILE has HOPE_SVC_CLIENT_ID/HOPE_SVC_CLIENT_SECRET." >&2
    exit 2
  fi
  local body
  body=$(printf '{"clientId":"%s","clientSecret":"%s","workingTenantId":"%s"}' "$client_id" "$client_secret" "$working_tenant_id")
  echo "# POST ${HOPE_BASE_URL}/api/v1/auth/service-token" >&2
  local resp
  resp=$(curl -sS -X POST "${HOPE_BASE_URL}/api/v1/auth/service-token" -H 'Content-Type: application/json' -d "$body")
  echo "$resp" | json_pretty_or_cat
  if have_jq; then
    local token
    token=$(echo "$resp" | jq -r '.accessToken // empty')
    if [[ -n "$token" ]]; then
      echo >&2
      echo "SERVICE_TOKEN=$token" >&2
    fi
  fi
}

get_jwt_silent() {
  local username="$1" password="$2" tenant_key="$3"
  local body resp
  if [[ -n "$tenant_key" ]]; then
    body=$(printf '{"username":"%s","password":"%s","tenantKey":"%s"}' "$username" "$password" "$tenant_key")
  else
    body=$(printf '{"username":"%s","password":"%s"}' "$username" "$password")
  fi
  resp=$(curl -sS -X POST "${HOPE_BASE_URL}/api/v1/auth/login" -H 'Content-Type: application/json' -d "$body")
  echo "$resp" >&2
  if have_jq; then echo "$resp" | jq -r '.token // empty'; else echo "$resp" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; fi
}

get_service_token_silent() {
  local client_id="$1" client_secret="$2" working_tenant_id="$3"
  local body resp
  body=$(printf '{"clientId":"%s","clientSecret":"%s","workingTenantId":"%s"}' "$client_id" "$client_secret" "$working_tenant_id")
  resp=$(curl -sS -X POST "${HOPE_BASE_URL}/api/v1/auth/service-token" -H 'Content-Type: application/json' -d "$body")
  echo "$resp" >&2
  if have_jq; then echo "$resp" | jq -r '.accessToken // empty'; else echo "$resp" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p'; fi
}

resolve_auth() {
  local mode="$1" jwt="$2" service_token="$3" username="$4" password="$5" tenant_key="$6" client_id="$7" client_secret="$8" working_tenant_id="$9"
  case "$mode" in
    jwt)
      [[ -n "$jwt" ]] || { echo "Missing --jwt" >&2; exit 2; }
      echo "jwt|$jwt"
      ;;
    service-token-raw)
      [[ -n "$service_token" ]] || { echo "Missing --service-token" >&2; exit 2; }
      echo "service|$service_token"
      ;;
    login)
      local t; t=$(get_jwt_silent "$username" "$password" "$tenant_key")
      [[ -n "$t" ]] || { echo "Failed to obtain JWT" >&2; exit 1; }
      echo "jwt|$t"
      ;;
    service-token)
      local t; t=$(get_service_token_silent "$client_id" "$client_secret" "$working_tenant_id")
      [[ -n "$t" ]] || { echo "Failed to obtain service token" >&2; exit 1; }
      echo "service|$t"
      ;;
    *)
      echo "Invalid --mode: $mode" >&2; exit 2;;
  esac
}

cmd_call() {
  local mode="" jwt="" service_token="" username="${USERNAME:-super_admin}" password="${PASSWORD:-password123}" tenant_key="${TENANT_KEY:-}"
  local client_id="" client_secret="" working_tenant_id="" method="" path="" data="" if_match=""
  client_id="${client_id:-$(read_env_var "$ALAAS_ENV_FILE" HOPE_SVC_CLIENT_ID || true)}"
  client_secret="${client_secret:-$(read_env_var "$ALAAS_ENV_FILE" HOPE_SVC_CLIENT_SECRET || true)}"
  working_tenant_id="${working_tenant_id:-$(read_env_var "$ALAAS_ENV_FILE" HOPE_WORKING_TENANT_ID || true)}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode) mode="$2"; shift 2;;
      --jwt) jwt="$2"; shift 2;;
      --service-token) service_token="$2"; shift 2;;
      --username) username="$2"; shift 2;;
      --password) password="$2"; shift 2;;
      --tenant-key) tenant_key="$2"; shift 2;;
      --client-id) client_id="$2"; shift 2;;
      --client-secret) client_secret="$2"; shift 2;;
      --working-tenant-id) working_tenant_id="$2"; shift 2;;
      --method) method="$2"; shift 2;;
      --path) path="$2"; shift 2;;
      --data) data="$2"; shift 2;;
      --if-match) if_match="$2"; shift 2;;
      -h|--help) usage; exit 0;;
      *) echo "Unknown arg: $1" >&2; usage; exit 2;;
    esac
  done
  [[ -n "$method" && -n "$path" ]] || { echo "--method and --path are required" >&2; exit 2; }
  [[ -n "$mode" ]] || { echo "--mode is required (login|service-token|jwt|service-token-raw)" >&2; exit 2; }

  local auth_kind auth_val auth
  auth=$(resolve_auth "$mode" "$jwt" "$service_token" "$username" "$password" "$tenant_key" "$client_id" "$client_secret" "$working_tenant_id")
  auth_kind="${auth%%|*}"; auth_val="${auth#*|}"

  local url="$path"
  [[ "$url" =~ ^https?:// ]] || url="${HOPE_BASE_URL}${path}"
  local -a args=( -sS -X "$method" "$url" -H 'Accept: application/json' )
  if [[ "$auth_kind" == "jwt" ]]; then args+=( -H "Authorization: Bearer ${auth_val}" ); else args+=( -H "X-Service-Account-Token: ${auth_val}" ); fi
  if [[ -n "$data" ]]; then args+=( -H 'Content-Type: application/json' -d "$data" ); fi
  if [[ -n "$if_match" ]]; then args+=( -H "If-Match: \"${if_match}\"" ); fi

  echo "# $method $url" >&2
  curl "${args[@]}" | json_pretty_or_cat
}

cmd_open_consultation() {
  local jwt="" service_token="" patient_id="debug-patient-001" department_id="" clinician_user_id="" context_json='{}'
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --jwt) jwt="$2"; shift 2;;
      --service-token) service_token="$2"; shift 2;;
      --patient-id) patient_id="$2"; shift 2;;
      --department-id) department_id="$2"; shift 2;;
      --clinician-user-id) clinician_user_id="$2"; shift 2;;
      --context-json) context_json="$2"; shift 2;;
      -h|--help) usage; exit 0;;
      *) echo "Unknown arg: $1" >&2; usage; exit 2;;
    esac
  done
  local auth_args=()
  if [[ -n "$jwt" ]]; then auth_args=(-H "Authorization: Bearer ${jwt}");
  elif [[ -n "$service_token" ]]; then auth_args=(-H "X-Service-Account-Token: ${service_token}");
  else echo "Provide --jwt or --service-token" >&2; exit 2; fi

  local data
  if have_jq; then
    data=$(jq -nc --arg pid "$patient_id" --argjson ctx "$context_json" '{patientId:$pid, context:$ctx}')
    if [[ -n "$department_id" ]]; then data=$(echo "$data" | jq --arg d "$department_id" '. + {departmentId:$d}'); fi
    if [[ -n "$clinician_user_id" ]]; then data=$(echo "$data" | jq --arg c "$clinician_user_id" '. + {clinicianUserId:$c}'); fi
  else
    # simple fallback (no optional fields except patientId/context)
    data="{\"patientId\":\"${patient_id}\",\"context\":${context_json}}"
  fi
  echo "# POST ${HOPE_BASE_URL}/api/v1/consultations/open" >&2
  curl -sS -X POST "${HOPE_BASE_URL}/api/v1/consultations/open" "${auth_args[@]}" -H 'Content-Type: application/json' -d "$data" | json_pretty_or_cat
}

cmd_stream_session() {
  local jwt="" service_token="" consultation_id="" language_mode="en"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --jwt) jwt="$2"; shift 2;;
      --service-token) service_token="$2"; shift 2;;
      --consultation-id) consultation_id="$2"; shift 2;;
      --language-mode) language_mode="$2"; shift 2;;
      -h|--help) usage; exit 0;;
      *) echo "Unknown arg: $1" >&2; usage; exit 2;;
    esac
  done
  [[ -n "$consultation_id" ]] || { echo "--consultation-id is required" >&2; exit 2; }
  local auth_args=()
  if [[ -n "$jwt" ]]; then auth_args=(-H "Authorization: Bearer ${jwt}");
  elif [[ -n "$service_token" ]]; then auth_args=(-H "X-Service-Account-Token: ${service_token}");
  else echo "Provide --jwt or --service-token" >&2; exit 2; fi

  local data
  if have_jq; then data=$(jq -nc --arg cid "$consultation_id" --arg lm "$language_mode" '{consultationId:$cid, languageMode:$lm}');
  else data="{\"consultationId\":\"${consultation_id}\",\"languageMode\":\"${language_mode}\"}"; fi
  echo "# POST ${HOPE_BASE_URL}/api/v1/audio/transcription-jobs/stream/session" >&2
  curl -sS -X POST "${HOPE_BASE_URL}/api/v1/audio/transcription-jobs/stream/session" "${auth_args[@]}" -H 'Content-Type: application/json' -d "$data" | json_pretty_or_cat
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    login) cmd_login "$@" ;;
    service-token) cmd_service_token "$@" ;;
    open-consultation) cmd_open_consultation "$@" ;;
    stream-session) cmd_stream_session "$@" ;;
    call) cmd_call "$@" ;;
    -h|--help|"") usage ;;
    *) echo "Unknown command: $cmd" >&2; usage; exit 2 ;;
  esac
}

main "$@"
