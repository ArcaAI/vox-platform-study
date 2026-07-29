/**
 * HarnessAssuranceService Unit Tests — live assurance feed.
 *
 * The ephemeral per-claim assurance feed: the harness `run_inferential_sensors`
 * activity POSTs one claim verdict at a time (Q5 true-live); the service folds it
 * into the accumulated full-state snapshot (Redis, 1h TTL) and publishes that
 * full state on `consultation:harness-assurance:{consultationId}` for the SSE
 * relay. `finalizeAssurance` later publishes the terminal `assurance_complete`.
 *
 * Covers:
 *   - reportClaim: first claim, dedupe-in-place, new-jobId reset, closed-feed ignore
 *   - publishComplete: terminal verdict folds onto prior claims + closes the feed
 *   - resilience: corrupt snapshot starts fresh; Redis failure → { ok: false }
 *   - SSE relay: snapshot replayed first; terminal `closed: true` completes the stream
 */
import { describe, it, expect, vi } from 'vitest';
import { Subject } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { HarnessAssuranceService } from '../harness-assurance.service';
import type { HarnessAssuranceEventDto } from '../dto';

const CID = 'consult-5d';
const TENANT = 'tenant-abc';
const CHANNEL = `consultation:harness-assurance:${CID}`;
const SNAPSHOT_KEY = `consultation:harness-assurance:${CID}:last`;

function buildDeps(opts: { snapshot?: string | null } = {}) {
  const cacheService = {
    get: vi.fn().mockResolvedValue(opts.snapshot ?? null),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const channelMessages$ = new Subject<string>();
  const redisSubscriber = {
    subscribeToChannel: vi.fn().mockResolvedValue(channelMessages$.asObservable()),
    unsubscribeFromChannel: vi.fn(),
  };

  const service = new HarnessAssuranceService(cacheService as any, redisSubscriber as any);

  return { service, cacheService, redisSubscriber, channelMessages$ };
}

const lastPublished = (cacheService: { publish: { mock: { calls: unknown[][] } } }): HarnessAssuranceEventDto => {
  const calls = cacheService.publish.mock.calls;
  return JSON.parse(calls[calls.length - 1][1] as string) as HarnessAssuranceEventDto;
};

describe('HarnessAssuranceService', () => {
  describe('reportClaim', () => {
    it('publishes the full accumulated state with the first claim (closed: false)', async () => {
      const { service, cacheService } = buildDeps();

      const ack = await service.reportClaim(CID, {
        tenantId: TENANT,
        jobId: 'job-1',
        claimId: 'c-1',
        sensor: 'groundedness',
        verdict: 'grounded',
        ordinal: 1,
        total: 3,
      });

      expect(ack).toEqual({ ok: true });
      expect(cacheService.setex).toHaveBeenCalledWith(SNAPSHOT_KEY, 3600, expect.any(String));
      expect(cacheService.publish).toHaveBeenCalledWith(CHANNEL, expect.any(String));
      const state = lastPublished(cacheService);
      expect(state.closed).toBe(false);
      expect(state.total).toBe(3);
      expect(state.claims).toHaveLength(1);
      expect(state.claims[0]).toMatchObject({ claimId: 'c-1', sensor: 'groundedness', verdict: 'grounded', ordinal: 1 });
    });

    it('appends distinct claims and updates a repeated claimId+sensor in place', async () => {
      const prior: HarnessAssuranceEventDto = {
        consultationId: CID,
        tenantId: TENANT,
        jobId: 'job-1',
        total: 3,
        claims: [{ claimId: 'c-1', sensor: 'groundedness', verdict: 'grounded', at: '2026-06-13T00:00:00.000Z' }],
        updatedAt: '2026-06-13T00:00:00.000Z',
        closed: false,
      };
      const { service, cacheService } = buildDeps({ snapshot: JSON.stringify(prior) });

      // A new claim appends…
      await service.reportClaim(CID, { tenantId: TENANT, jobId: 'job-1', claimId: 'c-2', sensor: 'groundedness', verdict: 'ungrounded' });
      expect(lastPublished(cacheService).claims).toHaveLength(2);

      // …a repeat of an existing claimId+sensor updates in place (no growth).
      cacheService.get.mockResolvedValue(JSON.stringify(lastPublished(cacheService)));
      await service.reportClaim(CID, { tenantId: TENANT, jobId: 'job-1', claimId: 'c-1', sensor: 'groundedness', verdict: 'ungrounded' });
      const state = lastPublished(cacheService);
      expect(state.claims).toHaveLength(2);
      expect(state.claims.find((c) => c.claimId === 'c-1')?.verdict).toBe('ungrounded');
    });

    it('discards the prior snapshot when a different jobId arrives (new run)', async () => {
      const prior: HarnessAssuranceEventDto = {
        consultationId: CID,
        jobId: 'job-OLD',
        claims: [{ claimId: 'c-1', sensor: 'groundedness', verdict: 'grounded', at: '2026-06-13T00:00:00.000Z' }],
        updatedAt: '2026-06-13T00:00:00.000Z',
        closed: false,
      };
      const { service, cacheService } = buildDeps({ snapshot: JSON.stringify(prior) });

      await service.reportClaim(CID, { tenantId: TENANT, jobId: 'job-NEW', claimId: 'c-9', sensor: 'safety', verdict: 'pass' });

      const state = lastPublished(cacheService);
      expect(state.jobId).toBe('job-NEW');
      expect(state.claims).toHaveLength(1);
      expect(state.claims[0].claimId).toBe('c-9');
    });

    it('ignores a claim once the feed is closed (returns ok, publishes nothing new)', async () => {
      const closed: HarnessAssuranceEventDto = {
        consultationId: CID,
        jobId: 'job-1',
        claims: [],
        gateDecision: 'PASS',
        updatedAt: '2026-06-13T00:00:00.000Z',
        closed: true,
      };
      const { service, cacheService } = buildDeps({ snapshot: JSON.stringify(closed) });

      const ack = await service.reportClaim(CID, { tenantId: TENANT, jobId: 'job-1', claimId: 'c-1', sensor: 'safety', verdict: 'flag' });

      expect(ack).toEqual({ ok: true });
      expect(cacheService.publish).not.toHaveBeenCalled();
    });

    it('returns { ok: false } on a Redis failure (best-effort — never throws)', async () => {
      const { service, cacheService } = buildDeps();
      cacheService.publish.mockRejectedValue(new Error('redis down'));

      const ack = await service.reportClaim(CID, { tenantId: TENANT, claimId: 'c-1', sensor: 'groundedness', verdict: 'grounded' });

      expect(ack).toEqual({ ok: false });
    });
  });

  describe('publishComplete', () => {
    it('publishes a terminal assurance_complete carrying the aggregate verdict + closed: true', async () => {
      const prior: HarnessAssuranceEventDto = {
        consultationId: CID,
        jobId: 'job-1',
        claims: [{ claimId: 'c-1', sensor: 'groundedness', verdict: 'grounded', at: '2026-06-13T00:00:00.000Z' }],
        updatedAt: '2026-06-13T00:00:00.000Z',
        closed: false,
      };
      const { service, cacheService } = buildDeps({ snapshot: JSON.stringify(prior) });

      const ack = await service.publishComplete(CID, {
        tenantId: TENANT,
        gateDecision: 'FLAG',
        safetyFlag: true,
        postSignAlert: true,
      });

      expect(ack).toEqual({ ok: true });
      const state = lastPublished(cacheService);
      expect(state.closed).toBe(true);
      expect(state.gateDecision).toBe('FLAG');
      expect(state.safetyFlag).toBe(true);
      expect(state.postSignAlert).toBe(true);
      // Folds onto the accumulated per-claim state so late joiners see it all.
      expect(state.claims).toHaveLength(1);
    });

    it('returns { ok: false } on a Redis failure', async () => {
      const { service, cacheService } = buildDeps();
      cacheService.publish.mockRejectedValue(new Error('redis down'));

      const ack = await service.publishComplete(CID, { gateDecision: 'PASS' });

      expect(ack).toEqual({ ok: false });
    });
  });

  describe('subscribeToAssurance', () => {
    it('replays the stored snapshot first, then relays channel events until closed', async () => {
      const snapshot = JSON.stringify({ consultationId: CID, claims: [], updatedAt: '2026-06-13T00:00:00.000Z', closed: false });
      const { service, channelMessages$ } = buildDeps({ snapshot });

      const events: string[] = [];
      let completed = false;
      const sub = service.subscribeToAssurance(CID).subscribe({
        next: (e: MessageEvent) => events.push(e.data as string),
        complete: () => {
          completed = true;
        },
      });

      // Let the async subscribe-before-snapshot setup settle.
      await new Promise((r) => setTimeout(r, 10));
      expect(events[0]).toBe(snapshot); // snapshot replayed first

      channelMessages$.next(JSON.stringify({ consultationId: CID, claims: [], updatedAt: '2026-06-13T00:00:01.000Z', closed: false }));
      channelMessages$.next(
        JSON.stringify({ consultationId: CID, claims: [], gateDecision: 'PASS', updatedAt: '2026-06-13T00:00:02.000Z', closed: true }),
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(completed).toBe(true);
      expect(events.some((e) => JSON.parse(e).closed === true)).toBe(true);
      sub.unsubscribe();
    });
  });
});
