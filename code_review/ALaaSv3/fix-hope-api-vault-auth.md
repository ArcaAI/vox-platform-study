# Fix HOPE API Vault auth timeout (step-by-step commands)

**Context:** During local setup, `project-hope` API (`pnpm api:dev`) failed with:
`VaultSecretsProvider.boot() FATAL: cannot authenticate to Vault (http://localhost:8200) — timeout of 5000ms exceeded. Refusing to start without a Vault session.`

Vault container/health was reachable (`http://localhost:8200/v1/sys/health` returned 200, `vault status` unsealed), but the API could not authenticate within the configured timeout.

Run these **one by one** from a terminal (optionally append output to `review/ALaaSv3/deploy_console_20261113.log`). Stop after each step and check the result before continuing.

---

## 1) Confirm Vault is reachable and unsealed
```bash
cd /Users/apple/repos/VOX/project-hope
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8200/v1/sys/health
docker exec hope-vault vault status
```
**Expected:** HTTP `200` (or initialized/unsealed healthy code) and Vault `Sealed false`, `Initialized true`.  
If not, fix/start Vault first:
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm infra:dev:up
```

## 2) Refresh Vault AppRole credentials in `.env.dev` (and reconcile)
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm infra:dev:up
```
**Expected:** finishes successfully, refreshes `VAULT_ROLE_ID`/`VAULT_SECRET_ID` in `.env.dev`, and reconciles kv-v2 secrets.

**Alternative (refresh-only):**
```bash
cd /Users/apple/repos/VOX/project-hope
./scripts/refresh-vault-creds.sh
```
(Then ensure Vault kv-v2 reconciliation is up to date if needed.)

## 3) Verify AppRole/Vault vars are present in `.env.dev`
```bash
cd /Users/apple/repos/VOX/project-hope
grep -n "^VAULT_ADDR=\|^VAULT_ROLE_ID=\|^VAULT_SECRET_ID=\|^VAULT_WRAPPED_SECRET_ID=\|^VAULT_REQUEST_TIMEOUT_MS=\|^SECRETS_PROVIDER=" .env.dev
```
**Expected:**
- `SECRETS_PROVIDER=vault`
- `VAULT_ADDR=http://localhost:8200`
- `VAULT_ROLE_ID=<non-empty>`
- `VAULT_SECRET_ID=<non-empty>`
- `VAULT_WRAPPED_SECRET_ID=` (blank for local dev raw-secret path)
- `VAULT_REQUEST_TIMEOUT_MS` set (increase in next step if still `5000`)

## 4) Increase Vault request timeout (previous failure was 5000ms)
Edit `/Users/apple/repos/VOX/project-hope/.env.dev` and change:
```ini
VAULT_REQUEST_TIMEOUT_MS=5000
```
to (for example):
```ini
VAULT_REQUEST_TIMEOUT_MS=30000
```

Command option:
```bash
cd /Users/apple/repos/VOX/project-hope
python3 - <<'PY'
from pathlib import Path
p = Path('.env.dev')
s = p.read_text()
old = 'VAULT_REQUEST_TIMEOUT_MS=5000'
new = 'VAULT_REQUEST_TIMEOUT_MS=30000'
if old in s:
    p.write_text(s.replace(old, new))
    print('updated VAULT_REQUEST_TIMEOUT_MS=30000')
else:
    print('VAULT_REQUEST_TIMEOUT_MS=5000 not found; check manually')
PY
```

## 5) Start HOPE API and watch for Vault/auth errors
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm api:dev
```
Leave this running. **Expected:** Nest app boots without `VaultSecretsProvider.boot() FATAL ... cannot authenticate to Vault`.

## 6) In a second terminal, test API health
```bash
curl -s http://localhost:8868/api/v1/health; echo
```
**Expected:** a healthy JSON/response (not empty/no connection).

---

## If it still fails
- Re-run **Step 2** (refresh/reconcile), then restart API.
- Check `pnpm api:dev` logs for specific Vault auth errors (invalid/expired AppRole secret, permission issues, request timeout still too low).
- Try increasing `VAULT_REQUEST_TIMEOUT_MS` further (e.g. `60000`) and restart API.
- Regenerate creds explicitly if needed:
```bash
cd /Users/apple/repos/VOX/project-hope
./scripts/refresh-vault-creds.sh
```
then restart `pnpm api:dev`.

## Local-debug workaround (only if needed and supported by your setup)
If you intentionally want to bypass Vault for local debugging (not the normal dev flow for this repo), you may try setting in `.env.dev`:
```ini
SECRETS_PROVIDER=env
PG_DYNAMIC_CREDS=false
```
Then restart `pnpm api:dev`. Only do this if required secrets are available via env/config for your scenario and you understand it deviates from the Vault-based setup. Revert to `SECRETS_PROVIDER=vault` for the standard flow.

## References
- `review/ALaaSv3/deploy_console_20261113.log` (observed failure and diagnostics)
- `review/ALaaSv3/run-alaas-and-hope-locally-step-by-step.md` (Step 2.3/2.4/2.5 and troubleshooting)
- `project-hope/scripts/dev-infra.sh`, `project-hope/scripts/refresh-vault-creds.sh`, `project-hope/scripts/dev-setup.sh`
