/**
 * TASK-1038 OD-35 — a run stream ticket carries the RUN READER it was minted under.
 *
 * Run reads are bound to the run's starting principal. Redeeming a ticket restores only the bound
 * human on `user` (for an API key, the key's human — not the principal the run is bound to), so
 * the reader the mint already proved (`{ principal, tenantWide }`) travels on the ticket and is
 * restored on CLS `runReader`, where `RunPrincipalAccessService` reads it first. The ticket stays
 * single-use and scoped to one run.
 */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { describe, expect, it, vi } from 'vitest';
import { STREAM_SCOPE_METADATA } from '../decorators/stream-scope.decorator';
import { StreamTicketService } from '../stream-ticket.service';
import { JwtAuthGuard } from '../../../guards/jwtauth.guard';

vi.mock('@nestjs/passport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/passport')>();
  return { ...actual, AuthGuard: () => class {} };
});

const READER = { principal: { type: 'apiKey', id: 'key-A' }, tenantWide: false };

function cache() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => void store.set(key, value)),
    del: vi.fn(async (key: string) => void store.delete(key)),
  };
}

describe('StreamTicketService — runReader', () => {
  it('persists the reader and returns it on consume', async () => {
    const svc = new StreamTicketService(cache() as never);
    const issued = await svc.issueTicket({ userId: 'human-1', tenantId: 't-1', scope: 'workflow_run:r-1', runReader: READER as never });
    const consumed = await svc.consumeTicket(issued.ticket);
    expect(consumed?.runReader).toEqual(READER);
  });

  it('a ticket minted without one carries none (every other ticket kind is unchanged)', async () => {
    const svc = new StreamTicketService(cache() as never);
    const issued = await svc.issueTicket({ userId: 'u', tenantId: 't-1', scope: 'consultation_job:j-1' });
    const consumed = await svc.consumeTicket(issued.ticket);
    expect(consumed).not.toHaveProperty('runReader');
  });

  it('a malformed stored reader is dropped, never trusted', async () => {
    const c = cache();
    const svc = new StreamTicketService(c as never);
    c.store.set(
      'stream-ticket:bad',
      JSON.stringify({
        userId: 'u',
        tenantId: 't',
        scope: 'workflow_run:r',
        exp: Date.now() + 10_000,
        runReader: { principal: { type: 'robot', id: 'x' }, tenantWide: 'yes' },
      }),
    );
    const consumed = await svc.consumeTicket('bad');
    expect(consumed).not.toBeNull();
    expect(consumed).not.toHaveProperty('runReader');
  });
});

describe('JwtAuthGuard — restores runReader on CLS when a ticket carries one', () => {
  function guardFor(stored: Record<string, unknown>) {
    const reflector = {
      getAllAndOverride: vi.fn((key: unknown) =>
        key === SKIP_AUTH_KEY ? false : key === STREAM_SCOPE_METADATA ? { namespace: 'workflow_run', param: 'runId' } : undefined,
      ),
    } as unknown as Reflector;
    const cls = { set: vi.fn(), get: vi.fn() };
    const tickets = { consumeTicket: vi.fn(async () => stored) };
    const request = { query: { ticket: 'tkt' }, params: { runId: 'r-1' } };
    const context = {
      getHandler: () => 'h',
      getClass: () => 'c',
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { guard: new JwtAuthGuard(reflector, tickets as never, cls as never), cls, context };
  }

  it('sets CLS runReader', async () => {
    const { guard, cls, context } = guardFor({
      userId: 'human-1',
      tenantId: 't-1',
      scope: 'workflow_run:r-1',
      exp: Date.now() + 10_000,
      impersonatedBy: null,
      runReader: READER,
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(cls.set).toHaveBeenCalledWith('runReader', READER);
  });

  it('does not set it for a ticket without one', async () => {
    const { guard, cls, context } = guardFor({
      userId: 'human-1',
      tenantId: 't-1',
      scope: 'workflow_run:r-1',
      exp: Date.now() + 10_000,
      impersonatedBy: null,
    });
    await guard.canActivate(context);
    expect(cls.set).not.toHaveBeenCalledWith('runReader', expect.anything());
  });
});
