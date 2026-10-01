import { randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { CHECKPOINT_SEGMENT_BYTES } from '../../contracts';
import { openArchive, readHeader } from '../reader';
import { createArchiveWriter } from '../writer';
import { baseHeader, collect, fakeSealing, manifestFor, splitArchive } from './helpers';

describe('archive round trip', () => {
  it('returns every entry byte-identical, in order, with the manifest last', async () => {
    const dataKey = randomBytes(32);
    const sink = new PassThrough();
    const bytes = collect(sink);
    const w = createArchiveWriter({ header: baseHeader(), dataKey, sink, sealing: fakeSealing() });
    const big = randomBytes(300 * 1024); // spans several 64 KiB segments
    const a = await w.writeEntry('db/Agent.csv.gz', Readable.from([big.subarray(0, 1000), big.subarray(1000)]));
    await w.writeEntry('media/b1/2026/10/01/x.wav', Buffer.from('tiny'));
    await w.finish(manifestFor([{ model: 'Agent', sha256: a.sha256 }]));
    const r = await openArchive(Readable.from(await bytes), dataKey);
    const seen: [string, Buffer][] = [];
    for await (const e of r.entries()) seen.push([e.name, Buffer.concat(await e.body.toArray())]);
    expect(seen.map(([n]) => n)).toEqual(['db/Agent.csv.gz', 'media/b1/2026/10/01/x.wav']);
    expect(seen[0][1].equals(big)).toBe(true);
    expect(r.manifest().tables[0].sha256).toBe(a.sha256);
  });

  it('reports size, digest and per-entry sha256; the header round-trips with a fresh nonce prefix', async () => {
    const dataKey = randomBytes(32);
    const runs: { file: Buffer; finish: { sizeBytes: number; digestHex: string } }[] = [];
    for (let i = 0; i < 2; i++) {
      const sink = new PassThrough();
      const bytes = collect(sink);
      const w = createArchiveWriter({ header: baseHeader(), dataKey, sink, sealing: fakeSealing() });
      const e = await w.writeEntry('db/X.csv.gz', Buffer.from('abc'));
      expect(e).toEqual({ sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', bytes: 3 });
      const finish = await w.finish(manifestFor([{ model: 'X', sha256: e.sha256 }]));
      runs.push({ file: await bytes, finish });
    }
    expect(runs[0].finish.sizeBytes).toBe(runs[0].file.length);
    const { header } = await readHeader(Readable.from(runs[0].file));
    expect(header.tenantId).toBe(baseHeader().tenantId);
    const { header: h2 } = await readHeader(Readable.from(runs[1].file));
    expect(h2.noncePrefix).not.toBe(header.noncePrefix);
    expect(Buffer.from(splitArchive(runs[0].file).trailer.subarray(8, 40)).toString('hex')).toBe(runs[0].finish.digestHex);
  });

  it('handles an entry stream that ends exactly on a segment boundary and empty entries', async () => {
    const dataKey = randomBytes(32);
    for (const size of [0, 1, CHECKPOINT_SEGMENT_BYTES - 40, CHECKPOINT_SEGMENT_BYTES, CHECKPOINT_SEGMENT_BYTES * 2 + 7]) {
      const sink = new PassThrough();
      const bytes = collect(sink);
      const w = createArchiveWriter({ header: baseHeader(), dataKey, sink, sealing: fakeSealing() });
      const body = randomBytes(size);
      await w.writeEntry('e', body);
      await w.finish(manifestFor([]));
      const r = await openArchive(Readable.from(await bytes), dataKey);
      const got: Buffer[] = [];
      for await (const e of r.entries()) got.push(Buffer.concat(await e.body.toArray()));
      expect(got).toHaveLength(1);
      expect(got[0].equals(body)).toBe(true);
    }
  });

  it('skips entries whose body the consumer did not read', async () => {
    const dataKey = randomBytes(32);
    const sink = new PassThrough();
    const bytes = collect(sink);
    const w = createArchiveWriter({ header: baseHeader(), dataKey, sink, sealing: fakeSealing() });
    await w.writeEntry('skip', randomBytes(200 * 1024));
    await w.writeEntry('keep', Buffer.from('kept'));
    await w.finish(manifestFor([]));
    const r = await openArchive(Readable.from(await bytes), dataKey);
    const got: Record<string, string> = {};
    for await (const e of r.entries()) if (e.name === 'keep') got[e.name] = Buffer.concat(await e.body.toArray()).toString();
    expect(got).toEqual({ keep: 'kept' });
  });

  it('refuses the reserved manifest name and writes after finish', async () => {
    const sink = new PassThrough();
    void collect(sink);
    const w = createArchiveWriter({ header: baseHeader(), dataKey: randomBytes(32), sink, sealing: fakeSealing() });
    await expect(w.writeEntry('manifest.json', Buffer.from('x'))).rejects.toThrow(/reserved/);
  });
});
