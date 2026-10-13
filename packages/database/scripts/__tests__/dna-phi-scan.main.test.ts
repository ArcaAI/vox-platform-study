/**
 * dna-phi-scan — the CLI entry point (TASK-1067).
 *
 * `dna-phi-scan.test.ts` covers the detectors. This file runs `main()` against a
 * mocked Vault + Prisma and pins what makes the tool safe to run on real PHI:
 * it reads only, it reports COUNTS and never the decrypted text or a matched
 * substring, and it always disconnects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DIRTY_TEXT = 'Patient chart references MRN: 998877 in the note.';
const CLEAN_TEXT = 'Writes concise, structured assessments.';

const { vaultClient, vaultFactory, prisma } = vi.hoisted(() => {
  const vaultClient = {
    token: undefined as string | undefined,
    unwrap: vi.fn(),
    approleLogin: vi.fn(async (): Promise<unknown> => ({ auth: { client_token: 'approle-token' } })),
    // The ciphertext's tail names which fixture plaintext Transit hands back.
    write: vi.fn(async (_path: string, body: { ciphertext: string }): Promise<unknown> => {
      const plaintext = body.ciphertext.endsWith(':dirty') ? DIRTY_TEXT : CLEAN_TEXT;
      return { data: { plaintext: Buffer.from(plaintext).toString('base64') } };
    }),
  };
  const vaultFactory = vi.fn(() => vaultClient);
  const prisma: Record<string, any> = {
    dnaWritingStyleReport: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    $disconnect: vi.fn(async () => undefined),
  };
  return { vaultClient, vaultFactory, prisma };
});

vi.mock('node-vault', () => ({ default: vaultFactory }));
vi.mock('../../src/client.js', () => ({ getPlatformAdminPrismaClient_Unscoped: () => prisma }));

import { main } from '../dna-phi-scan';

const VAULT_ENV = {
  SECRETS_PROVIDER: 'vault',
  VAULT_ADDR: 'http://vault:8200',
  VAULT_ROLE_ID: 'role-1',
  VAULT_SECRET_ID: 'direct-sid',
};

const ct = (tail: string) => Buffer.from(`vault:v1:${tail}`, 'utf8');
const ROWS = [
  { id: 'r-dirty', tenantId: 't-1', doctorId: 'd-1', encryptedStyleText: ct('dirty') },
  { id: 'r-clean', tenantId: 't-1', doctorId: 'd-2', encryptedStyleText: ct('clean') },
  { id: 'r-empty', tenantId: 't-1', doctorId: 'd-3', encryptedStyleText: null },
];

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(VAULT_ENV)) vi.stubEnv(k, v);
  vi.stubEnv('VAULT_WRAPPED_SECRET_ID', '');
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void stdout.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void stderr.push(a.join(' ')));
  process.exitCode = undefined;
  prisma.dnaWritingStyleReport.findMany.mockResolvedValue(ROWS);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const run = (...flags: string[]) => main(['tsx', 'dna-phi-scan.ts', ...flags], { ...process.env, ...VAULT_ENV });

describe('dna-phi-scan main', () => {
  it("scans the tenant's rows and labels each DIRTY / CLEAN / EMPTY with counts", async () => {
    await run('--tenantId', 't-1');

    expect(prisma.dnaWritingStyleReport.findMany).toHaveBeenCalledWith({ where: { tenantId: 't-1' } });
    const out = stdout.join('\n');
    expect(out).toMatch(/^DIRTY {2}id=r-dirty tenantId=t-1 doctorId=d-1 scannedChars=\d+ mrnShaped=1 /m);
    expect(out).toMatch(/^CLEAN {2}id=r-clean .* mrnShaped=0 /m);
    expect(out).toMatch(/^EMPTY {2}id=r-empty .*scannedChars=0 /m);
    expect(out).toMatch(/3 row\(s\) scanned — 1 dirty, 2 clean \(1 of which decrypted to nothing/);
  });

  it('never prints the decrypted text or a matched substring — in either output mode', async () => {
    await run('--tenantId', 't-1');
    await run('--tenantId', 't-1', '--json');

    const everything = [...stdout, ...stderr].join('\n');
    for (const leak of [DIRTY_TEXT, CLEAN_TEXT, '998877', 'MRN: 998877']) expect(everything).not.toContain(leak);
  });

  it('emits one JSON result per row with --json', async () => {
    await run('--tenantId', 't-1', '--json');

    const results = JSON.parse(stdout.join('\n'));
    expect(results.map((r: { id: string; clean: boolean }) => [r.id, r.clean])).toEqual([
      ['r-dirty', false],
      ['r-clean', true],
      ['r-empty', true],
    ]);
  });

  it('decrypts under the requested Transit mount and key', async () => {
    await run('--tenantId', 't-1', '--transit-mount', 'tx', '--transit-key', 'k1');

    expect(vaultClient.write).toHaveBeenCalledWith('tx/decrypt/k1', { ciphertext: 'vault:v1:dirty' });
  });

  it('reads only, and disconnects even when a decrypt fails', async () => {
    vaultClient.write.mockRejectedValueOnce(new Error('transit down'));

    await expect(run('--tenantId', 't-1')).rejects.toThrow(/transit down/);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(prisma.dnaWritingStyleReport.update).not.toHaveBeenCalled();
    expect(prisma.dnaWritingStyleReport.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['SECRETS_PROVIDER is not vault', ['--tenantId', 't-1'], { SECRETS_PROVIDER: 'env' }, /SECRETS_PROVIDER=vault is required/],
    ['--tenantId is missing', [], VAULT_ENV, /--tenantId <tenantId> is required/],
  ])('refuses to run when %s, before touching Vault or the database', async (_label, flags, env, error) => {
    await main(['tsx', 'dna-phi-scan.ts', ...flags], env);

    expect(process.exitCode).toBe(2);
    expect(stderr.join('\n')).toMatch(error);
    expect(vaultFactory).not.toHaveBeenCalled();
    expect(prisma.dnaWritingStyleReport.findMany).not.toHaveBeenCalled();
  });

  it('prints usage for --help and does nothing else', async () => {
    await run('--help');

    expect(stdout.join('\n')).toMatch(/dna-phi-scan — READ-ONLY heuristic scan/);
    expect(vaultFactory).not.toHaveBeenCalled();
  });
});
