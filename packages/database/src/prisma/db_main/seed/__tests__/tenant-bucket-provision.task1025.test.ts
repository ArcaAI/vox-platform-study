/**
 * TASK-1025 G1 — the seed's physical-bucket step (05b) must not HIDE failures.
 *
 * It used to wrap the whole loop in one try/catch: the first S3 error aborted
 * every remaining bucket and printed a single "Skipping" warning, so a green
 * seed log could sit on top of bucket rows with no physical bucket behind them.
 *
 * Decision (documented in the ticket README): the step still does NOT throw — a
 * seed run must not wedge a deploy on a storage hiccup — but it tries EVERY
 * bucket, names each one that failed on stderr, and returns the tally so the
 * caller (and this test) can see exactly what happened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(public readonly input: { Bucket: string }) {}
  }
  class HeadBucketCommand extends Command {}
  class CreateBucketCommand extends Command {}
  class S3Client {
    send = send;
  }
  return { S3Client, HeadBucketCommand, CreateBucketCommand };
});

import { provisionTenantBuckets } from '../05b-tenant-bucket-provision';

const rows = [{ name: 'hope-attachments-acme' }, { name: 'hope-recordings-acme' }, { name: 'hope-attachments-beta' }];
const client = { tenantBucket: { findMany: vi.fn(async () => rows) } };

function notFound(): Error {
  return Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
}

describe('provisionTenantBuckets (05b) — TASK-1025 G1 failure reporting', () => {
  beforeEach(() => {
    send.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('keeps going past a failed bucket and reports every failure by name', async () => {
    send.mockImplementation(async (command: { constructor: { name: string }; input: { Bucket: string } }) => {
      if (command.constructor.name === 'HeadBucketCommand') throw notFound();
      if (command.input.Bucket === 'hope-recordings-acme') throw new Error('AccessDenied');
      return {};
    });

    const result = await provisionTenantBuckets(client as never);

    expect(result.created).toEqual(['hope-attachments-acme', 'hope-attachments-beta']);
    expect(result.failed).toEqual([{ name: 'hope-recordings-acme', error: 'AccessDenied' }]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('hope-recordings-acme'));
  });

  it('does not treat an unreachable store as "bucket missing": a HeadBucket error other than 404 is a failure, not a create', async () => {
    send.mockImplementation(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    const result = await provisionTenantBuckets(client as never);

    expect(result.created).toEqual([]);
    expect(result.failed.map((f) => f.name)).toEqual(rows.map((r) => r.name));
    const createCalls = send.mock.calls.filter(
      ([command]) => (command as { constructor: { name: string } }).constructor.name === 'CreateBucketCommand',
    );
    expect(createCalls).toHaveLength(0);
  });

  it('counts buckets that already exist without re-creating them', async () => {
    send.mockResolvedValue({});

    const result = await provisionTenantBuckets(client as never);

    expect(result.existing).toEqual(rows.map((r) => r.name));
    expect(result.failed).toEqual([]);
  });

  it('never throws — a storage outage must not wedge the seed run', async () => {
    send.mockRejectedValue(new Error('boom'));

    await expect(provisionTenantBuckets(client as never)).resolves.toBeDefined();
  });
});
