#!/usr/bin/env zsh
# =============================================================================
# HOPE Monorepo — Python Local Environment Setup
# =============================================================================
# Sets up a shared conda environment (arcaenv) with all dependencies for:
#   - stt     (Speech-to-Text)
#   - text    (Summarization / LLM)
#   - nlp     (Medical NLP)
#   - harness (Clinical Documentation Harness orchestrator)
#   - guardrail (AI content-safety / medical-context validation)
#   - tts     (Realtime multi-provider Text-to-Speech)
#
# Usage:
#   ./scripts/setup-python-env.sh                      # Full setup (check + create + install all)
#   ./scripts/setup-python-env.sh --check              # Only check prerequisites
#   ./scripts/setup-python-env.sh --install            # Skip checks, install deps only
#   ./scripts/setup-python-env.sh --cpu                # CPU-only extras (explicit default)
#   ./scripts/setup-python-env.sh --apple              # Apple Silicon ML extras (MPS)
#   ./scripts/setup-python-env.sh --gpu                # NVIDIA GPU ML extras (CUDA)
#   ./scripts/setup-python-env.sh --rebuild            # Recreate the conda env from scratch
#   ./scripts/setup-python-env.sh --service stt        # Install ONE service (repeatable)
#   ./scripts/setup-python-env.sh --service stt --gpu  # ...with a hardware platform
#   ./scripts/setup-python-env.sh --help               # Show help
#
# HARDWARE PLATFORM (--cpu | --apple | --gpu) selects which optional extras a
# service installs. It is per-service: stt picks [ml]/[ml-gpu], tts picks
# [local], and services with no hardware-specific extras ignore it.
#
# --service narrows the install phase to the named service(s); the conda env,
# native conda packages and the libomp dedup still run (they are shared).
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
REBUILD=false

# Every Python service this script knows how to install, in dependency-safe
# order (workspace packages under packages/py-* are installed separately,
# before all of them — pip cannot resolve `{ workspace = true }`).
ALL_SERVICES=(stt text nlp harness guardrail tts)
# Selected subset (empty => all). Populated by --service.
SERVICES=()

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
expect_service=false
for arg in "$@"; do
    if $expect_service; then
        expect_service=false
        found=false
        for known in "${ALL_SERVICES[@]}"; do
            [[ "$arg" == "$known" ]] && found=true
        done
        if ! $found; then
            echo "${RED}Unknown service: $arg${NC}"
            echo "Known services: ${ALL_SERVICES[*]}"
            exit 1
        fi
        SERVICES+=("$arg")
        continue
    fi
    case "$arg" in
        --check)    CHECK_ONLY=true ;;
        --install)  INSTALL_ONLY=true ;;
        --rebuild)  REBUILD=true ;;
        --cpu)      ML_PLATFORM="none" ;;
        --apple)    ML_PLATFORM="apple" ;;
        --gpu)      ML_PLATFORM="gpu" ;;
        --service|-s) expect_service=true ;;
        --service=*)
            svc="${arg#--service=}"
            found=false
            for known in "${ALL_SERVICES[@]}"; do
                [[ "$svc" == "$known" ]] && found=true
            done
            if ! $found; then
                echo "${RED}Unknown service: $svc${NC}"
                echo "Known services: ${ALL_SERVICES[*]}"
                exit 1
            fi
            SERVICES+=("$svc")
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --check            Only check prerequisites (no installation)"
            echo "  --install          Skip checks, install dependencies into existing env"
            echo "  --rebuild          Recreate the conda environment from scratch (no prompt)"
            echo "  --cpu              CPU-only extras (explicit default)"
            echo "  --apple            Include Apple Silicon ML extras (MPS + FFmpeg)"
            echo "  --gpu              Include NVIDIA GPU ML extras (CUDA)"
            echo "  --service <name>   Install only this service (repeatable)"
            echo "                     One of: ${ALL_SERVICES[*]}"
            echo "  --help             Show this help message"
            echo ""
            echo "Without flags: runs full setup (check + create env + install all services)"
            exit 0
            ;;
        *)
            echo "${RED}Unknown option: $arg${NC}"
            echo "Run '$0 --help' for usage."
            exit 1
            ;;
    esac
done

if $expect_service; then
    echo "${RED}--service requires a service name.${NC}"
    echo "Known services: ${ALL_SERVICES[*]}"
    exit 1
fi

# No explicit --service => install everything.
if [[ ${#SERVICES[@]} -eq 0 ]]; then
    SERVICES=("${ALL_SERVICES[@]}")
fi

# Is <name> in the selected set?
service_selected() {
    local want="$1" s
    for s in "${SERVICES[@]}"; do
        [[ "$s" == "$want" ]] && return 0
    done
    return 1
}

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
    print_step "make (used by stt Makefile)"
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
        local recreate=false
        if $REBUILD; then
            print_warn "--rebuild given: recreating '$CONDA_ENV_NAME' from scratch."
            recreate=true
        elif [[ ! -t 0 ]]; then
            # Non-interactive (CI, nohup, IDE task runner): `read` returns empty
            # immediately, which would silently mean "keep". Say so explicitly.
            print_info "Non-interactive shell — keeping the existing environment."
            print_info "Pass --rebuild to recreate it without a prompt."
        else
            echo ""
            echo -n "  Recreate from scratch? This will remove the existing environment. (y/N) "
            read -r response
            [[ "$response" =~ ^[Yy]$ ]] && recreate=true
        fi
        if $recreate; then
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
    print_info "Services: ${SERVICES[*]}    Hardware platform: $ML_PLATFORM"

    local -a CR=(conda run -n "$CONDA_ENV_NAME" --no-capture-output)

    # Upgrade pip first
    print_step "Upgrading pip..."
    "${CR[@]}" pip install --upgrade pip setuptools wheel

    # --- workspace packages (not on PyPI) ---
    # Recreate wipes site-packages. pip cannot resolve `{ workspace = true }`,
    # so every packages/py-* member must be editable-installed BEFORE any
    # service. Discover them from disk so a new member cannot be forgotten
    # the way hope-otel was.
    local shared_dir
    for shared_dir in "$PROJECT_ROOT"/packages/py-*; do
        if [[ -f "$shared_dir/pyproject.toml" ]]; then
            print_step "Installing $(basename "$shared_dir") (workspace package, not on PyPI)..."
            "${CR[@]}" pip install -e "${shared_dir}"
        fi
    done
    print_step "Verifying workspace packages import..."
    if ! "${CR[@]}" python -c "import hope_runtime_models, hope_env, hope_otel"; then
        print_fail "Workspace packages failed to import after editable install"
        exit 1
    fi
    print_ok "Workspace packages ready (hope-runtime-models, hope-env, hope-otel)"

    # --- stt ---
    if service_selected stt; then
    print_header "  4a: stt (Speech-to-Text)"
    local stt_dir="$PROJECT_ROOT/apps/stt"
    if [[ -f "$stt_dir/pyproject.toml" ]]; then
        print_step "Installing stt dependencies..."
        case "$ML_PLATFORM" in
            apple)
                print_info "Including ML extras for Apple Silicon (MPS)"
                "${CR[@]}" pip install -e "${stt_dir}[ml,dev,test]"
                ;;
            gpu)
                print_info "Including ML extras for NVIDIA GPU (CUDA)"
                "${CR[@]}" pip install -e "${stt_dir}[ml-gpu,dev,test]"
                ;;
            *)
                print_info "CPU-only (no ML extras). Use --apple or --gpu for ML support."
                "${CR[@]}" pip install -e "${stt_dir}[dev,test]"
                ;;
        esac
        print_ok "stt installed"
    else
        print_warn "stt pyproject.toml not found at $stt_dir — skipping"
    fi
    fi

    # --- text ---
    if service_selected text; then
    print_header "  4b: text (Summarization)"
    local text_dir="$PROJECT_ROOT/apps/text"
    if [[ -f "$text_dir/pyproject.toml" ]]; then
        print_step "Installing text dependencies..."
        "${CR[@]}" pip install -e "${text_dir}[dev,test]"
        print_ok "text installed"
    else
        print_warn "text pyproject.toml not found at $text_dir — skipping"
    fi
    fi

    # --- nlp ---
    if service_selected nlp; then
    print_header "  4c: nlp (Medical NLP)"
    local nlp_dir="$PROJECT_ROOT/apps/nlp"
    if [[ -f "$nlp_dir/pyproject.toml" ]]; then
        print_step "Installing nlp dependencies..."
        "${CR[@]}" pip install -e "${nlp_dir}[dev,test]"
        print_ok "nlp installed"
    else
        print_warn "nlp pyproject.toml not found at $nlp_dir — skipping"
    fi
    fi

    # --- harness ---
    if service_selected harness; then
    print_header "  4d: harness (Clinical Documentation Harness)"
    local harness_dir="$PROJECT_ROOT/apps/harness"
    if [[ -f "$harness_dir/pyproject.toml" ]]; then
        print_step "Installing harness dependencies..."
        # Extras must match the `test-harness` CI job (.gitlab/ci/test.yml):
        #   - eval/rag   — deepeval / qdrant_client / fastembed are imported at
        #                  MODULE level by test modules, so their absence fails
        #                  COLLECTION (6 errors) rather than skipping.
        #   - guardrails — the PHI-redactor tests exercise real Presidio redaction.
        # `[dev,test]` alone left local envs unable to run the suite at all.
        "${CR[@]}" pip install -e "${harness_dir}[dev,test,eval,rag,guardrails]"
        print_ok "harness installed"
    else
        print_warn "harness pyproject.toml not found at $harness_dir — skipping"
    fi
    fi

    # --- guardrail ---
    if service_selected guardrail; then
    print_header "  4e: guardrail (Content Safety / Medical Validation)"
    local guardrail_dir="$PROJECT_ROOT/apps/guardrail"
    if [[ -f "$guardrail_dir/pyproject.toml" ]]; then
        print_step "Installing guardrail dependencies..."
        "${CR[@]}" pip install -e "${guardrail_dir}[dev,test]"
        print_ok "guardrail installed"
    else
        print_warn "guardrail pyproject.toml not found at $guardrail_dir — skipping"
    fi
    fi

    # --- tts ---
    if service_selected tts; then
    print_header "  4f: tts (Text-to-Speech)"
    local tts_dir="$PROJECT_ROOT/apps/tts"
    if [[ -f "$tts_dir/pyproject.toml" ]]; then
        print_step "Installing tts dependencies..."
        case "$ML_PLATFORM" in
            apple|gpu)
                print_info "Including self-hosted local engine extras ([local]: torch/kokoro)"
                "${CR[@]}" pip install -e "${tts_dir}[local,dev,test]"
                ;;
            *)
                print_info "Cloud providers only (no [local] engines). Use --apple or --gpu for self-hosted engines."
                "${CR[@]}" pip install -e "${tts_dir}[dev,test]"
                ;;
        esac
        print_ok "tts installed"
    else
        print_warn "tts pyproject.toml not found at $tts_dir — skipping"
    fi
    fi

    # -----------------------------------------------------------------------
    # Deduplicate OpenMP (libomp) — CRITICAL for macOS
    # -----------------------------------------------------------------------
    # pip-installed packages (torch, scikit-learn) bundle their own libomp.dylib.
    # When loaded alongside conda's libomp (used by numpy/scipy), the OpenMP
    # runtime aborts with "Error #15: found libomp.dylib already initialized".
    #
    # Fix: replace bundled copies with symlinks to conda's single libomp.
    # This must run AFTER all pip installs since pip may overwrite symlinks.
    # -----------------------------------------------------------------------
    print_header "  Deduplicating OpenMP runtime (libomp)"

    local env_path
    env_path="$(conda info --envs | grep "$CONDA_ENV_NAME" | awk '{print $NF}')"
    local conda_libomp="$env_path/lib/libomp.dylib"

    if [[ -f "$conda_libomp" ]]; then
        local site_pkgs="$env_path/lib/python${PYTHON_VERSION}/site-packages"
        local deduped=0

        for bundled in \
            "$site_pkgs/torch/lib/libomp.dylib" \
            "$site_pkgs/sklearn/.dylibs/libomp.dylib" \
        ; do
            if [[ -f "$bundled" && ! -L "$bundled" ]]; then
                print_step "Replacing $(basename "$(dirname "$(dirname "$bundled")")")/…/libomp.dylib → conda libomp"
                mv "$bundled" "${bundled}.bak"
                ln -sf "$conda_libomp" "$bundled"
                deduped=$((deduped + 1))
            elif [[ -L "$bundled" ]]; then
                print_info "Already a symlink: $bundled"
            fi
        done

        if [[ $deduped -gt 0 ]]; then
            print_ok "Replaced $deduped bundled libomp copies with symlinks to conda's libomp"
        else
            print_ok "No duplicate libomp copies found — nothing to fix"
        fi
    else
        print_warn "Conda libomp not found at $conda_libomp — skipping dedup"
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

    if "${CR[@]}" python -c "import structlog; print(f'  structlog {structlog.__version__}')" 2>/dev/null; then
        print_ok "structlog OK"
    else
        print_fail "structlog import failed"
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
    echo "  ${BOLD}Services:${NC}     ${SERVICES[*]}"
    echo ""
    echo "  ${BOLD}Activate the environment:${NC}"
    echo "    ${CYAN}conda activate $CONDA_ENV_NAME${NC}"
    echo ""
    echo "  ${BOLD}Run a service (dev):${NC}"
    echo "    ${CYAN}pnpm stt:dev${NC}         — STT on port 8861"
    echo "    ${CYAN}pnpm text:dev${NC}         — TEXT on port 8862"
    echo "    ${CYAN}pnpm guardrail:dev${NC}   — Guardrail on port 8863"
    echo "    ${CYAN}pnpm nlp:dev${NC}         — NLP on port 8864"
    echo "    ${CYAN}pnpm tts:dev${NC}         — TTS on port 8865"
    echo "    ${CYAN}pnpm harness:dev${NC}     — Harness on port 8866"
    echo "    ${CYAN}pnpm worker:dev${NC}      — Harness Temporal worker"
    echo "    ${CYAN}pnpm stack:dev${NC}       — the whole app stack + infra"
    echo ""
    echo "  ${BOLD}Run tests:${NC}"
    echo "    ${CYAN}pnpm stt:test${NC}   ${CYAN}pnpm text:test${NC}   ${CYAN}pnpm nlp:test${NC}"
    echo "    ${CYAN}pnpm guardrail:test${NC}   ${CYAN}pnpm harness:test${NC}   ${CYAN}pnpm tts:test${NC}"
    echo "    ${CYAN}pnpm test:py${NC}         — every Python suite"
    echo ""
    echo "  ${BOLD}Quality:${NC}"
    echo "    ${CYAN}pnpm lint:py${NC}   ${CYAN}pnpm format:py${NC}   ${CYAN}pnpm typecheck:py${NC}"
    echo ""

    if [[ "$ML_PLATFORM" == "none" ]]; then
        echo "  ${YELLOW}Note: ML dependencies were not installed.${NC}"
        echo "  ${YELLOW}To add ML support, re-run with --apple or --gpu:${NC}"
        echo "    ${CYAN}pnpm setup:python:apple${NC}   (or: pnpm stt:setup:apple)"
        echo "    ${CYAN}pnpm setup:python:gpu${NC}     (or: pnpm stt:setup:gpu)"
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
        # --rebuild still recreates the env even in install-only mode; otherwise
        # the flag would be silently ignored.
        $REBUILD && setup_conda_environment
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
