/**
 * prefix-cache-friendly live SMR prompt ordering.
 *
 * The live SMR user prompt is reordered to
 *   [stable system] + [transcript-so-far] + [current note] + [delta instruction]
 * so the leading `[stable system]` block is BYTE-IDENTICAL across every flush of
 * a session — first flush AND subsequent update flushes — letting a prefix-cache
 * engine (vLLM / llama.cpp `cache_prompt`) reuse the KV cache of that stable
 * prefix instead of re-prefilling a different leading instruction each flush
 * (the old ordering led with a mode-specific "produce…" vs "update…" directive,
 * so the two flush kinds shared no prefix at all).
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveDocumentationService, LIVE_SOAP_STABLE_SYSTEM_PREFIX } from '../live-documentation.service';

const CID = 'consultation-cache-001';
const TENANT = 'tenant-cache';

/** Records every SMR `/generate` prompt; returns a note so a prior note exists on flush 2. */
function recordingHttpMock(prompts: string[]) {
  return {
    axiosRef: {
      post: vi.fn().mockImplementation((url: string, body: { prompt?: string }) => {
        if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
        if (url.includes('/generate')) {
          prompts.push(String(body?.prompt ?? ''));
          return Promise.resolve({ data: { summary: 'Subjective: cough\nObjective:\nAssessment:\nPlan:' } });
        }
        return Promise.resolve({ data: {} });
      }),
    },
  };
}

function buildService(httpMock: unknown) {
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
  const configService = { get: vi.fn().mockImplementation((k: string) => ({ LIVE_DOC_MIN_INTERVAL_MS: '0' } as Record<string, unknown>)[k]) };
  const harnessPolicyService = { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma-4-e4b' }) };
  return new LiveDocumentationService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    httpMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cacheService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redisSubscriber as any,
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undefined as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    harnessPolicyService as any,
  );
}

describe('4D.1 — prefix-cache-friendly live prompt ordering', () => {
  it('exports a non-trivial stable system prefix carrying the SOAP output instruction', () => {
    expect(typeof LIVE_SOAP_STABLE_SYSTEM_PREFIX).toBe('string');
    expect(LIVE_SOAP_STABLE_SYSTEM_PREFIX.length).toBeGreaterThan(50);
    expect(LIVE_SOAP_STABLE_SYSTEM_PREFIX).toContain('Output EXACTLY these four sections');
  });

  it('leads every flush with a byte-identical stable prefix (first flush AND update flush)', async () => {
    const prompts: string[] = [];
    const service = buildService(recordingHttpMock(prompts));
    service.start({ consultationId: CID, tenantId: TENANT });

    service.ingestSegment(CID, { text: 'Patient reports cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID); // first flush — no prior note
    service.ingestSegment(CID, { text: 'and mild fever', isFinal: true, segmentId: 's2' });
    await service.flush(CID); // second flush — prior note now exists (update path)

    expect(prompts.length).toBe(2);
    const [first, second] = prompts;
    // Both flush kinds share the identical stable prefix → prefix-cache reuse.
    expect(first.startsWith(LIVE_SOAP_STABLE_SYSTEM_PREFIX)).toBe(true);
    expect(second.startsWith(LIVE_SOAP_STABLE_SYSTEM_PREFIX)).toBe(true);
  });

  it('orders the delta instruction AFTER the transcript and current note on the update path', async () => {
    const prompts: string[] = [];
    const service = buildService(recordingHttpMock(prompts));
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient reports cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);
    service.ingestSegment(CID, { text: 'and mild fever', isFinal: true, segmentId: 's2' });
    await service.flush(CID);

    const update = prompts[1];
    const noteIdx = update.indexOf('Current SOAP note so far');
    const transcriptIdx = update.indexOf('mild fever');
    const instructionIdx = update.indexOf('Update the existing SOAP note');
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(transcriptIdx).toBeGreaterThanOrEqual(0);
    expect(instructionIdx).toBeGreaterThanOrEqual(0);
    // [transcript] + [current note] both precede the [delta instruction].
    expect(instructionIdx).toBeGreaterThan(noteIdx);
    expect(instructionIdx).toBeGreaterThan(transcriptIdx);
    // Old transcript is not re-sent verbatim (incremental design preserved).
    expect(update).not.toContain('Patient reports cough');
  });
});
