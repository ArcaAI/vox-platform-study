#!/usr/bin/env zsh
set -eu

# Fast, staged-only gitleaks scan.
# Skips silently if gitleaks is not installed (developer onboarding window).
# CI gate (.gitlab/ci/scan.yml::scan-gitleaks) is the back-stop.
#
# Activation:
#   pnpm install (runs the "prepare" script which calls simple-git-hooks)
#
# Note for git worktrees: simple-git-hooks cannot mkdir inside a worktree
# pointer-file .git. Until a hooks-path-aware launcher lands, worktrees
# require a one-shot manual install:
#   cat > "$(git rev-parse --git-common-dir)/hooks/pre-commit" <<'HOOK'
#   #!/usr/bin/env zsh
#   exec "$(git rev-parse --show-toplevel)/scripts/gitleaks-precommit.sh" "$@"
#   HOOK
#   chmod +x "$(git rev-parse --git-common-dir)/hooks/pre-commit"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "warn(gitleaks-precommit): gitleaks not installed locally — skipping pre-commit scan."
  echo "warn(gitleaks-precommit): install via 'brew install gitleaks' (>= 8.21)."
  exit 0
fi

gitleaks protect --staged \
                 --config .gitleaks.toml \
                 --no-banner \
                 --redact \
                 --verbose
