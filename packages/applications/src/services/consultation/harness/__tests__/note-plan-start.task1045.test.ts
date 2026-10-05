/**
 * TASK-1045 lane E6 (H-110 / H-111 / H-116) — every run that writes the note starts WITH a
 * composed NotePlan.
 *
 *  - harness-doc lane: `HarnessGatewayService.start` sends `notePlanRef` on `document:start` (and
 *    the loop's consultation-ending signal forwards it to the finalize child);
 *  - governed (ArcaAI loop) lane: `readLiveHandoff` composes the plan once the live lane has
 *    handed off and every summary-node output becomes `{ text: '', note_plan_ref }` — the live
 *    text is never the note's input any more;
 *  - compose fail-closed: `NOTE_INPUT_EXCEEDS_CONTEXT` / `NOTE_MODEL_CONTEXT_UNDECLARED` set
 *    processing FAILED with that reason through the lifecycle gate and hand the finalizer NO text,
 *    never a truncated fallback.
 */
import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { ConsultationProcessing } from '@arcaai/domains';

import { HarnessGatewayService } from '../harness-gateway.service';
import { LiveDocumentationService } from '../../live-documentation/live-documentation.service';

const TENANT = '50000000-0000-0000-0000-000000000045';
const CID = '0199a000-0000-7000-8000-0000000000c1';
const PLAN_REF = { consultationId: CID, mode: 'final' as const, planId: '0199a000-0000-7000-8000-000000000001' };

describe('TASK-1045 E6 — the harness-doc start carries the plan pointer', () => {
  const build = () => {
    const http = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { ok: true } }) } };
    const config = { get: vi.fn(() => 'http://harness:8866') };
    const secrets = { getSecretOptional: vi.fn().mockResolvedValue('tok') };
    return { http, service: new HarnessGatewayService(http as never, config as never, secrets as never) };
  };

  it('document:start sends `notePlanRef` when the starter composed one', async () => {
    const { http, service } = build();

    await service.start(CID, { tenantId: TENANT, jobId: 'job-1', notePlanRef: PLAN_REF });

    const [url, body] = http.axiosRef.post.mock.calls[0]!;
    expect(url).toBe(`http://harness:8866/api/v1/internal/consultations/${CID}/document:start`);
    expect(body).toMatchObject({ tenantId: TENANT, jobId: 'job-1', notePlanRef: PLAN_REF });
  });

  it('a start without a plan sends no `notePlanRef` key at all (byte-identical body)', async () => {
    const { http, service } = build();

    await service.start(CID, { tenantId: TENANT, jobId: 'job-1' });

    expect(Object.keys(http.axiosRef.post.mock.calls[0]![1] as object)).not.toContain('notePlanRef');
  });

  it('the loop consultation-ending signal forwards `notePlanRef` to the finalize child', async () => {
    const { http, service } = build();

    await service.signalConsultationEnding(CID, { reason: 'recording_stopped', notePlanRef: PLAN_REF });

    const [url, body] = http.axiosRef.post.mock.calls[0]!;
    expect(url).toBe(`http://harness:8866/api/v1/internal/workflows/${CID}/signal/consultation-ending`);
    expect(body).toMatchObject({ notePlanRef: PLAN_REF });
  });
});

describe('TASK-1045 E6 — the governed handoff carries `note_plan_ref`', () => {
  const NOTE = {
    text: 'flat body join',
    sections: [
      { title: 'Subjective', content: 'Cough for three days.' },
      { title: 'Plan', content: 'Fluids.' },
    ],
    stats: { turns: 3 },
  };
  const ENTITIES = { entities: [{ text: 'cough', label: 'SYMPTOM' }] };
  const RECORD = { endedAt: '2026-10-05T09:00:00.000Z', tenantId: TENANT, outputs: { n_summary: NOTE, n_ner: ENTITIES } };

  function build(options: { composer?: { composeNotePlan: ReturnType<typeof vi.fn> } | null; status?: string } = {}) {
    const stored = new Map<string, string>([[`live-doc:handoff:${CID}`, JSON.stringify(RECORD)]]);
    const cache = {
      get: vi.fn(async (key: string) => stored.get(key) ?? null),
      exists: vi.fn(async (key: string) => stored.has(key)),
      set: vi.fn().mockResolvedValue(undefined),
      setex: vi.fn(async (key: string, _ttl: number, value: string) => {
        stored.set(key, value);
      }),
      publish: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
    };
    const composer = options.composer === undefined ? { composeNotePlan: vi.fn().mockResolvedValue({ notePlanRef: PLAN_REF, strategy: 'single_pass', callCount: 1, promptTokens: 900 }) } : options.composer;
    const lifecycleGate = { setProcessing: vi.fn().mockResolvedValue(undefined) };
    const args: unknown[] = new Array(34).fill(undefined);
    args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
    args[1] = { get: vi.fn(() => undefined) };
    args[2] = cache;
    args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
    args[15] = {
      findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, doctorId: null, departmentId: null, status: options.status ?? 'STOPPED', metadata: null })),
    };
    args[32] = composer ?? undefined;
    args[33] = lifecycleGate;
    const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
    return { service, composer, lifecycleGate, stored };
  }

  it('composes the plan once the live lane has handed off; the summary output becomes `{ text: "", note_plan_ref }`', async () => {
    const { service, composer, lifecycleGate } = build();

    const handoff = await service.readLiveHandoff(CID, ['n_summary', 'n_ner']);

    expect(composer!.composeNotePlan).toHaveBeenCalledWith(CID, { tenantId: TENANT, mode: 'final' });
    expect(handoff.ended).toBe(true);
    expect(handoff.outputs.n_summary).toMatchObject({ text: '', note_plan_ref: PLAN_REF });
    // A non-note output is passed through untouched.
    expect(handoff.outputs.n_ner).toEqual(ENTITIES);
    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
  });

  it('a second read reuses the plan composed for this handoff (no second composition)', async () => {
    const { service, composer } = build();

    await service.readLiveHandoff(CID, ['n_summary']);
    const again = await service.readLiveHandoff(CID, ['n_summary']);

    expect(composer!.composeNotePlan).toHaveBeenCalledTimes(1);
    expect(again.outputs.n_summary).toMatchObject({ note_plan_ref: PLAN_REF });
  });

  it('does not compose while the consultation is still live', async () => {
    const { service, composer } = build({ status: 'RECORDING' });

    await expect(service.readLiveHandoff(CID, ['n_summary'])).resolves.toMatchObject({ ended: false });
    expect(composer!.composeNotePlan).not.toHaveBeenCalled();
  });

  it.each([
    ['NOTE_INPUT_EXCEEDS_CONTEXT', new UnprocessableEntityException({ code: 'NOTE_INPUT_EXCEEDS_CONTEXT', message: 'too big' })],
    ['NOTE_MODEL_CONTEXT_UNDECLARED', new ServiceUnavailableException({ code: 'NOTE_MODEL_CONTEXT_UNDECLARED', message: 'no window' })],
  ])('%s fails closed: processing FAILED with that reason, and the finalizer is handed no text', async (code, error) => {
    const { service, lifecycleGate } = build({ composer: { composeNotePlan: vi.fn().mockRejectedValue(error) } });

    const handoff = await service.readLiveHandoff(CID, ['n_summary']);

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.FAILED, code);
    const output = handoff.outputs.n_summary as Record<string, unknown>;
    expect(output.text).toBe('');
    expect(output.sections).toBeUndefined();
    expect(output.note_plan_ref).toBeUndefined();
    expect(output.note_plan_error).toBe(code);
  });

  it('any other composition failure is "not ready yet": the read fails and nothing is marked', async () => {
    const { service, lifecycleGate } = build({
      composer: { composeNotePlan: vi.fn().mockRejectedValue(new ServiceUnavailableException({ code: 'NOTE_TOKENIZER_UNAVAILABLE', message: 'x' })) },
    });

    await expect(service.readLiveHandoff(CID, ['n_summary'])).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
  });

  it('without a composer wired the handoff is the legacy headed text', async () => {
    const { service } = build({ composer: null });

    const handoff = await service.readLiveHandoff(CID, ['n_summary']);

    expect(handoff.outputs.n_summary).toMatchObject({ text: 'flat body join' });
    expect(handoff.outputs.n_summary).not.toHaveProperty('note_plan_ref');
  });
});
