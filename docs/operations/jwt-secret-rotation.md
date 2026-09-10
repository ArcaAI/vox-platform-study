# Rotating `JWT_SECRET_KEY`

**Owner:** platform operations · **Status:** current as of 2026-09-10 (TASK-944)

`JWT_SECRET_KEY` is the HS256 secret every HOPE access token is signed and verified
with. This page states the rotation contract, what it costs, and how to do it.

It is the companion to `vault/README.md` §"Rotating a platform secret end to end",
which covers the generic kv-v2 procedure. JWT is called out separately because it is
the one platform secret whose two halves — sign and verify — are exercised by *every*
request, so getting it wrong is an outage rather than a degraded hop.

---

## The contract

> **Rotation is a rolling change. It does NOT require a restart.**
> Both halves resolve the secret from `SecretsService` at the moment they need it, so
> they converge together.
>
> **There is no previous-key grace window.** Tokens signed with the OLD secret stop
> verifying once a node has converged. Every live session gets one 401 and must log in
> again; nothing is lost and no restart is needed.

Concretely:

| Half | Where | How it resolves |
|---|---|---|
| **Sign** — `/auth/login`, `/auth/refresh`, impersonation, SSO/OIDC mint | `AuthController`, `AuthSsoController`, `AdminImpersonationController`, `FederatedAuthService`, `OidcStrategy` | `resolveJwtSecret()` per call |
| **Verify** — every authenticated route | `JwtStrategy`, via passport's `secretOrKeyProvider` | `resolveJwtSecret()` per request |

Both call **one function**: `resolveJwtSecret()` in
`packages/applications/src/services/auth/jwt-secret.ts`. That is the mechanism by which
they cannot diverge — not a convention, not a comment. It reads the boot-warmed sync
cache first and falls back to an async provider fetch when that entry has aged out;
`undefined` is a refusal at every call site (401 on a mint, a verification error on the
guard) and is never replaced by a literal.

### Why there is no grace window

A previous-key window would need a second Vault key, a second descriptor, a
multi-candidate verify path, and an operator procedure for retiring the old key — and
every one of those is a place for a stale secret to keep working longer than intended.
Weighed against a cost of "one re-login per live session, which self-heals", it was not
taken. This is a deliberate decision (TASK-944), not an omission. If a future
requirement makes forced re-login unacceptable — a long-running clinical session that
must not be interrupted mid-consultation, say — that is the trigger to revisit it, and
the change is confined to `resolveJwtSecret` and its callers.

### What this replaced

Before TASK-944, `JwtStrategy` read the secret **once, in its constructor**, and handed
passport the resulting string as `secretOrKey`. The mint paths re-resolved on every
call. Measured on `hope-v2-dev` (2026-09-10) after writing a new value to Vault:

- the sign path picked up the new secret within the SecretsService re-warm (~150 s);
- the verify path never did.

`POST /auth/login` therefore issued tokens that **every authenticated route rejected
with 401**, and it stayed that way until `hope-api` was restarted. Proven inside the pod
by HMAC-ing a freshly issued token against both candidate secrets: the new value had
signed it, and the guard still refused it.

`OidcStrategy` carried the same class of defect with the opposite sign: it substituted a
hard-coded development string when the sync cache was cold, minting tokens no verifier
would ever accept.

---

## Procedure

```bash
# 0. Confirm the name is a registered vault-kv descriptor (fails loudly if not).
pnpm --filter @arcaai/applications build
./scripts/vault-seed-secrets.sh --dry-run --only JWT_SECRET_KEY --allow-non-dev

# 1. Write the NEW value as a new kv-v2 version.
printf '%s' "$NEW_VALUE" | vex vault-0 vault kv put secret/hope/JWT_SECRET_KEY value=-

# 2. Confirm the version moved.
vex vault-0 vault kv metadata get secret/hope/JWT_SECRET_KEY | grep -E 'current_version'

# 3. Announce it, so every gateway node drops its cached entry NOW rather than at TTL.
#    Any node's Redis will do — this is a fan-out channel, not a per-node call.
kubectl -n hope-v2-dev exec deploy/hope-redis -- \
  redis-cli PUBLISH arca:secrets:invalidate '{"key":"JWT_SECRET_KEY"}'

# 4. Verify the announcement had listeners. This MUST be >= your gateway replica count.
kubectl -n hope-v2-dev exec deploy/hope-redis -- \
  redis-cli PUBSUB NUMSUB arca:secrets:invalidate

# 5. Prove sign and verify agree: mint a token and immediately use it.
TOKEN=$(curl -sS -X POST https://<api-host>/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"<user>","password":"<pass>"}' | jq -r .accessToken)
curl -sS -o /dev/null -w '%{http_code}\n' https://<api-host>/api/v1/user/me \
  -H "authorization: Bearer $TOKEN"     # expect 200, NOT 401
```

Step 5 is the whole point: a 401 there is the exact signature of the defect this page
documents, and it is the only check that exercises both halves against each other.

### Expected user impact

Sessions issued before the rotation stop verifying and their holders are returned to
the login screen. Refresh tokens are stored server-side in Redis and are **not** signed
with this secret, but the refresh response mints a new access token, so a refresh
succeeds and the session recovers on its own.

### If step 4 reports 0 subscribers

Then only the TTL re-warm will converge the fleet (bounded by `SECRETS_TTL_SEC`, default
300 s; the re-warm loop runs at half that). Rotation still completes — it is just slower
and less observable. The subscriber is `SecretsInvalidationSubscriber`, registered by
`SecretsModule.forRoot()`; it disables itself with a WARN line naming the channel when
Redis is not configured or unreachable, so check the gateway logs for that line first.

> This measured **0 subscribers** on the live cluster until TASK-944. The channel had
> publishers and `SecretsService` had a consumer method, but nothing ever called it —
> so the propagation path this runbook (and `vault/README.md`) described was inert, and
> only the TTL backstop was real.

---

## Related

- `docs/operations/vault/README.md` — the generic platform-secret rotation procedure,
  AppRole `secret_id` rotation, and the Vault operator runbook.
- `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers — why `JWT_SECRET_KEY`
  is `vault-kv` and why invalidation is the propagation path with TTL as the backstop.
- `packages/applications/src/services/auth/jwt-secret.ts` — the resolver, and the
  reasoning for it, in code.
