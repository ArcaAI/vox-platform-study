import { createHmac, randomBytes } from 'crypto';
import type { CorePrismaClient } from '../../../client';
import { getNodeEnv, type Environment } from '../../../env';
import { SEED_CUSTOMER_TENANT_IDS, SEED_SERVICE_ACCOUNT_CLIENT_IDS, SEED_SERVICE_ACCOUNT_DEV_SECRETS, SEED_SERVICE_ACCOUNT_IDS } from './00-constants';
import { resolveApiKeyPepper } from './api-key-pepper';

/**
 * the day-1 machine identity for the ArcaAI tenant.
 *
 * ## What the owner asked for, and the constraint it collides with
 *
 * *"make sure we have seed data to create service account for ArcaAI tenant"*.
 * definition of done says the client secret is shown ONCE and never
 * persisted recoverably — **"no secret value in any migration, seed, or
 * fixture"** — and therefore decided not to seed one at all,
 * leaving a fresh deploy with no machine path to administration until a human
 * super admin issues an account by hand.
 *
 * ## The resolution: seed the ACCOUNT, not the SECRET
 *
 * A ServiceAccount row is two separable things: an AUTHORITY declaration
 * (client id, display name, scopes, tenant binding, TTL) and a CREDENTIAL
 * (the secret behind `secretVerifier`). Only the second is a secret. So:
 *
 * | Environment | What is seeded | How an operator gets a working secret |
 * |---|---|---|
 * | **development / test** | The row **plus** a deterministic fixture secret from `00-constants`, double-gated exactly like the demo API keys | It is in `SEED_SERVICE_ACCOUNT_DEV_SECRETS` |
 * | **everything else** (incl. `RUN_SEED="safe"`) | The row only. `secretVerifier` is 32 bytes of CSPRNG output **for which no preimage was ever generated** — the account authenticates nothing | `POST /api/v1/admin/service-accounts/:id/rotate`, which returns a fresh secret exactly once |
 *
 * The production row is therefore INERT, not weak: there is no secret to leak
 * because none was ever computed. What the operator is spared is the part that
 * actually needs judgement — deciding the scope set and the tenant binding —
 * and rotation is a single call that answers no questions.
 *
 * Choosing the other option (a deterministic secret gated to dev/test only, and
 * no row at all in production) was rejected because it leaves the production
 * gap exactly where found it, which is the thing was
 * asked to close.
 *
 * ## Why the scope set is DERIVED from the tenant admin's authority
 *
 * A service account's authority IS its scope set — `serviceAccountPolicyRules`
 * builds its CASL ability from the scopes alone, with no user, no role and no
 * database read behind it. So the scope list is not a convenience list; it is
 * the whole privilege decision, and it must be justifiable rather than
 * plausible.
 *
 * The rule applied here: **include `svc:admin:<area>` if and only if EVERY
 * ability it implies is one the seeded `TENANT_ADMIN` role already holds.**
 * That makes the machine identity exactly as powerful as the human tenant
 * administrator it automates — no more — and it is mechanically checkable, so
 * `__tests__/service-account-seed.test.ts` re-derives it rather than trusting
 * the list below. The eighteen `admin:*` areas that fail the rule
 * (`tenant:write`, `role:write`, `rbac-policy:write`, `entitlement`,
 * `ai-model`, `ai-runtime-profile`, `ai-service`, `rate-limit`, `queue`,
 * `scheduler`, `usage`, `platform-metrics`, `pstudio`, `billing`, `changelog`,
 * `storage-key`, `tenant-storage`, `department-agent`) are platform-plane and
 * are deliberately absent — several imply `manage:all` or `manage:Tenant`.
 *
 * `svc:admin:*` and `svc:*` are BOTH deliberately unused: either would hand a
 * tenant-bound credential the platform plane by wildcard expansion.
 *
 * ## OD-2 revisited, 2026-08-20 — CI/automation needs a working secret on day 1
 *
 * decided not to seed a secret, and the resolution above (seed
 * the ACCOUNT, not the SECRET) closed only half the gap: a fresh deploy still
 * had no MACHINE path to administration, because the inert verifier requires a
 * human SUPER_ADMIN to log in and call `rotate` before any automation can
 * authenticate. The owner ruling that day names that residual gap
 * unacceptable — CI/automation needs machine access from day one — while
 * reaffirming the hard constraint that produced the original posture:
 * DoD forbids a recoverable secret in seed data, full stop.
 *
 * Both hold together because they are not in tension: `BOOTSTRAP_SUPER_ADMIN_
 * PASSWORD` (`92-bootstrap-admin.ts`) already proves the shape that satisfies
 * both at once — an operator-supplied value that never touches a tracked file,
 * read once at seed time, turned into a one-way hash before it ever reaches a
 * column. `BOOTSTRAP_SERVICE_ACCOUNT_SECRET` below is that exact shape applied
 * to this credential:
 *
 * | Environment | What the seed does |
 * |---|---|
 * | `BOOTSTRAP_SERVICE_ACCOUNT_SECRET` set (ANY `NODE_ENV`, incl. production/CI) | The operator's value is peppered-HMAC'd via `computeSecretVerifier` — the SAME construction `ServiceAccountService.exchangeToken` verifies against — and written as `secretVerifier`. The account authenticates immediately through `POST /api/v1/auth/service-token`; no human login, no `rotate` call. |
 * | Unset, development/test | Unchanged: the deterministic `SEED_SERVICE_ACCOUNT_DEV_SECRETS` fixture. |
 * | Unset, everywhere else | Unchanged: the inert random verifier — no credential is invented. The log says so and names the `rotate` endpoint. |
 *
 * This satisfies constraint for the same reason the bootstrap admin
 * does: what lands in the database is a peppered HMAC-SHA256 digest with no
 * recoverable preimage anywhere in the seed, migration, or fixture tree — the
 * plaintext lives only in the operator's env/Vault delivery mechanism, which is
 * exactly the class of input `09-infrastructure-devops.md` §Configuration Tiers
 * calls the bootstrap floor (the one input that cannot be read from the system
 * it unlocks). Absence is still absence: unset the variable and a fresh cluster
 * has zero machine-admin path, precisely as before — this adds an opt-in, it
 * does not change the default.
 *
 * Scope is unchanged and deliberately NOT widened to super-admin: the account
 * still carries only `ARCAAI_TENANT_ADMIN_SVC_SCOPES`, exactly the tenant
 * administrator's authority (derivation proven in
 * `__tests__/service-account-seed.test.ts`), because "CI/automation needs
 * machine access" was never a request for platform-plane reach — it is a
 * request that the tenant-scoped reach already designed should not
 * require a human in the loop to activate.
 *
 * The CREATE-ONLY guarantee applies here too: this path only produces a
 * working secret on the row's FIRST creation. An environment that was already
 * seeded inert (or already rotated by a human) is untouched by later setting
 * this variable — the reconcile branch below still only ever updates `scopes`.
 */

/** Reserved SYSTEM tenant — named only so the guard below can state that this account is NOT on it. */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** "Global" — a CUSTOMER tenant used as a platform-admin playground, and never a machine principal's home. */
const GLOBAL_PLAYGROUND_TENANT_ID = '50000000-0000-0000-0000-000000000000';

/**
 * Mirrors `ServiceAccountService.credentialsRefFor(clientId, 'current')`. The
 * row must always be able to say WHERE the credential lives (the entity's
 * `validate()` refuses an empty one), even before anything has been written
 * there — that is the point of a ref rather than a value.
 */
export function credentialsRefFor(clientId: string): string {
  return `service-accounts/${clientId}/current`;
}

/**
 * The ArcaAI tenant-administration scope set.
 *
 * Every entry is `svc:admin:<area>` — the renamespaced form
 * `service-account-scopes.registry.ts` derives from `API_KEY_SCOPE_REGISTRY`
 * at module load. The `→` comment on each line is the ability it implies, and
 * every one of those is held by the seeded `TENANT_ADMIN` role (proven, not
 * asserted, in `__tests__/service-account-seed.test.ts`).
 *
 * ─── Coordination note for (standalone STT + summarization) ────────
 *
 * adds `@RequiredSvcScopes` to the speech-to-text and summarization
 * surfaces. Two facts constrain what this seed could do about that today:
 *
 *  1. `SERVICE_ACCOUNT_SCOPE_REGISTRY` is DERIVED — it contains the 56
 *     `admin:*` strings renamespaced, plus two wildcards, and nothing else.
 *     There is no `svc:stt:*` or `svc:summarization:*` to seed.
 *  2. Seeding a string that is not in the registry would be actively harmful,
 *     not merely useless: `hasServiceAccountScope` is pure string matching, so
 *     the unknown scope WOULD satisfy the guard — while
 *     `serviceAccountPolicyRules` silently SKIPS it, so the request would then
 *     be refused by CASL. A credential that passes the scope gate and fails the
 *     ability gate is the worst of both worlds to debug.
 *
 * The four scopes marked below are the admin-plane STT and
 * summarization areas that exist TODAY, and they are what this account holds.
 * If declares NEW business-plane `svc:` scopes, add them to this array
 * (and to `SVC_SCOPE_IMPLICATIONS` in the test) — that is the one-line
 * insertion point, and the test will fail until the registry actually contains
 * them.
 */
export const ARCAAI_TENANT_ADMIN_SVC_SCOPES = [
  // Identity + access administration
  'svc:admin:user:read', // → read:User
  'svc:admin:user:write', // → manage:User
  'svc:admin:apikey:read', // → read:ApiKey
  'svc:admin:apikey:write', // → manage:ApiKey
  'svc:admin:role:read', // → read:Role (READ only: Role/Policy are GLOBAL tables)
  'svc:admin:tenant:read', // → read:Tenant
  'svc:admin:audit:read', // → read:AuditLog
  // Clinical configuration
  'svc:admin:department:manage', // → manage:Department
  'svc:admin:agent-promotion:manage', // → manage:WorkflowDefinition (cross-tenant workflow promotion)
  'svc:admin:prompt-template:manage', // → manage:PromptTemplate
  'svc:admin:consultation-context-schema:manage', // → manage:ConsultationContextSchema
  'svc:admin:document-template:manage', // → manage:DocumentTemplate
  'svc:admin:dna-writing-style:manage', // → manage:DnaWritingStyleReport
  'svc:admin:knowledge:manage', // → manage:KnowledgeDocument
  // Summarization / documentation plane
  'svc:admin:consultation-admin:manage', // → manage:Consultation
  'svc:admin:harness:manage', // → manage:HarnessPolicy, manage:HarnessEval, manage:HarnessWorkflow, read:HarnessAudit
  'svc:admin:agentic:manage', // → manage:HarnessPolicy
  'svc:admin:agent-trajectory:read', // → read:AgentTrajectory

  // Standalone-feature (business-plane) scopes —. These are what let the
  // account actually EXERCISE speech-to-text and summarization, as opposed to
  // administering their configuration. All three imply `create:Consultation`,
  // which TENANT_ADMIN holds, so they satisfy this file's derivation rule.
  // Renamespaced from the API-key scopes of the same name; the registry owns the
  // mapping (`STANDALONE_FEATURE_SCOPE_SOURCES`) and the test pins agreement.
  'svc:stt:transcription:write', // → create:Consultation (native STT jobs)
  'svc:stt:stream:write', // → create:Consultation (compat /api/stt sessions)
  'svc:consultation:report:write', // → create:Consultation (summarization, native + compat)
  // Speech-to-text plane
  'svc:admin:audio-pipeline:manage', // → manage:AsrPipeline
  'svc:admin:transcription-job:read', // → read:AsrPipeline
  'svc:admin:tenant-stt-config:manage', // → manage:TenantSttConfig
  // Speech synthesis
  // Model + provider selection (tenant tier only — `ai-model`/`ai-service`/
  // `ai-runtime-profile` all imply `manage:all` and are excluded)
  'svc:admin:ai-provider:manage', // → manage:GlobalSetting
  'svc:admin:settings:manage', // → manage:GlobalSetting
  'svc:admin:nlp-task-instructions:manage', // → manage:TenantNlpTaskInstructions
  // Tenant self-service surfaces
  'svc:admin:allowed-origin:manage', // → manage:TenantAllowedOrigin
  'svc:admin:tenant-frontend-config:manage', // → update:Tenant
  'svc:admin:tenant-idp-config:manage', // → manage:TenantIdentityProvider
  'svc:admin:mcp-server:manage', // → manage:McpServer
  'svc:admin:notification:manage', // → manage:Notification
  'svc:admin:resource-subscription:manage', // → manage:ResourceSubscription
  'svc:admin:service-release:manage', // → read:TenantTelemetry
  // Agentic workflow substrate
  'svc:admin:workflow-definition:manage', // → manage:WorkflowDefinition
  'svc:admin:workflow-node:read', // → read:WorkflowDefinition
  'svc:admin:workflow-run:read', // → read:WorkflowRun
  'svc:admin:workflow-test-fixture:manage', // → manage:WorkflowTestFixture
  // TASK-930 (INTERFACES §3) — the INVOCATION plane: a service account may list and invoke the
  // tenant's published agents and workflows, the way an API key does. Renamespaced from the
  // API-key scopes of the same name (`apikey-scopes.registry.ts`); every one implies an ability
  // TENANT_ADMIN already holds, so the derivation rule above still admits them.
  'svc:agent:definition:read', // → list:Agent
  'svc:agent:invocation:write', // → read:Agent (the invoke routes demand it)
  'svc:workflow:definition:read', // → list:WorkflowDefinition
  'svc:workflow:run:read', // → read:WorkflowRun
  'svc:workflow:run:write', // → create:WorkflowRun, update:WorkflowRun
] as const;

/**
 * Dev/test gate, mirroring `shouldSeedApiKeys`. Kept as its own predicate
 * rather than importing that one so a future change to API-key seeding cannot
 * silently change what a service account ships with.
 */
export function shouldSeedServiceAccountSecrets(env: Environment = getNodeEnv()): boolean {
  return env === 'development' || env === 'test';
}

/**
 * The day-1 bootstrap env var (OD-2, 2026-08-20 ruling — see the docblock
 * above). Same shape as `BOOTSTRAP_SUPER_ADMIN_PASSWORD` /
 * `BOOTSTRAP_TENANT_ADMIN_PASSWORD`: operator-supplied, seed-time only, never
 * read at runtime, never a literal in a tracked file.
 */
export const BOOTSTRAP_SERVICE_ACCOUNT_ENV_VAR = 'BOOTSTRAP_SERVICE_ACCOUNT_SECRET';

/**
 * Floor length for an operator-supplied secret. Higher than the human
 * password floor (12, `92-bootstrap-admin.ts`): this credential authenticates
 * unattended automation with no login rate limiting behind it, and the
 * runtime's own `ServiceAccountService.generateClientSecret()` produces 64 hex
 * characters (32 bytes) of CSPRNG output — 32 characters is the floor an
 * operator-chosen value must clear, not a recommendation to use exactly that.
 */
export const BOOTSTRAP_SERVICE_ACCOUNT_SECRET_MIN_LENGTH = 32;

/** Same stop-list as `92-bootstrap-admin.ts` / `93-bootstrap-tenant-admin.ts`, including this repository's own demo password. */
const REFUSED_SERVICE_ACCOUNT_SECRETS = new Set(['password123', 'password', 'changeme', 'admin', 'admin123', 'hope123', 'letmein', '12345678']);

/**
 * Read + validate the operator-supplied day-1 secret. Returns `undefined`
 * when not requested (the seed must not invent a credential); THROWS when
 * supplied but too weak, exactly like `resolveBootstrapAdminConfig` does for
 * the human bootstrap password. Exported so the rule is testable without a
 * database.
 */
export function resolveBootstrapServiceAccountSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const secret = env[BOOTSTRAP_SERVICE_ACCOUNT_ENV_VAR] ?? '';
  if (secret === '') return undefined;

  if (REFUSED_SERVICE_ACCOUNT_SECRETS.has(secret.toLowerCase())) {
    throw new Error(`${BOOTSTRAP_SERVICE_ACCOUNT_ENV_VAR} is a well-known value and is refused. Choose a unique, high-entropy secret.`);
  }
  if (secret.length < BOOTSTRAP_SERVICE_ACCOUNT_SECRET_MIN_LENGTH) {
    throw new Error(
      `${BOOTSTRAP_SERVICE_ACCOUNT_ENV_VAR} must be at least ${BOOTSTRAP_SERVICE_ACCOUNT_SECRET_MIN_LENGTH} characters — this credential ` +
        'authenticates unattended automation with no login rate limiting.',
    );
  }
  return secret;
}

/**
 * The peppered one-way verifier, matching
 * `ServiceAccountService.computeSecretVerifier` EXACTLY.
 *
 * Note the difference from `hashApiKey` in `02-apikey.ts`: that function falls
 * back to plain SHA-256 when there is no pepper, because `ApiKeyService.hashKey`
 * does. `computeSecretVerifier` never does — it always HMACs, with the literal
 * `'hope-service-account'` when `API_KEY_PEPPER` is absent. Copying the API-key
 * shape here would seed a verifier the gateway can never reproduce.
 */
export function computeSecretVerifier(clientSecret: string, pepper?: string): string {
  return createHmac('sha256', pepper ?? 'hope-service-account').update(clientSecret).digest('hex');
}

export const SEEDED_SERVICE_ACCOUNTS = [
  {
    id: SEED_SERVICE_ACCOUNT_IDS.ARCAAI_ADMIN,
    clientId: SEED_SERVICE_ACCOUNT_CLIENT_IDS.ARCAAI_ADMIN,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    displayName: 'ArcaAI Tenant Automation',
    description:
      'Day-1 machine identity for the ArcaAI tenant. Carries exactly the tenant-scoped authority of the TENANT_ADMIN role — ' +
      'no platform-plane scope, no cross-tenant reach. Rotate to obtain a usable secret.',
    scopes: [...ARCAAI_TENANT_ADMIN_SVC_SCOPES],
    devSecret: SEED_SERVICE_ACCOUNT_DEV_SECRETS.ARCAAI_ADMIN,
    /** 15 minutes — the model default. Short-lived is the point of the class. */
    tokenTtlSeconds: 900,
  },
] as const;

export const seedServiceAccount = async (client: CorePrismaClient) => {
  const env = getNodeEnv();
  const devFixture = shouldSeedServiceAccountSecrets(env);
  // OD-2, 2026-08-20 ruling: the operator-supplied day-1 secret, resolved in
  // EVERY environment (not just dev/test) — this is the CI/automation path.
  // Absent, it is `undefined` and the seed behaves exactly as before.
  const bootstrapSecret = resolveBootstrapServiceAccountSecret();
  const withUsableSecret = devFixture || bootstrapSecret !== undefined;

  console.log(
    `Seeding service accounts (${
      bootstrapSecret
        ? `day-1: operator-supplied secret via ${BOOTSTRAP_SERVICE_ACCOUNT_ENV_VAR}`
        : devFixture
          ? 'dev/test: with fixture secrets'
          : 'inert: rotate to obtain a secret'
    })...`,
  );

  // Only resolve the pepper when a USABLE verifier is being written. In the
  // inert path the verifier has no preimage, so the pepper is irrelevant — and
  // `resolveApiKeyPepper` THROWS when SECRETS_PROVIDER=vault and Vault is
  // unreachable, which would otherwise add a brand-new way for a production
  // `safe` seed to fail on something it does not need.
  const pepper = withUsableSecret ? await resolveApiKeyPepper() : undefined;

  let created = 0;
  for (const account of SEEDED_SERVICE_ACCOUNTS) {
    // Defence in depth: a tenant-bound account must never land on a reserved
    // platform tenant. SYSTEM is the config TIER, and `50000000-…` ("Global")
    // is a customer tenant used as a platform playground — `ServiceAccountService.
    // resolveIssuanceTenant` refuses the latter outright, and this keeps the
    // seed from writing what the API would reject.
    const boundTenantId: string = account.tenantId;
    if (boundTenantId === SYSTEM_TENANT_ID || boundTenantId === GLOBAL_PLAYGROUND_TENANT_ID) {
      throw new Error(`Refusing to seed service account "${account.clientId}" on reserved tenant ${account.tenantId}.`);
    }

    // CREATE-ONLY, like every other credential-bearing seed row. A re-seed must
    // never rewrite a rotated verifier, and must never widen a scope set an
    // admin narrowed. Checked by clientId as well as id, because `clientId` is
    // uniquely indexed and a partially-migrated environment would otherwise
    // fail the insert instead of skipping.
    const existing = await client.serviceAccount.findFirst({
      where: { OR: [{ id: account.id }, { clientId: account.clientId }] },
    });
    if (existing) {
      // AUTHORITY reconciles; the CREDENTIAL never does. This file's whole design
      // is that the two are separable — the secret verifier is left exactly as it
      // is (a rotated credential must survive a re-seed), but `scopes` are
      // configuration, and a seed that could never widen them would leave every
      // already-provisioned environment stuck on whatever the account was created
      // with. That is how this account ended up without the
      // standalone-feature scopes after they were added.
      const current = Array.isArray(existing.scopes) ? (existing.scopes as string[]) : [];
      const desired = [...account.scopes];
      const drifted = current.length !== desired.length || desired.some((scope) => !current.includes(scope));

      if (drifted) {
        await client.serviceAccount.update({ where: { id: existing.id }, data: { scopes: desired } });
        console.log(`  Service account "${account.clientId}" exists — reconciled scopes ${current.length} → ${desired.length} (secret untouched).`);
      } else {
        console.log(`  Service account "${account.clientId}" already exists and is in sync — leaving it untouched.`);
      }
      continue;
    }

    const tenant = await client.tenant.findFirst({ where: { id: account.tenantId } });
    if (!tenant) {
      throw new Error(
        `Cannot seed service account "${account.clientId}": tenant ${account.tenantId} does not exist. Run seedTenant (05-tenant) first.`,
      );
    }

    // Precedence: operator-supplied day-1 secret (any environment) > the
    // deterministic dev/test fixture > an inert, non-invented verifier. Only
    // the first two have a preimage; the inert path generates the verifier
    // DIRECTLY — there is no secret, not even transiently, so there is nothing
    // to leak, log or forget to discard.
    let secretVerifier: string;
    if (bootstrapSecret) {
      secretVerifier = computeSecretVerifier(bootstrapSecret, pepper);
    } else if (devFixture) {
      secretVerifier = computeSecretVerifier(account.devSecret, pepper);
    } else {
      secretVerifier = randomBytes(32).toString('hex');
    }

    await client.serviceAccount.create({
      data: {
        id: account.id,
        tenantId: account.tenantId,
        clientId: account.clientId,
        displayName: account.displayName,
        description: account.description,
        scopes: account.scopes,
        // `allowedTenantIds` and `allowedIps` are deliberately NOT set (they
        // stay SQL NULL). The first is a PLATFORM-account concept the entity
        // refuses on a tenant-bound row; the second is an IP allow-list, and a
        // seed cannot know the addresses a deployment will call from — an
        // empty list would read as "no restriction" while a guessed one would
        // lock the account out.
        superAdmin: false,
        tokenTtlSeconds: account.tokenTtlSeconds,
        credentialsRef: credentialsRefFor(account.clientId),
        secretVerifier,
      },
    });
    created += 1;

    console.log(`  Created service account "${account.clientId}" on tenant ${tenant.key} with ${account.scopes.length} svc:* scope(s).`);
    if (bootstrapSecret) {
      console.log(
        `    Day-1 secret configured via ${BOOTSTRAP_SERVICE_ACCOUNT_ENV_VAR} — exchange it now at POST /api/v1/auth/service-token. ` +
          'No SUPER_ADMIN login required. The secret itself is never logged.',
      );
    } else if (devFixture) {
      console.log(`    Dev/test fixture secret: SEED_SERVICE_ACCOUNT_DEV_SECRETS.ARCAAI_ADMIN (00-constants.ts). Never seeded outside dev/test.`);
    } else {
      console.log(
        `    No secret was generated. Obtain one with: POST /api/v1/admin/service-accounts/${account.id}/rotate ` +
          '(SUPER_ADMIN only; the response carries the secret exactly once), or re-run the seed with ' +
          `${BOOTSTRAP_SERVICE_ACCOUNT_ENV_VAR} set to provision one without a human in the loop.`,
      );
    }
  }

  console.log(`Seeded ${created} service account(s) (${SEEDED_SERVICE_ACCOUNTS.length - created} already present)`);
  return { success: true, count: created };
};
