# Day-1 Deployment Runbook — Bootstrap Credentials & Endpoint Correction

| | |
|---|---|
| **Audience** | Whoever brings up a fresh cluster (a namespace that has never been seeded before). |
| **Companion tickets** | `docs/implementation/TASK-763-Day-One-Seed-Data/README.md` §5 (OD-2, OD-4, OD-5) and `docs/implementation/TASK-766-Day-One-Seed-Completeness/README.md` §5 (OD-3) |
| **Scope** | Two things a fresh deploy needs a human to do that the seed deliberately cannot do for itself: (1) provision the first two human credentials, (2) correct the seeded provider/storage endpoints that can only ever be right on the laptop that authored them. |

---

## 1. Why this exists

The seed (`packages/database/src/prisma/db_main/seed/**`) is written to be safe to run
unattended against a database nobody has touched yet (`RUN_SEED="safe"` in production, `all` in
dev/test). Two categories of row are deliberately **CREATE-ONLY** — a re-seed never overwrites
them — which means whatever the seed writes on FIRST BOOT is what production runs until an
operator changes it by hand. Two consequences of that:

1. There is no credential in the database until an operator sets one — the seed refuses to invent
   a password, and refuses to plant a `password123`-style secret in a production seed path.
2. A handful of connection endpoints are seeded with the values that are correct on a developer's
   laptop (`localhost:11434`, `localhost:1234`, `localhost:9000`) — because that is the only
   value the seed can honestly assert without guessing at a cluster's internal DNS. On a fresh
   k3s/staging/production deploy they are wrong until corrected.

Neither gap is a bug to "fix" in the seed — see TASK-763 §5 OD-4/OD-5 and TASK-766 §5 OD-3 for
why. This page is the fix: the concrete, one-time operator sequence.

---

## 2. Bootstrap credentials (first login, human and tenant)

### 2.1 What gets provisioned and by which variables

Two seed phases are **env-driven** and **CREATE-ONLY** (a re-seed never rewrites the row, so a
rotated password survives). Both are gated the same way: absent → no-op; half-set → hard error;
a well-known weak value (including this repo's own `password123`) is refused *before* the length
check, so the error names the real problem instead of inviting a padded variant.

| Phase | Variables | Provisions |
|---|---|---|
| `92-bootstrap-admin.ts` | `BOOTSTRAP_SUPER_ADMIN_EMAIL` (required), `BOOTSTRAP_SUPER_ADMIN_PASSWORD` (required, ≥ 12 chars), `BOOTSTRAP_SUPER_ADMIN_USERNAME` (optional, defaults to `admin`) | The platform's first SUPER_ADMIN, assigned in the SYSTEM tenant. |
| `93-bootstrap-tenant-admin.ts` | `BOOTSTRAP_TENANT_ADMIN_EMAIL` (required), `BOOTSTRAP_TENANT_ADMIN_PASSWORD` (required, ≥ 12 chars), `BOOTSTRAP_TENANT_ADMIN_USERNAME` (optional, defaults to `tenant-admin`), `BOOTSTRAP_TENANT_ADMIN_TENANT_KEY` (optional, defaults to `ARCAAI`) | The first TENANT_ADMIN for the named customer tenant (by `Tenant.key`, not id — it survives a re-provisioned database). `__SYSTEM__` and `__GLOBAL__` are refused as targets. |
| `94-service-account.ts` | `BOOTSTRAP_SERVICE_ACCOUNT_SECRET` (optional, ≥ 32 chars) | A **working** day-1 secret for the ArcaAI tenant's already-seeded `ARCAAI_ADMIN` service account, so CI/automation can authenticate at `POST /api/v1/auth/service-token` with **no human login at all**. See §2.4 — this is a different shape from the two rows above (single value, no email, no half-configured state) and is documented there in full. |

The first two run in every seeding mode (`safe` and `all`, not `none`) — they are NOT on
`SEED_PHASES_EXCLUDED_FROM_SAFE`, unlike the `*@example.com` demo accounts in `91-user.ts`. That
is deliberate: a `RUN_SEED="safe"` production deploy is exactly the case with no other path to a
first login (see §1). `94-service-account.ts` itself also always runs; only whether it produces a
*working* secret depends on `BOOTSTRAP_SERVICE_ACCOUNT_SECRET`.

**Set these as host environment variables on the machine/job that runs `pnpm db:seed`, never in a
tracked file.** They are deliberately absent from `turbo.json#globalEnv`, from every
`.env.sample`, and from any `SettingDescriptor` — registering a descriptor makes a key *governed
and writable through the settings plane*, which a bootstrap credential must never become. This page
is the only tracked place that names them; do not add them anywhere else (TASK-766 §5 OD-3).

### 2.2 The first-login flow, end to end

```bash
# One-time, against a fresh (never-seeded) database.
BOOTSTRAP_SUPER_ADMIN_EMAIL='ops@yourcompany.example' \
BOOTSTRAP_SUPER_ADMIN_PASSWORD='<a real passphrase, >= 12 chars, not a well-known weak value>' \
BOOTSTRAP_TENANT_ADMIN_EMAIL='arcaai-ops@yourcompany.example' \
BOOTSTRAP_TENANT_ADMIN_PASSWORD='<a different real passphrase>' \
RUN_SEED="safe" NODE_ENV=production pnpm db:seed
```

1. The seed logs the username/email it provisioned for both accounts — **never the password**
   (it is never logged, and is not recoverable from the database afterward: only the hash is
   stored).
2. Log in as the SUPER_ADMIN at `POST /api/v1/auth/login` (or the admin console's login screen)
   with the email/password above.
3. As SUPER_ADMIN, issue a service account for machine access if one is needed
   (`POST /api/v1/admin/service-accounts`) — this is the ONLY path to a machine identity for any
   customer tenant OTHER than ArcaAI; there is deliberately no day-1 service account for any other
   customer tenant. For the ArcaAI tenant's own seeded `ARCAAI_ADMIN` service account
   (`94-service-account.ts`, TASK-766 §4.4), setting `BOOTSTRAP_SERVICE_ACCOUNT_SECRET` in the
   SAME seed run as this section gives it a working secret immediately — CI/automation does not
   need to wait for this step at all. See §2.4.
4. Log in as the TENANT_ADMIN the same way to administer the named tenant end to end (users,
   departments, prompt templates, consultations, STT/TTS config, allowed origins — the full list
   is TASK-766 §7 "Can").
5. **Re-running the seed is safe.** A second `pnpm db:seed` with the same variables logs
   `"... already exists — leaving it untouched"` for both phases and changes nothing. Rotate a
   password through the normal admin-console/API flow, never by re-seeding.

### 2.3 What happens if the variables are absent

Nothing — silently, by design. The phase logs that it is skipping and the seed continues. On a
`RUN_SEED="safe"` deploy with no other seeded human credential, this means **the deployment has no
way to log in at all** until someone re-runs the seed with the variables set (§2.2) or writes a
row into Postgres by hand. This is the exact failure mode TASK-763 §2.1 documents as the day-1
headline defect these two phases exist to close — if you hit it, you have skipped this section,
not found a new bug.

### 2.4 Day-1 machine credential for CI/automation (TASK-763 §5 OD-2, RESOLVED 2026-08-20)

TASK-763 originally decided NOT to seed a service-account secret at all — TASK-762's definition of
done forbids a recoverable secret in seed data, and the seed cannot know an operator's intended
secret. TASK-766 closed half the resulting gap by seeding the `ARCAAI_ADMIN` service account's
**authority** (tenant-scoped scopes matching the `TENANT_ADMIN` role, no platform-plane reach) on
every deploy, in every environment — but left its **secret** inert outside dev/test, so a fresh
cluster still had no machine path to administration until a human SUPER_ADMIN logged in and called
`rotate` (§2.2 step 3, pre-2026-08-20).

The 2026-08-20 owner ruling on OD-2 named that residual gap unacceptable: CI/automation needs
machine access from day one, with no human in the loop. The fix keeps both constraints:

- **The secret comes from OUTSIDE the seed.** Set `BOOTSTRAP_SERVICE_ACCOUNT_SECRET` as a host
  environment variable on the machine/job that runs `pnpm db:seed` — same rule as
  `BOOTSTRAP_SUPER_ADMIN_PASSWORD` above: never in a tracked file, never in `turbo.json#globalEnv`,
  never in a `.env.sample`, never a `SettingDescriptor`.
- **What lands in the database is never plaintext.** The seed peppered-HMACs it with
  `API_KEY_PEPPER` (the same construction `ServiceAccountService.exchangeToken` verifies against,
  and the same one the dev/test fixture already used) before it ever reaches the `secretVerifier`
  column. There is no recoverable preimage anywhere in the seed, migration, or fixture tree.
- **Absent, nothing is invented.** No `BOOTSTRAP_SERVICE_ACCOUNT_SECRET` → the account is still
  created with its full tenant-scoped authority, but the verifier is CSPRNG output with no
  preimage — exactly the TASK-766 behaviour, unchanged. The seed log says so and names the
  `rotate` endpoint, same as before.
- **Minimum 32 characters, and the same well-known-value stop-list as the two credentials above**
  (checked before the length rule, so a padded `password123`-style value is still refused).

```bash
# Provision the ArcaAI tenant's day-1 machine credential in the SAME run as §2.2.
BOOTSTRAP_SUPER_ADMIN_EMAIL='ops@yourcompany.example' \
BOOTSTRAP_SUPER_ADMIN_PASSWORD='<a real passphrase>' \
BOOTSTRAP_TENANT_ADMIN_EMAIL='arcaai-ops@yourcompany.example' \
BOOTSTRAP_TENANT_ADMIN_PASSWORD='<a different real passphrase>' \
BOOTSTRAP_SERVICE_ACCOUNT_SECRET='<a high-entropy value, >= 32 chars>' \
RUN_SEED="safe" NODE_ENV=production pnpm db:seed

# CI/automation authenticates immediately — no login, no rotate call:
curl -X POST https://<gateway>/api/v1/auth/service-token \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"hope_svc_a4ca1a11ad3141b0c0de0001","clientSecret":"<the same value>"}'
```

`clientId` is `SEED_SERVICE_ACCOUNT_CLIENT_IDS.ARCAAI_ADMIN` — deterministic, so it does not need
to be read back from the database. The returned token is opaque, short-lived (900s), and carries
exactly the `svc:*` scopes documented in `94-service-account.ts`'s header comment.

**CREATE-ONLY still applies.** This only produces a working secret on the row's FIRST creation.
Setting the variable on a re-seed of an ALREADY-seeded (inert or previously rotated) account
changes nothing — the reconcile branch only ever updates `scopes`, never the credential. To give
an existing inert account a secret after the fact, use `POST .../rotate` as SUPER_ADMIN, same as
before this change.

---

## 3. Correcting the seeded endpoints (provider connections + storage)

Two config-plane tables are seeded **CREATE-ONLY** with values that are only ever right on a
developer laptop. A fresh cluster must correct them once, after first seed and before relying on
the affected capability. Both corrections take effect immediately (no redeploy, no restart) —
each write busts the relevant process-wide cache.

### 3.1 Local LLM engine endpoints (TASK-763 §5 OD-4)

`17-ai-provider-connection.ts` seeds two SYSTEM-tenant rows `enabled: true` (so they serve
Day-1 with no other configuration):

| Row (`service`/`provider`) | Seeded `baseUrl` | Correct value on... |
|---|---|---|
| `llm` / `ollama` | `http://localhost:11434` | a k3s cluster: the in-cluster Service DNS for wherever Ollama actually runs (there is no cluster-run Ollama Service today — either point this at a reachable engine or disable the row, see below) |
| `llm` / `lm-studio` | `http://localhost:1234/v1` | LM Studio is a desktop app; it typically has no cluster equivalent — disable this row on a cluster unless you run an OpenAI-compatible engine at that path |

The `vllm` and `llama-cpp` rows already seed cluster Service DNS (`http://hope-vllm:8000/v1`,
`http://hope-llama-cpp:8080`) and need no correction if those Services exist in the target
cluster.

**When to do this:** before the first live consultation on a fresh cluster, if the tenant's
resolved `text.live` / `text.finalize` / `guardrail.validate` `AiTaskDefault` selects one of these
local engines (check `GET /api/v1/admin/ai-task-defaults` for the winning provider). If every
resolved task default is a cloud provider with a tenant-supplied key, this section does not apply.

**How, as SUPER_ADMIN:**

```bash
# 1. Read the current row + version.
GET /api/v1/admin/providers/llm/ollama

# 2a. Point it at a reachable engine (example: an in-cluster Service).
PUT /api/v1/admin/providers/llm/ollama
If-Match: "<version from step 1>"
{ "baseUrl": "http://hope-ollama:11434", "enabled": true, "expectedVersion": <version> }

# 2b. OR disable it outright if no such engine exists in this deployment —
#     `enabled: false` is a VETO, not merely "unused": it removes the row from
#     resolution in BOTH tiers rather than leaving an enabled-but-unreachable
#     endpoint for the resolver to pick and then fail against at request time.
PUT /api/v1/admin/providers/llm/ollama
If-Match: "<version from step 1>"
{ "enabled": false, "expectedVersion": <version> }
```

Repeat for `llm`/`lm-studio`. `PUT` requires `If-Match` (RFC 7232 — missing → `428`, drift →
`412`); use `expectedVersion: 0` only if the row somehow does not exist yet (it does, from the
seed, so this is normally a real version).

### 3.2 Platform-default object storage endpoint (TASK-763 §5 OD-5)

`05c-platform-storage-config.ts` seeds ONE SYSTEM-tenant row (`bucketId = null`, the platform
fallback tier of `bucket row → tenant default → SYSTEM default → env`) from `MINIO_*` env at seed
time. If `MINIO_ENDPOINT` is unset when the seed runs — which it will be on a cluster that has not
set it yet — the row persists `http://localhost:9000`, and because the row is CREATE-ONLY it will
**never self-correct**; the seed logs "already present — left untouched" on every future re-seed.

**When to do this:** once, on any cluster where object storage is not literally reachable at
`localhost:9000` from the API pod — i.e., every real deployment.

**How, as SUPER_ADMIN:**

```bash
# 1. Read the current row + version.
GET /api/v1/admin/tenants/storage/config/platform

# 2. Correct it.
PUT /api/v1/admin/tenants/storage/config/platform
If-Match: "<version from step 1>"
{
  "provider": "MINIO",
  "endpoint": "https://<real object-store endpoint>",
  "region": "<real region>",
  "forcePathStyle": true,
  "credentialsRef": "platform/storage/minio",
  "expectedVersion": <version>
}
```

Credentials are never accepted in this body — `credentialsRef` is a Vault kv-v2 path; write the
actual `{ "accessKeyId": ..., "secretAccessKey": ... }` JSON to that path directly in Vault. Until
that Vault path is populated, the runtime falls back to the legacy `S3_ACCESS_KEY` /
`S3_SECRET_KEY` secrets, which is what keeps a dev box working with zero extra setup — do not
treat that fallback as acceptable on a production cluster.

---

## 4. Checklist

- [ ] `BOOTSTRAP_SUPER_ADMIN_EMAIL` / `_PASSWORD` set as host env on the seed job; seed run once
- [ ] `BOOTSTRAP_TENANT_ADMIN_EMAIL` / `_PASSWORD` (and `_TENANT_KEY` if not ArcaAI) set; seed run
- [ ] `BOOTSTRAP_SERVICE_ACCOUNT_SECRET` set (≥ 32 chars) if CI/automation needs the ArcaAI
      `ARCAAI_ADMIN` service account's secret from day 1, with no human login (§2.4)
- [ ] First SUPER_ADMIN login verified
- [ ] First TENANT_ADMIN login verified for each customer tenant that needs one
- [ ] If §2.4 was used, the day-1 service-account token exchange verified
      (`POST /api/v1/auth/service-token` with the ArcaAI `clientId` + the same secret)
- [ ] `GET /api/v1/admin/providers/llm/ollama` and `.../llm/lm-studio` reviewed; corrected or
      disabled if this cluster does not run those engines at `localhost`
- [ ] `GET /api/v1/admin/tenants/storage/config/platform` reviewed; `endpoint`/`region` corrected
      if this cluster's object store is not `localhost:9000`
- [ ] Vault path `platform/storage/minio` (or whatever `credentialsRef` names) populated with real
      credentials before relying on platform-default storage

## Related

- `docs/implementation/TASK-763-Day-One-Seed-Data/README.md` — the seed audit that found these
  gaps (§5 OD-2 — RESOLVED 2026-08-20, see §2.4 above —, OD-4, OD-5)
- `docs/implementation/TASK-766-Day-One-Seed-Completeness/README.md` — the tenant-level bootstrap
  (§5 OD-3; §5 OD-2 there is the unrelated tenant-plan/ENTERPRISE decision)
- `packages/database/src/prisma/db_main/seed/94-service-account.ts` — the implementation (see its
  "OD-2 revisited, 2026-08-20" docblock section) and `__tests__/service-account-seed.test.ts` for
  the pinned tests
- `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers — why these are seed-time/env
  and never a `SettingDescriptor`
