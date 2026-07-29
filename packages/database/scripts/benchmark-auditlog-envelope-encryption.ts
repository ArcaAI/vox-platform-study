// AuditLog envelope-encryption
// BENCHMARK: plaintext vs envelope-encrypted write/read throughput.
//
// WHY envelope (and what this proves): AuditLog is the highest-volume write path
// in HOPE. The per-field pattern used by the other Phase 3 models does a Vault
// Transit round-trip PER FIELD PER ROW — far too costly here. Envelope
// encryption generates a Data Encryption Key (DEK), wraps it ONCE via Vault
// Transit (`hope-phi`), then encrypts every row LOCALLY with AES-256-GCM under
// that DEK → ZERO Vault calls on the hot path. This script quantifies:
//   1. CRYPTO OVERHEAD per row (always runs, no DB needed):
//        - plaintext baseline:  JSON.stringify(data)+(previousData)
//        - envelope encrypt:    stringify + local AES-256-GCM (the added cost)
//        - envelope decrypt:    local AES-256-GCM + JSON.parse (read path)
//   2. ONE-TIME DEK wrap latency via Vault Transit (when Vault is configured).
//   3. The REJECTED approach — per-row Vault Transit encrypt round-trips
//        (`--with-per-row-transit`, small N) — to show the round-trip cost
//        envelope avoids (the perf risk the plan flagged).
//   4. Optional end-to-end DB insert/read throughput (`--with-db`) into a
//        SESSION TEMP TABLE inside ONE transaction (auto-dropped ON COMMIT — no
//        DELETE/DROP/TRUNCATE executed, never touches the real AuditLog table).
//
// Self-contained on purpose (mirrors backfill-contextitem-content-encryption.ts):
// uses node:crypto for AES-256-GCM (equivalent to the hardened CryptoService —
// imported directly here would pull @arcaai/applications and create the workspace
// cycle applications → database → applications) and node-vault for the one DEK
// wrap + the optional per-row-transit comparison.
//
// Usage (crypto-only, no Vault, no DB):
//   pnpm --filter @arcaai/database tsx scripts/benchmark-auditlog-envelope-encryption.ts [--rows=20000]
//
// Usage (full — Vault + DB up):
//   SECRETS_PROVIDER=vault VAULT_ADDR=http://localhost:8200 \
//   VAULT_ROLE_ID=$(docker exec hope-vault vault read -field=role_id auth/approle/role/hope-app/role-id) \
//   VAULT_WRAPPED_SECRET_ID=$(docker exec hope-vault vault write -wrap-ttl=60s -f -format=json auth/approle/role/hope-app/secret-id | jq -r .wrap_info.token) \
//     pnpm --filter @arcaai/database tsx scripts/benchmark-auditlog-envelope-encryption.ts \
//       --rows=20000 --with-db --db-rows=3000 --with-per-row-transit --per-row-transit-rows=200
//
// Exit codes: 0 success · 1 runtime error.

import * as crypto from 'crypto';
import vault from 'node-vault';

export interface BenchArgs {
  rows: number;
  withDb: boolean;
  dbRows: number;
  withPerRowTransit: boolean;
  perRowTransitRows: number;
  transitMount: string;
  transitKey: string;
}

export function parseArgs(argv: string[]): BenchArgs {
  const map = new Map<string, string>();
  for (const a of argv.slice(2)) {
    const [k, v = ''] = a.replace(/^--/, '').split('=');
    map.set(k, v);
  }
  const num = (key: string, def: number) => {
    const n = parseInt(map.get(key) ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  return {
    rows: num('rows', 20000),
    withDb: map.has('with-db'),
    dbRows: num('db-rows', 3000),
    withPerRowTransit: map.has('with-per-row-transit'),
    perRowTransitRows: num('per-row-transit-rows', 200),
    transitMount: map.get('transit-mount') ?? 'transit',
    transitKey: map.get('transit-key') ?? 'hope-phi',
  };
}

// ── Local AES-256-GCM (iv ‖ tag ‖ ciphertext), equivalent to CryptoService ──────
function gcmEncrypt(plaintext: string, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}
function gcmDecrypt(buf: Buffer, key: Buffer): string {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// A representative AuditLog `data` payload (an UPDATE diff ~0.7KB).
function samplePayload(i: number): Record<string, unknown> {
  return {
    before: { status: 'DRAFT', title: `Consultation note ${i}`, assignee: null, tags: ['cardiology', 'follow-up'] },
    after: { status: 'FINAL', title: `Consultation note ${i}`, assignee: `user-${i % 97}`, tags: ['cardiology', 'follow-up', 'signed'] },
    actor: { id: `user-${i % 97}`, ip: '10.0.0.42' },
    fields: ['status', 'assignee', 'tags'],
    note: 'Patient reports improvement; adjust dosage and schedule follow-up in 2 weeks.',
  };
}

interface Timing {
  label: string;
  ops: number;
  ms: number;
}
function timed(label: string, ops: number, fn: () => void): Timing {
  const t0 = process.hrtime.bigint();
  fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { label, ops, ms };
}
function report(t: Timing): void {
  const opsPerSec = t.ops / (t.ms / 1000);
  const usPerOp = (t.ms * 1000) / t.ops;
  console.log(
    `  ${t.label.padEnd(38)} ${t.ops.toLocaleString().padStart(8)} ops  ${t.ms.toFixed(1).padStart(9)} ms  ${opsPerSec.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)} ops/s  ${usPerOp.toFixed(2).padStart(8)} µs/op`,
  );
}

// ── Vault (optional) ────────────────────────────────────────────────────────
interface VaultClientLike {
  token?: string;
  unwrap(payload?: { token: string }): Promise<unknown>;
  approleLogin(opts: { role_id: string; secret_id: string }): Promise<unknown>;
  write(path: string, body: Record<string, unknown>): Promise<unknown>;
}

async function tryAuthVault(): Promise<VaultClientLike | null> {
  if (process.env.SECRETS_PROVIDER !== 'vault') return null;
  const addr = process.env.VAULT_ADDR;
  const roleId = process.env.VAULT_ROLE_ID;
  if (!addr || !roleId) return null;
  const client = vault({ apiVersion: 'v1', endpoint: addr }) as unknown as VaultClientLike;
  let secretId = process.env.VAULT_SECRET_ID;
  const wrapped = process.env.VAULT_WRAPPED_SECRET_ID;
  if (wrapped) {
    const saved = client.token;
    client.token = wrapped;
    try {
      const res = (await client.unwrap()) as { data?: { secret_id?: string } };
      secretId = res?.data?.secret_id ?? secretId;
    } finally {
      client.token = saved;
    }
  }
  if (!secretId) return null;
  const login = (await client.approleLogin({ role_id: roleId, secret_id: secretId })) as { auth?: { client_token?: string } };
  if (!login?.auth?.client_token) return null;
  client.token = login.auth.client_token;
  return client;
}

async function transitEncrypt(client: VaultClientLike, cfg: BenchArgs, plaintextB64: string): Promise<{ ciphertext: string; keyVersion: number }> {
  const res = (await client.write(`${cfg.transitMount}/encrypt/${cfg.transitKey}`, { plaintext: plaintextB64 })) as {
    data?: { ciphertext?: string; key_version?: number };
  };
  if (!res?.data?.ciphertext) throw new Error('transit/encrypt returned empty ciphertext');
  return { ciphertext: res.data.ciphertext, keyVersion: res.data.key_version ?? 1 };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(`\nTASK-369 Phase 3D — AuditLog envelope-encryption benchmark`);
  console.log(
    `rows=${args.rows} withDb=${args.withDb}(db-rows=${args.dbRows}) withPerRowTransit=${args.withPerRowTransit}(${args.perRowTransitRows})\n`,
  );

  // Pre-build payloads + DEK so the timed loops measure only crypto/serialize.
  const payloads = Array.from({ length: args.rows }, (_, i) => samplePayload(i));
  const jsons = payloads.map((p) => JSON.stringify(p));
  const dek = crypto.randomBytes(32); // local DEK for the micro-benchmark
  const avgBytes = Math.round(jsons.reduce((s, j) => s + Buffer.byteLength(j, 'utf8'), 0) / jsons.length);

  console.log(`(1) CRYPTO OVERHEAD per row — avg payload ${avgBytes} bytes; each row encrypts BOTH data + previousData\n`);
  // Plaintext baseline: stringify data + previousData (what every audit write already does).
  report(
    timed('plaintext: stringify ×2', args.rows, () => {
      for (let i = 0; i < args.rows; i++) {
        void JSON.stringify(payloads[i]);
        void JSON.stringify(payloads[i]);
      }
    }),
  );
  // Envelope encrypt: stringify + local GCM, for data + previousData.
  const ciphertexts: Buffer[] = new Array(args.rows);
  report(
    timed('envelope: stringify+GCM encrypt ×2', args.rows, () => {
      for (let i = 0; i < args.rows; i++) {
        ciphertexts[i] = gcmEncrypt(JSON.stringify(payloads[i]), dek);
        void gcmEncrypt(JSON.stringify(payloads[i]), dek);
      }
    }),
  );
  // Envelope decrypt (read path): local GCM + parse, for data + previousData.
  report(
    timed('envelope: GCM decrypt+parse ×2', args.rows, () => {
      for (let i = 0; i < args.rows; i++) {
        void JSON.parse(gcmDecrypt(ciphertexts[i], dek));
        void JSON.parse(gcmDecrypt(ciphertexts[i], dek));
      }
    }),
  );

  // (2)+(3) Vault-dependent measurements. Resilient: a missing hope-phi key or
  // ACL grant (provisioned by a separate worker) degrades to a PENDING note
  // rather than failing the run — the crypto numbers above are the core result.
  const client = await tryAuthVault();
  if (!client) {
    console.log(`\n(2) DEK wrap + (3) per-row Transit: SKIPPED — Vault not configured/reachable.`);
    console.log(`    Re-run with SECRETS_PROVIDER=vault + VAULT_ADDR/VAULT_ROLE_ID/VAULT_WRAPPED_SECRET_ID to measure. RESULTS PENDING.`);
  } else {
    try {
      const dekB64 = dek.toString('base64');
      const t0 = process.hrtime.bigint();
      const wrapped = await transitEncrypt(client, args, dekB64);
      const wrapMs = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`\n(2) DEK wrap via Vault Transit (${args.transitKey}): ${wrapMs.toFixed(1)} ms — ONCE per process (amortized over ALL rows).`);
      console.log(`    wrapped=${wrapped.ciphertext.slice(0, 24)}… key v${wrapped.keyVersion}`);

      if (args.withPerRowTransit) {
        const n = args.perRowTransitRows;
        const tA = process.hrtime.bigint();
        for (let i = 0; i < n; i++) {
          await transitEncrypt(client, args, Buffer.from(jsons[i % jsons.length], 'utf8').toString('base64'));
        }
        const ms = Number(process.hrtime.bigint() - tA) / 1e6;
        console.log(`\n(3) REJECTED — per-row Vault Transit encrypt (1 field × ${n} rows):`);
        report({ label: 'per-row transit encrypt', ops: n, ms });
        console.log(`    → envelope avoids ALL of these per-row round-trips; the only Vault call is the single DEK wrap in (2).`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.log(`\n(2)/(3) Vault Transit on '${args.transitKey}': UNAVAILABLE (${msg}).`);
      console.log(`    Likely the hope-phi key/ACL is not provisioned yet (separate worker). RESULTS PENDING.`);
    }
  }

  // (4) Optional end-to-end DB throughput in a session temp table.
  if (args.withDb) {
    await runDbBenchmark(args, dek);
  }

  console.log(`\nDone.\n`);
}

async function runDbBenchmark(args: BenchArgs, dek: Buffer): Promise<void> {
  // eslint-disable-next-line no-restricted-imports -- benchmark uses the unscoped admin client (no tenant context)
  const { getPlatformAdminPrismaClient_Unscoped } = await import('../src/client.js');
  const prisma = getPlatformAdminPrismaClient_Unscoped();
  const n = args.dbRows;
  console.log(`\n(4) DB throughput — ${n} inserts into a SESSION TEMP TABLE (ON COMMIT DROP; real AuditLog untouched)\n`);
  try {
    await prisma.$transaction(
      async (tx) => {
        // Temp table mirrors the AuditLog columns under test. ON COMMIT DROP =>
        // auto-removed at tx end; no DROP/DELETE/TRUNCATE is ever executed.
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE bench_auditlog (id text PRIMARY KEY, data jsonb, "previousData" jsonb, "encryptedData" bytea, "encryptedPreviousData" bytea) ON COMMIT DROP`,
        );

        // Plaintext-only inserts.
        const pPlain0 = process.hrtime.bigint();
        for (let i = 0; i < n; i++) {
          const j = JSON.stringify(samplePayload(i));
          await tx.$executeRaw`INSERT INTO bench_auditlog (id, data, "previousData") VALUES (${`p-${i}`}, ${j}::jsonb, ${j}::jsonb)`;
        }
        const plainMs = Number(process.hrtime.bigint() - pPlain0) / 1e6;
        report({ label: 'DB insert: plaintext JSONB ×2', ops: n, ms: plainMs });

        // Envelope dual-write inserts (plaintext retained + ciphertext columns).
        const pEnc0 = process.hrtime.bigint();
        for (let i = 0; i < n; i++) {
          const j = JSON.stringify(samplePayload(i));
          const c = gcmEncrypt(j, dek);
          await tx.$executeRaw`INSERT INTO bench_auditlog (id, data, "previousData", "encryptedData", "encryptedPreviousData") VALUES (${`e-${i}`}, ${j}::jsonb, ${j}::jsonb, ${c}, ${c})`;
        }
        const encMs = Number(process.hrtime.bigint() - pEnc0) / 1e6;
        report({ label: 'DB insert: envelope dual-write', ops: n, ms: encMs });

        // Read back + locally decrypt the envelope rows.
        const r0 = process.hrtime.bigint();
        const rows = (await tx.$queryRawUnsafe(`SELECT "encryptedData" FROM bench_auditlog WHERE id LIKE 'e-%'`)) as Array<{
          encryptedData: Buffer | Uint8Array;
        }>;
        let decoded = 0;
        for (const row of rows) {
          void JSON.parse(gcmDecrypt(Buffer.from(row.encryptedData), dek));
          decoded++;
        }
        const readMs = Number(process.hrtime.bigint() - r0) / 1e6;
        report({ label: 'DB read+decrypt: envelope', ops: decoded, ms: readMs });
      },
      { timeout: 600_000, maxWait: 30_000 },
    );
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly = typeof process.argv[1] === 'string' && /benchmark-auditlog-envelope-encryption/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    const e = err as Error & { code?: string };
    console.error(`benchmark error: ${e.message}${e.code ? ` (code ${e.code})` : ''}`);
    if (process.env.BENCH_DEBUG === '1') console.error(err);
    process.exit(1);
  });
}
