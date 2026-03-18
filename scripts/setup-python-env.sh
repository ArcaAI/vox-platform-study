#!/usr/bin/env zsh
# =============================================================================
# HOPE Monorepo — Python Local Environment Setup
# =============================================================================
# Sets up a shared conda environment (arcaenv) with all dependencies for:
#   - stt-v2  (Speech-to-Text v2)
#   - smr-v2  (Summary Agent / SMR v2)
#   - nlp     (Medical NLP)
#
# Usage:
#   ./scripts/setup-python-env.sh              # Full setup (check + create + install)
#   ./scripts/setup-python-env.sh --check      # Only check prerequisites
#   ./scripts/setup-python-env.sh --install     # Skip checks, install deps only
#   ./scripts/setup-python-env.sh --apple       # Include Apple Silicon ML extras (MPS)
#   ./scripts/setup-python-env.sh --gpu         # Include NVIDIA GPU ML extras (CUDA)
#   ./scripts/setup-python-env.sh --help        # Show help
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
CONDA_ENV_NAME="arcaenv"
PYTHON_VERSION="3.11"
REQUIRED_NODE_MAJOR=22
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ML platform flag
ML_PLATFORM="none"
CHECK_ONLY=false
INSTALL_ONLY=false

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
for arg in "$@"; do
    case "$arg" in
        --check)    CHECK_ONLY=true ;;
        --install)  INSTALL_ONLY=true ;;
        --apple)    ML_PLATFORM="apple" ;;
        --gpu)      ML_PLATFORM="gpu" ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --check     Only check prerequisites (no installation)"
            echo "  --install   Skip checks, install dependencies into existing env"
            echo "  --apple     Include Apple Silicon ML extras (MPS + FFmpeg)"
            echo "  --gpu       Include NVIDIA GPU ML extras (CUDA)"
            echo "  --help      Show this help message"
            echo ""
            echo "Without flags: runs full setup (check + create env + install)"
            exit 0
            ;;
        *)
            echo "${RED}Unknown option: $arg${NC}"
            echo "Run '$0 --help' for usage."
            exit 1
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
print_header() {
    echo ""
    echo "${BOLD}${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo "${BOLD}${BLUE}  $1${NC}"
    echo "${BOLD}${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

print_step() {
    echo "${CYAN}  ▸ $1${NC}"
}

print_ok() {
    echo "${GREEN}  ✔ $1${NC}"
}

print_warn() {
    echo "${YELLOW}  ⚠ $1${NC}"
}

print_fail() {
    echo "${RED}  ✘ $1${NC}"
}

print_info() {
    echo "${BLUE}  ℹ $1${NC}"
}

command_exists() {
    command -v "$1" &>/dev/null
}

# ---------------------------------------------------------------------------
# Phase 1: Check & list installed tools
# ---------------------------------------------------------------------------
check_prerequisites() {
    print_header "Phase 1: Checking Prerequisites"

    local all_ok=true

    # --- OS ---
    print_step "Operating System"
    local os_name="$(uname -s)"
    local os_arch="$(uname -m)"
    print_ok "$os_name $os_arch"

    # --- Node.js ---
    print_step "Node.js (required >= $REQUIRED_NODE_MAJOR)"
    if command_exists node; then
        local node_version="$(node --version)"
        local node_major="${node_version#v}"
        node_major="${node_major%%.*}"
        if [[ "$node_major" -ge "$REQUIRED_NODE_MAJOR" ]]; then
            print_ok "Node.js $node_version"
        else
            print_warn "Node.js $node_version found, but >= v${REQUIRED_NODE_MAJOR} required"
            all_ok=false
        fi
    else
        print_fail "Node.js not found"
        print_info "Install via: https://nodejs.org/ or 'brew install node@${REQUIRED_NODE_MAJOR}'"
        all_ok=false
    fi

    # --- pnpm ---
    print_step "pnpm (monorepo package manager)"
    if command_exists pnpm; then
        print_ok "pnpm $(pnpm --version)"
    else
        print_fail "pnpm not found"
        print_info "Install via: 'corepack enable' or 'npm install -g pnpm'"
        all_ok=false
    fi

    # --- Python ---
    print_step "Python (required >= $PYTHON_VERSION)"
    if command_exists python3; then
        local py_version="$(python3 --version 2>&1 | awk '{print $2}')"
        print_ok "Python $py_version (system)"
    elif command_exists python; then
        local py_version="$(python --version 2>&1 | awk '{print $2}')"
        print_ok "Python $py_version (system)"
    else
        print_warn "System Python not found (conda will provide Python $PYTHON_VERSION)"
    fi

    # --- Conda ---
    print_step "Conda (primary — required)"
    if command_exists conda; then
        local conda_version="$(conda --version 2>&1 | awk '{print $2}')"
        print_ok "conda $conda_version"
        print_info "Conda base: $(conda info --base 2>/dev/null)"
    else
        print_fail "conda not found"
        echo ""
        echo "${RED}${BOLD}  Conda is required for this project.${NC}"
        echo ""
        echo "  Install one of the following:"
        echo "    ${CYAN}Miniforge (recommended):${NC}"
        echo "      brew install miniforge"
        echo "      — or —"
        echo "      https://github.com/conda-forge/miniforge#download"
        echo ""
        echo "    ${CYAN}Miniconda:${NC}"
        echo "      https://docs.conda.io/en/latest/miniconda.html"
        echo ""
        echo "    ${CYAN}Anaconda:${NC}"
        echo "      https://www.anaconda.com/download"
        echo ""
        all_ok=false
    fi

    # --- uv (Python package installer, used by lock files) ---
    print_step "uv (fast Python package installer)"
    if command_exists uv; then
        print_ok "uv $(uv --version 2>&1 | awk '{print $2}')"
    else
        print_warn "uv not found (optional, pip will be used instead)"
        print_info "Install via: 'brew install uv' or 'curl -LsSf https://astral.sh/uv/install.sh | sh'"
    fi

    # --- pyenv (optional) ---
    print_step "pyenv (optional Python version manager)"
    if command_exists pyenv; then
        print_ok "pyenv $(pyenv --version 2>&1 | awk '{print $2}')"
        print_info "Installed Python versions:"
        pyenv versions 2>/dev/null | while read -r line; do
            echo "      $line"
        done
    else
        print_info "pyenv not installed (optional — conda handles Python versions)"
    fi

    # --- Docker ---
    print_step "Docker (required for infrastructure services)"
    if command_exists docker; then
        local docker_version="$(docker --version 2>&1 | awk '{print $3}' | tr -d ',')"
        print_ok "Docker $docker_version"
    else
        print_warn "Docker not found (needed for PostgreSQL, Redis, MinIO, etc.)"
        print_info "Install via: https://www.docker.com/products/docker-desktop"
    fi

    # --- Docker Compose ---
    print_step "Docker Compose"
    if docker compose version &>/dev/null 2>&1; then
        local compose_version="$(docker compose version --short 2>&1)"
        print_ok "Docker Compose $compose_version"
    elif command_exists docker-compose; then
        local compose_version="$(docker-compose --version 2>&1 | awk '{print $4}' | tr -d ',')"
        print_ok "docker-compose $compose_version (legacy)"
    else
        print_warn "Docker Compose not found"
    fi

    # --- Git ---
    print_step "Git"
    if command_exists git; then
        print_ok "git $(git --version | awk '{print $3}')"
    else
        print_fail "git not found"
        all_ok=false
    fi

    # --- make ---
    print_step "make (used by stt-v2 Makefile)"
    if command_exists make; then
        print_ok "make $(make --version 2>/dev/null | head -1 | awk '{print $NF}')"
    else
        print_warn "make not found"
        print_info "Install via: 'xcode-select --install' (macOS) or 'sudo apt install build-essential' (Linux)"
    fi

    # --- Summary ---
    echo ""
    if $all_ok; then
        print_ok "${BOLD}All required prerequisites are installed!${NC}"
    else
        print_fail "${BOLD}Some prerequisites are missing. Please install them before continuing.${NC}"
        if $CHECK_ONLY; then
            exit 1
        fi
        echo ""
        echo -n "  Continue anyway? (y/N) "
        read -r response
        if [[ ! "$response" =~ ^[Yy]$ ]]; then
            echo "  Aborting."
            exit 1
        fi
    fi
}

# ---------------------------------------------------------------------------
# Phase 2: List existing conda environments
# ---------------------------------------------------------------------------
list_conda_environments() {
    print_header "Phase 2: Existing Conda Environments"

    if ! command_exists conda; then
        print_fail "conda not available — cannot continue"
        exit 1
    fi

    conda env list 2>/dev/null | while read -r line; do
        if [[ -n "$line" && ! "$line" =~ ^# ]]; then
            if [[ "$line" == *"$CONDA_ENV_NAME"* ]]; then
                echo "  ${GREEN}→ $line${NC}  (target environment)"
            else
                echo "    $line"
            fi
        fi
    done
}

# ---------------------------------------------------------------------------
# Phase 3: Create or verify the conda environment
# ---------------------------------------------------------------------------
setup_conda_environment() {
    print_header "Phase 3: Setting Up Conda Environment — $CONDA_ENV_NAME"

    if conda env list 2>/dev/null | grep -q "^${CONDA_ENV_NAME} \|^${CONDA_ENV_NAME}$"; then
        print_ok "Environment '$CONDA_ENV_NAME' already exists"
        echo ""
        echo -n "  Recreate from scratch? This will remove the existing environment. (y/N) "
        read -r response
        if [[ "$response" =~ ^[Yy]$ ]]; then
            print_step "Removing existing environment..."
            conda env remove -n "$CONDA_ENV_NAME" -y
            print_step "Creating fresh environment with Python $PYTHON_VERSION..."
            conda create -n "$CONDA_ENV_NAME" python="$PYTHON_VERSION" -y
        else
            print_info "Keeping existing environment. Will update dependencies."
        fi
    else
        print_step "Creating conda environment: $CONDA_ENV_NAME (Python $PYTHON_VERSION)"
        conda create -n "$CONDA_ENV_NAME" python="$PYTHON_VERSION" -y
    fi

    # -----------------------------------------------------------------------
    # Conda-managed native packages (all platforms)
    # -----------------------------------------------------------------------
    # These MUST be installed via conda (not pip) to avoid native library
    # symbol conflicts on macOS (libiconv / BLAS / LAPACK mismatches).
    #
    # Key constraint chain:
    #   - torchcodec 0.7.x (required by torch 2.8.x) needs FFmpeg 6.x
    #   - av (PyAV) 13.x from conda-forge is built against FFmpeg 6.x
    #   - numpy/scipy must match conda's libopenblas (pip wheels link Accelerate)
    #   - omegaconf is required by pyannote.audio for model config loading
    #
    # IMPORTANT: Do NOT install av via pip — pip wheels bundle their own
    # FFmpeg libs with broken libiconv linkage on macOS. Always use conda.
    # -----------------------------------------------------------------------
    print_step "Installing conda-managed native packages..."
    conda install -n "$CONDA_ENV_NAME" -c conda-forge \
        'ffmpeg>=6.1,<7' \
        'av>=13.1,<14' \
        'numpy>=2.4' \
        'scipy>=1.17' \
        'libiconv>=1.18' \
        -y

    print_step "Installing omegaconf (required by pyannote.audio)..."
    conda run -n "$CONDA_ENV_NAME" --no-capture-output pip install 'omegaconf>=2.3.0'

    # Apple Silicon: set DYLD_LIBRARY_PATH so conda libs are found at runtime
    if [[ "$ML_PLATFORM" == "apple" ]]; then
        print_step "Creating DYLD_LIBRARY_PATH activation scripts..."
        local env_path
        env_path="$(conda info --envs | grep "$CONDA_ENV_NAME" | awk '{print $NF}')"

        mkdir -p "$env_path/etc/conda/activate.d"
        mkdir -p "$env_path/etc/conda/deactivate.d"

        cat > "$env_path/etc/conda/activate.d/env_vars.sh" << 'ACTIVATE_EOF'
#!/bin/sh
export OLD_DYLD_LIBRARY_PATH="${DYLD_LIBRARY_PATH:-}"
export DYLD_LIBRARY_PATH="$CONDA_PREFIX/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
ACTIVATE_EOF

        cat > "$env_path/etc/conda/deactivate.d/env_vars.sh" << 'DEACTIVATE_EOF'
#!/bin/sh
export DYLD_LIBRARY_PATH="$OLD_DYLD_LIBRARY_PATH"
unset OLD_DYLD_LIBRARY_PATH
DEACTIVATE_EOF

        print_ok "DYLD_LIBRARY_PATH scripts created"
    fi

    # Verify
    print_step "Verifying environment..."
    conda run -n "$CONDA_ENV_NAME" python --version
    print_ok "Conda environment '$CONDA_ENV_NAME' is ready"
}

# ---------------------------------------------------------------------------
# Phase 4: Install dependencies for all Python services
# ---------------------------------------------------------------------------
install_dependencies() {
    print_header "Phase 4: Installing Python Dependencies"

    local -a CR=(conda run -n "$CONDA_ENV_NAME" --no-capture-output)

    # Upgrade pip first
    print_step "Upgrading pip..."
    "${CR[@]}" pip install --upgrade pip setuptools wheel

    # --- stt-v2 ---
    print_header "  4a: stt-v2 (Speech-to-Text v2)"
    local stt_v2_dir="$PROJECT_ROOT/apps/stt-v2"
    if [[ -f "$stt_v2_dir/pyproject.toml" ]]; then
        print_step "Installing stt-v2 dependencies..."
        case "$ML_PLATFORM" in
            apple)
                print_info "Including ML extras for Apple Silicon (MPS)"
                "${CR[@]}" pip install -e "${stt_v2_dir}[ml,dev,test]"
                ;;
            gpu)
                print_info "Including ML extras for NVIDIA GPU (CUDA)"
                "${CR[@]}" pip install -e "${stt_v2_dir}[ml-gpu,dev,test]"
                ;;
            *)
                print_info "CPU-only (no ML extras). Use --apple or --gpu for ML support."
                "${CR[@]}" pip install -e "${stt_v2_dir}[dev,test]"
                ;;
        esac
        print_ok "stt-v2 installed"
    else
        print_warn "stt-v2 pyproject.toml not found at $stt_v2_dir — skipping"
    fi

    # --- smr (smr-v2) ---
    print_header "  4b: smr / smr-v2 (Summary Agent)"
    local smr_dir="$PROJECT_ROOT/apps/smr"
    if [[ -f "$smr_dir/pyproject.toml" ]]; then
        print_step "Installing smr dependencies..."
        "${CR[@]}" pip install -e "${smr_dir}[dev,test]"
        print_ok "smr (smr-v2) installed"
    else
        print_warn "smr pyproject.toml not found at $smr_dir — skipping"
    fi

    # --- nlp ---
    print_header "  4c: nlp (Medical NLP)"
    local nlp_dir="$PROJECT_ROOT/apps/nlp"
    if [[ -f "$nlp_dir/pyproject.toml" ]]; then
        print_step "Installing nlp dependencies..."
        "${CR[@]}" pip install -e "${nlp_dir}"
        print_ok "nlp installed"
    else
        print_warn "nlp pyproject.toml not found at $nlp_dir — skipping"
    fi

    # --- Post-install verification ---
    print_header "  Verifying Installations"

    print_step "Checking installed packages..."
    "${CR[@]}" pip list --format=columns 2>/dev/null | head -5 || true
    local pkg_count
    pkg_count="$("${CR[@]}" pip list 2>/dev/null | wc -l | tr -d ' ')"
    pkg_count=$(( pkg_count - 2 ))
    echo "  ... ($pkg_count packages total)"

    print_step "Verifying key imports..."

    if "${CR[@]}" python -c "import fastapi; print(f'  fastapi {fastapi.__version__}')" 2>/dev/null; then
        print_ok "FastAPI OK"
    else
        print_fail "FastAPI import failed"
    fi

    if "${CR[@]}" python -c "import sqlalchemy; print(f'  sqlalchemy {sqlalchemy.__version__}')" 2>/dev/null; then
        print_ok "SQLAlchemy OK"
    else
        print_fail "SQLAlchemy import failed"
    fi

    # Conda-managed packages
    if "${CR[@]}" python -c "import av; print(f'  av {av.__version__} (FFmpeg {av.ffmpeg_version_info})')" 2>/dev/null; then
        print_ok "PyAV + FFmpeg OK (conda-managed)"
    else
        print_fail "PyAV import failed — run conda install av"
    fi

    if "${CR[@]}" python -c "import numpy; print(f'  numpy {numpy.__version__}')" 2>/dev/null; then
        print_ok "NumPy OK (conda-managed)"
    else
        print_fail "NumPy import failed"
    fi

    if "${CR[@]}" python -c "import scipy; print(f'  scipy {scipy.__version__}')" 2>/dev/null; then
        print_ok "SciPy OK (conda-managed)"
    else
        print_fail "SciPy import failed"
    fi

    if "${CR[@]}" python -c "import omegaconf; print(f'  omegaconf {omegaconf.__version__}')" 2>/dev/null; then
        print_ok "OmegaConf OK"
    else
        print_warn "OmegaConf not available (pyannote.audio diarization may fail)"
    fi

    # transformers pipeline (validates av + scipy + sklearn chain)
    if "${CR[@]}" python -c "from transformers import pipeline; print('  transformers.pipeline import OK')" 2>/dev/null; then
        print_ok "Transformers pipeline OK"
    else
        print_warn "Transformers pipeline import failed — NLP service may not start"
    fi

    if [[ "$ML_PLATFORM" != "none" ]]; then
        if "${CR[@]}" python -c "
import torch
print(f'  torch {torch.__version__}')
print(f'  CUDA available: {torch.cuda.is_available()}')
mps = torch.backends.mps.is_available() if hasattr(torch.backends, 'mps') else False
print(f'  MPS available: {mps}')
" 2>/dev/null; then
            print_ok "PyTorch OK"
        else
            print_warn "PyTorch import failed — ML features may not work"
        fi
    fi

    if "${CR[@]}" python -c "import spacy; print(f'  spacy {spacy.__version__}')" 2>/dev/null; then
        print_ok "spaCy OK"
    else
        print_warn "spaCy not available (nlp service may need it)"
    fi
}

# ---------------------------------------------------------------------------
# Phase 5: Summary
# ---------------------------------------------------------------------------
print_summary() {
    print_header "Setup Complete!"

    echo ""
    echo "  ${BOLD}Environment:${NC}  $CONDA_ENV_NAME"
    echo "  ${BOLD}Python:${NC}       $PYTHON_VERSION"
    echo "  ${BOLD}ML Platform:${NC}  $ML_PLATFORM"
    echo ""
    echo "  ${BOLD}Activate the environment:${NC}"
    echo "    ${CYAN}conda activate $CONDA_ENV_NAME${NC}"
    echo ""
    echo "  ${BOLD}Run services from monorepo root:${NC}"
    echo "    ${CYAN}pnpm dev:stt-v2${NC}    — STT v2 on port 8001"
    echo "    ${CYAN}pnpm dev:smr-v2${NC}    — SMR v2 on port 5006"
    echo ""
    echo "  ${BOLD}Run services directly:${NC}"
    echo "    ${CYAN}conda run -n $CONDA_ENV_NAME uvicorn stt_v2.main:app --reload --app-dir apps/stt-v2/src${NC}"
    echo "    ${CYAN}conda run -n $CONDA_ENV_NAME uvicorn smr_v2.main:app --reload --app-dir apps/smr/src${NC}"
    echo "    ${CYAN}conda run -n $CONDA_ENV_NAME uvicorn nlp.main:app --reload --app-dir apps/nlp/src${NC}"
    echo ""
    echo "  ${BOLD}Run tests:${NC}"
    echo "    ${CYAN}conda run -n $CONDA_ENV_NAME pytest apps/stt-v2/tests/ -v${NC}"
    echo "    ${CYAN}conda run -n $CONDA_ENV_NAME pytest apps/smr/tests/ -v${NC}"
    echo "    ${CYAN}conda run -n $CONDA_ENV_NAME pytest apps/nlp/tests/ -v${NC}"
    echo ""

    if [[ "$ML_PLATFORM" == "none" ]]; then
        echo "  ${YELLOW}Note: ML dependencies were not installed.${NC}"
        echo "  ${YELLOW}To add ML support, re-run with --apple or --gpu:${NC}"
        echo "    ${CYAN}./scripts/setup-python-env.sh --install --apple${NC}"
        echo "    ${CYAN}./scripts/setup-python-env.sh --install --gpu${NC}"
        echo ""
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    echo ""
    echo "${BOLD}${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo "${BOLD}${BLUE}║       HOPE Monorepo — Python Environment Setup             ║${NC}"
    echo "${BOLD}${BLUE}║       Environment: $CONDA_ENV_NAME | Python: $PYTHON_VERSION                   ║${NC}"
    echo "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"

    if $CHECK_ONLY; then
        check_prerequisites
        list_conda_environments
        echo ""
        print_ok "Check complete. Run without --check to proceed with setup."
        exit 0
    fi

    if $INSTALL_ONLY; then
        install_dependencies
        print_summary
        exit 0
    fi

    # Full setup
    check_prerequisites
    list_conda_environments
    setup_conda_environment
    install_dependencies
    print_summary
}

main "$@"
