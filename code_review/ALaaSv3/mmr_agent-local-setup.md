# ALaaS `mmr_agent` local setup/start (macOS, `sks_local_laptop`)

## What `mmr_agent` is
- Local **multi-mic audio capture sidecar** for ALaaSv3.0 (`ALaaSv3.0/apps/mmr_agent`).
- FastAPI service (default `http://localhost:5001`) running on the machine with microphones.
- Lists/selects mics, applies DSP (Pedalboard), persists settings in `dspsettings.json`, and streams audio chunks to `web_ui` (WS `ws://localhost:5001/audio_stream`); `web_ui` forwards frames to `audio-stream-svc` (`/ws/consultation`).
- Does **not** talk directly to HOPE, Azure, Redis, or Postgres.
- Source/docs: `ALaaSv3.0/apps/mmr_agent/README.md`, `ALaaSv3.0/docs/apps/mmr_agent.md`, `ALaaSv3.0/docs/LOCAL_DEV_WITH_HOPE.md` (§2.6).

## Why mic selection fails without it
`web_ui` (EntryPoint) authenticates/fetches mics from the audio agent (`POST http://localhost:5001/token`, `GET /list_mics`, etc. via `VITE_AUDIO_AGENT_BASE_URL`). If `mmr_agent` is not running you will see:
- `POST http://localhost:5001/token net::ERR_CONNECTION_REFUSED`
- `Authentication error: Failed to fetch`
- `Error fetching mics from agent: Failed to authenticate with audio agent`

## Prerequisites (this laptop)
- Python 3.x (`python3 --version` available). Python 3.14 used on this machine.
- **PortAudio** installed for `sounddevice` on macOS (Homebrew): `/opt/homebrew/bin/brew list portaudio` present.
- `web_ui` configured to reach agent: `ALaaSv3.0/apps/web_ui/.env` → `VITE_AUDIO_AGENT_BASE_URL=http://localhost:5001`, `VITE_AUDIO_AGENT_WS_URL=ws://localhost:5001`.
- Agent config/CORS: `ALaaSv3.0/apps/mmr_agent/audio_agent_config.ini` (`allowed_origin` includes `http://localhost:5173`, host/port default `0.0.0.0:5001`).

## Setup (one-time, in repo app dir)
```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/mmr_agent

# create venv (recommended; isolates deps)
python3 -m venv .venv
source .venv/bin/activate

pip install --upgrade pip
pip install -r requirements.txt
# README notes source may also require:
pip install numpy slowapi python-jose passlib bcrypt websockets
```

### Dependency compatibility note (observed locally)
With `passlib==1.7.x` (via deps) and `bcrypt>=4/5`, startup failed during auth hash init:
- `AttributeError: module 'bcrypt' has no attribute '__about__'`
- `ValueError: password cannot be longer than 72 bytes...` (passlib/bcrypt backend issue)

**Workaround applied in `.venv`:**
```bash
source .venv/bin/activate
pip install "bcrypt<4"
```
(Installed `bcrypt-3.2.2` in local venv; do not commit `.venv`.)

## Start
```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/mmr_agent
source .venv/bin/activate
python src/audio_agent.py
# alternative (if desired): uvicorn src.audio_agent:app --reload --host 127.0.0.1 --port 5001
```
Background/startup logging (workspace convention):
```bash
LOG="/Users/apple/repos/VOX/review/ALaaSv3/deploy_console_20261114.log"
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/mmr_agent
source .venv/bin/activate
nohup python src/audio_agent.py >> "$LOG" 2>&1 & echo MMR_PID=$!
```

## Verify
```bash
# listener
lsof -nP -iTCP:5001 -sTCP:LISTEN

# health and mic list
curl -sS http://localhost:5001/health; echo
curl -sS http://localhost:5001/list_mics; echo
```
Expected: `:5001` listening, `/health` returns healthy JSON, `/list_mics` returns `{"mics":[...]}` (may be empty if no devices/permissions).

## Troubleshooting
- **`ERR_CONNECTION_REFUSED` on `:5001` / mic selection broken:** agent not running or crashed on startup. Check log/tail and run in foreground (`python src/audio_agent.py`) to see traceback.
- **`ModuleNotFoundError: No module named 'sounddevice'` (or other deps):** venv not activated or deps not installed. Re-run install steps; ensure `brew install portaudio` if PortAudio/sounddevice build/runtime fails.
- **`bcrypt`/`passlib` startup errors:** use `pip install "bcrypt<4"` in the venv (see compatibility note above).
- **Port already in use:** `lsof -nP -iTCP:5001 -sTCP:LISTEN`; stop conflicting process or change port/config consistently with `VITE_AUDIO_AGENT_BASE_URL`.
- **CORS/origin issues from UI:** ensure `audio_agent_config.ini` `allowed_origin` includes `http://localhost:5173` and restart agent.
- **Auth/token issues:** UI fetches token from agent before mic list; verify `/token` flow, env/config secrets (`AUDIO_AGENT_SECRET_KEY`, `ADMIN_PASSWORD` defaults in `audio_agent_config.ini` are dev-only).
- **No mics returned / OS permission denied:** check macOS microphone permissions for terminal/Python, and that input devices are available.
- **ALaaS still not recording/consulting end-to-end:** `mmr_agent` only captures/streams mics. Consultation flow also needs `web_ui`, `audio-stream-svc` (`:4000`), ALaaS DB/Redis (`5433/6380`), HOPE API (`:8868`) and HOPE downstream services/providers ready.

## Current local status (2026-11-15, `ALaaSv3.0` branch `sks_local_laptop`)
- `mmr_agent` started via `.venv` on `:5001` and verified (`/health` healthy, `/list_mics` returned local mics).
- `audio-stream-svc` (`:4000`) and `web_ui` (`:5173`) running; HOPE API healthy on `:8868` (attach `127.0.0.1:9229`).
- Terminal output logged to `review/ALaaSv3/deploy_console_20261114.log`.
- Note: `apps/mmr_agent/.venv/` and local `.env` backups/edits are local working-tree artifacts; do not commit secrets or env files.
