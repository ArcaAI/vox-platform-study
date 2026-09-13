/**
 * TASK-968 — the prompt-template test bench must run with the SAME reasoning posture a real
 * generation would.
 *
 * TASK-876 pointed the bench at the tenant's assigned TEXT_GENERATION agent, precisely so that
 * "a template tested against a model no consultation would ever run" stops being a test of
 * nothing. But `resolveTestTextTarget` kept only `{ provider, model }` off the resolved candidate
 * and threw its `parameters` away, and `submitTextGenerationJob` then called
 * `applyTextRuntimeProfile(body)` with no second argument — a no-op. The bench selected the
 * agent's reasoning posture and then ran WITHOUT it, which is the same "resolved then discarded"
 * defect TASK-891 C2 fixed on the live and finalize paths, and it made the bench diverge from
 * production in exactly the dimension TASK-891 measured as worth 5168 ms → 1237 ms.
 *
 * The REAL `TextRequestEnrichmentService` is used (not a double): the claim under test is about
 * the body that service builds.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PromptManagementService } from '../prompt-management.service';
import { TextRequestEnrichmentService } from '../../text-request/text-request-enrichment.service';

const TENANT = 'tenant-1';

const template = { id: 'tpl-1', tenantId: TENANT, content: 'Summarize the transcript', category: 'SYSTEM', variables: null, version: 1 };

/** `POST /generate` with `stream:true` answers 200 + text/event-stream; the id rides the first frame. */
const streamingGenerateAck = (generationId: string) => {
  const stream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stream.destroy = vi.fn();
  stream.on('newListener', (event) => {
    if (event !== 'data') return;
    setImmediate(() => stream.emit('data', Buffer.from(`event: meta\ndata: {"generation_id":"${generationId}"}\nid: ${generationId}:0\n\n`)));
  });
  return stream;
};

function buildService(primary: Record<string, unknown>) {
  const post = vi.fn().mockImplementation(async () => ({ data: streamingGenerateAck('task-1') }));
  const clsService = {
    get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'userAbility' ? { can: () => true } : null)),
    set: vi.fn(),
  };
  const svc = new PromptManagementService(
    { findById: vi.fn().mockResolvedValue(template), encryptFieldsIntoEntity: vi.fn(), updateWithVersion: vi.fn() } as never,
    { findByVersionNumber: vi.fn() } as never,
    {} as never,
    {} as never,
    { emit: vi.fn() } as never,
    clsService as never,
    {} as never, // databaseService
    { axiosRef: { post, get: vi.fn() } } as never,
    { get: vi.fn().mockReturnValue('http://text.test') } as never,
    undefined, // secretsService
    undefined, // userProfileService
    undefined, // entitlements
    undefined, // promotionGate
    undefined, // aiModelRepository
    undefined, // goldenCaseRepository
    // REAL enrichment — a stub would assert nothing about the body it builds.
    new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined) as never,
    { resolve: vi.fn().mockResolvedValue({ primary }) } as never, // TextAgentResolverService
  );
  return { svc, post };
}

const lastBody = (post: ReturnType<typeof vi.fn>) => post.mock.calls.at(-1)![1] as Record<string, unknown>;

const candidate = (parameters?: Record<string, unknown>) => ({ provider: 'lm-studio', model: 'resolved-medgemma', ...(parameters ? { parameters } : {}) });

describe('TASK-968 — the bench runs on the assigned agent`s reasoning posture', () => {
  it('an agent that disabled reasoning benches with reasoning off', async () => {
    const { svc, post } = buildService(candidate({ generation: { temperature: 0.2, reasoning: { enabled: false } } }));

    await svc.startPromptTemplateTest('tpl-1', {} as never);

    expect(lastBody(post).extra, 'the bench ran on a posture it had already resolved and dropped').toEqual({ reasoning_effort: 'minimal' });
  });

  it('an agent that named an effort benches with that effort', async () => {
    const { svc, post } = buildService(candidate({ generation: { reasoning: { enabled: true, effort: 'high' } } }));

    await svc.startPromptTemplateTest('tpl-1', {} as never);

    expect(lastBody(post).extra).toEqual({ reasoning_effort: 'high' });
  });

  it('an agent with no reasoning opinion sends no `extra` key at all', async () => {
    const { svc, post } = buildService(candidate({ generation: { temperature: 0.2 } }));

    await svc.startPromptTemplateTest('tpl-1', {} as never);

    expect(Object.keys(lastBody(post))).not.toContain('extra');
  });

  it('a caller-pinned provider/model names a raw registry row with no agent behind it — no posture is invented', async () => {
    const { svc, post } = buildService(candidate({ generation: { reasoning: { enabled: false } } }));

    await svc.startPromptTemplateTest('tpl-1', { provider: 'lm-studio', model: 'pinned' } as never);

    expect(Object.keys(lastBody(post))).not.toContain('extra');
  });
});
