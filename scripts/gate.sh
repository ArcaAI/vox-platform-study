#!/usr/bin/env bash
# Orchestrator quality gate — run once, after every lane is merged.
#
#   scripts/gate.sh                 full gate
#   scripts/gate.sh --changed       only suites touched since $GATE_BASE (default origin/dev-2.2)
#   scripts/gate.sh --keep-going    don't stop after a red fast phase
#   scripts/gate.sh --no-coverage   skip coverage (it is ON for a full gate, OFF for --changed;
#                                   --coverage forces it on)
#
# Coverage reports land in $GATE_COVERAGE_DIR (default coverage/gate/, gitignored): one
# html/ + lcov/json per suite, and a per-suite total table at the end of the run.
#
# Phases (each step's log lands in $GATE_LOG_DIR/<step>.log):
#   1. fast     lint · ruff · api typecheck          (parallel, ~1 min, stops the gate on red)
#   2. build    api build (turbo builds domains/applications) + the five API artifacts + checks,
#               FAILING if regeneration changed a committed artifact (they were stale)
#   3. test     TS unit · database · harness · guardrail · text (parallel)
#
# Every step is killed after $GATE_STEP_TIMEOUT seconds (default 900) and reported as
# FAIL (rc 124), so a hung test fails the gate instead of blocking it forever.
#
# Deliberately NOT run separately, because an aggregate already covers them:
#   - domains / applications / admin-console / vox tests  → `pnpm test:unit`
#   - admin-console lint                                   → `pnpm lint` (turbo)
#   - domains / applications build                         → `pnpm api:build` (turbo deps)
set -uo pipefail
cd "$(dirname "$0")/.."

CHANGED=0 KEEP_GOING=0 COVERAGE=
for a in "$@"; do
  case "$a" in
    --changed) CHANGED=1 ;;
    --keep-going) KEEP_GOING=1 ;;
    --coverage) COVERAGE=1 ;;
    --no-coverage) COVERAGE=0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

BASE="${GATE_BASE:-origin/dev-2.2}"
LOG_DIR="${GATE_LOG_DIR:-${TMPDIR:-/tmp}/hope-gate}"
CONDA_BIN="${CONDA_BIN:-$HOME/miniconda3/envs/arcaenv/bin}"   # `conda run` is broken in the sandbox
PY="$CONDA_BIN/python"
PY_WORKERS="${PY_WORKERS:-4}"                                  # 0 = serial pytest
STEP_TIMEOUT="${GATE_STEP_TIMEOUT:-900}"                       # seconds; a hung step fails (rc 124)
rm -rf "$LOG_DIR" && mkdir -p "$LOG_DIR"
# A partial (--changed) run's percentages would mislead, so coverage defaults off there.
[ -n "$COVERAGE" ] || COVERAGE=$([ $CHANGED -eq 1 ] && echo 0 || echo 1)
COV_DIR="${GATE_COVERAGE_DIR:-$PWD/coverage/gate}"
[ $COVERAGE -eq 1 ] && rm -rf "$COV_DIR" && mkdir -p "$COV_DIR"

RES="$LOG_DIR/.results"   # one "name|rc|seconds" line per step
: >"$RES"

# killtree <pid> — TERM a process and every descendant (macOS has no `timeout`/setsid)
killtree() {
  local c
  for c in $(pgrep -P "$1"); do killtree "$c"; done
  kill -TERM "$1" 2>/dev/null
}

# run <name> <cmd...> — logged, timed, killed after $STEP_TIMEOUT
run() {
  local name=$1; shift
  local t0=$SECONDS
  "$@" >"$LOG_DIR/$name.log" 2>&1 &
  local cpid=$!
  ( sleep "$STEP_TIMEOUT" && kill -0 "$cpid" 2>/dev/null \
      && echo "gate: '$name' exceeded ${STEP_TIMEOUT}s — killed" >>"$LOG_DIR/$name.log" \
      && touch "$LOG_DIR/.$name.timeout" && killtree "$cpid" ) &
  local wpid=$!
  wait "$cpid"
  local rc=$?
  killtree "$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null
  [ -e "$LOG_DIR/.$name.timeout" ] && rc=124
  echo "$name|$rc|$((SECONDS - t0))" >>"$RES"
  printf '  %-16s %s  %4ss\n' "$name" "$([ $rc -eq 0 ] && echo ok || echo FAIL)" "$((SECONDS - t0))"
  return $rc
}

# par <name=cmd>... — run every step in the background, wait for all
par() {
  local pids="" spec pid rc=0
  for spec in "$@"; do
    run "${spec%%=*}" sh -c "${spec#*=}" &
    pids="$pids $!"
  done
  for pid in $pids; do wait "$pid" || rc=1; done
  return $rc
}

# changed <path>... — true in full mode, or when <path> differs from $BASE (incl. uncommitted)
changed() { [ $CHANGED -eq 0 ] && return 0; ! git diff --quiet "$(git merge-base "$BASE" HEAD)" -- "$@"; }
# pytest flags: xdist workers + dump every thread's stack if one test runs > 5 min
pyxdist() {
  echo "-o faulthandler_timeout=300 $([ "$PY_WORKERS" = 0 ] || echo "-n $PY_WORKERS")"
}
# pycov <svc> — each pyproject already measures `--cov=<pkg>`; add the gate's reports, or turn it off
pycov() {
  [ $COVERAGE -eq 1 ] || { echo "--no-cov"; return; }
  echo "--cov-report=json:$COV_DIR/py-$1/coverage.json --cov-report=html:$COV_DIR/py-$1/html --cov-report=xml:$COV_DIR/py-$1/coverage.xml"
}
# vcov <suite> — Vitest coverage flags. V8, not istanbul: istanbul instruments every
# module, which made the unit run 4x slower (787 s vs 189 s) and timed out 13 tests.
# `forks`, not `threads`: V8 coverage under worker_threads kills the run with SIGBUS
# here (even a quarter shard), while forks + V8 covers the full suite in ~336 s.
vcov() {
  [ $COVERAGE -eq 1 ] || return 0
  echo "--pool=forks --coverage.enabled --coverage.provider=v8 --coverage.reporter=json-summary --coverage.reporter=html --coverage.reporter=lcov --coverage.reportsDirectory=$COV_DIR/ts-$1"
}

echo "gate: base=$BASE changed=$CHANGED coverage=$COVERAGE logs=$LOG_DIR"

# ---- 1. fast ---------------------------------------------------------------
echo "[1/3] fast checks"
par "lint=pnpm lint" \
    "ruff=$CONDA_BIN/ruff check apps/harness/src apps/guardrail/src apps/text/src" \
    "api-typecheck=pnpm --filter @arcaai/api exec tsc --noEmit"
FAST=$?
if [ $FAST -ne 0 ] && [ $KEEP_GOING -eq 0 ]; then
  echo "fast phase red — stopping (use --keep-going to continue)"
fi

if [ $FAST -eq 0 ] || [ $KEEP_GOING -eq 1 ]; then
  # ---- 2. build ------------------------------------------------------------
  echo "[2/3] build + API artifacts"
  # Fingerprint the five generated artifacts BEFORE regenerating them: the generators rewrite
  # them in place, so without this a stale committed artifact is silently "fixed" in the working
  # tree and every later check compares the regenerated files with themselves.
  ARTIFACTS="apps/api/openapi.json apps/api/route-manifest.json apps/admin-console/src/server/api-docs packages/vox-node/src/resources/admin"
  artifact_sum() { find $ARTIFACTS -type f -not -path '*/__tests__/*' -print0 | sort -z | xargs -0 shasum | shasum; }
  ARTIFACTS_BEFORE=$(artifact_sum)
  run api-artifacts sh -c 'pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin' \
    && run api-checks sh -c 'pnpm api:openapi:check && pnpm api:portal:check && pnpm --filter @arcaai/vox-node gen:admin:check'
  if [ "$(artifact_sum)" != "$ARTIFACTS_BEFORE" ]; then
    { echo "gate: the generated API artifacts were STALE — regenerating changed them:"; git status --short -- $ARTIFACTS; \
      echo "commit the regenerated files (they are now in the working tree)"; } >"$LOG_DIR/api-artifacts-drift.log"
    echo "api-artifacts-drift|1|0" >>"$RES"
    printf '  %-16s %s  %4ss\n' "api-drift" FAIL 0
  fi

  # ---- 3. test -------------------------------------------------------------
  echo "[3/3] tests"
  if [ $CHANGED -eq 1 ]; then
    TS="pnpm exec dotenv -e .env.test -- vitest run --changed $BASE --exclude '**/integration/**' --exclude '**/e2e/**' --passWithNoTests && pnpm --filter @arcaai/vox --filter @arcaai/admin-console exec vitest run --changed $BASE --passWithNoTests"
  elif [ $COVERAGE -eq 1 ]; then
    # `pnpm test:unit`, spelled out so each of its three Vitest runs can write its own report
    TS="pnpm exec dotenv -e .env.test -- vitest run --exclude '**/integration/**' --exclude '**/e2e/**' $(vcov workspace) && pnpm --filter @arcaai/vox exec vitest run $(vcov vox) && pnpm --filter @arcaai/admin-console exec vitest run $(vcov admin-console)"
  else
    TS="pnpm test:unit"
  fi
  STEPS=("ts-unit=$TS")
  changed packages/database && STEPS+=("db-test=pnpm --filter @arcaai/database exec vitest run $(vcov database)")
  changed apps/harness packages/py-* && STEPS+=("harness-py=cd apps/harness && $PY -m pytest -q $(pyxdist) $(pycov harness) src/harness/tests/unit")
  changed apps/guardrail packages/py-* && STEPS+=("guardrail-py=cd apps/guardrail && $PY -m pytest -q $(pyxdist) $(pycov guardrail) src/guardrail/tests")
  changed apps/text packages/py-* && STEPS+=("text-py=cd apps/text && $PY -m pytest -q $(pyxdist) $(pycov text) src/text/tests/unit")
  par "${STEPS[@]}"
fi

# ---- summary ----------------------------------------------------------------
echo
printf '%-16s %-5s %6s\n' STEP RESULT TIME
FAILED=0
while IFS='|' read -r n rc s; do
  printf '%-16s %-5s %5ss\n' "$n" "$([ "$rc" = 0 ] && echo ok || echo FAIL)" "$s"
  [ "$rc" = 0 ] || { FAILED=1; echo "    ↳ $LOG_DIR/$n.log"; }
done <"$RES"
echo "total ${SECONDS}s"

if [ $COVERAGE -eq 1 ] && [ -n "$(ls -A "$COV_DIR" 2>/dev/null)" ]; then
  echo
  python3 - "$COV_DIR" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
rows = []
for d in sorted(root.iterdir()):
    ts, py = d / "coverage-summary.json", d / "coverage.json"
    if ts.exists():
        t = json.loads(ts.read_text())["total"]
        rows.append((d.name, t["lines"]["pct"], t["branches"]["pct"], t["functions"]["pct"], t["lines"]["total"]))
    elif py.exists():
        t = json.loads(py.read_text())["totals"]
        rows.append((d.name, t["percent_covered"], None, None, t["num_statements"]))
fmt = lambda v: "   -  " if v is None else f"{v:5.1f}%"
print(f"{'COVERAGE':16} {'LINES':>6} {'BRANCH':>6} {'FUNCS':>6} {'SIZE':>7}")
for name, lines, br, fn, size in rows:
    print(f"{name:16} {fmt(lines)} {fmt(br)} {fmt(fn)} {size:7d}")
print(f"html: {root}/<suite>/html/index.html (Vitest: {root}/ts-<suite>/index.html)")
PY
fi
exit $FAILED
