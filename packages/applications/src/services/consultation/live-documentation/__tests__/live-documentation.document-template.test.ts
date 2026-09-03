/**
 * the live loop actually serves the tenant's DOCUMENT TEMPLATE.
 *
 * The compiler and the parser are unit-tested in isolation elsewhere; this
 * suite proves the seam between them and the running loop, which is where a
 * catalog quietly fails to matter. Three properties:
 *
 *  1. A tenant that published a discharge summary gets a discharge summary —
 *     its keys in the `response_format` the TEXT call carries, its titles in
 *     the parsed sections. That is the claim the ticket exists to make true:
 *     custom shapes were STRUCTURALLY excluded, not merely unwired.
 *  2. The template is FROZEN at session start, exactly like the agent
 *     snapshot, so a mid-consultation publish cannot change the note in flight.
 *  3. With no catalog wired at all, the loop serves the compiled PLATFORM shape
 *     — the fail-open tier. A live consultation must never die because nobody
 *     has authored a template yet.
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { compileDocumentTemplate } from '../../../document-template/document-template-compiler';
import { SOAP_NOTE_SHAPE } from '../../../document-template/platform-document-shapes';
import type { ResolvedDocumentTemplate } from '../../../document-template/IDocumentTemplateService';

const CID = 'consultation-template-001';
const TENANT = 'tenant-template';

const DISCHARGE: ResolvedDocumentTemplate = {
  templateId: 'template-1',
  slug: 'discharge_summary',
  versionNumber: 3,
  documentTemplateVersionId: 'version-3',
  compiled: compileDocumentTemplate({
    schemaVersion: '1.0',
    title: 'Discharge Summary',
    sections: [
      { key: 'admission_reason', title: 'Reason for Admission', form: 'PROSE', required: true },
      { key: 'hospital_course', title: 'Hospital Course', form: 'PROSE' },
      { key: 'follow_up', title: 'Follow-up', form: 'PROSE' },
    ],
  }),
};

interface TextCall {
  prompt?: string;
  response_format?: { json_schema?: { title?: string; properties?: Record<string, unknown>; required?: string[] } };
}

function recordingHttpMock(calls: TextCall[], generated: string) {
  return {
    axiosRef: {
      post: vi.fn().mockImplementation((url: string, body: TextCall) => {
        if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
        if (url.includes('/generate')) {
          calls.push(body);
          return Promise.resolve({ data: { summary: generated } });
        }
        return Promise.resolve({ data: {} });
      }),
    },
  };
}

function buildService(httpMock: unknown, documentTemplateService?: unknown) {
  const cacheService = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const configService = { get: vi.fn().mockImplementation((k: string) => (({ LIVE_DOC_MIN_INTERVAL_MS: '0' }) as Record<string, unknown>)[k]) };
  const harnessPolicyService = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma-4-e4b' }) };

  // Positional construction: the template service is the LAST constructor
  // parameter, so every earlier optional dep is filled with `undefined`.
  return new LiveDocumentationService(
    httpMock as never,
    configService as never,
    cacheService as never,
    redisSubscriber as never,
    undefined,
    undefined as never,
    harnessPolicyService as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    documentTemplateService as never,
  );
}

describe('the live loop serves the tenant’s document template', () => {
  it('sends the TENANT’s compiled schema as `response_format`, not a hardcoded SOAP literal', async () => {
    const calls: TextCall[] = [];
    const templateService = { resolveForGeneration: vi.fn().mockResolvedValue(DISCHARGE) };
    const service = buildService(
      recordingHttpMock(calls, JSON.stringify({ admission_reason: 'Chest pain.', hospital_course: 'Improved.', follow_up: null })),
      templateService,
    );

    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Admitted with chest pain', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    expect(templateService.resolveForGeneration).toHaveBeenCalledWith(TENANT);
    const schema = calls[0].response_format?.json_schema;
    expect(schema?.title).toBe('Discharge Summary');
    expect(Object.keys(schema?.properties ?? {})).toEqual(['admission_reason', 'hospital_course', 'follow_up']);
    // The four SOAP keys are simply absent — which was structurally impossible
    // before this ticket, in five separate places.
    expect(schema?.properties).not.toHaveProperty('subjective');
  });

  it('names the tenant’s document in the prose prompt, so instruction and schema agree', async () => {
    const calls: TextCall[] = [];
    const service = buildService(recordingHttpMock(calls, '{}'), { resolveForGeneration: vi.fn().mockResolvedValue(DISCHARGE) });

    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Admitted with chest pain', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    // A model told in prose to produce a SOAP note while being decoded against
    // a discharge-summary schema is being given two different jobs.
    expect(calls[0].prompt).toContain('Discharge Summary');
    expect(calls[0].prompt).not.toContain('SOAP');
  });

  it('parses the response into the TEMPLATE’s sections, and marks a null one as not discussed', async () => {
    const generated = JSON.stringify({ admission_reason: 'Chest pain.', hospital_course: 'Improved on GTN.', follow_up: null });
    const service = buildService(recordingHttpMock([], generated), { resolveForGeneration: vi.fn().mockResolvedValue(DISCHARGE) });

    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Admitted with chest pain', isFinal: true, segmentId: 's1' });
    const payload = await service.flush(CID);

    expect(payload?.sections?.map((s) => s.title)).toEqual(['Reason for Admission', 'Hospital Course', 'Follow-up']);
    // D-21 end to end: the model was ABLE to say "not discussed" and did, and
    // the section carries no invented follow-up plan.
    expect(payload?.sections?.[2].content).toBe('');
    expect(payload?.runningSummary).toBe('Chest pain.\n\nImproved on GTN.');
  });

  it('FREEZES the template at session start — a mid-consultation publish cannot change the note', async () => {
    const calls: TextCall[] = [];
    const resolveForGeneration = vi.fn().mockResolvedValue(DISCHARGE);
    const service = buildService(recordingHttpMock(calls, '{}'), { resolveForGeneration });

    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'one', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    // The tenant publishes something else mid-consultation.
    resolveForGeneration.mockResolvedValue({ ...DISCHARGE, compiled: compileDocumentTemplate(SOAP_NOTE_SHAPE) });

    service.ingestSegment(CID, { text: 'two', isFinal: true, segmentId: 's2' });
    await service.flush(CID);

    // Resolved exactly once, at start; the second flush reads the cached
    // snapshot. Same discipline as the frozen agent snapshot.
    expect(resolveForGeneration).toHaveBeenCalledTimes(1);
    expect(calls[1].response_format?.json_schema?.title).toBe('Discharge Summary');
  });

  it('serves the compiled PLATFORM shape when no catalog is wired (fail-open)', async () => {
    const calls: TextCall[] = [];
    const service = buildService(recordingHttpMock(calls, '{}'));

    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    const schema = calls[0].response_format?.json_schema;
    expect(schema?.title).toBe('SOAP Note');
    expect(schema?.required).toEqual(['subjective', 'objective', 'assessment', 'plan']);
    // D-21 holds for the platform shape too: every key is required (strict
    // decoding stays on) and every one of them is NULLABLE.
    expect((schema?.properties as Record<string, { type: unknown }>).objective.type).toEqual(['string', 'null']);
  });

  it('falls open to the platform shape when the catalog throws', async () => {
    const calls: TextCall[] = [];
    const service = buildService(recordingHttpMock(calls, '{}'), {
      resolveForGeneration: vi.fn().mockRejectedValue(new Error('catalog unavailable')),
    });

    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    expect(calls[0].response_format?.json_schema?.title).toBe('SOAP Note');
  });
});
