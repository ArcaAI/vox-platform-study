/**
 * TASK-792 W5 (M-9) — the quality-signal thresholds are GOVERNED, not literals.
 *
 * `APPROVED_CLEAN_MAX_RATIO` / `HEAVILY_EDITED_MIN_RATIO` decide the training-label
 * taxonomy: which encounters become "imitate this" few-shot exemplars and which
 * become "this was reworked" evidence. Per rule 00 (`00-project-context.md`
 * §Configuration Principles) a threshold is config, never a TS literal — and it
 * stopped being moot the moment W1 gave the pipeline a live writer.
 *
 * Resolution goes through `EffectiveSettingsService`, the same governed read the
 * sibling `agentic.fewshot.curationMode` uses, so a `PUT /admin/settings/registry/:key`
 * retunes the taxonomy with no redeploy.
 *
 * Two safety properties beyond "it reads the setting":
 *
 *  * **Degrade to the code defaults, never to an unlabelled corpus.** An
 *    unresolved threshold must reproduce today's behaviour exactly — these are
 *    tuning knobs (`failMode: 'open-to-default'`), not a selection.
 *  * **Reject an INVERTED band.** `clean > heavy` would make every ratio match
 *    both arms, silently relabelling the whole corpus. A nonsensical pair is
 *    refused in favour of the defaults rather than trusted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GateEditMiningService } from '../gate-edit-mining.service';
import {
  AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_DEFAULT,
  AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY,
  AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_DEFAULT,
  AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY,
  GATE_EDIT_QUALITY_THRESHOLD_SETTINGS,
} from '../gate-edit-mining.settings';

const TENANT = 'tenant-1';

const repository = {
  create: vi.fn(async (entity: unknown) => entity),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
  findByConsultation: vi.fn(),
  findTopForRetrieval: vi.fn(),
  findForCorpusExport: vi.fn(),
};

const cls = {
  get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : k === 'user' ? { id: 'user-1' } : undefined)),
  set: vi.fn(),
  run: vi.fn(async (cb: () => unknown) => cb()),
};

const redactor = { redact: vi.fn(async (text: string) => `[REDACTED] ${text}`) };

/** An EffectiveSettingsService double returning the supplied key→value map. */
function settings(values: Record<string, unknown>, opts: { throws?: boolean } = {}) {
  return {
    resolveEffective: vi.fn(async (key: string) => {
      if (opts.throws) throw new Error('settings backend down');
      if (!(key in values)) throw new Error(`no value for ${key}`);
      return { key, value: values[key], tier: 'global-kv', sourceScope: 'system' };
    }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildService(effectiveSettings?: any) {
  return new GateEditMiningService(repository as never, { emit: vi.fn() } as never, cls as never, redactor as never, effectiveSettings as never);
}

/**
 * A candidate whose delivered→signed edit ratio is 1/14 ≈ 0.071 — one changed
 * word in a fourteen-word note. That sits inside the DEFAULT ambiguous band
 * (0.05 .. 0.3), so it is NOT mined under the code defaults. Any label it
 * acquires therefore proves a governed threshold was actually applied.
 */
const midBandCandidate = () => ({
  tenantId: TENANT,
  consultationId: 'consultation-1',
  departmentId: 'dept-1',
  gateDecision: 'SIGNED',
  deliveredContent: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen',
  signedContent: 'one two three four five six seven eight nine ten eleven twelve thirteen CHANGED',
  deliveredAt: '2026-07-20T10:00:00.000Z',
  signedAt: '2026-07-20T10:04:00.000Z',
});

const createdSignal = () => (repository.create.mock.calls[0][0] as { qualitySignal: string }).qualitySignal;

describe('GateEditMiningService — governed quality-signal thresholds (W5 / M-9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.findByConsultation.mockResolvedValue(null);
  });

  it('registers both thresholds as governed settings descriptors', () => {
    const keys = GATE_EDIT_QUALITY_THRESHOLD_SETTINGS.map((d) => d.key);
    expect(keys).toContain(AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY);
    expect(keys).toContain(AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY);

    for (const key of [AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY, AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY]) {
      const descriptor = GATE_EDIT_QUALITY_THRESHOLD_SETTINGS.find((d) => d.key === key)!;
      expect(descriptor.dataType).toBe('number');
      // A tuning knob: an unresolved value degrades to the code default rather
      // than raising. Selection keys are the fail-closed ones, not these.
      expect(descriptor.failMode).toBe('open-to-default');
    }
  });

  it('keeps the documented code defaults (0.05 / 0.3) as the descriptor defaults', () => {
    expect(AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_DEFAULT).toBe(0.05);
    expect(AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_DEFAULT).toBe(0.3);
  });

  it('resolves both thresholds for the CANDIDATE tenant, not an ambient one', async () => {
    const effective = settings({
      [AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY]: 0.05,
      [AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY]: 0.3,
    });

    await buildService(effective).mineFromGateDecision(midBandCandidate());

    for (const key of [AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY, AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY]) {
      expect(effective.resolveEffective).toHaveBeenCalledWith(key, expect.objectContaining({ tenantId: TENANT }));
    }
  });

  it('a widened clean threshold relabels a mid-band edit as APPROVED_CLEAN', async () => {
    // 0.2 > the ~0.071 actual ratio, so the note now reads as accepted-as-written.
    const effective = settings({
      [AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY]: 0.2,
      [AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY]: 0.3,
    });

    await buildService(effective).mineFromGateDecision(midBandCandidate());

    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(createdSignal()).toBe('APPROVED_CLEAN');
  });

  it('a lowered heavy threshold relabels the same edit as HEAVILY_EDITED', async () => {
    // 0.06 < the ~0.071 actual ratio, so the same note now reads as reworked.
    const effective = settings({
      [AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY]: 0.01,
      [AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY]: 0.06,
    });

    await buildService(effective).mineFromGateDecision(midBandCandidate());

    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(createdSignal()).toBe('HEAVILY_EDITED');
  });

  it('degrades to the code defaults when the settings backend fails (mid-band stays unmined)', async () => {
    await buildService(settings({}, { throws: true })).mineFromGateDecision(midBandCandidate());

    // Default band 0.05..0.3 excludes ~0.071 — the ambiguous middle is deliberately not mined.
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('degrades to the code defaults when no settings service is wired at all', async () => {
    await buildService(undefined).mineFromGateDecision(midBandCandidate());

    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses an INVERTED band and falls back to the defaults', async () => {
    // clean(0.9) > heavy(0.1): every ratio would satisfy both arms, silently
    // relabelling the entire corpus by whichever branch is tested first.
    const effective = settings({
      [AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY]: 0.9,
      [AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY]: 0.1,
    });

    await buildService(effective).mineFromGateDecision(midBandCandidate());

    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses a non-numeric or out-of-range threshold and falls back to the defaults', async () => {
    const effective = settings({
      [AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY]: 'not-a-number',
      [AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY]: 42,
    });

    await buildService(effective).mineFromGateDecision(midBandCandidate());

    expect(repository.create).not.toHaveBeenCalled();
  });
});
