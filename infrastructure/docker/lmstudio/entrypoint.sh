#!/usr/bin/env bash
# =============================================================================
# TASK-824 — LM Studio (`llmster`) serving entrypoint
# =============================================================================
# Every rule below was MEASURED against llmster 0.0.23-1 in a container on
# 2026-08-30, not inferred from docs. Where a measurement contradicts the
# ticket, the measurement is followed and the contradiction is named.
#
# THE ONE RULE THAT GOVERNS THIS WHOLE FILE:
#
#   `lms` EXITS 0 WHETHER OR NOT THE THING YOU ASKED ABOUT IS TRUE.
#
#   Measured:  `lms server status`  -> exit 0 BEFORE the daemon even exists
#              `lms daemon status`  -> exit 0 for "LM Studio is not running"
#                                      AND for "llmster v0.0.23+1 is running"
#              `lms runtime select` -> exit 0 selecting a CUDA engine on a
#                                      machine with NO GPU AT ALL
#
#   So EVERY gate here matches OUTPUT TEXT, never `$?`. This is the same
#   failure shape as §4.11's HTTP hazard (200 for unknown paths -> check the
#   body) reappearing one layer down in the CLI. Do not "simplify" any check
#   below into an exit-code test.
#
#   ⚠️ README §4.7's published wait-loop is broken by exactly this:
#        for _ in $(seq 1 60); do lms server status >/dev/null 2>&1 && break; ...
#      `lms server status` exits 0 immediately, so the loop breaks on its FIRST
#      iteration and never waits for anything. Every later command then races
#      the daemon. Fixed at A-1 below.
#
# Boot order:
#   A-0  refuse to start unless the model volume is verified        (§3.3, §5 L-4)
#   A-1  daemon up, then WAIT — on output, not exit code            (§4.2)
#   A-2  select AND verify the accelerator                          (§4.1, §8.4)
#   A-3  publish weights; assert every expected key is visible      (§4.10)
#   A-5  start HTTP with explicit --port AND --bind                 (§4.2)
#   A-6  preload after the server                                   (§4.3)
#   A-7  hold PID 1, drain on SIGTERM                               (§5 L-5)
#
# Exit 78 (EX_CONFIG) for every assertion failure, so a misconfiguration is
# distinguishable from a crash in `kubectl describe`.
# =============================================================================
set -euo pipefail

PORT="${LMS_PORT:-1234}"
BIND="${LMS_SERVER_HOST:-0.0.0.0}"
# DATA_DIR is the PVC ROOT. The sentinel lives here, NOT under models/, because
# the sync Job mounts the same PVC at /models and writes "${DEST}/.ready" — i.e.
# the volume root. The Deployment's await-models initContainer checks the same
# path from its own mount. All three must agree on the root; they did not in an
# earlier draft of this file, which would have made every pod fail A-0 forever.
DATA_DIR="${HOPE_DATA_DIR:-/data}"
MODELS_DIR="${HOPE_MODELS_DIR:-/data/models}"
STAGING_DIR="${HOPE_STAGING_DIR:-/data/staging}"
EXPECT_ACCEL="${HOPE_EXPECT_ACCEL:-cuda}"
IMPORT_MAP="${HOPE_IMPORT_MAP:-/manifest/imports.tsv}"
EX_CONFIG=78

log()  { printf '%s entrypoint: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die()  { log "FATAL: $*"; exit "${EX_CONFIG}"; }

# -----------------------------------------------------------------------------
# A-7 — registered first so it covers every stage below.
# -----------------------------------------------------------------------------
# The Service has already dropped this endpoint (preStop sleep), so no NEW
# request can arrive while `lms server stop` drains the in-flight ones.
shutdown() {
  log "SIGTERM received — draining in-flight generations"
  lms server stop >/dev/null 2>&1 || true
  lms daemon down >/dev/null 2>&1 || true
  exit 0
}
trap shutdown TERM INT

# -----------------------------------------------------------------------------
# A-0. The model volume must be verified before anything else happens.
# -----------------------------------------------------------------------------
# The sync Job writes `.ready` ONLY after every object passed its prefix's
# SHA256SUMS. Refusing here — rather than serving whatever is on the volume —
# is what stops a half-synced or corrupted model reaching a clinician. The
# `await-models` initContainer is the belt to this braces.
if [ "${HOPE_REQUIRE_READY:-1}" = "1" ]; then
  [ -f "${DATA_DIR}/.ready" ] || die \
    "${DATA_DIR}/.ready is absent — the model volume is not verified. The sync \
Job has not completed, or it failed closed. Refusing to serve."
  log "model volume verified at $(cat "${DATA_DIR}/.ready")"
fi

# `~/.lmstudio/models` is a symlink to ${MODELS_DIR} baked into the image; an
# empty volume leaves it dangling and every write fails with a confusing ENOENT.
mkdir -p "${MODELS_DIR}" "${STAGING_DIR}"

# -----------------------------------------------------------------------------
# A-1. Daemon, then wait — on OUTPUT.
# -----------------------------------------------------------------------------
# `lms daemon up` forks and exits (§4.2): it prints a PID and returns, and no
# --foreground flag exists anywhere in `lms`. That is the entire reason this
# wrapper exists. Every later `lms` call talks to the daemon over the unix
# socket in ~/.lmstudio/.internal/ — which is why .internal stays in the image
# and never on a network volume (§4.4).
log "starting llmster daemon"
lms daemon up || true

daemon_up=0
for _ in $(seq 1 "${HOPE_DAEMON_WAIT_SECONDS:-90}"); do
  # MEASURED: "llmster v0.0.23+1 is running (PID: 16)" vs "LM Studio is not
  # running" — both exit 0. The text is the only signal.
  if lms daemon status 2>/dev/null | grep -q 'is running'; then daemon_up=1; break; fi
  sleep 1
done
[ "${daemon_up}" = "1" ] || die \
  "llmster daemon did not report 'is running' within ${HOPE_DAEMON_WAIT_SECONDS:-90}s."
log "daemon up: $(lms daemon status 2>/dev/null | head -1)"

# -----------------------------------------------------------------------------
# A-2. ACCELERATOR — the runtime half of README §0 risk A-3.
# -----------------------------------------------------------------------------
# The Dockerfile closes the BUILD half (a CPU tarball cannot satisfy the pinned
# +cuda12 SHA-512). It CANNOT close these three, all of which yield a server
# that starts, serves and answers on CPU with no error anywhere:
#
#   (i)   MEASURED, AND NOT IN THE TICKET: the bundle ships BOTH engines and
#         SELECTS THE CPU ONE BY DEFAULT. On the arm64 bundle, a fresh
#         container reports:
#             llama.cpp-linux-arm64@2.31.2                  <-- SELECTED
#             llama.cpp-linux-arm64-nvidia-cuda13@2.31.2
#         So shipping the right bundle is NECESSARY BUT NOT SUFFICIENT. Without
#         an explicit `lms runtime select`, a correct CUDA image runs on CPU.
#         This is a second, independent silent-CPU path beyond §4.1's.
#   (ii)  the pod lands without runtimeClassName: nvidia / nvidia.com/gpu;
#   (iii) the node driver is below the 550.54.14 floor.
#
# §8.4 establishes this is UNDETECTABLE OVER HTTP — /api/v1/models reports
# `format: "gguf"`, a weights format, not an accelerator, and no
# /api/v1/(runtime|engine|system|server) path exists. This block is therefore
# the ONLY place in the platform where a silent CPU-only deployment is caught.
if [ "${EXPECT_ACCEL}" != "none" ]; then

  engines="$(lms runtime ls 2>/dev/null || true)"
  [ -n "${engines}" ] || die "\`lms runtime ls\` returned nothing — cannot verify the accelerator."
  log "installed engines:"; printf '%s\n' "${engines}" | sed 's/^/    /' >&2

  # 1. Is an accelerated engine even present? If not, this is the wrong bundle.
  target_engine="$(printf '%s\n' "${engines}" \
    | grep -i "${EXPECT_ACCEL}" \
    | awk '{print $1}' | sed 's/@.*//' | head -1 || true)"

  if [ -z "${target_engine}" ]; then
    die "no engine matching '${EXPECT_ACCEL}' is installed. This image was built from \
the WRONG BUNDLE — it is CPU-only and would serve happily at a fraction of the \
throughput. Build info: $(cat "${HOME}/.lmstudio/hope-build-info.json" 2>/dev/null || echo unknown)"
  fi

  # 2. Select it. MEASURED: this succeeds on a machine with no GPU, so it
  #    proves selection ONLY — never GPU presence. Step 3 does that.
  log "selecting accelerated engine '${target_engine}'"
  lms runtime select "${target_engine}" --latest >/dev/null 2>&1 \
    || lms runtime select "${target_engine}" >/dev/null 2>&1 \
    || die "failed to select engine '${target_engine}'"

  # 3. Is there actually a GPU? MEASURED shape of `lms runtime survey --json`:
  #      hardwareSurvey.gpuSurveyResult.result.code = "noDevicesFound"
  #      memoryInfo.vramCapacity = 0
  #    on a GPU-less host. vramCapacity is the cleanest assertion target.
  survey="$(lms runtime survey --json 2>/dev/null || lms runtime survey 2>/dev/null || true)"
  [ -n "${survey}" ] || die "\`lms runtime survey\` returned nothing — GPU presence is UNVERIFIABLE."

  gpu_ok=1
  printf '%s' "${survey}" | grep -q 'noDevicesFound'  && gpu_ok=0
  printf '%s' "${survey}" | grep -q 'No GPUs detected' && gpu_ok=0
  printf '%s' "${survey}" | grep -Eq '"vramCapacity"[[:space:]]*:[[:space:]]*0[,}]' && gpu_ok=0

  if [ "${gpu_ok}" != "1" ]; then
    msg="NO GPU DETECTED. The '${EXPECT_ACCEL}' engine is installed and selected, but the \
hardware survey reports no device — so this pod would serve ON CPU, silently, and no \
HTTP endpoint could ever reveal it (§8.4). Check runtimeClassName: nvidia, the \
nvidia.com/gpu request AND limit, and driver >= 550.54.14. Survey: \
$(printf '%s' "${survey}" | tr -d '\n' | head -c 400)"
    [ "${HOPE_ACCEL_ENFORCE:-strict}" = "strict" ] && die "${msg}"
    log "WARNING: ${msg}"
  else
    log "accelerator OK — '${target_engine}' selected and a GPU is present"
  fi

  # 4. Re-assert the tick landed on the accelerated engine. WARNING ONLY, on
  #    purpose: `lms runtime ls` marks the selection with a UTF-8 '✓', and a
  #    locale or terminal-encoding quirk could make this grep miss a selection
  #    that actually succeeded. Steps 1-3 already establish the load-bearing
  #    facts (an accelerated engine exists, selecting it returned success, and a
  #    GPU is physically present), so failing the boot on a decorative glyph
  #    would trade a real risk for a false one.
  if ! lms runtime ls 2>/dev/null | grep -i "${EXPECT_ACCEL}" | grep -q '✓'; then
    log "WARNING: could not confirm the '✓' is on the '${EXPECT_ACCEL}' engine. \
Selection reported success and a GPU is present, so this is most likely an \
encoding artefact — but check 'lms runtime ls' if throughput looks like CPU."
  else
    log "selection confirmed on the '${EXPECT_ACCEL}' engine"
  fi
fi

# -----------------------------------------------------------------------------
# A-3. PUBLISH WEIGHTS — README §4.10, corrected by measurement.
# -----------------------------------------------------------------------------
# §4.10 concludes, from three pieces of evidence, that a GGUF dropped on the
# volume "is simply not visible" and that `lms import` is therefore mandatory.
# The three pieces of evidence are each CORRECT — there is no rescan verb in
# `lms`, no rescan RPC, and no rescan concept in the docs — but the INFERENCE
# drawn from them does not hold.
#
#   MEASURED, llmster 0.0.23-1, 2026-08-30:
#     * a GGUF placed at <models>/<publisher>/<model>/x.gguf BEFORE daemon start
#       is indexed at start                       -> `lms ls` shows it
#     * a GGUF dropped there WHILE the daemon runs is indexed within seconds,
#       with no import, no restart and no rescan  -> `lms ls` shows it
#
#   There is no rescan COMMAND because the daemon watches the directory. Those
#   are different claims, and only the first was ever evidenced.
#
# The design therefore PREFERS the simple mechanism and VERIFIES it, keeping
# `lms import` as the repair path rather than the load-bearing step — because
# bug #844 ("models missing until the application is restarted") is open, so
# the watch is observed behaviour, not a guarantee.
#
# THE MODEL KEY IS DERIVED FROM THE DIRECTORY, NOT THE FILENAME.
#   MEASURED: --user-repo hopetest/imported-model on a file named
#   hope-test-model.gguf produced key `text-embedding-imported-model`.
#   This is the §7.4 `sourceUri` trap: `resolveTextSelectionForKey` puts
#   AiModel.sourceUri on the wire as the OpenAI `model` field, so the <model>
#   segment here MUST equal the seed row's sourceUri or every generation 404s.
#
# `lms import` FLAGS — MEASURED, and worse than the ticket feared:
#   Omitting -L/-c/-l does NOT silently move the file in a container. It
#   CRASHES: `-y` suppresses the warning text but the CLI still opens a TTY
#   prompt, and with no TTY it dies with
#     `BadResource: ENOTTY: Not a typewriter` ... exit 1, nothing imported.
#   With -L it works and prints "Hard link created at ...", staging link count
#   1 -> 2, same inode. So -L is mandatory for a different reason than stated,
#   and the assertion below is kept regardless.
publish_and_verify() {
  [ -f "${IMPORT_MAP}" ] || { log "no ${IMPORT_MAP} — nothing to publish"; return 0; }

  # A hard link cannot cross filesystems. Assert rather than discover it at
  # 3am: if -L silently degraded we would be back at the move hazard.
  local stage_dev model_dev
  stage_dev="$(stat -c %d "${STAGING_DIR}" 2>/dev/null || echo x)"
  model_dev="$(stat -c %d "${MODELS_DIR}"  2>/dev/null || echo y)"
  [ "${stage_dev}" = "${model_dev}" ] || die \
    "${STAGING_DIR} (dev ${stage_dev}) and ${MODELS_DIR} (dev ${model_dev}) are on \
DIFFERENT filesystems. \`lms import -L\` hard-links and cannot cross a filesystem \
boundary. Mount both from the SAME PVC."

  local rel_path user_repo expected_key src publisher model_seg before_inode
  while IFS="$(printf '\t')" read -r rel_path user_repo expected_key; do
    case "${rel_path}" in ''|\#*) continue ;; esac
    [ -n "${user_repo:-}" ]    || die "imports.tsv row '${rel_path}' has no <publisher>/<model>"
    [ -n "${expected_key:-}" ] || die "imports.tsv row '${rel_path}' has no expected model key"

    publisher="${user_repo%%/*}"
    model_seg="${user_repo##*/}"
    src="${STAGING_DIR}/${rel_path}"
    [ -f "${src}" ] || die "staged object ${src} is absent but imports.tsv requires it — \
the sync Job and imports.tsv disagree."

    # Already published (by a previous boot, or by the sync writing straight
    # into the tree)? Then do nothing — import is the repair path, not the norm.
    if [ -f "${MODELS_DIR}/${publisher}/${model_seg}/$(basename "${rel_path}")" ]; then
      log "already published: ${user_repo}"
      continue
    fi

    before_inode="$(stat -c %i "${src}")"
    log "importing ${rel_path} as ${user_repo}"
    lms import "${src}" --user-repo "${user_repo}" -y -L \
      || die "\`lms import -L\` failed for ${rel_path}. In a TTY-less container this is \
what omitting -L/-c/-l also looks like (ENOTTY). Do not retry without -L."

    # Trap assertion: if staging vanished, -L did not hard-link and we have
    # destroyed the staging area. Fail now, while the evidence still exists.
    [ -f "${src}" ] || die \
      "staging file ${src} DISAPPEARED after 'lms import -L' — the import MOVED it. \
Staging is inconsistent; do not restart until the sync Job has re-run."
    [ "$(stat -c %i "${src}")" = "${before_inode}" ] \
      || log "WARNING: ${src} changed inode across import — verify it was not rewritten"
  done < "${IMPORT_MAP}"

  # ---- the gate that actually matters -------------------------------------
  # Whether the weights arrived by directory watch or by import, the only thing
  # worth asserting is that llmster can SEE every key we intend to serve. A
  # missing key here is bug #844 manifesting, and it must stop the boot rather
  # than surface later as a 404 on a clinical request.
  local visible missing=0
  visible="$(lms ls 2>/dev/null || true)"
  log "models visible to llmster:"; printf '%s\n' "${visible}" | sed 's/^/    /' >&2
  while IFS="$(printf '\t')" read -r rel_path user_repo expected_key; do
    case "${rel_path}" in ''|\#*) continue ;; esac
    if printf '%s' "${visible}" | grep -qF "${expected_key}"; then
      log "  key OK: ${expected_key}"
    else
      log "  KEY MISSING: ${expected_key}"
      missing=1
    fi
  done < "${IMPORT_MAP}"

  [ "${missing}" = "0" ] || die \
    "one or more expected model keys are NOT visible to llmster. \`apps/text\` puts \
AiModel.sourceUri on the wire as the OpenAI \`model\` field (§7.4), so serving now would \
404 every generation. Check that the <model> segment of each --user-repo equals the \
seed row's sourceUri."
}
publish_and_verify

# -----------------------------------------------------------------------------
# A-5. HTTP layer. BOTH --port AND --bind are mandatory.
# -----------------------------------------------------------------------------
# MEASURED, and stronger than §4.2 states: in a FRESH container the daemon's
# own record reads {"host":"127.0.0.1","port":41343} — loopback on a RANDOM
# high port. `lms server start --help` confirms the port defaults to "the same
# port as the last time it was started", and a fresh container has no last
# time. So omitting --port does not fall back to 1234; it lands somewhere
# unpredictable. Omitting --bind binds loopback, where the k8s Service's
# traffic arrives on no interface at all: the pod looks healthy from inside and
# refuses every request from `apps/text`.
#
# Note also: ~/.lmstudio/.internal/http-server.json is NOT the live serving
# address. MEASURED: it still read 127.0.0.1:41343 after
# `lms server start --port 1234 --bind 0.0.0.0` succeeded. Never read the
# serving port from that file.
log "starting HTTP server on ${BIND}:${PORT}"
lms server start --port "${PORT}" --bind "${BIND}"

# §4.11 / bug #1323, MEASURED — every one of these returned HTTP 200:
#     /lmstudio-greeting        200 {"lmstudio":true}
#     /this-path-does-not-exist 200 {"error":"Unexpected endpoint or method..."}
#     /health                   200 {"error":"Unexpected endpoint or method..."}
#     /totally/bogus            200 {"error":"Unexpected endpoint or method..."}
# A status-code probe therefore passes against a broken server AND against
# paths that do not exist. The BODY is the only signal. This is also why the
# k8s liveness probe is an `exec`, not an `httpGet` — httpGet cannot inspect a
# body, so no httpGet probe on this server can ever fail.
greet_ok=0
for _ in $(seq 1 "${HOPE_SERVER_WAIT_SECONDS:-60}"); do
  if curl -fsS "http://127.0.0.1:${PORT}/lmstudio-greeting" 2>/dev/null \
       | grep -q '"lmstudio":[[:space:]]*true'; then greet_ok=1; break; fi
  sleep 1
done
[ "${greet_ok}" = "1" ] || die \
  "/lmstudio-greeting never returned {\"lmstudio\":true}. (A 200 alone proves nothing \
here — unknown paths return 200 too.)"
log "HTTP server is live on ${BIND}:${PORT}"

# -----------------------------------------------------------------------------
# A-6. Preload. AFTER the server, deliberately.
# -----------------------------------------------------------------------------
# Loading first leaves the container un-probeable for the whole cold read
# (minutes on a cold PVC). Starting the server first lets LIVENESS go green
# early and leaves READINESS as the thing that waits for weights — the correct
# split, because alive-but-not-ready is a pod the Service has rightly removed
# from rotation, not one the kubelet should kill.
#
# §4.3 says to "turn JIT loading off" and gate readiness on /v1/models.
# MEASURED: there is NO JIT control anywhere in the CLI — not on
# `lms server start`, not on `lms load`, not on `lms server`. And with JIT on,
# /v1/models lists every model ON DISK regardless of load state (both test
# models appeared with nothing loaded), exactly as §4.3 warns.
#
# So readiness cannot be /v1/models, and it cannot be an httpGet at all.
# MEASURED alternative: GET /api/v1/models returns per model
#     "key": "...", "loaded_instances": [ { "id": "<--identifier>", ... } ]
# and `loaded_instances` is EMPTY for a model that is merely on disk. That
# field is the real readiness signal, and the k8s readinessProbe execs a grep
# for it. See deployment-llmster/lmstudio.yaml.
if [ -n "${LMS_LOAD:-}" ]; then
  log "preloading ${LMS_LOAD}"
  # --gpu / --ttl / --parallel / --identifier are CLI-ONLY. REST
  # POST /api/v1/models/load accepts only model, context_length,
  # eval_batch_size, flash_attention, num_experts, offload_kv_cache_to_gpu
  # (§4.5) — `parallel` is readable over HTTP but not writable. `--parallel` is
  # the headless Max Concurrent Predictions knob: source-verified, absent from
  # the published docs, default 4, llama.cpp runtime only.
  # shellcheck disable=SC2086
  lms load "${LMS_LOAD}" -y \
    --gpu "${LMS_GPU:-max}" \
    ${LMS_CONTEXT:+--context-length "${LMS_CONTEXT}"} \
    ${LMS_PARALLEL:+--parallel "${LMS_PARALLEL}"} \
    ${LMS_TTL:+--ttl "${LMS_TTL}"} \
    ${LMS_IDENTIFIER:+--identifier "${LMS_IDENTIFIER}"} \
    || die "preload of '${LMS_LOAD}' failed — refusing to serve a pod that would answer \
with an empty loaded_instances[] forever."
  log "loaded instances:"; lms ps 2>&1 | sed 's/^/    /' >&2 || true
fi

# -----------------------------------------------------------------------------
# A-7. Hold PID 1.
# -----------------------------------------------------------------------------
# `lms log stream` is the only long-running foreground command in the CLI, and
# it doubles as container log output. tini is PID 1 (Dockerfile ENTRYPOINT) and
# reaps the daemon's children.
log "ready — holding on 'lms log stream'"
exec lms log stream
