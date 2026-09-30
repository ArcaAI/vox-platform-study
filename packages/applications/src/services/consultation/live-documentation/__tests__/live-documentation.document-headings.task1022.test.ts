/**
 * TASK-1022 — the handoff carries the document template's HEADINGS to the finalizer.
 *
 * The finalizer is told to use exactly the template's headings, in order. The live session froze
 * that template at start (`ensureTemplateResolved` → `session.templateSnapshot`), and `stop()`
 * writes the handoff before teardown, so the checklist titles are still on the session there.
 * They are stored on the record and published in the handoff `context` as:
 *
 *  - `document_headings` — a numbered plain-text list (`1. New Complaints\n2. …`), the form the
 *    seeded finalizer prompt binds (`{{trigger.context.document_headings | default("")}}`);
 *  - `document_heading_list` — the same titles as an array.
 *
 * No snapshot (or no record) ⇒ neither key: the prompt's default then applies and the finalizer
 * falls back to the `##` headings of its own input.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';

const TENANT = 'tenant-headings';
const CID = 'consultation-headings-001';

function buildService(opts: { status?: string; consultationReadable?: boolean } = {}) {
  const stored = new Map<string, string>();
  const cache = {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      stored.set(key, value);
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
  const args: unknown[] = new Array(28).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  args[15] = {
    findById: vi.fn(async () =>
      opts.consultationReadable === false
        ? null
        : { id: CID, tenantId: TENANT, doctorId: null, departmentId: null, status: opts.status ?? 'DRAINING', metadata: null },
    ),
  };
  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, stored };
}

type SessionShape = {
  consultationId: string;
  tenantId: string;
  liveNodeOutputs?: Record<string, Record<string, unknown>>;
  templateSnapshot?: { slug: string; compiled?: { checklist: Array<{ key: string; title: string }> } };
};

async function stop(service: LiveDocumentationService, session: SessionShape): Promise<void> {
  await (service as unknown as { persistLiveHandoff(s: SessionShape): Promise<void> }).persistLiveHandoff(session);
}

const REVISIT_TEMPLATE = {
  slug: 'arcaai-gen-soap-revisit',
  compiled: {
    checklist: [
      { key: 'new_complaints', title: 'New Complaints' },
      { key: 'investigations', title: '  Investigations ' },
      { key: 'current_diagnosis', title: 'Current Diagnosis' },
      { key: 'blank', title: '   ' },
    ],
  },
};

describe('TASK-1022 — the frozen template headings on the live handoff', () => {
  it('stores the checklist titles, in template order, on the record', async () => {
    const { service, stored } = buildService();
    const session: SessionShape = {
      consultationId: CID,
      tenantId: TENANT,
      liveNodeOutputs: { n_summary: { text: 'x' } },
      templateSnapshot: REVISIT_TEMPLATE,
    };

    await stop(service, session);

    expect(JSON.parse(stored.get(`live-doc:handoff:${CID}`)!).documentHeadings).toEqual(['New Complaints', 'Investigations', 'Current Diagnosis']);
  });

  it('publishes them in the handoff context as a numbered list and as an array', async () => {
    const { service } = buildService();
    await stop(service, { consultationId: CID, tenantId: TENANT, liveNodeOutputs: { n_summary: { text: 'x' } }, templateSnapshot: REVISIT_TEMPLATE });

    const answer = await service.readLiveHandoff(CID, ['n_summary']);

    expect(answer.ended).toBe(true);
    expect(answer.context.document_headings).toBe('1. New Complaints\n2. Investigations\n3. Current Diagnosis');
    expect(answer.context.document_heading_list).toEqual(['New Complaints', 'Investigations', 'Current Diagnosis']);
    // The clinical half is still there beside it.
    expect(answer.context.visit_type).toBe('new-visit');
  });

  it('publishes the headings even when the consultation row cannot be read', async () => {
    const { service } = buildService({ consultationReadable: false });
    await stop(service, { consultationId: CID, tenantId: TENANT, templateSnapshot: REVISIT_TEMPLATE });

    const answer = await service.readLiveHandoff(CID);

    expect(answer.context).toEqual({
      document_headings: '1. New Complaints\n2. Investigations\n3. Current Diagnosis',
      document_heading_list: ['New Complaints', 'Investigations', 'Current Diagnosis'],
    });
  });

  it('omits both keys when the session froze no template', async () => {
    const { service, stored } = buildService();
    await stop(service, { consultationId: CID, tenantId: TENANT, liveNodeOutputs: { n_summary: { text: 'x' } } });

    const answer = await service.readLiveHandoff(CID);

    expect('documentHeadings' in JSON.parse(stored.get(`live-doc:handoff:${CID}`)!)).toBe(false);
    expect('document_headings' in answer.context).toBe(false);
    expect('document_heading_list' in answer.context).toBe(false);
  });

  it('omits both keys when the frozen template has no titled section', async () => {
    const { service } = buildService();
    await stop(service, { consultationId: CID, tenantId: TENANT, templateSnapshot: { slug: 's', compiled: { checklist: [] } } });

    const answer = await service.readLiveHandoff(CID);

    expect('document_headings' in answer.context).toBe(false);
  });

  it('omits both keys when there is no handoff record at all', async () => {
    const { service } = buildService();

    const answer = await service.readLiveHandoff(CID);

    expect(answer.ended).toBe(true);
    expect('document_headings' in answer.context).toBe(false);
  });
});
