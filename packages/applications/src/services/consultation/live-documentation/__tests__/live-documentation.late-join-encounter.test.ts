/**
 * The live-summary late join replays the CURRENT encounter only.
 *
 * Section rows and the cached note outlive the append of a new encounter. A client subscribing to
 * encounter 2's stream was replayed encounter 1's section rows (its draft, its lock) and — between
 * the append and encounter 2's first recording — encounter 1's terminal note, which also ended the
 * stream before encounter 2 produced anything.
 *
 * What this suite pins:
 *  1. only rows of the consultation's current encounter are replayed (an unstamped row = encounter 1);
 *  2. a cached note / pre-summary written before the current encounter started is not replayed;
 *  3. within one encounter the late join is unchanged — its rows, its snapshot, its terminal;
 *  4. when the current encounter cannot be read nothing is filtered (the late join that shipped).
 */
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { DocumentSectionFactory } from '@arcaai/domains';

import { LiveDocumentationService } from '../live-documentation.service';

const TENANT = 'tenant-latejoin-enc';
const CID = 'consultation-latejoin-enc';
const CHANNEL = `consultation:live-summary:${CID}`;
const SNAPSHOT_KEY = `${CHANNEL}:last`;
const PRESUMMARY_KEY = `${CHANNEL}:presummary:last`;

const ENCOUNTER_ONE_AT = '2026-10-13T04:00:30.000Z';
const ENCOUNTER_TWO_STARTED = new Date('2026-10-13T04:03:45.000Z');
const ENCOUNTER_TWO_AT = '2026-10-13T04:04:20.000Z';

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function row(sectionKey: string, idx: number, encounterSeq?: number) {
  const entity = DocumentSectionFactory.CreateDocumentSection({
    tenantId: TENANT,
    consultationId: CID,
    documentKey: 'soap_note',
    sectionKey,
    title: sectionKey,
    idx,
  });
  entity.applyMachineContent(`${sectionKey} body`);
  if (encounterSeq !== undefined) entity.metaData = { encounterSeq };
  entity.content = null;
  return entity;
}

const ROWS = [row('legacy_allergies', 0), row('consent', 1, 1), row('interval_history', 0, 2)];

const snapshot = (updatedAt: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ consultationId: CID, runningSummary: 'note', sections: [], entities: [], updatedAt, ...extra });
const presummary = (updatedAt: string) => JSON.stringify({ event: 'presummary', consultationId: CID, status: 'ready', content: '- x', updatedAt });

interface Wiring {
  cached: Record<string, string>;
  /** `null` ⇒ no consultation repository wired. */
  currentEncounterSeq?: number | null;
  /** `null` ⇒ no encounter repository wired. */
  encounterStartedAt?: Date | null;
}

function buildService(wiring: Wiring) {
  const store = new Map(Object.entries(wiring.cached));
  const cache = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(),
    publish: vi.fn(),
    del: vi.fn(),
    eval: vi.fn(async () => 0),
    sadd: vi.fn(),
    srem: vi.fn(),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn(),
  };
  const channel = new Subject<string>();
  const repository = {
    findByConsultation: vi.fn(async () => ROWS),
    decryptContentFromEntity: vi.fn(async (entity: { sectionKey: string }) => `${entity.sectionKey} body`),
  };
  const encounterSeq = wiring.currentEncounterSeq === undefined ? 2 : wiring.currentEncounterSeq;
  const startedAt = wiring.encounterStartedAt === undefined ? ENCOUNTER_TWO_STARTED : wiring.encounterStartedAt;

  const args: unknown[] = new Array(39).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(async () => channel.asObservable()), unsubscribeFromChannel: vi.fn() };
  args[7] = { encrypt: vi.fn(), decrypt: vi.fn() };
  args[11] = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)), set: vi.fn(), run: vi.fn() };
  args[15] = encounterSeq === null ? undefined : { findById: vi.fn(async () => ({ id: CID, currentEncounterSeq: encounterSeq })) };
  args[18] = repository;
  args[38] = startedAt === null ? undefined : { findBySeq: vi.fn(async (_cid: string, seq: number) => ({ consultationId: CID, seq, startedAt })) };

  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service };
}

interface Frame {
  type?: string;
  data: string;
}

async function lateJoin(wiring: Wiring) {
  const { service } = buildService(wiring);
  const frames: Frame[] = [];
  let completed = false;
  const sub = service.subscribeToLiveSummary(CID).subscribe({
    next: (event: unknown) => frames.push(event as Frame),
    complete: () => {
      completed = true;
    },
  });
  await tick();
  sub.unsubscribe();
  return { frames, completed };
}

const sectionKeys = (frames: Frame[]) =>
  frames.filter((frame) => frame.type === 'section.patch').map((frame) => (JSON.parse(frame.data) as { sectionKey: string }).sectionKey);

describe('late join — the current encounter only', () => {
  it('replays only the current encounter’s section rows', async () => {
    const { frames } = await lateJoin({ cached: { [SNAPSHOT_KEY]: snapshot(ENCOUNTER_TWO_AT) } });
    expect(sectionKeys(frames)).toEqual(['interval_history']);
  });

  it('drops the previous encounter’s TERMINAL note — encounter 2’s stream stays open', async () => {
    const { frames, completed } = await lateJoin({
      cached: { [SNAPSHOT_KEY]: snapshot(ENCOUNTER_ONE_AT, { closed: true }), [PRESUMMARY_KEY]: presummary(ENCOUNTER_ONE_AT) },
    });
    expect(frames.some((frame) => frame.data.includes('"closed":true'))).toBe(false);
    expect(frames.some((frame) => frame.type === 'presummary')).toBe(false);
    expect(completed).toBe(false);
  });

  it('within the encounter the late join is unchanged — its snapshot, its pre-summary', async () => {
    const { frames } = await lateJoin({
      cached: { [SNAPSHOT_KEY]: snapshot(ENCOUNTER_TWO_AT), [PRESUMMARY_KEY]: presummary(ENCOUNTER_TWO_AT) },
    });
    expect(frames.map((frame) => frame.type)).toEqual([undefined, 'section.patch', 'presummary']);
  });

  it('in encounter 1 an unstamped row is that encounter’s, and its snapshot is replayed', async () => {
    const { frames } = await lateJoin({
      cached: { [SNAPSHOT_KEY]: snapshot(ENCOUNTER_ONE_AT) },
      currentEncounterSeq: 1,
      encounterStartedAt: new Date('2026-10-13T03:57:00.000Z'),
    });
    expect(sectionKeys(frames)).toEqual(['legacy_allergies', 'consent']);
    expect(frames[0]?.type).toBeUndefined();
  });

  it('filters nothing when the current encounter cannot be read', async () => {
    const { frames } = await lateJoin({
      cached: { [SNAPSHOT_KEY]: snapshot(ENCOUNTER_ONE_AT) },
      currentEncounterSeq: null,
      encounterStartedAt: null,
    });
    expect(sectionKeys(frames)).toEqual(['legacy_allergies', 'consent', 'interval_history']);
    expect(frames[0]?.type).toBeUndefined();
  });
});
