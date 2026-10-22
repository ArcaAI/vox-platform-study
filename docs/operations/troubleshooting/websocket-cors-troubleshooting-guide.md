# WebSocket CORS & Allowed Origins Troubleshooting Guide

### Scope & System Context
* **Affected Service:** `hope-api-gateway` (`SttWsGateway` / `OriginRegistryService`)
* **Impacted Surfaces:** Live Transcription Playground (`/playground/live-transcription`), Consultation Scribe (`/playground/consultation`), and real-time streaming WebSocket endpoints (`/ws/stt/live`, `/ws/transcribe`).

---

## 1. Problem Description

When users access the HOPE web application from a domain (e.g., `https://vox2.arcaai.com`), real-time streaming audio sessions fail to establish. The browser client enters a reconnect loop and displays:

```text
Connecting to live session...
Reconnecting (attempt 1/4)...
Reconnecting (attempt 2/4)...
Session error: Live session expired or unauthorized.
```

In the browser DevTools Console / Network tab:
* The HTTP Upgrade handshake to `wss://vox2.arcaai.com/ws/stt/live` is closed immediately with **HTTP 403 Forbidden** or WebSocket close code **`4003`** (`Origin rejected`).

---

## 2. Root Cause Analysis

The HOPE API Gateway implements **Cross-Site WebSocket Hijacking (CSWSH)** validation:

1. When a browser client opens a WebSocket connection, it sends the standard `Origin` header (e.g. `Origin: https://vox2.arcaai.com`).
2. The gateway's `OriginRegistryService` inspects the tenant's approved origin patterns stored in PostgreSQL table `core."TenantAllowedOrigin"`.
3. If the incoming `Origin` does not match any registered pattern for the tenant (or the platform-wide wildcard list), the gateway rejects the handshake.
4. Initially, only `*.bcmch.org` and localhost patterns were registered for tenant `50000000-0000-0000-0000-000000000001`, causing all traffic originating from `arcaai.com` subdomains to be blocked.

---

## 3. Diagnostic Procedures

### Step 1: Check Gateway Logs for Rejection Events
Run the following command against the gateway container:
```bash
kubectl logs -n project-hope-vox -l app.kubernetes.io/name=api-gateway -c gateway --tail=100 | grep -i "origin"
```

**Signature Log:**
```text
[SttWsGateway] Rejecting WebSocket connection: origin 'https://vox2.arcaai.com' is not permitted for tenant '50000000-0000-0000-0000-000000000001'.
```

### Step 2: Query Existing Allowed Origins in PostgreSQL
```bash
kubectl exec -n project-hope-vox-infra postgres-pgvector-db-0 -- psql -U postgres -d hope -c \
  'SELECT id, "tenantId", origin, label, "resourceStatus" FROM core."TenantAllowedOrigin";'
```

---

## 4. Resolution Steps

### Option A: Via Admin Console UI (Recommended)

1. Open **Admin Console** &rarr; **Security** &rarr; **Allowed Origins** (`/admin/allowed-origins`).
2. Click **Add Allowed Origin** and register the exact application URL:
   * **Origin:** `https://vox2.arcaai.com`
   * **Label:** `ArcaAI Vox2 Web App`
   * **Description:** `Frontend portal for live transcription and consultation playgrounds`
3. Click **Add Allowed Origin** again to register the wildcard subdomain pattern:
   * **Origin:** `https://*.arcaai.com:*`
   * **Label:** `ArcaAI Subdomains (Wildcard)`
   * **Description:** `Allows all subdomains and dynamic client ports`
4. Click **Register origin** to save.

---

### Option B: Via Direct SQL Query

Execute the following SQL insertion on the infra PostgreSQL cluster:

```bash
kubectl exec -n project-hope-vox-infra postgres-pgvector-db-0 -- psql -U postgres -d hope -c "
INSERT INTO core.\"TenantAllowedOrigin\" 
  (\"id\", \"tenantId\", \"origin\", \"label\", \"resourceStatus\", \"createdAt\", \"updatedAt\") 
VALUES 
  (gen_random_uuid(), '50000000-0000-0000-0000-000000000001', 'https://vox2.arcaai.com', 'ArcaAI Vox2 Web App', 'ENABLED', NOW(), NOW()),
  (gen_random_uuid(), '50000000-0000-0000-0000-000000000001', 'https://*.arcaai.com:*', 'ArcaAI Subdomains (Wildcard)', 'ENABLED', NOW(), NOW()),
  (gen_random_uuid(), '50000000-0000-0000-0000-000000000001', 'https://console.arcaai.com', 'ArcaAI Console', 'ENABLED', NOW(), NOW())
ON CONFLICT (\"origin\", \"tenantId\") DO NOTHING;
"
```

---

## 5. Verification

1. **Verify Gateway Cache Reload:**
   The `OriginRegistryService` polls the database and automatically reloads active origins. Check the logs:
   ```bash
   kubectl logs -n project-hope-vox -l app.kubernetes.io/name=api-gateway -c gateway --tail=50 | grep -i "allowed origins"
   ```
   **Expected Confirmation:**
   ```text
   [OriginRegistryService] Tenant allowed origins cache reloaded. Total entries: 18 (was: 15)
   ```

2. **Verify in Browser:**
   * Go to `https://vox2.arcaai.com/playground/live-transcription`.
   * Click **Start Session**.
   * Status transitions to **`🟢 Connected / Ready`** and audio streams without disconnection.
