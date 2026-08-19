import { createHmac, randomBytes } from 'crypto';
import type { CorePrismaClient } from '../../../client';
import { getNodeEnv, type Environment } from '../../../env';
import { SEED_CUSTOMER_TENANT_IDS, SEED_SERVICE_ACCOUNT_CLIENT_IDS, SEED_SERVICE_ACCOUNT_DEV_SECRETS, SEED_SERVICE_ACCOUNT_IDS } from './00-constants';
import { resolveApiKeyPepper } from './api-key-pepper';

/**
 * TASK-766 — the day-1 machine identity for the ArcaAI tenant.
 *
 * ## What the owner asked for, and the constraint it collides with
 *
 * *"make sure we have seed data to create service account for ArcaAI tenant"*.
 * TASK-762's definition of done says the client secret is shown ONCE and never
 * persisted recoverably — **"no secret value in any migration, seed, or
 * fixture"** — and TASK-763 §OD-2 therefore decided not to seed one at all,
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
 * gap exactly where TASK-763 §OD-2 found it, which is the thing this ticket was
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
 * ─── Coordination note for TASK-767 (standalone STT + summarization) ────────
 *
 * TASK-767 adds `@RequiredSvcScopes` to the speech-to-text and summarization
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
 * The four scopes marked `[TASK-767]` below are the admin-plane STT and
 * summarization areas that exist TODAY, and they are what this account holds.
 * If TASK-767 declares NEW business-plane `svc:` scopes, add them to this array
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
  'svc:admin:role:read', // → read:Role   (READ only: Role/Policy are GLOBAL tables)
  'svc:admin:tenant:read', // → read:Tenant
  'svc:admin:audit:read', // → read:AuditLog
  // Clinical configuration
  'svc:admin:department:manage', // → manage:Department
  'svc:admin:agent-promotion:manage', // → manage:DepartmentAgent
  'svc:admin:prompt-template:manage', // → manage:PromptTemplate
  'svc:admin:consultation-context-schema:manage', // → manage:ConsultationContextSchema
  'svc:admin:dna-writing-style:manage', // → manage:DnaWritingStyleReport
  'svc:admin:knowledge:manage', // → manage:KnowledgeDocument
  // Summarization / documentation plane  [TASK-767]
  'svc:admin:consultation-admin:manage', // → manage:Consultation
  'svc:admin:harness:manage', // → manage:HarnessPolicy, manage:HarnessEval, manage:HarnessWorkflow, read:HarnessAudit
  'svc:admin:agentic:manage', // → manage:HarnessPolicy
  'svc:admin:agent-trajectory:read', // → read:AgentTrajectory
  // Speech-to-text plane  [TASK-767]
  'svc:admin:audio-pipeline:manage', // → manage:AsrPipeline
  'svc:admin:transcription-job:read', // → read:AsrPipeline
  'svc:admin:tenant-stt-config:manage', // → manage:TenantSttConfig
  // Speech synthesis
  'svc:admin:tenant-tts-config:manage', // → manage:TenantTtsConfig
  // Model + provider selection (tenant tier only — `ai-model`/`ai-service`/
  // `ai-runtime-profile` all imply `manage:all` and are excluded)
  'svc:admin:ai-task-default:manage', // → manage:AiTaskDefault
  'svc:admin:ai-provider:manage', // → manage:GlobalSetting
  'svc:admin:settings:manage', // → manage:GlobalSetting
  'svc:admin:nlp-task-instructions:manage', // → manage:TenantNlpTaskInstructions
  'svc:admin:pipeline-policy:manage', // → manage:PipelinePolicy
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
  const withUsableSecret = shouldSeedServiceAccountSecrets(env);

  console.log(`Seeding service accounts (${withUsableSecret ? 'dev/test: with fixture secrets' : 'inert: rotate to obtain a secret'})...`);

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
      console.log(`  Service account "${account.clientId}" already exists — leaving it untouched.`);
      continue;
    }

    const tenant = await client.tenant.findFirst({ where: { id: account.tenantId } });
    if (!tenant) {
      throw new Error(
        `Cannot seed service account "${account.clientId}": tenant ${account.tenantId} does not exist. Run seedTenant (05-tenant) first.`,
      );
    }

    // The inert path generates a verifier DIRECTLY — there is no secret, not
    // even transiently, so there is nothing to leak, log or forget to discard.
    const secretVerifier = withUsableSecret ? computeSecretVerifier(account.devSecret, pepper) : randomBytes(32).toString('hex');

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
    if (withUsableSecret) {
      console.log(`    Dev/test fixture secret: SEED_SERVICE_ACCOUNT_DEV_SECRETS.ARCAAI_ADMIN (00-constants.ts). Never seeded outside dev/test.`);
    } else {
      console.log(
        `    No secret was generated. Obtain one with: POST /api/v1/admin/service-accounts/${account.id}/rotate ` +
          '(SUPER_ADMIN only; the response carries the secret exactly once).',
      );
    }
  }

  console.log(`Seeded ${created} service account(s) (${SEEDED_SERVICE_ACCOUNTS.length - created} already present)`);
  return { success: true, count: created };
};
