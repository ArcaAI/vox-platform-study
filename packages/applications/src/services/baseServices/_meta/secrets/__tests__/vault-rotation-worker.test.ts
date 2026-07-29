// VaultRotationWorker.
//
// Asserts:
//   - handleAuditLine parses Vault audit JSON for kv-v2 update/create
//     under secret/data/<prefix>/<KEY> and publishes
//     {"key":"<KEY>"} to the configured Redis channel.
//   - Non-relevant audit lines (read, list, login, transit) are ignored.
//   - Malformed lines do not throw.
//   - Idempotency: emitting the same audit line twice publishes twice
//     (the cache.delete is a no-op for already-absent keys, so we do
//     NOT dedup at the publisher).
import { describe, it, expect, vi } from 'vitest';
import { VaultRotationWorker } from '../vault-rotation-worker';

function fakePublisher(): { publish: ReturnType<typeof vi.fn>; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const publish = vi.fn(async (ch: string, msg: string) => {
    calls.push([ch, msg]);
    return 1;
  });
  return { publish, calls };
}

describe('VaultRotationWorker.handleAuditLine (Phase 6 Task 6.3)', () => {
  it('publishes an invalidation event for kv-v2 update under secret/data/hope/<KEY>', async () => {
    const pub = fakePublisher();
    const w = new VaultRotationWorker({
      publisher: pub as never,
      channel: 'arca:secrets:invalidate',
      kvPrefix: 'hope',
    });
    const line = JSON.stringify({
      type: 'request',
      request: { operation: 'update', path: 'secret/data/hope/JWT_SECRET_KEY' },
    });
    await w.handleAuditLine(line);
    expect(pub.calls).toEqual([['arca:secrets:invalidate', JSON.stringify({ key: 'JWT_SECRET_KEY' })]]);
  });

  it('publishes for create as well as update', async () => {
    const pub = fakePublisher();
    const w = new VaultRotationWorker({ publisher: pub as never, kvPrefix: 'hope' });
    const line = JSON.stringify({
      type: 'request',
      request: { operation: 'create', path: 'secret/data/hope/API_KEY_PEPPER' },
    });
    await w.handleAuditLine(line);
    expect(pub.calls).toEqual([['arca:secrets:invalidate', JSON.stringify({ key: 'API_KEY_PEPPER' })]]);
  });

  it('ignores read operations (no eviction needed on get)', async () => {
    const pub = fakePublisher();
    const w = new VaultRotationWorker({ publisher: pub as never, kvPrefix: 'hope' });
    const line = JSON.stringify({
      type: 'request',
      request: { operation: 'read', path: 'secret/data/hope/JWT_SECRET_KEY' },
    });
    await w.handleAuditLine(line);
    expect(pub.calls).toEqual([]);
  });

  it('ignores transit/encrypt operations (the key changed; the value did not)', async () => {
    const pub = fakePublisher();
    const w = new VaultRotationWorker({ publisher: pub as never, kvPrefix: 'hope' });
    const line = JSON.stringify({
      type: 'request',
      request: { operation: 'update', path: 'transit/encrypt/hope-globalsetting' },
    });
    await w.handleAuditLine(line);
    expect(pub.calls).toEqual([]);
  });

  it('ignores non-request entries (response, error, etc)', async () => {
    const pub = fakePublisher();
    const w = new VaultRotationWorker({ publisher: pub as never, kvPrefix: 'hope' });
    const line = JSON.stringify({
      type: 'response',
      request: { operation: 'update', path: 'secret/data/hope/JWT_SECRET_KEY' },
    });
    await w.handleAuditLine(line);
    expect(pub.calls).toEqual([]);
  });

  it('ignores paths under a different prefix', async () => {
    const pub = fakePublisher();
    const w = new VaultRotationWorker({ publisher: pub as never, kvPrefix: 'hope' });
    const line = JSON.stringify({
      type: 'request',
      request: { operation: 'update', path: 'secret/data/another-app/JWT_SECRET_KEY' },
    });
    await w.handleAuditLine(line);
    expect(pub.calls).toEqual([]);
  });

  it('does not throw on malformed JSON (logs at debug)', async () => {
    const pub = fakePublisher();
    const w = new VaultRotationWorker({ publisher: pub as never, kvPrefix: 'hope' });
    await expect(w.handleAuditLine('{not-json')).resolves.toBeUndefined();
    expect(pub.calls).toEqual([]);
  });

  it('honours a custom channel override', async () => {
    const pub = fakePublisher();
    const w = new VaultRotationWorker({
      publisher: pub as never,
      channel: 'custom:secret-channel',
      kvPrefix: 'hope',
    });
    const line = JSON.stringify({
      type: 'request',
      request: { operation: 'update', path: 'secret/data/hope/X' },
    });
    await w.handleAuditLine(line);
    expect(pub.calls[0]?.[0]).toBe('custom:secret-channel');
  });
});

describe('VaultRotationWorker idempotency (Phase 6 Task 6.8)', () => {
  it('publishes the same key twice on duplicate audit lines (no dedup at publisher)', async () => {
    const pub = fakePublisher();
    const w = new VaultRotationWorker({ publisher: pub as never, kvPrefix: 'hope' });
    const line = JSON.stringify({
      type: 'request',
      request: { operation: 'update', path: 'secret/data/hope/JWT_SECRET_KEY' },
    });
    await w.handleAuditLine(line);
    await w.handleAuditLine(line);
    expect(pub.calls).toHaveLength(2);
    expect(pub.calls[0]).toEqual(pub.calls[1]);
  });
});

describe('VaultRotationWorker.run file-tail loop (Phase 6 Task 6.4)', () => {
  it('reads new audit lines appended after start and forwards them', async () => {
    const { mkdtempSync, writeFileSync, appendFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'vault-rot-'));
    const file = join(dir, 'audit.log');
    // Seed with one line (which the loop should NOT re-read because it
    // starts tailing from EOF).
    writeFileSync(
      file,
      JSON.stringify({
        type: 'request',
        request: { operation: 'update', path: 'secret/data/hope/PRE_BOOT' },
      }) + '\n',
    );

    const pub = fakePublisher();
    const w = new VaultRotationWorker({
      publisher: pub as never,
      kvPrefix: 'hope',
      pollIntervalMs: 50,
    });
    const ac = new AbortController();
    const runPromise = w.run(file, ac.signal);

    // Append a fresh audit line and wait briefly for the loop to pick it up.
    await new Promise((r) => setTimeout(r, 100));
    appendFileSync(
      file,
      JSON.stringify({
        type: 'request',
        request: { operation: 'update', path: 'secret/data/hope/POST_BOOT' },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 250));
    ac.abort();
    await runPromise;

    // The pre-boot line MUST NOT have been published; only POST_BOOT.
    const keys = pub.calls.map(([, msg]) => (JSON.parse(msg) as { key: string }).key);
    expect(keys).toContain('POST_BOOT');
    expect(keys).not.toContain('PRE_BOOT');
  });

  it('aborts cleanly via AbortSignal', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'vault-rot-abort-'));
    const file = join(dir, 'audit.log');
    writeFileSync(file, '');

    const pub = fakePublisher();
    const w = new VaultRotationWorker({
      publisher: pub as never,
      kvPrefix: 'hope',
      pollIntervalMs: 25,
    });
    const ac = new AbortController();
    const p = w.run(file, ac.signal);
    setTimeout(() => ac.abort(), 60);
    await expect(p).resolves.toBeUndefined();
  });
});
