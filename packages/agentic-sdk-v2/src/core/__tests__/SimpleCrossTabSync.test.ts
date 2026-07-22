/**
 * @arcaai/vox - SimpleCrossTabSync Tests
 *
 * Covers W0-4 (HMAC-signed cross-tab messages) and W0-5 (per-tenant
 * BroadcastChannel naming) on top of the original sync contract.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SimpleCrossTabSync,
  createCrossTabSync,
  __resetSessionHmacSecretForTests,
  __getSessionHmacSecretForTests,
} from '../SimpleCrossTabSync';
import type { ContextItem } from '../../types';

// =============================================================================
// Mock BroadcastChannel that delivers postMessage synchronously to same-named
// peers. Tracks every constructed channel so tests can inspect channel names.
// =============================================================================
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown) {
    if (this.closed) return;
    MockBroadcastChannel.instances
      .filter((i) => i.name === this.name && i !== this && !i.closed)
      .forEach((i) => {
        if (i.onmessage) {
          i.onmessage(new MessageEvent('message', { data }));
        }
      });
  }

  close() {
    this.closed = true;
    const idx = MockBroadcastChannel.instances.indexOf(this);
    if (idx > -1) MockBroadcastChannel.instances.splice(idx, 1);
  }

  static clearInstances() {
    MockBroadcastChannel.instances = [];
  }
}

const originalBroadcastChannel = globalThis.BroadcastChannel;

// Helper: wait long enough for async HMAC sign/verify microtasks (and the
// internal "flush after signing" postMessage) to settle. crypto.subtle is
// async in jsdom so we must flush the queue before asserting reception.
async function flushAsync(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

const baseConsultation = {
  patientId: 'patient-123',
  doctorId: 'doctor-456',
  appointmentDate: '2026-01-29',
};

function mkContext(overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    id: 'ctx-1',
    consultationId: 'consultation-1',
    type: 'CASE_NOTE',
    content: 'Test note',
    source: 'USER',
    isSummary: false,
    isTranscription: false,
    isAiGenerated: false,
    createdAt: '2026-01-29T10:00:00Z',
    updatedAt: '2026-01-29T10:00:00Z',
    ...overrides,
  } as ContextItem;
}

describe('SimpleCrossTabSync', () => {
  beforeEach(() => {
    MockBroadcastChannel.clearInstances();
    (globalThis as unknown as { BroadcastChannel: typeof MockBroadcastChannel }).BroadcastChannel = MockBroadcastChannel;
  });

  afterEach(() => {
    (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel = originalBroadcastChannel;
  });

  // ===========================================================================
  // Constructor & factory
  // ===========================================================================
  describe('constructor', () => {
    it('exposes the consultation key derived from patient+doctor+date', () => {
      const sync = new SimpleCrossTabSync(baseConsultation);
      expect(sync.getConsultationKey()).toBe('patient-123_doctor-456_2026-01-29');
      expect(sync.isAvailable()).toBe(true);
      sync.close();
    });

    it('generates a unique tab id per instance', () => {
      const s1 = new SimpleCrossTabSync(baseConsultation);
      const s2 = new SimpleCrossTabSync(baseConsultation);
      expect(s1.getTabId()).not.toBe(s2.getTabId());
      s1.close();
      s2.close();
    });
  });

  describe('createCrossTabSync factory', () => {
    it('returns a SimpleCrossTabSync instance', () => {
      const s = createCrossTabSync(baseConsultation);
      expect(s).toBeInstanceOf(SimpleCrossTabSync);
      expect(s.isAvailable()).toBe(true);
      s.close();
    });
  });

  // ===========================================================================
  // Context broadcast / receive (HMAC-signed; tabs in same JS context share the
  // module-level secret so they can verify each other's messages).
  // ===========================================================================
  describe('context broadcasting', () => {
    it('delivers context to another tab on the same consultation channel', async () => {
      const s1 = new SimpleCrossTabSync(baseConsultation);
      const s2 = new SimpleCrossTabSync(baseConsultation);
      const received: ContextItem[] = [];
      s2.onContextAdded((c) => received.push(c));

      const ctx = mkContext({ content: 'shared note' });
      await s1.broadcastContext(ctx);
      await flushAsync();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(ctx);

      s1.close();
      s2.close();
    });

    it('does NOT deliver to a tab on a different consultation', async () => {
      const s1 = new SimpleCrossTabSync(baseConsultation);
      const s2 = new SimpleCrossTabSync({ ...baseConsultation, patientId: 'patient-other' });
      const received: ContextItem[] = [];
      s2.onContextAdded((c) => received.push(c));

      await s1.broadcastContext(mkContext());
      await flushAsync();

      expect(received).toHaveLength(0);

      s1.close();
      s2.close();
    });

    it('does NOT receive its own messages', async () => {
      const sync = new SimpleCrossTabSync(baseConsultation);
      const received: ContextItem[] = [];
      sync.onContextAdded((c) => received.push(c));

      await sync.broadcastContext(mkContext());
      await flushAsync();

      expect(received).toHaveLength(0);
      sync.close();
    });
  });

  describe('context updates', () => {
    it('delivers context_updated events', async () => {
      const s1 = new SimpleCrossTabSync(baseConsultation);
      const s2 = new SimpleCrossTabSync(baseConsultation);
      const got: ContextItem[] = [];
      s2.onContextUpdated((c) => got.push(c));

      await s1.broadcastContextUpdate(mkContext({ content: 'Updated' }));
      await flushAsync();

      expect(got).toHaveLength(1);
      expect(got[0].content).toBe('Updated');
      s1.close();
      s2.close();
    });
  });

  describe('listener management', () => {
    it('fans out to multiple listeners', async () => {
      const s1 = new SimpleCrossTabSync(baseConsultation);
      const s2 = new SimpleCrossTabSync(baseConsultation);
      const a: ContextItem[] = [];
      const b: ContextItem[] = [];
      s2.onContextAdded((c) => a.push(c));
      s2.onContextAdded((c) => b.push(c));

      await s1.broadcastContext(mkContext());
      await flushAsync();

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      s1.close();
      s2.close();
    });

    it('returns an unsubscribe fn that detaches the listener', async () => {
      const s1 = new SimpleCrossTabSync(baseConsultation);
      const s2 = new SimpleCrossTabSync(baseConsultation);
      const received: ContextItem[] = [];
      const off = s2.onContextAdded((c) => received.push(c));

      await s1.broadcastContext(mkContext());
      await flushAsync();
      expect(received).toHaveLength(1);

      off();
      await s1.broadcastContext(mkContext());
      await flushAsync();
      expect(received).toHaveLength(1);

      s1.close();
      s2.close();
    });
  });

  describe('lifecycle', () => {
    it('close() makes broadcastContext a no-op (no throw)', async () => {
      const sync = new SimpleCrossTabSync(baseConsultation);
      sync.close();
      await expect(sync.broadcastContext(mkContext())).resolves.toBeUndefined();
    });

    it('handles missing BroadcastChannel gracefully', async () => {
      delete (globalThis as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
      const sync = new SimpleCrossTabSync(baseConsultation);
      expect(sync.isAvailable()).toBe(false);
      await expect(sync.broadcastContext(mkContext())).resolves.toBeUndefined();
      sync.close();
    });
  });

  // ===========================================================================
  // HMAC-signed messages
  //
  // Every broadcast must wrap its payload as `{ payload, hmac }`. Receivers
  // verify HMAC and drop on mismatch / missing signature. The signing key is
  // a per-session, in-memory, never-persisted random 32-byte secret.
  // ===========================================================================
  describe('HMAC-signed cross-tab messages', () => {
    beforeEach(() => {
      // Reset module-level secret so each test starts from a fresh "app load".
      __resetSessionHmacSecretForTests();
    });

    function injectRawIntoChannel(sync: SimpleCrossTabSync, data: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test introspection.
      const channel = (sync as any).channel as MockBroadcastChannel | null;
      if (channel?.onmessage) {
        channel.onmessage(new MessageEvent('message', { data }));
      }
    }

    it('wraps every postMessage in a {payload, hmac} envelope', async () => {
      const sync = new SimpleCrossTabSync(baseConsultation);
      // Channel construction is async without tenantId.
      await sync.whenReady();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test introspection.
      const channel = (sync as any).channel as MockBroadcastChannel;
      const spy = vi.spyOn(channel, 'postMessage');

      await sync.broadcastContext(mkContext());
      await flushAsync();

      expect(spy).toHaveBeenCalledTimes(1);
      const sent = spy.mock.calls[0]![0] as { payload?: unknown; hmac?: unknown };
      expect(sent).toHaveProperty('payload');
      expect(sent).toHaveProperty('hmac');
      expect(typeof sent.hmac).toBe('string');
      expect((sent.hmac as string).length).toBeGreaterThan(0);

      sync.close();
    });

    it('drops unsigned (raw legacy-shape) messages and warns', async () => {
      const warn = vi.fn();
      const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
      const sync = new SimpleCrossTabSync(baseConsultation, { logger });
      // Channel construction is async without tenantId.
      await sync.whenReady();
      const listener = vi.fn();
      sync.onContextAdded(listener);

      // Raw legacy-shape (no envelope, no hmac)
      injectRawIntoChannel(sync, {
        type: 'context_added',
        tabId: 'attacker-tab',
        data: mkContext({ content: 'malicious' }),
        timestamp: Date.now(),
      });
      await flushAsync();

      expect(listener).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      sync.close();
    });

    it('drops messages with tampered payload (HMAC no longer matches)', async () => {
      const warn = vi.fn();
      const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

      const sender = new SimpleCrossTabSync(baseConsultation);
      const receiver = new SimpleCrossTabSync(baseConsultation, { logger });
      // Channel construction is async without tenantId.
      await Promise.all([sender.whenReady(), receiver.whenReady()]);
      const listener = vi.fn();
      receiver.onContextAdded(listener);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test introspection.
      const senderChannel = (sender as any).channel as MockBroadcastChannel;
      // Intercept sender's postMessage and tamper the payload before delivery.
      vi.spyOn(senderChannel, 'postMessage').mockImplementation((wire: unknown) => {
        const envelope = wire as { payload: { data: unknown }; hmac: string };
        envelope.payload = { ...envelope.payload, data: mkContext({ content: 'TAMPERED' }) };
        // Manually fan out to other channels with the SAME name (mirroring real BroadcastChannel).
        MockBroadcastChannel.instances
          .filter((i) => i.name === senderChannel.name && i !== senderChannel && !i.closed)
          .forEach((i) => i.onmessage?.(new MessageEvent('message', { data: envelope })));
      });

      await sender.broadcastContext(mkContext({ content: 'original' }));
      await flushAsync();

      expect(listener).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();

      sender.close();
      receiver.close();
    });

    it('drops messages signed with a different secret (cross-context attack)', async () => {
      const warn = vi.fn();
      const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

      const receiver = new SimpleCrossTabSync(baseConsultation, { logger });
      const listener = vi.fn();
      receiver.onContextAdded(listener);

      // Sign a message with a DIFFERENT secret and inject directly.
      const otherSecret = new Uint8Array(32);
      crypto.getRandomValues(otherSecret);
      const otherKey = await crypto.subtle.importKey(
        'raw',
        otherSecret as unknown as ArrayBuffer,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const payload = {
        type: 'context_added',
        tabId: 'attacker-tab',
        data: mkContext(),
        timestamp: Date.now(),
      };
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
      const sig = await crypto.subtle.sign('HMAC', otherKey, payloadBytes);
      const hmac = btoa(String.fromCharCode(...new Uint8Array(sig)));

      injectRawIntoChannel(receiver, { payload, hmac });
      await flushAsync();

      expect(listener).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();

      receiver.close();
    });

    it('accepts a properly-signed message and delivers it to listeners', async () => {
      const s1 = new SimpleCrossTabSync(baseConsultation);
      const s2 = new SimpleCrossTabSync(baseConsultation);
      const got: ContextItem[] = [];
      s2.onContextAdded((c) => got.push(c));

      await s1.broadcastContext(mkContext({ content: 'happy path' }));
      await flushAsync();

      expect(got).toHaveLength(1);
      expect(got[0].content).toBe('happy path');

      s1.close();
      s2.close();
    });

    it('uses a 32-byte secret (NIST guidance for HMAC-SHA-256)', () => {
      __resetSessionHmacSecretForTests();
      // Trigger lazy generation by constructing an instance.
      const sync = new SimpleCrossTabSync(baseConsultation);
      const secret = __getSessionHmacSecretForTests();
      expect(secret).not.toBeNull();
      expect(secret!.byteLength).toBe(32);
      sync.close();
    });

    it('regenerates the secret on reset (simulating app reload)', () => {
      __resetSessionHmacSecretForTests();
      new SimpleCrossTabSync(baseConsultation).close();
      const first = __getSessionHmacSecretForTests();

      __resetSessionHmacSecretForTests();
      new SimpleCrossTabSync(baseConsultation).close();
      const second = __getSessionHmacSecretForTests();

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // Different 32-byte arrays — collision probability is ~2^-256.
      expect(Buffer.from(first!).equals(Buffer.from(second!))).toBe(false);
    });
  });

  // ===========================================================================
  // Per-tenant BroadcastChannel naming
  //
  // Channel name MUST include the active tenant id — `agentic.<tenantId>` —
  // or `agentic.<consultationKey>` when tenantId is not reachable. Never the
  // bare `'agentic'` string (would cross-talk between tenants).
  // ===========================================================================
  describe('per-tenant BroadcastChannel naming', () => {
    function lastChannelName(): string {
      const ch = MockBroadcastChannel.instances[MockBroadcastChannel.instances.length - 1];
      return ch.name;
    }

    it('uses `agentic.<tenantId>` when a tenantId is provided', async () => {
      const sync = new SimpleCrossTabSync(baseConsultation, { tenantId: 'tenant-A' });
      await sync.whenReady();
      expect(lastChannelName()).toBe('agentic.tenant-A');
      sync.close();
    });

    it('falls back to `agentic.<sha256-first8-hex>` when tenantId is missing (no raw PHI in channel name)', async () => {
      const sync = new SimpleCrossTabSync(baseConsultation);
      await sync.whenReady();
      const name = lastChannelName();
      // Format: `agentic.` + 16 hex chars (first 8 bytes of SHA-256).
      expect(name).toMatch(/^agentic\.[0-9a-f]{16}$/);
      // The raw consultation key — patientId / doctorId / appointmentDate —
      // must NOT appear anywhere in the channel name.
      expect(name).not.toContain(baseConsultation.patientId);
      expect(name).not.toContain(baseConsultation.doctorId);
      expect(name).not.toContain(baseConsultation.appointmentDate);
      sync.close();
    });

    it('produces a stable hash for the same consultation key', async () => {
      const a = new SimpleCrossTabSync(baseConsultation);
      const b = new SimpleCrossTabSync(baseConsultation);
      await Promise.all([a.whenReady(), b.whenReady()]);
      const names = MockBroadcastChannel.instances.slice(-2).map((ch) => ch.name);
      expect(names[0]).toBe(names[1]);
      a.close();
      b.close();
    });

    it('produces distinct hashes for different consultation keys', async () => {
      const a = new SimpleCrossTabSync(baseConsultation);
      const b = new SimpleCrossTabSync({ ...baseConsultation, patientId: 'patient-OTHER' });
      await Promise.all([a.whenReady(), b.whenReady()]);
      const names = MockBroadcastChannel.instances.slice(-2).map((ch) => ch.name);
      expect(names[0]).not.toBe(names[1]);
      a.close();
      b.close();
    });

    it('never uses the bare `agentic` channel name', async () => {
      const a = new SimpleCrossTabSync(baseConsultation, { tenantId: 't1' });
      const b = new SimpleCrossTabSync(baseConsultation);
      await Promise.all([a.whenReady(), b.whenReady()]);
      for (const ch of MockBroadcastChannel.instances) {
        expect(ch.name).not.toBe('agentic');
      }
      a.close();
      b.close();
    });

    it('isolates tenants — different tenantIds cannot exchange messages', async () => {
      const s1 = new SimpleCrossTabSync(baseConsultation, { tenantId: 'tenant-A' });
      const s2 = new SimpleCrossTabSync(baseConsultation, { tenantId: 'tenant-B' });
      const received: ContextItem[] = [];
      s2.onContextAdded((c) => received.push(c));

      await s1.broadcastContext(mkContext({ content: 'cross-tenant should not leak' }));
      await flushAsync();

      expect(received).toHaveLength(0);
      s1.close();
      s2.close();
    });

    it('setTenantId() closes the old channel and opens a new one named for the new tenant', async () => {
      const sync = new SimpleCrossTabSync(baseConsultation, { tenantId: 'tenant-A' });
      await sync.whenReady();
      const before = MockBroadcastChannel.instances.length;
      const oldChannel = MockBroadcastChannel.instances[before - 1];

      sync.setTenantId('tenant-B');
      await sync.whenReady();

      expect(oldChannel.closed).toBe(true);
      const after = MockBroadcastChannel.instances.length;
      expect(after).toBe(before); // -1 old (closed/removed) + 1 new
      const newChannel = MockBroadcastChannel.instances[after - 1];
      expect(newChannel.name).toBe('agentic.tenant-B');
      sync.close();
    });

    it('setTenantId() is a no-op when called with the current tenantId', async () => {
      const sync = new SimpleCrossTabSync(baseConsultation, { tenantId: 'tenant-A' });
      await sync.whenReady();
      const beforeCount = MockBroadcastChannel.instances.length;
      sync.setTenantId('tenant-A');
      expect(MockBroadcastChannel.instances.length).toBe(beforeCount);
      sync.close();
    });
  });

  // ===========================================================================
  // SharedWorker-backed HMAC key
  //
  // Two tabs of the same origin share a single 32-byte HMAC secret held in
  // the SharedWorker process. Before, each tab had its own module
  // singleton and therefore COULD NOT verify cross-tab messages — the
  // pre-refactor `SimpleCrossTabSync` only worked when the receiving page
  // happened to be the same JS process as the sender (vitest jsdom case).
  // The mock installs a `globalThis.SharedWorker` that proxies all ports
  // to a single in-memory secret store, simulating real cross-tab routing.
  // ===========================================================================
  describe('SharedWorker-backed HMAC key', () => {
    // Minimal in-memory SharedWorker mock — see CrossTabHmacKeyManager.test.ts
    // for the comprehensive RPC-level coverage. This mirror exists so the
    // SimpleCrossTabSync end-to-end (BroadcastChannel + HMAC manager) flow
    // can be exercised against a shared secret.
    type Req =
      | { id: string; op: 'sign'; payload: ArrayBuffer }
      | { id: string; op: 'verify'; payload: ArrayBuffer; hmac: ArrayBuffer }
      | { id: string; op: 'reset' };
    type Res =
      | { id: string; ok: true; result: ArrayBuffer | boolean | null }
      | { id: string; ok: false; error: string };

    class MockSharedWorkerImpl {
      private secret: Uint8Array | null = null;
      private keyPromise: Promise<CryptoKey> | null = null;
      private async getKey(): Promise<CryptoKey> {
        if (this.keyPromise === null) {
          if (this.secret === null) {
            this.secret = new Uint8Array(32);
            crypto.getRandomValues(this.secret);
          }
          this.keyPromise = crypto.subtle.importKey(
            'raw',
            this.secret as unknown as ArrayBuffer,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign', 'verify'],
          );
        }
        return this.keyPromise;
      }
      async handle(req: Req, respond: (r: Res) => void): Promise<void> {
        try {
          if (req.op === 'sign') {
            const sig = await crypto.subtle.sign('HMAC', await this.getKey(), req.payload);
            respond({ id: req.id, ok: true, result: sig });
          } else if (req.op === 'verify') {
            const ok = await crypto.subtle.verify('HMAC', await this.getKey(), req.hmac, req.payload);
            respond({ id: req.id, ok: true, result: ok });
          } else {
            this.secret = null;
            this.keyPromise = null;
            respond({ id: req.id, ok: true, result: null });
          }
        } catch (err) {
          respond({ id: req.id, ok: false, error: String(err) });
        }
      }
    }
    class MockMessagePort {
      onmessage: ((e: MessageEvent) => void) | null = null;
      closed = false;
      constructor(private impl: MockSharedWorkerImpl) {}
      postMessage(req: unknown): void {
        if (this.closed) return;
        queueMicrotask(() => {
          void this.impl.handle(req as Req, (res) => {
            if (this.closed) return;
            this.onmessage?.(new MessageEvent('message', { data: res }));
          });
        });
      }
      start(): void {}
      close(): void {
        this.closed = true;
      }
    }
    class MockSharedWorker {
      static instances = new Map<string, MockSharedWorkerImpl>();
      port: MockMessagePort;
      constructor(url: string | URL, _options?: { name?: string }) {
        const key = typeof url === 'string' ? url : url.toString();
        let impl = MockSharedWorker.instances.get(key);
        if (!impl) {
          impl = new MockSharedWorkerImpl();
          MockSharedWorker.instances.set(key, impl);
        }
        this.port = new MockMessagePort(impl);
      }
      static reset() {
        this.instances.clear();
      }
    }

    beforeEach(() => {
      MockSharedWorker.reset();
      __resetSessionHmacSecretForTests();
      (globalThis as unknown as { SharedWorker: typeof MockSharedWorker }).SharedWorker = MockSharedWorker;
    });

    afterEach(() => {
      delete (globalThis as { SharedWorker?: unknown }).SharedWorker;
    });

    it('isUsingSharedWorkerHmac() returns true when the SharedWorker mock is installed', async () => {
      const sync = new SimpleCrossTabSync(baseConsultation);
      // Trigger lazy manager construction.
      await sync.broadcastContext(mkContext());
      await flushAsync();
      expect(sync.isUsingSharedWorkerHmac()).toBe(true);
      sync.close();
    });

    it('two SimpleCrossTabSync tabs sharing the SharedWorker verify each other (cross-tab)', async () => {
      // The CORE guarantee: tab A signs with the shared secret in
      // the SharedWorker, tab B verifies against THE SAME secret — even
      // though A and B would in real life be separate JS processes.
      const tabA = new SimpleCrossTabSync(baseConsultation);
      const tabB = new SimpleCrossTabSync(baseConsultation);
      const received: ContextItem[] = [];
      tabB.onContextAdded((c) => received.push(c));

      await tabA.broadcastContext(mkContext({ content: 'cross-tab payload' }));
      await flushAsync(8);

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('cross-tab payload');
      // Both tabs must be using the SharedWorker path.
      expect(tabA.isUsingSharedWorkerHmac()).toBe(true);
      expect(tabB.isUsingSharedWorkerHmac()).toBe(true);

      tabA.close();
      tabB.close();
    });

    it('a message tampered after signing still fails HMAC even via the SharedWorker', async () => {
      const warn = vi.fn();
      const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
      const sender = new SimpleCrossTabSync(baseConsultation);
      const receiver = new SimpleCrossTabSync(baseConsultation, { logger });
      // Channel construction is async without tenantId.
      await Promise.all([sender.whenReady(), receiver.whenReady()]);
      const listener = vi.fn();
      receiver.onContextAdded(listener);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test introspection.
      const senderChannel = (sender as any).channel as MockBroadcastChannel;
      vi.spyOn(senderChannel, 'postMessage').mockImplementation((wire: unknown) => {
        const envelope = wire as { payload: { data: unknown }; hmac: string };
        envelope.payload = { ...envelope.payload, data: mkContext({ content: 'TAMPERED VIA SHARED-WORKER' }) };
        MockBroadcastChannel.instances
          .filter((i) => i.name === senderChannel.name && i !== senderChannel && !i.closed)
          .forEach((i) => i.onmessage?.(new MessageEvent('message', { data: envelope })));
      });

      await sender.broadcastContext(mkContext({ content: 'original' }));
      await flushAsync(8);

      expect(listener).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();

      sender.close();
      receiver.close();
    });

    it('SharedWorker unavailable → falls back to per-session secret silently', async () => {
      delete (globalThis as { SharedWorker?: unknown }).SharedWorker;
      __resetSessionHmacSecretForTests();

      const tabA = new SimpleCrossTabSync(baseConsultation);
      const tabB = new SimpleCrossTabSync(baseConsultation);
      const got: ContextItem[] = [];
      tabB.onContextAdded((c) => got.push(c));

      await tabA.broadcastContext(mkContext({ content: 'fallback path' }));
      await flushAsync();

      expect(got).toHaveLength(1);
      expect(got[0].content).toBe('fallback path');
      // Trigger manager init on tabA so we can inspect.
      expect(tabA.isUsingSharedWorkerHmac()).toBe(false);

      tabA.close();
      tabB.close();
    });
  });
});
