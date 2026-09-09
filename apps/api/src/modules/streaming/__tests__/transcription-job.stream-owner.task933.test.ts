/**
 * TASK-933 §3.3 — a live STT streaming session OWNED by a machine principal.
 *
 * The session-ownership chain has four independent links and they all compare the SAME id:
 * the session record's `userId`, the one-shot ticket's `userId`, the gateway-side
 * `sessionId -> { tenantId, userId }` binding, and the WS handshake's compare of the two.
 * Before this ticket every link read CLS `user?.id` and fell back to `''` / `null` when there
 * was none — so a service account created a session with an EMPTY ticket owner and an
 * OWNERLESS binding, and then could not connect to it, refresh it or close it. The old
 * SVC-NOTE on this controller recorded that as deliberate.
 *
 * The fix is one resolution helper, used by every link: `cls.user?.id ?? cls.serviceAccount?.id`.
 * A session is never created ownerless — the empty-string and null fallbacks are gone — so the
 * WS gateway's compare (untouched, a pure string equality on both ends) now succeeds for the
 * owner and still refuses everyone else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';

const TENANT = 'tenant-1';
const SVC_ACCOUNT_ID = 'e0000000-0000-0000-0000-000000000001';
const HUMAN_ID = '70000000-0000-0000-0000-000000000040';

/* eslint-disable @typescript-eslint/no-explicit-any */
const clsFor = (store: Record<string, unknown>) => ({ get: vi.fn((key?: string) => (key === undefined ? undefined : store[key])) });

function build(cls: ReturnType<typeof clsFor>) {
  const sessionService = {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', status: 'ready', maxConcurrent: 4, currentActive: 1 }),
    removeSession: vi.fn().mockResolvedValue(undefined),
  };
  const streamTicketService = {
    issueTicket: vi.fn().mockResolvedValue({ ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: 'stt_session:sess-1' }),
  };
  const binding = {
    bind: vi.fn().mockResolvedValue(undefined),
    bindSessionMeta: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new TranscriptionJobController(
    {} as any, // jobService
    {} as any, // realtimeService
    sessionService as any,
    cls as any,
    { resolveDescriptor: vi.fn().mockResolvedValue(null) } as any, // blobStorage
    { getBucketByPurpose: vi.fn(), getBucketBySlug: vi.fn() } as any, // tenantBucketService
    { getById: vi.fn().mockResolvedValue({ id: 'pipe-1', tenantId: TENANT }) } as any, // pipelineService
    streamTicketService as any,
    binding as any,
    { assertConcurrencyQuota: vi.fn().mockResolvedValue(undefined) } as any, // entitlements
  );
  return { controller, sessionService, streamTicketService, binding };
}

describe('createStreamSession — the session OWNER is the acting principal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a service account owns the session it creates: record, ticket and binding all name it', async () => {
    const { controller, sessionService, streamTicketService, binding } = build(clsFor({ tenantId: TENANT, serviceAccount: { id: SVC_ACCOUNT_ID } }));

    await controller.createStreamSession({ pipelineId: 'pipe-1' } as any);

    expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: SVC_ACCOUNT_ID }));
    expect(streamTicketService.issueTicket).toHaveBeenCalledWith(expect.objectContaining({ userId: SVC_ACCOUNT_ID }));
    expect(binding.bind).toHaveBeenCalledWith('sess-1', TENANT, SVC_ACCOUNT_ID);
  });

  it('a human still owns their own session — the machine branch adds a case, it does not move one', async () => {
    const { controller, sessionService, streamTicketService, binding } = build(
      clsFor({ tenantId: TENANT, user: { id: HUMAN_ID, tenantId: TENANT } }),
    );

    await controller.createStreamSession({ pipelineId: 'pipe-1' } as any);

    expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: HUMAN_ID }));
    expect(streamTicketService.issueTicket).toHaveBeenCalledWith(expect.objectContaining({ userId: HUMAN_ID }));
    expect(binding.bind).toHaveBeenCalledWith('sess-1', TENANT, HUMAN_ID);
  });

  it('refuses to create an OWNERLESS session rather than minting an empty-string ticket owner', async () => {
    // No `user`, no `serviceAccount` — a shape the guard cannot actually produce, which is
    // exactly why it must be refused loudly instead of writing `''` into the ticket and `null`
    // into the binding (the pre-TASK-933 behaviour, which the WS handshake then rejected).
    const { controller, streamTicketService, binding } = build(clsFor({ tenantId: TENANT }));

    await expect(controller.createStreamSession({ pipelineId: 'pipe-1' } as any)).rejects.toThrow();
    expect(streamTicketService.issueTicket).not.toHaveBeenCalled();
    expect(binding.bind).not.toHaveBeenCalled();
  });
});

describe('refreshStreamTicket — the reissued ticket names the same owner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mints for the service account, so the reconnect handshake still matches the binding', async () => {
    const { controller, streamTicketService } = build(clsFor({ tenantId: TENANT, serviceAccount: { id: SVC_ACCOUNT_ID } }));

    await controller.refreshStreamTicket('sess-1');

    expect(streamTicketService.issueTicket).toHaveBeenCalledWith({
      userId: SVC_ACCOUNT_ID,
      tenantId: TENANT,
      scope: 'stt_session:sess-1',
    });
  });

  it('mints for the human when the caller is one', async () => {
    const { controller, streamTicketService } = build(clsFor({ tenantId: TENANT, user: { id: HUMAN_ID, tenantId: TENANT } }));

    await controller.refreshStreamTicket('sess-1');

    expect(streamTicketService.issueTicket).toHaveBeenCalledWith({ userId: HUMAN_ID, tenantId: TENANT, scope: 'stt_session:sess-1' });
  });

  it('refuses when there is no principal at all — never an empty-string owner', async () => {
    const { controller, streamTicketService } = build(clsFor({ tenantId: TENANT }));

    await expect(controller.refreshStreamTicket('sess-1')).rejects.toThrow();
    expect(streamTicketService.issueTicket).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
