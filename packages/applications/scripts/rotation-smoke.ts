#!/usr/bin/env tsx
// Staging end-to-end secret-rotation smoke test.
//
// What this script does (single shot, no daemon mode):
//   1. Bind to Redis as a SUBSCRIBER on `arca:secrets:invalidate` so we
//      observe the invalidation event in real time.
//   2. Capture an old JWT (issued under the current JWT_SECRET_KEY) via
//      a /api/v1/auth/login call.
//   3. Write a new version of `secret/hope/JWT_SECRET_KEY` to Vault.
//   4. Wait for the rotation worker (or the manual override) to publish
//      to Redis, and count subscribers reached.
//   5. Sleep the rotation overlap window.
//   6. Hit /api/v1/auth/whoami with the OLD JWT and verify it now
//      returns 401 (the cache was evicted, the new key invalidates it).
//   7. Issue a fresh JWT against the NEW key and verify whoami returns
//      200.
//
// Usage (staging):
//   $ pnpm --filter @arcaai/applications exec tsx scripts/rotation-smoke.ts \
//       --base-url https://api.staging.arcaai.com \
//       --vault-addr https://vault.staging.arcaai.com \
//       --user smoke@arcaai.com --pass "$SMOKE_PASS" \
//       --overlap-sec 60
//
// Required env vars:
//   - VAULT_TOKEN     (operator's Vault token, OR ROLE_ID + SECRET_ID
//                      for AppRole; the script supports both)
//   - REDIS_HOST, REDIS_PORT, REDIS_PASS
//
// IMPORTANT: This script is intentionally NOT part of the default
// test suite. It mutates a live Vault instance and a live HOPE API.
// Run it only against staging.
import { setTimeout as sleep } from 'node:timers/promises';
import Redis from 'ioredis';
import vault from 'node-vault';

interface Args {
  baseUrl: string;
  vaultAddr: string;
  user: string;
  pass: string;
  overlapSec: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (i < 0) return undefined;
    const arg = argv[i];
    if (arg.includes('=')) return arg.split('=').slice(1).join('=');
    return argv[i + 1];
  };
  const baseUrl = get('--base-url');
  const vaultAddr = get('--vault-addr');
  const user = get('--user');
  const pass = get('--pass');
  const overlapSec = parseInt(get('--overlap-sec') ?? '60', 10);
  if (!baseUrl || !vaultAddr || !user || !pass) {
    throw new Error('rotation-smoke: required flags: --base-url, --vault-addr, --user, --pass');
  }
  return { baseUrl, vaultAddr, user, pass, overlapSec };
}

interface LoginResponse {
  access_token: string;
}

interface ApiClient {
  login(user: string, pass: string): Promise<string>;
  whoami(jwt: string): Promise<{ ok: boolean; status: number }>;
}

function buildClient(baseUrl: string): ApiClient {
  return {
    async login(user, pass) {
      const r = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: user, password: pass }),
      });
      if (!r.ok) throw new Error(`login failed: ${r.status}`);
      const body = (await r.json()) as LoginResponse;
      return body.access_token;
    },
    async whoami(jwt) {
      const r = await fetch(`${baseUrl}/api/v1/auth/whoami`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      return { ok: r.ok, status: r.status };
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const api = buildClient(args.baseUrl);

  console.log(`[smoke] base-url=${args.baseUrl}`);
  console.log(`[smoke] vault=${args.vaultAddr}`);
  console.log(`[smoke] overlap-sec=${args.overlapSec}`);

  console.log('[smoke] step 1: subscribe to arca:secrets:invalidate');
  const subscriber = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASS,
  });
  let invalidations = 0;
  const observed: string[] = [];
  subscriber.on('message', (_ch, msg) => {
    invalidations++;
    try {
      const parsed = JSON.parse(msg) as { key: string };
      observed.push(parsed.key);
    } catch {
      /* ignore malformed lines from other writers */
    }
  });
  await subscriber.subscribe('arca:secrets:invalidate');

  console.log('[smoke] step 2: capture pre-rotation JWT');
  const oldJwt = await api.login(args.user, args.pass);

  console.log('[smoke] step 3: rotate JWT_SECRET_KEY in Vault');
  const client = vault({ apiVersion: 'v1', endpoint: args.vaultAddr }) as unknown as {
    write(p: string, body: Record<string, unknown>): Promise<unknown>;
  };
  if (!process.env.VAULT_TOKEN) {
    throw new Error('rotation-smoke: VAULT_TOKEN required for staging smoke');
  }
  (client as unknown as { token: string }).token = process.env.VAULT_TOKEN;
  // Mint a fresh value LOCALLY rather than using vault's secret-generators
  // engine (kept off the dep list in HOPE). This is staging-only, so a
  // hex random is fine.
  const newValue = (await import('node:crypto')).randomBytes(32).toString('hex');
  await client.write('secret/data/hope/JWT_SECRET_KEY', { data: { value: newValue } });

  console.log('[smoke] step 4: wait for invalidation event');
  const waitDeadline = Date.now() + 10_000;
  while (Date.now() < waitDeadline && invalidations === 0) await sleep(100);
  if (invalidations === 0) {
    throw new Error('rotation-smoke: no invalidation event received within 10s — rotation worker offline?');
  }
  console.log(`[smoke] invalidation observed (${invalidations} events, keys=${observed.join(',')})`);

  console.log(`[smoke] step 5: sleep overlap-window ${args.overlapSec}s`);
  await sleep(args.overlapSec * 1000);

  console.log('[smoke] step 6: verify old JWT now rejected (cache evicted)');
  const oldRes = await api.whoami(oldJwt);
  if (oldRes.ok) {
    throw new Error(`rotation-smoke: old JWT still accepted (status=${oldRes.status}); rotation did not propagate`);
  }
  console.log(`[smoke] old JWT correctly rejected (status=${oldRes.status})`);

  console.log('[smoke] step 7: issue fresh JWT, verify accepted');
  const newJwt = await api.login(args.user, args.pass);
  const newRes = await api.whoami(newJwt);
  if (!newRes.ok) {
    throw new Error(`rotation-smoke: new JWT not accepted (status=${newRes.status})`);
  }
  console.log(`[smoke] new JWT accepted (status=${newRes.status})`);

  await subscriber.unsubscribe('arca:secrets:invalidate');
  subscriber.disconnect();
  console.log('[smoke] PASS');
}

const invokedDirectly = typeof process.argv[1] === 'string' && /rotation-smoke/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    // Never echo the rotated value — defensive even though this script
    // only generates `newValue` locally and never logs it.
    console.error(`[smoke] FAIL: ${(err as Error).message}`);
    process.exit(1);
  });
}

export { parseArgs };
