/**
 * TASK-1019 lane Y / TASK-1051 lane C1 — plain-language rendering helpers.
 * Pure functions: no raw enums, no colour-only meaning, estimates never shown
 * as observations.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveAttentionItems,
  formatDataAge,
  formatKeepPolicy,
  formatLoadFailureDetail,
  formatModelStatus,
  formatReportingServices,
  formatStateWhere,
  formatTraffic,
  formatUsedBy,
  formatUsedByNote,
  isLivePathModel,
  isProblemModel,
  primaryRowAction,
  rowActionFor,
} from '../residency-display';
import {
  BUILTIN_RNNOISE,
  FAILED_RNNOISE_LIKE,
  GiB,
  LIVE_WHISPER,
  LMS,
  makeCatalogue,
  makeDevice,
  makeModel,
  makeService,
  NLP,
  PINNED_NOT_LOADED,
  REMOTE_SARVAM,
  ROUTING_GUARD,
  STT,
  UNMATCHED_GEMMA,
  WORKER,
} from './residency-test-data';

const DEVICES = [makeDevice()];

describe('formatModelStatus — failed (TASK-1019)', () => {
  it('says "Load failed" with the error code, as text', () => {
    const failed = makeModel({
      status: 'failed',
      error: { code: 'RuntimeError', message: 'no gguf in /models/whisper', at: '2026-09-29T10:00:00Z' },
    });

    expect(formatModelStatus(failed, [])).toBe('Load failed · RuntimeError');
  });

  it('drops the code when it only repeats the sentence (the generic LOAD_FAILED) or is missing', () => {
    expect(formatModelStatus(makeModel({ status: 'failed', error: { code: 'LOAD_FAILED', message: 'x', at: null } }), [])).toBe('Load failed');
    expect(formatModelStatus(makeModel({ status: 'failed', error: null }), [])).toBe('Load failed');
  });

  it('never falls through to a "Not loaded" sentence', () => {
    expect(formatModelStatus(makeModel({ status: 'failed' }), [])).not.toMatch(/Not loaded/);
  });
});

describe('formatLoadFailureDetail (TASK-1019)', () => {
  it('returns the message for a failed model and nothing otherwise', () => {
    expect(formatLoadFailureDetail(makeModel({ status: 'failed', error: { code: 'RuntimeError', message: 'no gguf', at: null } }))).toBe('no gguf');
    expect(formatLoadFailureDetail(makeModel({ status: 'not_loaded' }))).toBeNull();
    expect(formatLoadFailureDetail(makeModel({ status: 'failed', error: null }))).toBeNull();
  });
});

describe('the retry of a failed model is the primary row action', () => {
  it('offers Load when the gateway offers it', () => {
    expect(primaryRowAction(makeModel({ status: 'failed' }).actions)).toBe('load');
  });
});

describe('formatDataAge — the agent clock, not the fetch (F7)', () => {
  const now = new Date('2026-10-07T10:00:00Z');

  it('reads "just now" under 5 s', () => {
    expect(formatDataAge('2026-10-07T09:59:57Z', now)).toBe('data just now');
  });

  it('reads seconds, then minutes', () => {
    expect(formatDataAge('2026-10-07T09:59:52Z', now)).toBe('data 8 s old');
    expect(formatDataAge('2026-10-07T09:57:00Z', now)).toBe('data 3 min old');
  });

  it('says so when no service has reported', () => {
    expect(formatDataAge(null, now)).toBe('no service has reported yet');
  });
});

describe('formatReportingServices', () => {
  it('counts services that answered and are not stale', () => {
    expect(formatReportingServices([STT, LMS, NLP], [])).toBe('3 of 3 services reporting');
    expect(formatReportingServices([STT, LMS, NLP], ['nlp'])).toBe('2 of 3 services reporting');
    expect(formatReportingServices([STT, { ...LMS, reachable: false }], [])).toBe('1 of 2 services reporting');
  });
});

describe('formatUsedBy — every consumer kind (F2)', () => {
  it('counts agents and tenants', () => {
    expect(formatUsedBy(LIVE_WHISPER.usage)).toBe('5 agents · 3 tenants');
    expect(formatUsedBy({ ...LIVE_WHISPER.usage, agentCount: 1, tenantCount: 1 })).toBe('1 agent · 1 tenant');
  });

  it('names a routing-policy consumer instead of "no agent"', () => {
    expect(formatUsedBy(ROUTING_GUARD.usage)).toBe('Routing policy');
    expect(formatUsedByNote(ROUTING_GUARD.usage)).toBe('Guardrail judge');
  });

  it('names a pipeline stage of N ASR agents', () => {
    const usage = { ...REMOTE_SARVAM.usage, consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 15, workflowNodes: 0 } };
    expect(formatUsedBy(usage)).toBe('Pipeline stage of 15 ASR agents');
  });

  it('says "No consumer" when nothing uses it, and flags live consultations in the note', () => {
    expect(formatUsedBy(REMOTE_SARVAM.usage)).toBe('No consumer');
    expect(formatUsedByNote(LIVE_WHISPER.usage)).toBe('Live consultations');
    expect(formatUsedByNote(REMOTE_SARVAM.usage)).toBe('');
  });
});

describe('formatStateWhere', () => {
  it('loaded: device + measured size', () => {
    expect(formatStateWhere(LIVE_WHISPER, DEVICES)).toEqual({ state: 'Loaded', tone: 'ok', where: 'GPU 0 · 1.5 GB measured' });
  });

  it('not loaded: an estimate is marked as one, with load time', () => {
    expect(formatStateWhere(PINNED_NOT_LOADED, DEVICES)).toEqual({ state: 'Not loaded', tone: 'warn', where: 'Needs ~1.5 GB est. · loads in ~7 s' });
    expect(formatStateWhere(makeModel({ size: { bytes: null, source: 'unknown' } }), DEVICES).where).toBe('Size unknown');
  });

  it('remote and built-in are "Not applicable", never failed', () => {
    expect(formatStateWhere(REMOTE_SARVAM, DEVICES)).toEqual({ state: 'Remote API', tone: 'neutral', where: 'Cloud · no GPU memory' });
    expect(formatStateWhere(BUILTIN_RNNOISE, DEVICES)).toEqual({
      state: 'Built in',
      tone: 'neutral',
      where: 'Compiled into its library · nothing to load',
    });
    expect(formatKeepPolicy(REMOTE_SARVAM)).toEqual({ label: 'Not applicable', reason: 'Nothing to load or unload' });
  });

  it('failed: words, never colour alone', () => {
    expect(formatStateWhere(FAILED_RNNOISE_LIKE, DEVICES)).toMatchObject({ state: 'Load failed · ModelNotCacheServedError', tone: 'critical' });
  });

  it('an unmatched instance says it is not in the catalogue', () => {
    expect(formatStateWhere(UNMATCHED_GEMMA, DEVICES)).toMatchObject({ state: 'Loaded · unmatched', tone: 'warn' });
  });
});

describe('formatTraffic', () => {
  it('joins the live counters and dashes when nothing is known', () => {
    expect(formatTraffic(LIVE_WHISPER, new Date('2026-10-07T10:00:00Z'))).toBe('4.2 req/min · p50 310 ms · 2 in flight · used 1 min ago');
    expect(formatTraffic(UNMATCHED_GEMMA, new Date())).toBe('31 req/min · p50 1.2 s');
    expect(formatTraffic(PINNED_NOT_LOADED, new Date())).toBe('—');
    expect(formatTraffic(ROUTING_GUARD, new Date())).toBe('—');
  });
});

describe('row predicates and the row action', () => {
  it('flags problems: failed, unmatched, pinned-not-loaded', () => {
    expect(isProblemModel(FAILED_RNNOISE_LIKE)).toBe(true);
    expect(isProblemModel(UNMATCHED_GEMMA)).toBe(true);
    expect(isProblemModel(PINNED_NOT_LOADED)).toBe(true);
    expect(isProblemModel(LIVE_WHISPER)).toBe(false);
    expect(isProblemModel(REMOTE_SARVAM)).toBe(false);
  });

  it('flags the live path', () => {
    expect(isLivePathModel(LIVE_WHISPER)).toBe(true);
    expect(isLivePathModel(ROUTING_GUARD)).toBe(false);
  });

  it('picks Load…/Unload…/Link…/Reload…, and nothing for remote, built-in or read-only', () => {
    expect(rowActionFor(STT, PINNED_NOT_LOADED)).toBe('load');
    expect(rowActionFor(STT, LIVE_WHISPER)).toBe('unload');
    expect(rowActionFor(LMS, UNMATCHED_GEMMA)).toBe('link');
    expect(rowActionFor(STT, REMOTE_SARVAM)).toBeNull();
    expect(rowActionFor(STT, BUILTIN_RNNOISE)).toBeNull();
    expect(rowActionFor(WORKER, LIVE_WHISPER)).toBeNull();
    expect(rowActionFor(LMS, { ...ROUTING_GUARD, actions: ['reload', 'edit_policy'] })).toBe('reload');
  });
});

describe('deriveAttentionItems — risk-ordered (artboard 01)', () => {
  it('is empty when nothing needs attention', () => {
    const calm = makeCatalogue({ services: [makeService({ models: [LIVE_WHISPER, REMOTE_SARVAM] })] });
    expect(deriveAttentionItems(calm)).toEqual([]);
  });

  it('orders over-headroom GPUs, then unmatched instances, then pinned models that are not loaded', () => {
    const over = makeDevice({ overHeadroom: true, freeBytes: 26 * 1024 ** 2, headroomBytes: 2.4 * GiB, unattributedBytes: 5.8 * GiB });
    const items = deriveAttentionItems(makeCatalogue({ devices: [over], services: [STT, LMS] }));

    expect(items.map((item) => item.kind)).toEqual(['over_headroom', 'mismatch', 'live_path_not_loaded']);
    expect(items[0]).toMatchObject({ severity: 'critical', tag: 'Critical' });
    expect(items[0]!.title).toBe('GPU 0 is past its headroom — 26 MB free, 2.4 GB should stay free');
    expect(items[0]!.body).toMatch(/5\.8 GB on this card is not attributed to any model/);

    expect(items[1]).toMatchObject({ tag: 'Mismatch', service: LMS, model: UNMATCHED_GEMMA });
    expect(items[1]!.title).toBe('Language models (LM Studio) is running gemma-4-e2b-it-qat@q4_0, which no catalogue model claims');
    expect(items[1]!.body).toMatch(/Gemma 4 E2B IT QAT/);

    expect(items[2]).toMatchObject({ tag: 'Live path', service: STT, model: PINNED_NOT_LOADED });
    expect(items[2]!.title).toBe('Whisper Large Code-Switch is pinned but not loaded');
  });

  it('ignores remote and built-in rows even when pinned', () => {
    const pinnedRemote = { ...REMOTE_SARVAM, keepPolicy: { ...LIVE_WHISPER.keepPolicy } };
    expect(deriveAttentionItems(makeCatalogue({ services: [makeService({ models: [pinnedRemote] })] }))).toEqual([]);
  });

  it('a pinned model whose load failed is also flagged', () => {
    const failedPinned = { ...PINNED_NOT_LOADED, status: 'failed' as const };
    const items = deriveAttentionItems(makeCatalogue({ services: [makeService({ models: [failedPinned] })] }));
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Whisper Large Code-Switch is pinned but its last load failed');
  });
});
