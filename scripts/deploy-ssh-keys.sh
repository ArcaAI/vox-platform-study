#!/bin/zsh
#
# deploy-ssh-keys.sh
# Generates an ed25519 SSH key and deploys it to all homelab VMs
# via cloudflared tunnel using password auth (one-time setup).
#
# Usage:
#   ./scripts/deploy-ssh-keys.sh           # Deploy to ALL VMs
#   ./scripts/deploy-ssh-keys.sh gpu db0   # Deploy to specific VMs only
#   ./scripts/deploy-ssh-keys.sh --dry-run # Show what would happen
#
# Prerequisites:
#   - cloudflared installed at /opt/homebrew/bin/cloudflared
#   - Password auth currently enabled on target VMs
#   - User 'dell' exists on all VMs

set -euo pipefail

CLOUDFLARED="/opt/homebrew/bin/cloudflared"
SSH_KEY="$HOME/.ssh/id_ed25519_homelab"
SSH_USER="dell"
BASE_LOCAL_PORT=2200
DRY_RUN=false

typeset -A VM_MAP
VM_MAP=(
    gpu           "server-gpu.taphuynh.dev"
    rb            "ssh-rb.taphuynh.dev"
    master        "ssh-master.taphuynh.dev"
    vuvu          "ssh-vuvu.taphuynh.dev"
    minio         "ssh-minio.taphuynh.dev"
    gitlab        "ssh-git.taphuynh.dev"
    gitlab-runner "ssh-git-runner.taphuynh.dev"
    db0           "ssh-db0.taphuynh.dev"
    db1           "ssh-db1.taphuynh.dev"
    db2           "ssh-db2.taphuynh.dev"
)

VM_ORDER=(gpu master vuvu minio gitlab gitlab-runner db0 db1 db2)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()    { echo "${BLUE}[INFO]${NC}  $1" }
log_success() { echo "${GREEN}[OK]${NC}    $1" }
log_warn()    { echo "${YELLOW}[WARN]${NC}  $1" }
log_error()   { echo "${RED}[FAIL]${NC}  $1" }
log_step()    { echo "\n${CYAN}━━━ $1 ━━━${NC}" }

# ── Parse arguments ──────────────────────────────────────────────

TARGETS=()
for arg in "$@"; do
    if [[ "$arg" == "--dry-run" ]]; then
        DRY_RUN=true
    elif [[ -n "${VM_MAP[$arg]+x}" ]]; then
        TARGETS+=("$arg")
    else
        log_error "Unknown VM alias: $arg"
        echo "Available: ${VM_ORDER[*]}"
        exit 1
    fi
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
    TARGETS=("${VM_ORDER[@]}")
fi

# ── Step 1: Generate SSH key if needed ───────────────────────────

log_step "Step 1: SSH Key"

if [[ -f "$SSH_KEY" ]]; then
    log_success "Key already exists: $SSH_KEY"
    log_info "Fingerprint: $(ssh-keygen -lf "$SSH_KEY")"
else
    if $DRY_RUN; then
        log_info "[DRY RUN] Would generate: $SSH_KEY"
    else
        log_info "Generating ed25519 key..."
        ssh-keygen -t ed25519 -C "taphuynh@homelab" -f "$SSH_KEY"
        chmod 600 "$SSH_KEY"
        chmod 644 "${SSH_KEY}.pub"
        log_success "Key generated: $SSH_KEY"
        log_info "Fingerprint: $(ssh-keygen -lf "$SSH_KEY")"
    fi
fi

# ── Step 2: Deploy to each VM ───────────────────────────────────

log_step "Step 2: Deploy Public Key to VMs"

echo "Targets: ${TARGETS[*]}"
echo "User: $SSH_USER"
echo ""

SUCCEEDED=()
FAILED=()
SKIPPED=()

PORT=$BASE_LOCAL_PORT
for vm in "${TARGETS[@]}"; do
    HOSTNAME="${VM_MAP[$vm]}"
    PORT=$((PORT + 1))

    echo ""
    log_info "[$vm] → $HOSTNAME (local port $PORT)"

    if $DRY_RUN; then
        log_info "[DRY RUN] Would tunnel $HOSTNAME → localhost:$PORT and deploy key"
        SKIPPED+=("$vm")
        continue
    fi

    # Check if key is already deployed (try ProxyCommand-based connection first)
    if ssh -o BatchMode=yes \
           -o ConnectTimeout=10 \
           -o StrictHostKeyChecking=accept-new \
           -o ProxyCommand="$CLOUDFLARED access ssh --hostname $HOSTNAME" \
           -i "$SSH_KEY" \
           "$SSH_USER@$HOSTNAME" "echo ok" 2>/dev/null; then
        log_success "[$vm] Key already deployed — skipping"
        SKIPPED+=("$vm")
        continue
    fi

    log_info "[$vm] Starting cloudflared tunnel..."

    # Start tunnel in background
    $CLOUDFLARED access tcp --hostname "$HOSTNAME" --url "localhost:$PORT" &>/dev/null &
    TUNNEL_PID=$!

    # Wait for tunnel to be ready
    READY=false
    for i in {1..15}; do
        if nc -z localhost "$PORT" 2>/dev/null; then
            READY=true
            break
        fi
        sleep 1
    done

    if ! $READY; then
        log_error "[$vm] Tunnel failed to start within 15s"
        kill $TUNNEL_PID 2>/dev/null || true
        FAILED+=("$vm")
        continue
    fi

    log_info "[$vm] Tunnel ready. Deploying key (you'll be prompted for $SSH_USER's password)..."
    echo "${YELLOW}       ↓ Enter password for $SSH_USER@$vm ↓${NC}"

    # Deploy the key
    if ssh-copy-id \
        -i "${SSH_KEY}.pub" \
        -p "$PORT" \
        -o StrictHostKeyChecking=accept-new \
        -o UserKnownHostsFile=/dev/null \
        "$SSH_USER@localhost" 2>/dev/null; then
        log_success "[$vm] Key deployed successfully"
        SUCCEEDED+=("$vm")
    else
        log_error "[$vm] Key deployment failed"
        FAILED+=("$vm")
    fi

    # Kill the tunnel
    kill $TUNNEL_PID 2>/dev/null || true
    wait $TUNNEL_PID 2>/dev/null || true
    sleep 1
done

# ── Step 3: Summary ─────────────────────────────────────────────

log_step "Summary"

if [[ ${#SUCCEEDED[@]} -gt 0 ]]; then
    log_success "Deployed: ${SUCCEEDED[*]}"
fi
if [[ ${#SKIPPED[@]} -gt 0 ]]; then
    log_info "Skipped (already done or dry-run): ${SKIPPED[*]}"
fi
if [[ ${#FAILED[@]} -gt 0 ]]; then
    log_error "Failed: ${FAILED[*]}"
    echo ""
    log_info "To retry failed VMs:"
    echo "  ./scripts/deploy-ssh-keys.sh ${FAILED[*]}"
fi

# ── Step 4: Verification instructions ───────────────────────────

if [[ ${#SUCCEEDED[@]} -gt 0 ]] || [[ ${#SKIPPED[@]} -gt 0 ]]; then
    log_step "Verify"
    echo "Test key-based access (no password should be needed):"
    echo ""
    for vm in "${TARGETS[@]}"; do
        echo "  ssh $vm"
    done
    echo ""
    log_info "If any still prompt for a password, the key wasn't deployed correctly."
    log_info "Re-run: ./scripts/deploy-ssh-keys.sh <vm-alias>"
fi
