import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  baseHeader,
  collect,
  FAKE_SIGN_KEYS,
  FAKE_SIGN_PUBLIC_KEY_PEM,
  fakeSealing,
  manifestFor,
  OTHER_SIGN_PUBLIC_KEY_PEM,
} from '../../packages/applications/src/services/tenant-checkpoint/archive/__tests__/helpers';
import { createArchiveWriter } from '../../packages/applications/src/services/tenant-checkpoint/archive/writer';
import { openCheckpointFile } from '../checkpoint-open';

const PASSPHRASE = 'correct horse battery staple';
const sealing = fakeSealing();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hcp-open-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function buildFile(entries: [string, Buffer][], opts: { passphrase?: string | null } = {}): Promise<string> {
  const { plaintext, platformWrapped } = await sealing.generateDataKey();
  const passphrase = opts.passphrase === undefined ? PASSPHRASE : opts.passphrase;
  const keys = passphrase ? { platform: platformWrapped, passphrase: await sealing.wrapWithPassphrase(plaintext, passphrase) } : { platform: platformWrapped };
  const sink = new PassThrough();
  const bytes = collect(sink);
  const w = createArchiveWriter({ header: baseHeader({ keys }), dataKey: plaintext, sink, sealing });
  const tables = [];
  for (const [name, body] of entries) {
    const r = await w.writeEntry(name, body);
    const m = /^db\/(.+)\.csv\.gz$/.exec(name);
    if (m) tables.push({ model: m[1], sha256: r.sha256 });
  }
  await w.finish(manifestFor(tables));
  const file = join(dir, 'ckpt.hcp');
  await writeFile(file, await bytes);
  return file;
}

describe('openCheckpointFile — offline opener', () => {
  it('writes every entry under out/ with entry names as relative paths, plus the manifest', async () => {
    const big = randomBytes(200 * 1024);
    const file = await buildFile([
      ['db/Agent.csv.gz', big],
      ['media/b1/2026/10/01/x.wav', Buffer.from('wav')],
    ]);
    const out = join(dir, 'out');
    const r = await openCheckpointFile({ file, out, passphrase: PASSPHRASE });
    expect((await readFile(join(out, 'db/Agent.csv.gz'))).equals(big)).toBe(true);
    expect((await readFile(join(out, 'media/b1/2026/10/01/x.wav'))).toString()).toBe('wav');
    expect(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')).tables[0].model).toBe('Agent');
    expect(r.entries).toEqual(['db/Agent.csv.gz', 'media/b1/2026/10/01/x.wav']);
    expect(r.signature).toBe('present, not verified');
    expect(r.header.tenantId).toBe(baseHeader().tenantId);
  });

  it('reports "verified" with the right public key PEM', async () => {
    const file = await buildFile([['db/A.csv.gz', Buffer.from('a')]]);
    const r = await openCheckpointFile({ file, out: join(dir, 'out'), passphrase: PASSPHRASE, publicKey: FAKE_SIGN_PUBLIC_KEY_PEM });
    expect(r.signature).toBe('verified');
  });

  it('accepts the raw base64 public key Vault returns', async () => {
    const file = await buildFile([['db/A.csv.gz', Buffer.from('a')]]);
    const raw = (FAKE_SIGN_KEYS.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64');
    const r = await openCheckpointFile({ file, out: join(dir, 'out'), passphrase: PASSPHRASE, publicKey: raw });
    expect(r.signature).toBe('verified');
  });

  it('reports "INVALID" with another public key', async () => {
    const file = await buildFile([['db/A.csv.gz', Buffer.from('a')]]);
    const r = await openCheckpointFile({ file, out: join(dir, 'out'), passphrase: PASSPHRASE, publicKey: OTHER_SIGN_PUBLIC_KEY_PEM });
    expect(r.signature).toBe('INVALID');
  });

  it('a wrong passphrase rejects PASSPHRASE_INVALID and leaves out/ absent', async () => {
    const file = await buildFile([['db/A.csv.gz', Buffer.from('secret')]]);
    const out = join(dir, 'out');
    await expect(openCheckpointFile({ file, out, passphrase: 'nope' })).rejects.toMatchObject({ reason: 'PASSPHRASE_INVALID' });
    expect(existsSync(out)).toBe(false);
    expect((await readdir(dir)).sort()).toEqual(['ckpt.hcp']);
  });

  it('a checkpoint sealed without a passphrase cannot be opened offline', async () => {
    const file = await buildFile([['db/A.csv.gz', Buffer.from('a')]], { passphrase: null });
    await expect(openCheckpointFile({ file, out: join(dir, 'out'), passphrase: PASSPHRASE })).rejects.toMatchObject({ reason: 'PASSPHRASE_INVALID' });
  });

  it.each([['../evil'], ['/etc/evil'], ['a/../../evil'], ['a\\..\\evil'], ['a//b']])(
    'refuses the entry name %s and leaves no plaintext behind',
    async (name) => {
      const file = await buildFile([
        ['db/A.csv.gz', Buffer.from('first entry is fine')],
        [name, Buffer.from('x')],
      ]);
      const out = join(dir, 'out');
      await expect(openCheckpointFile({ file, out, passphrase: PASSPHRASE })).rejects.toThrow(/unsafe entry name/);
      expect(existsSync(out)).toBe(false);
      expect((await readdir(dir)).sort()).toEqual(['ckpt.hcp']);
      expect(existsSync(join(dir, '..', 'evil'))).toBe(false);
    },
  );

  it('a corrupted file fails with CORRUPT_SEGMENT and leaves out/ absent', async () => {
    const file = await buildFile([['db/A.csv.gz', randomBytes(100 * 1024)]]);
    const buf = await readFile(file);
    buf[buf.length - 200] ^= 0x01; // inside the last segment
    await writeFile(file, buf);
    const out = join(dir, 'out');
    await expect(openCheckpointFile({ file, out, passphrase: PASSPHRASE })).rejects.toMatchObject({ reason: 'CORRUPT_SEGMENT' });
    expect(existsSync(out)).toBe(false);
  });

  it('refuses to write into a non-empty existing directory', async () => {
    const file = await buildFile([['db/A.csv.gz', Buffer.from('a')]]);
    const out = join(dir, 'out');
    await openCheckpointFile({ file, out, passphrase: PASSPHRASE });
    await expect(openCheckpointFile({ file, out, passphrase: PASSPHRASE })).rejects.toThrow(/not empty/);
  });
});
