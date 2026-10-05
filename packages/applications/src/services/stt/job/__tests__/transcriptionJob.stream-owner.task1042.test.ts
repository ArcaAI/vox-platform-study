/**
 * TASK-1042 (C8) — every new STREAMING job row records the principal that opened the session:
 * `metaData.owner = RunPrincipalAccessService.currentPrincipal()` — the API key id for a key, the
 * service account id for a machine, the human for a JWT. A run may bind only a session its own
 * principal opened; a row with no owner (no principal in context) is never bindable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobService } from '../transcriptionJob.service';

let store: Record<string, unknown> = {};

function build() {
  const jobRepository = { create: vi.fn(async (entity: unknown) => entity) };
  const cls = { get: vi.fn((key: string) => store[key]) };
  const service = new TranscriptionJobService(jobRepository as never, { emit: vi.fn() } as never, cls as never);
  return { service, jobRepository };
}

const open = (service: TranscriptionJobService) =>
  service.createForStreamSession({ tenantId: 't-1', streamSessionId: 'stt-1', userId: 'human-1', agentVersionId: 'v1', resolvedSpec: null });

const stampedOwner = (jobRepository: { create: ReturnType<typeof vi.fn> }) =>
  (jobRepository.create.mock.calls[0][0] as { metaData?: Record<string, unknown> }).metaData?.owner;

beforeEach(() => {
  store = {};
});

describe('createForStreamSession — the C8 owner stamp', () => {
  it('an API key opens the session: the owner is the KEY, not its bound human', async () => {
    store = { tenantId: 't-1', user: { id: 'human-1' }, apiKey: { id: 'key-A', scopes: [] } };
    const { service, jobRepository } = build();
    await open(service);
    expect(stampedOwner(jobRepository)).toEqual({ type: 'apiKey', id: 'key-A' });
  });

  it('a service account opens the session: the owner is the service account', async () => {
    store = { tenantId: 't-1', serviceAccount: { id: 'sa-1', scopes: [] } };
    const { service, jobRepository } = build();
    await open(service);
    expect(stampedOwner(jobRepository)).toEqual({ type: 'serviceAccount', id: 'sa-1' });
  });

  it('a human JWT opens the session: the owner is the user', async () => {
    store = { tenantId: 't-1', user: { id: 'human-1' } };
    const { service, jobRepository } = build();
    await open(service);
    expect(stampedOwner(jobRepository)).toEqual({ type: 'user', id: 'human-1' });
  });

  it('no principal in context (a tenant-less internal path): no owner, so the row is never bindable', async () => {
    const { service, jobRepository } = build();
    await open(service);
    expect(stampedOwner(jobRepository)).toBeUndefined();
  });
});
