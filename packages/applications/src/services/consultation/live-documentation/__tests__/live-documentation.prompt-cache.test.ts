/**
 * prefix-cache-friendly live TEXT prompt ordering.
 *
 * The live TEXT user prompt is reordered to
 *   [stable system] + [transcript-so-far] + [current note] + [delta instruction]
 * so the leading `[stable system]` block is BYTE-IDENTICAL across every flush of
 * a session — first flush AND subsequent update flushes — letting a prefix-cache
 * engine (vLLM / llama.cpp `cache_prompt`) reuse the KV cache of that stable
 * prefix instead of re-prefilling a different leading instruction each flush
 * (the old ordering led with a mode-specific "produce…" vs "update…" directive,
 * so the two flush kinds shared no prefix at all).
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveDocumentationService, LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX, LIVE_DOCUMENT_SYSTEM_PROMPT } from '../live-documentation.service';
import { liveSystemHead } from './live-compose-expectations';

const CID = 'consultation-cache-001';
const TENANT = 'tenant-cache';

/** Records every TEXT `/generate` prompt; returns a note so a prior note exists on flush 2. */
/** One recorded TEXT call: the system message (instructions) and the user message (data). */
interface Sent {
  system: string;
  user: string;
}

function recordingHttpMock(prompts: Sent[]) {
  return {
    axiosRef: {
      post: vi.fn().mockImplementation((url: string, body: { prompt?: string; system_prompt?: string }) => {
        if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
        if (url.includes('/generate')) {
          prompts.push({ system: String(body?.system_prompt ?? ''), user: String(body?.prompt ?? '') });
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
  const configService = { get: vi.fn().mockImplementation((k: string) => (({ LIVE_DOC_MIN_INTERVAL_MS: '0' }) as Record<string, unknown>)[k]) };
  const harnessPolicyService = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma-4-e4b' }) };
  return new LiveDocumentationService(
    httpMock as any,
    configService as any,
    cacheService as any,
    redisSubscriber as any,
    undefined,
    undefined as any,
    harnessPolicyService as any,
  );
}

describe('4D.1 — prefix-cache-friendly live prompt ordering', () => {
  it('exports a non-trivial stable system prefix carrying the compiled output instruction', () => {
    expect(typeof LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX).toBe('string');
    expect(LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX.length).toBeGreaterThan(50);
    // the prefix is now COMPILED from the platform document shape
    // rather than written out as four literal headings, so this asserts the
    // compiled instruction's invariant parts instead of the old sentence.
    expect(LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX).toContain('Output a single JSON object with EXACTLY these keys');
    expect(LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX).toContain('set its value to null');
  });

  it('leads every flush with a byte-identical stable prefix (first flush AND update flush)', async () => {
    const prompts: Sent[] = [];
    const service = buildService(recordingHttpMock(prompts));
    service.start({ consultationId: CID, tenantId: TENANT });

    service.ingestSegment(CID, { text: 'Patient reports cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID); // first flush — no prior note
    service.ingestSegment(CID, { text: 'and mild fever', isFinal: true, segmentId: 's2' });
    await service.flush(CID); // second flush — prior note now exists (update path)

    expect(prompts.length).toBe(2);
    const [first, second] = prompts;
    // Both flush kinds share the identical stable head — platform rules, the agent's instruction,
    // the stable lead-in — so the engine reuses its cached KV.
    const head = liveSystemHead(LIVE_DOCUMENT_SYSTEM_PROMPT, LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX);
    expect(first.system.startsWith(head)).toBe(true);
    expect(second.system.startsWith(head)).toBe(true);
  });

  it('keeps the variable directive after the stable lead-in, and the transcript and note as DATA after every instruction', async () => {
    const prompts: Sent[] = [];
    const service = buildService(recordingHttpMock(prompts));
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient reports cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);
    service.ingestSegment(CID, { text: 'and mild fever', isFinal: true, segmentId: 's2' });
    await service.flush(CID);

    const update = prompts[1];
    // the prose names the RESOLVED template's title instead of asserting "SOAP note" while the
    // response schema described whatever the tenant actually published. With no template service
    // wired this fixture resolves the platform shape, whose title is "SOAP Note".
    // TASK-939 OD-2(a) — the update instruction is about the CONTRIBUTION, not the document.
    const instructionIdx = update.system.indexOf('Report what the new transcript adds to the SOAP Note');
    expect(instructionIdx).toBeGreaterThan(update.system.indexOf(LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX));
    // The note so far and the new transcript are DATA — delimited blocks in the user message.
    expect(update.user).toContain('<<<EXTERNAL_DATA section="current_note">>>\n--- Current SOAP Note so far ---');
    expect(update.user).toContain('mild fever');
    expect(update.system).not.toContain('mild fever');
    // Old transcript is not re-sent verbatim (incremental design preserved).
    expect(update.user).not.toContain('Patient reports cough');
    // TASK-939 — the output contract is the last instruction: after the directive and the frame.
    const turnIdx = update.system.indexOf('WHAT TO EMIT THIS TURN:');
    expect(turnIdx).toBeGreaterThan(instructionIdx);
    expect(update.system.indexOf('HOW TO PRODUCE THIS TURN:')).toBeLessThan(turnIdx);
  });
});
