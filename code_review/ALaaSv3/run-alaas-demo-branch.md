# Run ALaaS v3.0 (demo branch) — quick start

**Repo:** `/Users/apple/repos/VOX/ALaaSv3.0`  
**Branch:** `demo-branch` (checked out)  
**Assumptions:** `.env` files for **`apps/audio-stream-svc`** and **`apps/web_ui`** are already updated. Do not commit secrets/tokens.

> **Prerequisites (must be ready before testing full consultation flow):**
> - Node.js/npm installed (audio-stream-svc requires **Node >= 22** per `apps/audio-stream-svc/package.json`).
> - Dependencies/credentials available (e.g. `GITHUB_TOKEN` with `read:packages` if `@arcaai/*` packages need to be installed from GitHub Packages).
> - Required services reachable as per your env: **HOPE gateway**, **PostgreSQL**, **Redis**, HOPE identity mapping/config, etc. (`audio-stream-svc` may fail at boot if HOPE/DB/Redis/config is unavailable).
> - For **live microphone recording** in browser, `apps/mmr_agent` (audio agent sidecar, default `http://localhost:5001`) must also be running and accessible. `web_ui` live audio WS is hardcoded to `ws://localhost:5001/audio_stream`.

---

## Terminal 1 — Run backend (`audio-stream-svc`)

```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/audio-stream-svc

# Free port 4000 if already in use
lsof -ti :4000 | xargs kill -9 2>/dev/null

# Install dependencies and build
npm install
npm run build

# Start dev server
npm run start:dev
```

**Expected:** Backend starts on `http://localhost:4000` (or the port configured in `apps/audio-stream-svc/.env` / `PORT`).

**Quick checks (optional, in another terminal):**
```bash
curl -s http://localhost:4000/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/v1/consultation/protocol
```

---

## Terminal 2 — Run frontend (`web_ui`)

```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/web_ui

# Install dependencies
npm install

# Start Vite dev server
npm run dev
```

**Expected:** Frontend opens on `http://localhost:5173`.

> Ensure `apps/web_ui/.env` points to the backend (e.g. `VITE_API_BASE_URL=http://localhost:4000`) and `VITE_API_KEY` matches backend `API_KEY` if required by your setup.

---

## Recommended run order

1. Ensure infra/dependencies are up (HOPE, PostgreSQL, Redis as configured).
2. **(If doing live recording)** Start `apps/mmr_agent` (audio stream/mic sidecar) first so mic capture is available on `localhost:5001`.
3. **Terminal 1:** Start `audio-stream-svc` (backend).
4. **Terminal 2:** Start `web_ui` (frontend).

Stop in reverse order (frontend → backend → mmr_agent).

---

## Optional — run mmr_agent for live mic/audio capture

If you need real microphone streaming during consultation:

```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/mmr_agent

# Activate your Python/conda environment (recommended)
# conda activate <your-env>

pip install -r requirements.txt
# Additional packages may be needed per app README (numpy, slowapi, python-jose, passlib, bcrypt, websockets)
pip install numpy slowapi python-jose passlib bcrypt websockets

python src/audio_agent.py
# or: uvicorn src.audio_agent:app --reload --host 127.0.0.1 --port 5001
```

Verify:
```bash
curl -s http://127.0.0.1:5001/health
curl -s http://127.0.0.1:5001/list_mics
```

---

## Notes / troubleshooting
- **Port mismatch:** If backend `PORT` is not `4000`, update the port-free command/URLs and `VITE_API_BASE_URL` accordingly.
- **Boot failures in `audio-stream-svc`:** check HOPE credentials/URL, DB/Redis connectivity, and identity mapping config in `.env`.
- **UI cannot call backend:** verify `VITE_API_BASE_URL` and `VITE_API_KEY` vs backend `API_KEY`.
- **No live audio:** verify `mmr_agent` is running on `5001`, browser mic permissions, and backend/HOPE realtime connectivity.
- **`@arcaai/*` install issues:** export/set `GITHUB_TOKEN` with `read:packages` before `npm install` in `audio-stream-svc`.
