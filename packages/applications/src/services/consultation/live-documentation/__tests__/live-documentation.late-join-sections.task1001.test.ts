/**
 * TASK-1001 S-9 — a late joiner is replayed the SECTION plane, not only the note.
 *
 * ## The defect
 *
 * `GET :id/live-summary/stream` multiplexes the whole-document snapshot and one `section.patch` per
 * written section. A client folds patches by `(documentKey, sectionKey)` and applies one only when
 * its `revision` is newer. On (re)connect the late join replayed the snapshot and the warm-start
 * `presummary` — and never a patch — while the snapshot's sections carried neither a key nor a
 * revision. A reconnecting client therefore:
 *
 *  - could not seed its revision map, so the next patch it saw (possibly an OLDER one still in
 *    flight) was applied over the newer text the snapshot had just shown; and
 *  - held the snapshot's sections under a title-derived identity and the next patch's under the
 *    template's, i.e. the same section twice (ALaaS S-4).
 *
 * ## What this suite pins
 *
 *  1. the replayed snapshot's sections carry `documentKey` + `sectionKey` from their persisted row,
 *     and `revision` ONLY when the snapshot's text IS that revision — a client that seeds from a
 *     revision whose text it does not hold would then discard the patch that corrects it;
 *  2. one `section.patch` per persisted section follows the snapshot — the row's latest revision,
 *     its decrypted body and its current annotations (the `duplicate` flag included) — before the
 *     warm start, so the note is complete before the background material;
 *  3. a relayed `section.patch` the replay already delivered (same section, revision not newer) is
 *     not sent twice; a newer one, another section's, and a degrade for a never-written section are;
 *  4. on a FINISHED consultation the terminal snapshot is replayed LAST and ends the stream, because
 *     every SDK stops reading at `closed: true` and a patch after it would never be seen;
 *  5. the replay can only ADD frames: no tenant, no encryptor, a failed read — each degrades to
 *     exactly the snapshot + pre-summary late join that shipped before, byte for byte.
 */
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { DocumentSectionFactory } from '@arcaai/domains';

import { LiveDocumentationService } from '../live-documentation.service';
import type { SectionAnnotationDto } from '../realtime';

const TENANT = 'tenant-1001-latejoin';
const CID = 'consultation-1001-latejoin';
const DOC = 'soap_note';
const CHANNEL = `consultation:live-summary:${CID}`;
const SNAPSHOT_KEY = `${CHANNEL}:last`;
const PRESUMMARY_KEY = `${CHANNEL}:presummary:last`;
const SNAPSHOT_AT = '2026-09-23T10:00:00.000Z';

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const DUPLICATE: SectionAnnotationDto = { kind: 'duplicate', start: 0, end: 5, duplicateOf: 'plan', duplicateOfTitle: 'Plan' };

/**
 * Two persisted sections, as a DATABASE read returns them: `content` has no column, so the body is
 * only reachable through the decrypt. `subjective` is machine-written twice (revision 2) and carries
 * a cross-section `duplicate` flag; `plan` was confirmed by the clinician (revision 1).
 */
function persistedRows() {
  const subjective = DocumentSectionFactory.CreateDocumentSection({
    tenantId: TENANT,
    consultationId: CID,
    documentKey: DOC,
    sectionKey: 'subjective',
    title: 'Subjective',
    idx: 0,
  });
  subjective.applyMachineContent('Cough.');
  subjective.applyMachineContent('Cough for three days.', [DUPLICATE] as never);

  const plan = DocumentSectionFactory.CreateDocumentSection({
    tenantId: TENANT,
    consultationId: CID,
    documentKey: DOC,
    sectionKey: 'plan',
    title: 'Plan',
    idx: 1,
  });
  plan.applyClinicianContent('Rest and fluids.', 'doctor-1');

  const bodies = new Map([
    ['subjective', 'Cough for three days.'],
    ['plan', 'Rest and fluids.'],
  ]);
  subjective.content = null;
  plan.content = null;
  return { rows: [subjective, plan], bodies };
}

/**
 * The note snapshot a flush cached. `Subjective` matches its row exactly; `Plan` is the MACHINE's
 * text, which the store refused to write over the clinician's confirmed section — the snapshot and
 * the row disagree, which is the case a revision stamp would get wrong.
 */
function noteSnapshot(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    consultationId: CID,
    runningSummary: 'Subjective\nCough for three days.\n\nPlan\nRest.',
    sections: [
      { title: 'Subjective', content: 'Cough for three days.' },
      { title: 'Plan', content: 'Rest.' },
    ],
    entities: [],
    updatedAt: SNAPSHOT_AT,
    ...extra,
  });
}

const PRESUMMARY = JSON.stringify({ event: 'presummary', consultationId: CID, status: 'ready', content: '- Diabetes', updatedAt: SNAPSHOT_AT });

interface Wiring {
  cached?: Record<string, string>;
  /** `null` ⇒ no `DocumentSectionRepository` wired at all. */
  repository?: ReturnType<typeof repositoryDouble> | null;
  /** `null` ⇒ no encryptor wired. */
  secrets?: object | null;
  /** The request tenant CLS answers; `null` ⇒ none. */
  clsTenant?: string | null;
}

function repositoryDouble(rows = persistedRows()) {
  return {
    rows,
    findByConsultation: vi.fn(async (_tenantId: string, _consultationId: string) => rows.rows),
    decryptContentFromEntity: vi.fn(async (row: { sectionKey: string }) => rows.bodies.get(row.sectionKey) ?? null),
  };
}

/** Tag of the compare-and-delete script `start()` runs on the cached snapshot key. */
const CLEAR_TERMINAL_TAG = 'live-doc:snapshot:clear-terminal';

function buildService(wiring: Wiring = {}) {
  const store = new Map(Object.entries(wiring.cached ?? { [SNAPSHOT_KEY]: noteSnapshot(), [PRESUMMARY_KEY]: PRESUMMARY }));
  const cache = {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
    publish: vi.fn(),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    // Dispatched by the script's tag comment, as the single-owner lock suite does. The clear is
    // emulated with the contract its Lua states — delete the key ONLY when it holds a terminal
    // (`closed: true`) payload — and the store moves at CALL time, as Redis serialises the body.
    eval: vi.fn((script: string, _numKeys: number, key: string) => {
      if (!script.includes(CLEAR_TERMINAL_TAG)) return Promise.resolve(1);
      const current = store.get(key);
      let terminal = false;
      try {
        terminal = current !== undefined && (JSON.parse(current) as { closed?: unknown }).closed === true;
      } catch {
        terminal = false;
      }
      if (!terminal) return Promise.resolve(0);
      store.delete(key);
      return Promise.resolve(1);
    }),
    sadd: vi.fn(),
    srem: vi.fn(),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn(),
  };
  const channels = new Map<string, Subject<string>>();
  const channelFor = (name: string): Subject<string> => {
    const known = channels.get(name);
    if (known) return known;
    const created = new Subject<string>();
    channels.set(name, created);
    return created;
  };
  const channel = channelFor(CHANNEL);
  const repository = wiring.repository === null ? undefined : (wiring.repository ?? repositoryDouble());
  const clsTenant = wiring.clsTenant === undefined ? TENANT : wiring.clsTenant;

  const args: unknown[] = new Array(19).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(async (name: string) => channelFor(name).asObservable()), unsubscribeFromChannel: vi.fn() };
  args[7] = wiring.secrets === null ? undefined : (wiring.secrets ?? { encrypt: vi.fn(), decrypt: vi.fn() });
  args[11] = { get: vi.fn((key: string) => (key === 'tenantId' ? (clsTenant ?? undefined) : undefined)), set: vi.fn(), run: vi.fn() };
  args[18] = repository;

  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, cache, channel, repository };
}

interface Frame {
  type?: string;
  data: string;
}

/** Subscribe to the live-summary stream and let the late join settle. */
async function watch(service: LiveDocumentationService) {
  const frames: Frame[] = [];
  let completed = false;
  const sub = service.subscribeToLiveSummary(CID).subscribe({
    next: (event: unknown) => frames.push(event as Frame),
    complete: () => {
      completed = true;
    },
  });
  await tick();
  return { frames, sub, completed: () => completed };
}

async function lateJoin(wiring: Wiring = {}) {
  const built = buildService(wiring);
  return { ...built, ...(await watch(built.service)) };
}

const parsed = (frame: Frame) => JSON.parse(frame.data) as Record<string, unknown>;

/** A live `section.patch` as the flush would publish it. */
const livePatch = (sectionKey: string, revision: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: 'section.patch',
    consultationId: CID,
    documentKey: DOC,
    sectionKey,
    title: sectionKey,
    idx: 0,
    revision,
    state: 'provisional',
    content: `live ${sectionKey} r${revision}`,
    updatedAt: '2026-09-23T10:00:01.000Z',
    ...extra,
  });

describe('TASK-1001 S-9 — the late join replays the section plane', () => {
  it('emits the note snapshot, then one `section.patch` per persisted section, then the warm start', async () => {
    const { frames, sub, completed } = await lateJoin();

    expect(frames.map((frame) => frame.type)).toEqual([undefined, 'section.patch', 'section.patch', 'presummary']);
    expect(frames[3]!.data).toBe(PRESUMMARY);
    expect(completed()).toBe(false);
    sub.unsubscribe();
  });

  it('each replayed patch is the row`s CURRENT state — latest revision, decrypted body, current annotations', async () => {
    const { frames, sub } = await lateJoin();

    const [subjective, plan] = [parsed(frames[1]!), parsed(frames[2]!)];
    expect(subjective).toMatchObject({
      event: 'section.patch',
      consultationId: CID,
      documentKey: DOC,
      sectionKey: 'subjective',
      title: 'Subjective',
      idx: 0,
      revision: 2,
      state: 'provisional',
      content: 'Cough for three days.',
    });
    // The cross-section flag rides the replay exactly as it rode the live patch.
    expect(subjective.annotations).toEqual([DUPLICATE]);
    // A replay is not an append: nothing "just arrived".
    expect(subjective).not.toHaveProperty('appended');

    // The clinician's confirmed text — which no patch ever carried, because an edit is written
    // through REST — is what the section plane converges to.
    expect(plan).toMatchObject({ sectionKey: 'plan', revision: 1, state: 'confirmed', content: 'Rest and fluids.' });
    sub.unsubscribe();
  });

  it('stamps the snapshot`s sections with their row identity, and with `revision` only where the text IS that revision', async () => {
    const { frames, sub } = await lateJoin();

    const sections = parsed(frames[0]!).sections as Array<Record<string, unknown>>;
    expect(sections[0]).toEqual({ title: 'Subjective', content: 'Cough for three days.', documentKey: DOC, sectionKey: 'subjective', revision: 2 });
    // Identity yes, revision NO: the snapshot shows the machine's refused text, and a client seeded
    // with revision 1 here would discard the replayed patch that carries the clinician's.
    expect(sections[1]).toEqual({ title: 'Plan', content: 'Rest.', documentKey: DOC, sectionKey: 'plan' });
    // Nothing else about the snapshot moves.
    expect(parsed(frames[0]!)).toMatchObject({ consultationId: CID, updatedAt: SNAPSHOT_AT, entities: [] });
    sub.unsubscribe();
  });

  it('reads the sections under the REQUEST tenant', async () => {
    const { repository, sub } = await lateJoin();

    expect(repository!.findByConsultation).toHaveBeenCalledWith(TENANT, CID);
    sub.unsubscribe();
  });

  it('leaves a snapshot section no row matches untouched, and the snapshot byte-identical when none match', async () => {
    const cached = {
      [SNAPSHOT_KEY]: JSON.stringify({
        consultationId: CID,
        runningSummary: 'Running Summary\nfree text',
        sections: [{ title: 'Running Summary', content: 'free text' }],
        entities: [],
        updatedAt: SNAPSHOT_AT,
      }),
    };
    const { frames, sub } = await lateJoin({ cached });

    expect(frames[0]!.data).toBe(cached[SNAPSHOT_KEY]);
    // The rows are still the section plane's current state, so they are still replayed.
    expect(frames.map((frame) => frame.type)).toEqual([undefined, 'section.patch', 'section.patch']);
    sub.unsubscribe();
  });
});

describe('TASK-1001 S-9 — a replayed patch is not sent twice', () => {
  it('drops a relayed patch the replay already delivered (same section, revision not newer)', async () => {
    const { frames, channel, sub } = await lateJoin();
    const before = frames.length;

    channel.next(livePatch('subjective', 2));
    channel.next(livePatch('subjective', 1));
    channel.next(livePatch('plan', 1));
    await tick();

    expect(frames).toHaveLength(before);
    sub.unsubscribe();
  });

  it('relays a NEWER revision, another section`s patch, another document`s, and a degrade for a never-written section', async () => {
    const { frames, channel, sub } = await lateJoin();
    const before = frames.length;
    const relayed = [
      livePatch('subjective', 3),
      livePatch('plan', 2),
      livePatch('assessment', 1),
      livePatch('subjective', 1, { documentKey: 'discharge_summary' }),
      livePatch('assessment', 0, { state: 'empty', content: '', degradeReason: 'text_unavailable' }),
    ];
    for (const raw of relayed) channel.next(raw);
    await tick();

    expect(frames.slice(before).map((frame) => frame.data)).toEqual(relayed);
    sub.unsubscribe();
  });

  it('still drops the whole-document snapshot the replay already showed, although the replay re-serialized it with stamps', async () => {
    const { frames, channel, sub } = await lateJoin();
    const before = frames.length;

    channel.next(noteSnapshot());
    await tick();

    expect(frames).toHaveLength(before);
    sub.unsubscribe();
  });
});

describe('TASK-1001 S-9 + F5 — a late joiner of a FINISHED consultation', () => {
  it('is replayed the section plane BEFORE the terminal snapshot, which comes last and ends the stream', async () => {
    const closed = noteSnapshot({ closed: true });
    const { frames, channel, completed } = await lateJoin({ cached: { [SNAPSHOT_KEY]: closed } });

    expect(frames.map((frame) => frame.type)).toEqual(['section.patch', 'section.patch', undefined]);
    expect(parsed(frames[2]!)).toMatchObject({ closed: true, consultationId: CID });
    expect(completed()).toBe(true);

    // Nothing reaches a stream that has ended.
    channel.next(livePatch('subjective', 9));
    await tick();
    expect(frames).toHaveLength(3);
  });
});

describe('TASK-1001 S-9 — the replay only ever ADDS frames; every gap degrades to the previous late join', () => {
  const previousLateJoin = [noteSnapshot(), PRESUMMARY];

  it('no request tenant and no local session ⇒ the rows are not read at all', async () => {
    const repository = repositoryDouble();
    const { frames, sub } = await lateJoin({ repository, clsTenant: null });

    expect(repository.findByConsultation).not.toHaveBeenCalled();
    expect(frames.map((frame) => frame.data)).toEqual(previousLateJoin);
    sub.unsubscribe();
  });

  it('no encryptor ⇒ no replay: a body that cannot be read is never published as an empty one', async () => {
    const repository = repositoryDouble();
    const { frames, sub } = await lateJoin({ repository, secrets: null });

    expect(frames.map((frame) => frame.data)).toEqual(previousLateJoin);
    sub.unsubscribe();
  });

  it('no `DocumentSectionRepository` wired ⇒ exactly the previous late join', async () => {
    const { frames, sub } = await lateJoin({ repository: null });

    expect(frames.map((frame) => frame.data)).toEqual(previousLateJoin);
    sub.unsubscribe();
  });

  it('a failed section read ⇒ the previous late join, and no setup-error frame', async () => {
    const repository = repositoryDouble();
    repository.findByConsultation.mockRejectedValue(new Error('db down'));
    const { frames, sub, completed } = await lateJoin({ repository });

    expect(frames.map((frame) => frame.data)).toEqual(previousLateJoin);
    expect(completed()).toBe(false);
    sub.unsubscribe();
  });

  it('a section whose body cannot be decrypted is left out — its patch AND its snapshot stamp', async () => {
    const repository = repositoryDouble();
    repository.decryptContentFromEntity.mockImplementation(async (row: { sectionKey: string }) => {
      if (row.sectionKey === 'subjective') throw new Error('transit unavailable');
      return 'Rest and fluids.';
    });
    const { frames, sub } = await lateJoin({ repository });

    expect(frames.map((frame) => frame.type)).toEqual([undefined, 'section.patch', 'presummary']);
    expect(parsed(frames[1]!)).toMatchObject({ sectionKey: 'plan' });
    const sections = parsed(frames[0]!).sections as Array<Record<string, unknown>>;
    expect(sections[0]).toEqual({ title: 'Subjective', content: 'Cough for three days.' });
    sub.unsubscribe();
  });
});

/**
 * TASK-1001 — a RESUMED recording must not replay the PREVIOUS session's terminal.
 *
 * `…:last`'s final write at stop is the `closed: true` payload, and nothing reset it when the same
 * consultation started recording again — so until the new session's first flush overwrote it, every
 * subscriber was replayed a `closed` that belonged to a session already over. Every SDK stops
 * reading there, and with F5 the relay ends the stream there too: the resumed recording's live note
 * never reached a client that (re)connected in that window. Resuming is the clinician's ordinary
 * second-segment flow, so this is the case that must work.
 *
 * `start()` now runs a compare-and-delete on the key: it goes ONLY when it holds a terminal. A live
 * session's snapshot is never terminal (the `closed` payload is written by `stop` and nothing else),
 * so no replica can delete a still-running session's note, whichever instance the start lands on.
 */
describe('TASK-1001 — a resumed recording drops the previous session`s terminal snapshot', () => {
  it('resume after close: the late joiner gets NO `closed`, the persisted note, and an open stream', async () => {
    const { service, cache } = buildService({ cached: {} });
    // The previous session's stop — the real write: `…:last` becomes the `closed: true` payload.
    await service.stop(CID);
    expect((JSON.parse(cache.store.get(SNAPSHOT_KEY)!) as { closed?: boolean }).closed).toBe(true);

    // The clinician resumes recording on the same consultation.
    service.start({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1' });
    await tick();

    const { frames, sub, completed } = await watch(service);

    expect(frames.some((frame) => (JSON.parse(frame.data) as { closed?: boolean }).closed === true)).toBe(false);
    // What a late joiner sees between the resume and the first flush: the persisted sections.
    expect(frames.map((frame) => frame.type)).toEqual(['section.patch', 'section.patch']);
    expect(completed()).toBe(false);
    sub.unsubscribe();
  });

  it('a finished consultation that is NOT resumed still replays `closed`, last, and ends the stream', async () => {
    const { service } = buildService({ cached: {} });
    await service.stop(CID);

    const { frames, completed } = await watch(service);

    expect(frames.map((frame) => frame.type)).toEqual(['section.patch', 'section.patch', undefined]);
    expect((JSON.parse(frames.at(-1)!.data) as { closed?: boolean }).closed).toBe(true);
    expect(completed()).toBe(true);
  });

  it('never clears a LIVE session`s snapshot — a start landing on another replica leaves it alone', async () => {
    // A session is running (on whichever instance owns it) and has flushed: its snapshot is live.
    const { service, cache } = buildService({ cached: { [SNAPSHOT_KEY]: noteSnapshot() } });

    // A duplicate start on THIS instance (it holds no session, so it is a genuinely new start here).
    service.start({ consultationId: CID, tenantId: TENANT });
    await tick();

    expect(cache.store.get(SNAPSHOT_KEY)).toBe(noteSnapshot());
    const { frames, sub, completed } = await watch(service);
    expect(frames[0]!.type).toBeUndefined();
    expect(parsed(frames[0]!)).toMatchObject({ consultationId: CID, updatedAt: SNAPSHOT_AT });
    expect(completed()).toBe(false);
    sub.unsubscribe();
  });

  it('runs the ATOMIC compare-and-delete on the snapshot key, once per genuinely new session', async () => {
    const { service, cache } = buildService({ cached: {} });

    service.start({ consultationId: CID, tenantId: TENANT });
    // Re-binding an already-running session is not a new session: it must not run again.
    service.start({ consultationId: CID, tenantId: TENANT });
    await tick();

    const clears = cache.eval.mock.calls.filter((call) => String(call[0]).includes(CLEAR_TERMINAL_TAG));
    expect(clears).toEqual([[expect.stringContaining(CLEAR_TERMINAL_TAG), 1, SNAPSHOT_KEY]]);
    // Never a blind DEL of the note: a live session's snapshot must survive any start.
    expect(cache.del).not.toHaveBeenCalledWith(SNAPSHOT_KEY);
  });
});
