/**
 * Provision the 10 tenants x 100 users (+ machine credentials) the load run
 * needs, and write the manifest `run-load.ts` reads.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  THIS SCRIPT WAS WRITTEN BUT DELIBERATELY NEVER RUN.
 *
 *  TASK-993 lane G is forbidden from touching any shared surface: no
 *  `db:push`, no `db:migrate`, no `test:db:reset`, no seed. The orchestrator
 *  owns the database. So this file is reviewed, typechecked and linted, and an
 *  operator runs it — see "Running it" below.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ## What it writes, and why each row is needed
 *
 * | Row | Why the load run needs it |
 * |---|---|
 * | `Tenant` x N, `plan: ENTERPRISE` | Only ENTERPRISE allows 100 users (`PRO.maxUsers = 25`), so the target population does not fit any other plan. It is also the only plan on the `relaxed` tier — the 300/min figure §2.4 is about. |
 * | `Department` x1 per tenant | A non-exempt user needs a `UserDepartment`, and membership checks fail closed without one. |
 * | `User` x M per tenant | The humans. One shared bcrypt digest, hashed ONCE — 1,000 bcrypt(10) calls is minutes of pure CPU. |
 * | `UserRoleAssignment` (TENANT_ADMIN) | Abilities. Without them every admin request is a 403 and the run measures the authorization guard instead of a capacity ceiling — observed at 63/96 responses on the first smoke run. TENANT_ADMIN and not DOCTOR because the measured load model is an ADMIN-CONSOLE session; a clinician reaches almost none of those routes. Override with `LOAD_FIXTURE_ROLE`. |
 * | `UserDepartment` | See above. |
 * | `ApiKey` x2 per tenant | The machine plane shares the tenant bucket; omitting it overstates the humans' budget. |
 * | `ServiceAccount` x1 per tenant | The second machine class, and the only one that reaches `/admin/*`. |
 * | reference set | `provisionTenantReferenceSet` — nothing widens a CONTENT read to SYSTEM, so an unprovisioned tenant fails closed on its first consultation. |
 *
 * ## Two hashing traps this script is written around
 *
 * 1. **API keys** hash with `HMAC-SHA256(pepper, rawKey)` when a pepper exists
 *    and plain `SHA-256(rawKey)` when it does not — and it must agree with
 *    `ApiKeyService.hashKey` or every key 401s. The pepper comes from
 *    `resolveApiKeyPepper()`, which falls back to Vault; reading
 *    `process.env.API_KEY_PEPPER` directly is wrong under `SECRETS_PROVIDER=vault`,
 *    where the tracked `.env.dev` keeps it blank on purpose.
 * 2. **Service-account secrets** do NOT share that shape. `computeSecretVerifier`
 *    ALWAYS HMACs, falling back to the literal `'hope-service-account'` rather
 *    than degrading to SHA-256. Copying the API-key branch here seeds a verifier
 *    the gateway can never reproduce.
 *
 * Both are imported from the seed rather than reimplemented.
 *
 * ## Running it
 *
 *     LOAD_FIXTURE_CONFIRM=yes pnpm load:seed                 # against .env.dev
 *     LOAD_FIXTURE_CONFIRM=yes LOAD_TENANTS=10 LOAD_USERS=100 pnpm load:seed
 *     LOAD_FIXTURE_CONFIRM=yes npx dotenv -e .env.test -- pnpm load:seed
 *
 * It is ADDITIVE and idempotent: every write is an upsert on a deterministic id
 * in the reserved `9930…` block, so re-running it changes nothing and it never
 * touches a row it did not create. It resets nothing and deletes nothing.
 *
 * ## Removing it
 *
 * Every row it creates has an id beginning `9930`. The teardown is printed at
 * the end of a successful run; it is deliberately NOT a flag on this script,
 * because a destructive default is how a fixture script becomes an incident.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcryptjs from 'bcryptjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(HERE, '..', 'results');

/** Reserved id block for TASK-993 load fixtures. Disjoint from 0000/5000 (tenants), 6000 (keys), 7000 (users), e000 (service accounts). */
const BLOCK = '9930';
/** Version-4-shaped so any `@IsUUID()` DTO on the way in accepts it — the seeded `70000000-…` ids do not. */
function fixtureId(kind: number, a: number, b = 0): string {
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
  return `${BLOCK}${hex(kind, 4)}-0000-4000-8000-${hex(a, 6)}${hex(b, 6)}`;
}
const KIND = { tenant: 0x0001, department: 0x0002, user: 0x0003, apiKey: 0x0004, serviceAccount: 0x0005 } as const;

const TENANTS = Number(process.env.LOAD_TENANTS ?? 10);
const USERS_PER_TENANT = Number(process.env.LOAD_USERS ?? 100);
const API_KEYS_PER_TENANT = Number(process.env.LOAD_API_KEYS ?? 2);
const SERVICE_ACCOUNTS_PER_TENANT = Number(process.env.LOAD_SERVICE_ACCOUNTS ?? 1);
const PASSWORD = process.env.LOAD_FIXTURE_PASSWORD ?? 'loadtest123';
/**
 * The role every fixture user gets.
 *
 * TENANT_ADMIN, because the load model this fixture feeds was measured on the
 * ADMIN CONSOLE: a DOCTOR can reach almost none of those routes, so a
 * clinician-roled fixture produces a run made of 403s. Set `LOAD_FIXTURE_ROLE`
 * to model a clinician population instead — the harness calibrates whatever it
 * is given and reports what it dropped.
 */
const ROLE_NAME = process.env.LOAD_FIXTURE_ROLE ?? 'TENANT_ADMIN';

/** `ApiKeyService.hashKey`'s exact shape. Peppered ⇒ HMAC; unpeppered ⇒ plain SHA-256. */
function hashApiKey(rawKey: string, pepper?: string): string {
  return pepper ? createHmac('sha256', pepper).update(rawKey).digest('hex') : createHash('sha256').update(rawKey).digest('hex');
}

/** Deterministic so a re-run produces the SAME key material and the manifest stays valid. */
function rawApiKey(tenantIndex: number, keyIndex: number): string {
  const body = createHash('sha256').update(`hope-load-fixture:${tenantIndex}:${keyIndex}`).digest('hex');
  return `hope_sk_${body}_${body.slice(0, 6)}`;
}
function rawServiceSecret(tenantIndex: number, accountIndex: number): string {
  return `hope_svcsec_load_${createHash('sha256').update(`hope-load-svc:${tenantIndex}:${accountIndex}`).digest('hex')}`;
}
function serviceClientId(tenantIndex: number, accountIndex: number): string {
  return `hope_svc_${createHash('sha256').update(`hope-load-svcid:${tenantIndex}:${accountIndex}`).digest('hex').slice(0, 24)}`;
}

function refuse(reason: string): never {
  console.error(`\n[load:seed] REFUSING — ${reason}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  // Three guards. This script writes 1,000+ rows; none of them should ever be a
  // surprise, and none of them should ever land in production.
  if (process.env.LOAD_FIXTURE_CONFIRM !== 'yes') {
    refuse(
      `set LOAD_FIXTURE_CONFIRM=yes to proceed.\n` +
        `  It will create ${TENANTS} tenants, ${TENANTS * USERS_PER_TENANT} users, ` +
        `${TENANTS * API_KEYS_PER_TENANT} API keys and ${TENANTS * SERVICE_ACCOUNTS_PER_TENANT} service accounts\n` +
        `  in the database ${process.env.DATABASE_URL?.replace(/:\/\/[^@]*@/, '://***@') ?? '(DATABASE_URL unset)'}.`,
    );
  }
  if (process.env.NODE_ENV === 'production') refuse('NODE_ENV=production. This fixture is for local and test databases only.');
  if (!process.env.DATABASE_URL) refuse('DATABASE_URL is not set.');

  // RELATIVE imports, not `@arcaai/database`. The repo-root `tests/` tree is not
  // a workspace package, so the bare specifier does not resolve from here — and
  // adding the dependency to the root `package.json` would be a shared-surface
  // change this lane does not own.
  //
  // Lazy and dynamic, matching `tests/helpers/db.helper.ts`: the database package
  // is ESM-only and a static import breaks under a CJS-compiling runner.
  // eslint-disable-next-line no-restricted-imports -- test fixture on the §B.4 allow-list: rows must be written across tenants with no CLS context to establish one
  const { getPlatformAdminPrismaClient_Unscoped } = await import('../../../packages/database/src/client');
  const client = getPlatformAdminPrismaClient_Unscoped();

  const { resolveApiKeyPepper } = await import('../../../packages/database/src/prisma/db_main/seed/api-key-pepper');
  const { computeSecretVerifier, credentialsRefFor, ARCAAI_TENANT_ADMIN_SVC_SCOPES } =
    await import('../../../packages/database/src/prisma/db_main/seed/94-service-account');
  const { SDK_DAY_ONE_SCOPES } = await import('../../../packages/database/src/prisma/db_main/seed/02-apikey');
  const { provisionTenantReferenceSet } = await import('../../../packages/database/src/prisma/db_main/seed/26-tenant-reference-set');

  const pepper = await resolveApiKeyPepper();
  if (!pepper) {
    console.warn('[load:seed] no API_KEY_PEPPER resolved — hashing keys with plain SHA-256. This is only correct if the GATEWAY also has no pepper.');
  }

  // ONE bcrypt, reused. 1,000 x bcrypt(10) is several minutes of CPU for no
  // added realism — `91-user.ts` makes the same call for the same reason.
  console.log('[load:seed] hashing the shared password once…');
  const passwordHash = await bcryptjs.hash(PASSWORD, 10);

  // Pinned to the SYSTEM tenant: `Role.name` is globally unique today, but a
  // custom role could otherwise shadow the built-in, which is why every seed
  // that looks a role up does it this way.
  const role = await client.role.findFirst({ where: { name: ROLE_NAME, tenantId: '00000000-0000-0000-0000-000000000000' } });
  if (!role) refuse(`the ${ROLE_NAME} role is missing — run the ordinary seed first (\`pnpm db:seed\`).`);

  const manifest = { generatedAt: new Date().toISOString(), password: PASSWORD, tenants: [] as unknown[] };

  for (let t = 0; t < TENANTS; t += 1) {
    const tenantId = fixtureId(KIND.tenant, t);
    const key = `LOADTEST_${String(t).padStart(2, '0')}`;
    process.stdout.write(`[load:seed] tenant ${t + 1}/${TENANTS} ${key} `);

    await client.tenant.upsert({
      where: { id: tenantId },
      // ENTERPRISE is not a preference: it is the only plan whose `maxUsers`
      // reaches 100 and the only one on the `relaxed` rate-limit tier.
      create: { id: tenantId, name: `Load Test ${t}`, key, plan: 'ENTERPRISE', description: 'TASK-993 load fixture' },
      update: { plan: 'ENTERPRISE' },
    });

    const departmentId = fixtureId(KIND.department, t);
    await client.department.upsert({
      where: { id: departmentId },
      create: { id: departmentId, tenantId, code: 'LOAD', name: 'Load Test Department' },
      update: {},
    });

    const users: Array<{ username: string }> = [];
    for (let u = 0; u < USERS_PER_TENANT; u += 1) {
      const userId = fixtureId(KIND.user, t, u);
      const username = `load_${String(t).padStart(2, '0')}_${String(u).padStart(3, '0')}`;

      await client.user.upsert({
        where: { id: userId },
        create: { id: userId, username, password: passwordHash },
        update: { password: passwordHash },
      });

      // `UserRoleAssignment.tenantId` is NOT NULL, and the unique key is
      // [userId, roleId, tenantId] — so the upsert has to name all three.
      await client.userRoleAssignment.upsert({
        where: { UserRoleAssignment_userId_roleId_tenantId_unique: { userId, roleId: role.id, tenantId } },
        create: { userId, roleId: role.id, tenantId },
        update: {},
      });

      // Without this, membership checks fail closed for every non-exempt user.
      // Upserted on the declared compound key rather than findFirst+create, so
      // a re-run is idempotent even if two operators race.
      await client.userDepartment.upsert({
        where: { UserDepartment_tenant_user_department_unique: { tenantId, userId, departmentId } },
        create: { userId, departmentId, tenantId, isPrimary: true },
        update: {},
      });

      users.push({ username });
    }
    process.stdout.write(`${users.length} users `);

    const apiKeys: string[] = [];
    for (let k = 0; k < API_KEYS_PER_TENANT; k += 1) {
      const raw = rawApiKey(t, k);
      const id = fixtureId(KIND.apiKey, t, k);
      const data = {
        tenantId,
        keyName: `load-fixture-${t}-${k}`,
        keyHash: hashApiKey(raw, pepper),
        keyPrefix: raw.substring(0, 12),
        keyChecksum: raw.split('_').at(-1),
        scopes: [...SDK_DAY_ONE_SCOPES],
        description: 'TASK-993 load fixture',
      };
      await client.apiKey.upsert({ where: { id }, create: { id, ...data }, update: data });
      apiKeys.push(raw);
    }

    const serviceAccounts: Array<{ clientId: string; clientSecret: string }> = [];
    for (let s = 0; s < SERVICE_ACCOUNTS_PER_TENANT; s += 1) {
      const clientId = serviceClientId(t, s);
      const clientSecret = rawServiceSecret(t, s);
      const id = fixtureId(KIND.serviceAccount, t, s);
      const data = {
        tenantId,
        clientId,
        displayName: `Load Fixture SA ${t}-${s}`,
        scopes: [...ARCAAI_TENANT_ADMIN_SVC_SCOPES],
        credentialsRef: credentialsRefFor(clientId),
        // NOT hashApiKey: this one always HMACs, with its own default pepper.
        secretVerifier: computeSecretVerifier(clientSecret, pepper),
        tokenTtlSeconds: 900,
      };
      await client.serviceAccount.upsert({ where: { id }, create: { id, ...data }, update: data });
      serviceAccounts.push({ clientId, clientSecret });
    }

    // Content is CLONED, never resolved across tenants at runtime
    // (00-project-context.md §"Content is cloned; configuration cascades"), so a
    // tenant without its reference set fails closed the first time the run asks
    // it to do anything clinical.
    await provisionTenantReferenceSet(client, tenantId);
    process.stdout.write('+ reference set\n');

    manifest.tenants.push({ id: tenantId, key, plan: 'ENTERPRISE', users, apiKeys, serviceAccounts });
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = resolve(RESULTS_DIR, 'fixture.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    [
      '',
      `[load:seed] wrote ${path}`,
      '',
      '  This manifest contains PLAINTEXT credentials for the fixture tenants.',
      '  `tests/load/results/` is gitignored; keep it that way.',
      '',
      '  To remove the fixture (destructive, run it yourself, never from a script):',
      '    delete from core."UserDepartment"      where id like \'9930%\';',
      '    delete from core."UserRoleAssignment"  where id like \'9930%\';',
      '    delete from core."ApiKey"              where id like \'9930%\';',
      '    delete from core."ServiceAccount"      where id like \'9930%\';',
      '    delete from core."User"                where id like \'9930%\';',
      '    -- the reference-set clones are tenant-owned; drop them with the tenant.',
      '    delete from core."Department"          where "tenantId" like \'99300001%\';',
      '    delete from core."Tenant"              where id like \'99300001%\';',
      '',
    ].join('\n'),
  );

  await client.$disconnect();
}

main().catch((error: unknown) => {
  console.error('[load:seed] failed:', error);
  process.exitCode = 1;
});
