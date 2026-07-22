/**
 * StreamTicketService — unit tests
 *
 * Locked contract (D1):
 *   - `issueTicket({ userId, tenantId, scope })` writes a 30s-TTL record at
 *     Redis key `stream-ticket:<ticket>` containing `{ userId, tenantId, scope, exp }`.
 *   - `consumeTicket(ticket)` atomically GET + DEL and returns the stored
 *     record, or `null` if the key is missing / already consumed / expired.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamTicketService, STREAM_TICKET_KEY_PREFIX, STREAM_TICKET_TTL_SECONDS } from '../stream-ticket.service';

function createMockCache() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    set: vi.fn(),
    delMany: vi.fn(),
    keys: vi.fn(),
    exists: vi.fn(),
    publish: vi.fn(),
    lpush: vi.fn(),
    rpush: vi.fn(),
    hset: vi.fn(),
    scan: vi.fn(async () => []),
    sadd: vi.fn(async () => 0),
    srem: vi.fn(async () => 0),
    smembers: vi.fn(async () => []),
    eval: vi.fn(async () => null),
    incr: vi.fn(),
    expire: vi.fn(),
    isConnected: vi.fn(() => true),
  };
}

describe('StreamTicketService', () => {
  let cache: ReturnType<typeof createMockCache>;
  let service: StreamTicketService;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = createMockCache();
    service = new StreamTicketService(cache);
  });

  describe('issueTicket', () => {
    it('returns ticket + expiresAt + scope and persists to Redis with 30s TTL', async () => {
      const before = Date.now();
      const result = await service.issueTicket({
        userId: 'user-1',
        tenantId: 'tenant-1',
        scope: 'consultation_job:job-1',
      });
      const after = Date.now();

      expect(typeof result.ticket).toBe('string');
      expect(result.ticket.length).toBeGreaterThanOrEqual(32);
      expect(result.scope).toBe('consultation_job:job-1');
      expect(result.expiresAt).toBeGreaterThanOrEqual(before + STREAM_TICKET_TTL_SECONDS * 1000 - 10);
      expect(result.expiresAt).toBeLessThanOrEqual(after + STREAM_TICKET_TTL_SECONDS * 1000 + 10);

      const expectedKey = `${STREAM_TICKET_KEY_PREFIX}${result.ticket}`;
      expect(cache.setex).toHaveBeenCalledWith(expectedKey, STREAM_TICKET_TTL_SECONDS, expect.any(String));

      const stored = cache.store.get(expectedKey);
      expect(stored).toBeDefined();
      const parsed = JSON.parse(stored!);
      expect(parsed.userId).toBe('user-1');
      expect(parsed.tenantId).toBe('tenant-1');
      expect(parsed.scope).toBe('consultation_job:job-1');
      expect(parsed.exp).toBe(result.expiresAt);
    });

    it('generates a different ticket for each call', async () => {
      const a = await service.issueTicket({ userId: 'u', tenantId: 't', scope: 's' });
      const b = await service.issueTicket({ userId: 'u', tenantId: 't', scope: 's' });
      expect(a.ticket).not.toBe(b.ticket);
    });

    it('persists tenantId as null when caller omits it', async () => {
      await service.issueTicket({ userId: 'u', scope: 's' });
      const stored = JSON.parse([...cache.store.values()][0]);
      expect(stored.tenantId).toBeNull();
    });
  });

  describe('consumeTicket', () => {
    it('returns the stored record on first call and deletes the key (single-use)', async () => {
      const issued = await service.issueTicket({
        userId: 'user-1',
        tenantId: 'tenant-1',
        scope: 'consultation_job:job-1',
      });

      const consumed = await service.consumeTicket(issued.ticket);

      expect(consumed).toEqual({
        userId: 'user-1',
        tenantId: 'tenant-1',
        scope: 'consultation_job:job-1',
        exp: issued.expiresAt,
        impersonatedBy: null,
      });
      expect(cache.del).toHaveBeenCalledWith(`${STREAM_TICKET_KEY_PREFIX}${issued.ticket}`);
      expect(cache.store.has(`${STREAM_TICKET_KEY_PREFIX}${issued.ticket}`)).toBe(false);
    });

    it('returns null on the second consume of the same ticket', async () => {
      const issued = await service.issueTicket({ userId: 'u', scope: 's' });

      const first = await service.consumeTicket(issued.ticket);
      const second = await service.consumeTicket(issued.ticket);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('returns null when the ticket does not exist', async () => {
      const result = await service.consumeTicket('no-such-ticket');
      expect(result).toBeNull();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('returns null and removes the key when the stored exp is in the past', async () => {
      const issued = await service.issueTicket({ userId: 'u', scope: 's' });
      // Tamper with the stored record so `exp` is in the past
      const key = `${STREAM_TICKET_KEY_PREFIX}${issued.ticket}`;
      const raw = cache.store.get(key)!;
      const parsed = JSON.parse(raw);
      parsed.exp = Date.now() - 1000;
      cache.store.set(key, JSON.stringify(parsed));

      const result = await service.consumeTicket(issued.ticket);
      expect(result).toBeNull();
      expect(cache.del).toHaveBeenCalledWith(key);
    });

    it('returns null when the stored payload is not valid JSON', async () => {
      cache.store.set(`${STREAM_TICKET_KEY_PREFIX}garbage`, 'not-json');
      const result = await service.consumeTicket('garbage');
      expect(result).toBeNull();
      // We still attempt to clean up the bad key.
      expect(cache.del).toHaveBeenCalledWith(`${STREAM_TICKET_KEY_PREFIX}garbage`);
    });
  });

  // ─── impersonatedBy ───────────────────────────────────────────────────────
  describe('impersonatedBy propagation', () => {
    it('persists impersonatedBy on the stored ticket when supplied at issue time', async () => {
      const issued = await service.issueTicket({
        userId: 'doctor-001',
        tenantId: 'tenant-acme',
        scope: 'consultation_job:job-1',
        impersonatedBy: 'admin-007',
      });

      const stored = JSON.parse(cache.store.get(`${STREAM_TICKET_KEY_PREFIX}${issued.ticket}`)!);
      expect(stored.impersonatedBy).toBe('admin-007');
    });

    it('returns impersonatedBy on consumeTicket so the guard can restore it on req.user', async () => {
      const issued = await service.issueTicket({
        userId: 'doctor-001',
        tenantId: 'tenant-acme',
        scope: 'consultation_job:job-1',
        impersonatedBy: 'admin-007',
      });

      const consumed = await service.consumeTicket(issued.ticket);
      expect(consumed?.impersonatedBy).toBe('admin-007');
    });

    it('persists impersonatedBy as null when caller omits it', async () => {
      const issued = await service.issueTicket({
        userId: 'user-1',
        scope: 'foo:bar',
      });

      const stored = JSON.parse(cache.store.get(`${STREAM_TICKET_KEY_PREFIX}${issued.ticket}`)!);
      expect(stored.impersonatedBy).toBeNull();
    });

    it('honours legacy stored tickets without impersonatedBy field (backward compat)', async () => {
      const legacyTicket = 'legacy-ticket-1';
      const legacyPayload = {
        userId: 'user-1',
        tenantId: 'tenant-1',
        scope: 'consultation_job:job-1',
        exp: Date.now() + 30_000,
        // No impersonatedBy — simulating a ticket minted before impersonation support.
      };
      cache.store.set(`${STREAM_TICKET_KEY_PREFIX}${legacyTicket}`, JSON.stringify(legacyPayload));

      const consumed = await service.consumeTicket(legacyTicket);
      expect(consumed?.impersonatedBy).toBeNull();
      expect(consumed?.userId).toBe('user-1');
    });
  });

  describe('constants', () => {
    it('uses a 30-second TTL (locked contract D1)', () => {
      expect(STREAM_TICKET_TTL_SECONDS).toBe(30);
    });

    it('uses the "stream-ticket:" key prefix (locked contract D1)', () => {
      expect(STREAM_TICKET_KEY_PREFIX).toBe('stream-ticket:');
    });
  });
});
