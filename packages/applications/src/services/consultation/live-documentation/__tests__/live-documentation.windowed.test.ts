/**
 * LiveDocumentationService — windowed transcript mode.
 *
 * `agentic.context.transcript.mode` shipped as a declared-but-inert descriptor
 * ("windowed lands in a later phase"). This is that phase.
 *
 * What the two modes mean on the live path, which is already DELTA-based:
 *   - `whole` (default, unchanged): when the un-flushed backlog exceeds the delta
 *     cap, take whole segments from the HEAD (oldest first) and carry the tail
 *     into the next flush (the C5-04 rule).
 *   - `windowed`: take the most RECENT segments instead, because the prior SOAP
 *     note already carries everything older — sending the oldest backlog verbatim
 *     re-describes what the note has, while the newest content is what the note
 *     is missing. The dropped head is acknowledged in the prompt rather than
 *     silently omitted, and the cursor still advances over everything covered so
 *     nothing is re-sent twice.
 *
 * THE load-bearing test is the equivalence invariant: when the backlog fits in
 * the window, `windowed` must produce a BYTE-IDENTICAL prompt to `whole`. That
 * bounds the blast radius of the flip to exactly the overflow case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { AGENTIC_CONTEXT_DEFAULTS } from '../../../settings-registry/descriptors/agentic-context.descriptors';

const CID = 'consultation-window';
const TENANT = 'tenant-window';

function buildHttpMock() {
  const post = vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
    if (String(url).includes('/generate')) return Promise.resolve({ data: { summary: 'S: ok' } });
    return Promise.resolve({ data: {} });
  });
  return { axiosRef: { post } };
}

function buildService(stored: Record<string, unknown> = {}) {
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
  const resolveEffective = vi.fn(async (key: string) => {
    const knob = key.replace('agentic.context.', '') as keyof typeof AGENTIC_CONTEXT_DEFAULTS;
    return knob in stored
      ? { key, tier: 'global-kv', value: stored[knob], sourceScope: 'global-kv' }
      : { key, tier: 'global-kv', value: AGENTIC_CONTEXT_DEFAULTS[knob], sourceScope: 'code-default' };
  });
  const http = buildHttpMock();
  const service = new LiveDocumentationService(
    http as never,
    { get: vi.fn() } as never,
    cacheService as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined as never,
    undefined as never,
    { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'm' }) } as never,
    undefined as never,
    undefined as never,
    { resolveEffective } as never,
  );
  return { service, http };
}

const generatePrompt = (http: { axiosRef: { post: ReturnType<typeof vi.fn> } }, index = 0): string => {
  const calls = http.axiosRef.post.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/generate'));
  return (calls[index][1] as { prompt: string }).prompt;
};

/** Drive one flush with `segments` ingested, under the given stored knobs. */
async function flushWith(stored: Record<string, unknown>, segments: string[]) {
  const { service, http } = buildService(stored);
  service.start({ consultationId: CID, tenantId: TENANT });
  segments.forEach((text, i) => service.ingestSegment(CID, { text, isFinal: true, segmentId: `s${i}` }));
  await service.flush(CID, { force: true });
  return { service, http };
}

afterEach(() => vi.restoreAllMocks());

describe('LiveDocumentationService — windowed transcript', () => {
  it('EQUIVALENCE: a backlog inside the window yields a byte-identical prompt in both modes', async () => {
    const segments = ['Patient reports chest pain.', 'No shortness of breath.'];

    const whole = await flushWith({ 'transcript.mode': 'whole' }, segments);
    const windowed = await flushWith({ 'transcript.mode': 'windowed' }, segments);

    expect(generatePrompt(windowed.http)).toBe(generatePrompt(whole.http));
  });

  it('EQUIVALENCE holds at the exact boundary (backlog === cap)', async () => {
    // Two 20-char segments + the joining space = 41; a 41-char cap fits exactly.
    const segments = ['a'.repeat(20), 'b'.repeat(20)];
    const knobs = { 'liveDelta.maxChars': 41 };

    const whole = await flushWith({ ...knobs, 'transcript.mode': 'whole' }, segments);
    const windowed = await flushWith({ ...knobs, 'transcript.mode': 'windowed' }, segments);

    expect(generatePrompt(windowed.http)).toBe(generatePrompt(whole.http));
    expect(generatePrompt(windowed.http)).toContain('b'.repeat(20));
  });

  it('whole mode keeps the OLDEST content on overflow (unchanged)', async () => {
    const { http } = await flushWith({ 'transcript.mode': 'whole', 'liveDelta.maxChars': 30 }, ['a'.repeat(25), 'b'.repeat(25), 'c'.repeat(25)]);

    const prompt = generatePrompt(http);
    expect(prompt).toContain('a'.repeat(25));
    expect(prompt).not.toContain('c'.repeat(25));
  });

  it('windowed mode keeps the NEWEST content on overflow', async () => {
    const { http } = await flushWith({ 'transcript.mode': 'windowed', 'liveDelta.maxChars': 30 }, ['a'.repeat(25), 'b'.repeat(25), 'c'.repeat(25)]);

    const prompt = generatePrompt(http);
    expect(prompt).toContain('c'.repeat(25));
    expect(prompt).not.toContain('a'.repeat(25));
  });

  it('windowed mode tells the model that earlier transcript was elided', async () => {
    // Silently dropping clinical content would be unsafe — the model must know
    // the window is partial so it does not treat it as the whole encounter.
    const { http } = await flushWith({ 'transcript.mode': 'windowed', 'liveDelta.maxChars': 30 }, ['a'.repeat(25), 'b'.repeat(25), 'c'.repeat(25)]);

    expect(generatePrompt(http)).toMatch(/earlier transcript/i);
  });

  it('windowed mode does NOT add that notice when nothing was elided', async () => {
    const { http } = await flushWith({ 'transcript.mode': 'windowed' }, ['Patient reports chest pain.']);

    expect(generatePrompt(http)).not.toMatch(/earlier transcript/i);
  });

  it('keeps the stable cache-friendly prefix in both modes', async () => {
    const segments = ['a'.repeat(25), 'b'.repeat(25), 'c'.repeat(25)];
    const whole = await flushWith({ 'transcript.mode': 'whole', 'liveDelta.maxChars': 30 }, segments);
    const windowed = await flushWith({ 'transcript.mode': 'windowed', 'liveDelta.maxChars': 30 }, segments);

    // Both prompts must still OPEN with the same stable system block — that is
    // what the engine's prefix cache keys on.
    const stablePrefix = generatePrompt(whole.http).slice(0, 200);
    expect(generatePrompt(windowed.http).startsWith(stablePrefix)).toBe(true);
  });

  it('defaults to whole when nothing is stored', async () => {
    const { service } = buildService();
    expect((await service.resolveAgenticContext(TENANT)).transcriptMode).toBe('whole');
  });
});
