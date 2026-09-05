#!/bin/bash
# ============================================================================
# Stage the e2e STT fixture model (TASK-869)
# ============================================================================
# The live-session e2e specs (`stt-session-cross-tenant`, `streaming-ticket-refresh`,
# the two streaming baselines) need a whisper.cpp model the stack can load
# WITHOUT a Hugging Face credential and WITHOUT a network fetch:
#
#   - no credential, because the platform-default ASR model is an ArcaAI
#     fine-tune in a PRIVATE repo and the test stack holds no Hub token;
#   - no fetch, because `POST audio/transcription-jobs/stream/session` loads the
#     model INLINE and the gateway gives that call 15s. A hub resolve pulls the
#     WHOLE `ggerganov/whisper.cpp` repo (47 files, ~25 min measured), so the
#     session times out long before the weights land.
#
# So the weights are staged into a directory and `AiModel.localPath` points at
# it — the "admin-staged directory" mode `resolve_for_model_config` honours
# before any credential resolution.
#
# USAGE:  ./scripts/stage-e2e-stt-model.sh
# Then put the printed path in `.env.test` as SEED_STT_FIXTURE_LOCAL_PATH and
# re-seed (`RUN_SEED=all NODE_ENV=test pnpm test:db:seed`).
# ============================================================================
set -euo pipefail

REPO='ggerganov/whisper.cpp'
FILE='ggml-large-v3-turbo-q8_0.bin'   # q8_0 — must match the row's `computeType`
DEST="${STT_E2E_MODEL_DIR:-$HOME/.cache/hope/e2e-models/whisper-large-v3-turbo-q8_0}"

PY="${CONDA_PREFIX:-$HOME/miniconda3/envs/arcaenv}/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

mkdir -p "$DEST"
if [ -f "$DEST/$FILE" ]; then
    echo "already staged: $DEST/$FILE"
else
    echo "downloading $REPO/$FILE (~834 MiB, public — no token needed)…"
    "$PY" - "$REPO" "$FILE" "$DEST" <<'PYEOF'
import shutil, sys
from huggingface_hub import hf_hub_download
repo, filename, dest = sys.argv[1], sys.argv[2], sys.argv[3]
# Fetch the ONE file, then copy it out of the hash-keyed snapshot dir: the
# loader is handed a directory and picks the file whose name carries the quant.
shutil.copyfile(hf_hub_download(repo, filename), f"{dest}/{filename}")
PYEOF
fi

echo ""
echo "SEED_STT_FIXTURE_LOCAL_PATH=$DEST"
