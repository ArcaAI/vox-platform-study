/**
 * TASK-932 §3.7 — the partial-summary OPERATING FRAME, and the summary language it carries.
 *
 * ## What is being separated
 *
 * The v3 department corpus is CLINICAL instruction — what belongs under which heading, which
 * source may supply it, how a date is written — and this ticket does not change a byte of it.
 * What the corpus cannot say, because it predates the realtime lane, is how a TURN works: the
 * transcript is partial and routinely code-switched (`languageMode: 'ml-en'`, code-switching on),
 * a running note already exists and must be extended rather than restarted, and the note's
 * language is a different axis from the transcript's.
 *
 * Those are properties of the RUNTIME, identical across all 22 department bodies, so the frame is
 * stated once by the lane. This suite pins that it says the things it exists to say and that it
 * names the SESSION's sections rather than a hardcoded SOAP tuple.
 *
 * TASK-1001 removed the OUTPUT LANGUAGE from that list: the note's language is a tenant DECISION,
 * not a runtime property, and stating it here is what made it unconfigurable. It is now a seeded
 * prompt fragment; see `live-documentation.operating-frame.task1001.test.ts` and the note below.
 *
 * The frame is asserted through the real prompt the service sends, not through a snapshot of a
 * private method, so a refactor that stops appending it fails here.
 */
import { describe, expect, it, vi } from 'vitest';

import { LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX, LiveDocumentationService } from '../live-documentation.service';

const CID = 'consultation-frame-001';
const TENANT = 'tenant-frame';

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

/** `metadata` is what a consultation row carries; `null` ⇒ no consultation repository at all. */
function buildService(prompts: string[], metadata: Record<string, unknown> | null) {
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
  const configService = { get: vi.fn().mockImplementation((key: string) => (key === 'LIVE_DOC_MIN_INTERVAL_MS' ? '0' : undefined)) };
  const harnessPolicyService = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma-4-e4b' }) };
  const consultationRepository = metadata === null ? undefined : { findById: vi.fn().mockResolvedValue({ id: CID, tenantId: TENANT, metadata }) };

  // Positional, like every sibling suite in this folder, but assembled by INDEX so a constructor
  // change fails here rather than silently sliding a mock into the wrong dependency.
  const args: unknown[] = new Array(25).fill(undefined);
  args[0] = recordingHttpMock(prompts);
  args[1] = configService;
  args[2] = cacheService;
  args[3] = redisSubscriber;
  args[6] = harnessPolicyService;
  args[15] = consultationRepository;

  return new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
}

/** Run one flush and return the TEXT prompt it produced. */
async function flushOnce(metadata: Record<string, unknown> | null): Promise<string> {
  const prompts: string[] = [];
  const service = buildService(prompts, metadata);
  service.start({ consultationId: CID, tenantId: TENANT });
  service.ingestSegment(CID, { text: 'Patient reports cough for three days', isFinal: true, segmentId: 's1' });
  await service.flush(CID);
  expect(prompts.length).toBeGreaterThan(0);
  return prompts.at(-1)!;
}

describe('TASK-932 §3.7 — the partial-summary operating frame', () => {
  it('states the turn steps, in order, after the delta instruction', async () => {
    const prompt = await flushOnce({});

    expect(prompt).toContain('HOW TO PRODUCE THIS TURN:');
    // 1 — translate internally. Without this the note follows whichever language dominated the
    // last few seconds of a code-switched turn.
    expect(prompt).toMatch(/PARTIAL and may be code-switched/);
    expect(prompt).toMatch(/understand it in English internally/);
    // 2 — merge, do not restart.
    expect(prompt).toMatch(/This is an UPDATE, not a fresh note/);
    // 3 — the template's sections, by key, with null for what has not been reached (was 4
    //     before TASK-1001 retired the language step).
    expect(prompt).toMatch(/using these keys exactly:/);
    expect(prompt).toMatch(/never a placeholder, never invented content/);
    // 4 — the consultation is still running.
    expect(prompt).toMatch(/still in progress/);

    // The frame is the LAST thing the model reads: it is the turn's procedure.
    const frameAt = prompt.indexOf('HOW TO PRODUCE THIS TURN:');
    expect(frameAt).toBeGreaterThan(prompt.indexOf('Transcript so far:'));
    expect(prompt.slice(frameAt)).not.toContain('Transcript so far:');
  });

  it('names the SESSION`s own section keys, not a hardcoded SOAP tuple', async () => {
    const prompt = await flushOnce({});
    const line = prompt.split('\n').find((candidate) => candidate.includes('using these keys exactly:'))!;
    // The platform shape's four keys, which is what an unwired document-template service serves.
    for (const key of ['subjective', 'objective', 'assessment', 'plan']) expect(line).toContain(key);
  });

  /**
   * TASK-1001 (OD-1 / OD-3) — the LANGUAGE cases that stood here are GONE, and deliberately not
   * replaced in kind.
   *
   * They pinned a step this frame no longer has: the output language was generated in code from
   * the consultation's declared `summaryLanguage`, which is exactly why a tenant admin could not
   * change it and why ALaaS's `ml-en` (an STT code-switch MODE) produced a Malayalam note. The
   * rule is now CONTENT — one shared `Output language policy` template referenced as an
   * unconditional `instruction.fragments[]` pointer by every ArcaAI summary agent.
   *
   * What replaces them lives in `live-documentation.operating-frame.task1001.test.ts`: that the
   * frame emits no language line at all, that the policy arrives through the fragment path, and —
   * the clause that used to ride along with the generated line — that section keys and headings
   * are still required to stay in English (finding S-4; a translated heading makes ALaaS insert a
   * twin section that nothing ever removes).
   *
   * The TASK-891 OD-1 posture this suite was written to protect is unchanged and is asserted
   * there: absent is still not English, and now nothing in code says otherwise.
   */
  it('says nothing about the output language — that rule is tenant content now (TASK-1001)', async () => {
    const prompt = await flushOnce({ summaryLanguage: 'ml' });

    expect(prompt).not.toContain('Write every section value in');
    expect(prompt).not.toContain('No output language was declared');
    expect(prompt).not.toContain('Malayalam');
  });

  it('leaves the prefix-cacheable lead-in untouched — the frame is appended, never prepended', async () => {
    const prompt = await flushOnce({ summaryLanguage: 'ml' });
    expect(prompt.startsWith(LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX)).toBe(true);
  });

  it('survives a consultation repository that is not wired at all', async () => {
    const prompt = await flushOnce(null);
    expect(prompt).toContain('HOW TO PRODUCE THIS TURN:');
    expect(prompt).toContain('using these keys exactly:');
  });
});
