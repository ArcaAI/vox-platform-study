/**
 * TASK-1023 D-C — the store half of a cancel: an in-flight multipart upload is
 * ABORTED (its parts released) when the job's signal fires, and the partial
 * objects a cancelled job wrote can be deleted by key.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, DeleteObjectsCommand, PutObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { S3ModelStore } from '../model-store';

type Sent = { name: string; input: Record<string, unknown>; opts?: { abortSignal?: AbortSignal } };

function fakeClient(handler: (name: string, sent: Sent[]) => unknown) {
  const sent: Sent[] = [];
  return {
    sent,
    send: vi.fn(async (cmd: { input: Record<string, unknown>; constructor: { name: string } }, opts?: { abortSignal?: AbortSignal }) => {
      const entry = { name: cmd.constructor.name, input: cmd.input, opts };
      sent.push(entry);
      return handler(entry.name, sent);
    }),
  };
}

describe('S3ModelStore — cancel (TASK-1023)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'store-1023-'));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('a signal fired between parts aborts the multipart upload and never completes it', async () => {
    const file = join(dir, 'w.bin');
    await writeFile(file, Buffer.alloc(30, 1));
    const controller = new AbortController();
    const client = fakeClient((name) => {
      if (name === 'CreateMultipartUploadCommand') return { UploadId: 'up-1' };
      if (name === UploadPartCommand.name) {
        controller.abort(new Error('CANCELLED'));
        return { ETag: '"e1"' };
      }
      return {};
    });
    const store = new S3ModelStore(client, 'hope-models', { partSizeBytes: 10 });

    await expect(store.uploadFile('p/w.bin', file, { signal: controller.signal })).rejects.toThrow('CANCELLED');

    const names = client.sent.map((s) => s.name);
    expect(names.filter((n) => n === UploadPartCommand.name)).toHaveLength(1);
    expect(names).toContain(AbortMultipartUploadCommand.name);
    expect(names).not.toContain(CompleteMultipartUploadCommand.name);
    expect(client.sent.find((s) => s.name === AbortMultipartUploadCommand.name)?.input).toMatchObject({ Key: 'p/w.bin', UploadId: 'up-1' });
  });

  it('the signal rides on every request (the SDK aborts an in-flight part)', async () => {
    const file = join(dir, 's.bin');
    await writeFile(file, Buffer.alloc(3, 1));
    const signal = new AbortController().signal;
    const client = fakeClient(() => ({}));
    await new S3ModelStore(client, 'hope-models', { partSizeBytes: 10 }).uploadFile('p/s.bin', file, { signal });
    expect(client.sent[0].name).toBe(PutObjectCommand.name);
    expect(client.sent[0].opts?.abortSignal).toBe(signal);
  });

  it('an already-aborted signal sends nothing', async () => {
    const file = join(dir, 's.bin');
    await writeFile(file, Buffer.alloc(3, 1));
    const controller = new AbortController();
    controller.abort(new Error('CANCELLED'));
    const client = fakeClient(() => ({}));
    await expect(new S3ModelStore(client, 'hope-models').uploadFile('p/s.bin', file, { signal: controller.signal })).rejects.toThrow('CANCELLED');
    expect(client.sent).toHaveLength(0);
  });

  it('deleteKeys removes exactly the named keys, 1000 per request, and returns the count', async () => {
    const client = fakeClient(() => ({ Deleted: [] }));
    const keys = Array.from({ length: 1001 }, (_, i) => `p/k${i}`);
    await expect(new S3ModelStore(client, 'hope-models').deleteKeys(keys)).resolves.toBe(1001);
    const batches = client.sent.filter((s) => s.name === DeleteObjectsCommand.name).map((s) => (s.input.Delete as { Objects: unknown[] }).Objects.length);
    expect(batches).toEqual([1000, 1]);
  });

  it('deleteKeys with nothing to delete sends nothing', async () => {
    const client = fakeClient(() => ({}));
    await expect(new S3ModelStore(client, 'hope-models').deleteKeys([])).resolves.toBe(0);
    expect(client.sent).toHaveLength(0);
  });
});
