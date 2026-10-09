import { describe, expect, it } from 'vitest';
import { type JudgedPlacement, type PlacementOption, type PlacementReading, judgePlacement, rankPlacements } from '../residency-placement';

/**
 * TASK-1055 review — the pure placement helpers: R1-F1 (the default target leads while it fits;
 * a single card beats `multi`; `multi` only when no single card fits) and R2-F5 (a split is judged
 * PER CARD, by its ratio).
 */
const MiB = 1024 * 1024;
const CARD = 16_000 * MiB;

const reading = (id: string, freeMib: number): PlacementReading => ({
  id,
  kind: 'gpu',
  totalBytes: CARD,
  freeBytes: freeMib * MiB,
  usedBytes: CARD - freeMib * MiB,
});
const gpu = (n: number): PlacementOption => ({ device: `gpu${n}`, physical: [`gpu${n}`], agentDevice: `cuda:${n}`, order: n });
const multi = (weights?: Record<string, number>): PlacementOption => ({
  device: 'multi',
  physical: ['gpu0', 'gpu1'],
  agentDevice: null,
  order: 1_000,
  ...(weights ? { weights } : {}),
});

// headroom 10 % of 16 000 MiB = 1 600 MiB per card
const judge = (option: PlacementOption, free: Record<string, number>, needMib: number | null, livePathModels = 0): JudgedPlacement =>
  judgePlacement({
    option,
    readings: option.physical.map((id) => reading(id, free[id])),
    needBytes: needMib === null ? null : needMib * MiB,
    creditBytes: 0,
    headroomPercent: 10,
    livePathModels,
    evictable: [],
  });

describe('rankPlacements (R1-F1)', () => {
  it('the preferred (default) target leads whenever it fits', () => {
    const free = { gpu0: 5_000, gpu1: 12_000 };
    const ranked = rankPlacements([judge(gpu(0), free, 2_000), judge(gpu(1), free, 2_000)], 'gpu0');
    expect(ranked.map((c) => c.device)).toEqual(['gpu0', 'gpu1']);
  });

  it('a preferred target that does not fit does not lead', () => {
    const free = { gpu0: 2_000, gpu1: 12_000 };
    const ranked = rankPlacements([judge(gpu(0), free, 2_000), judge(gpu(1), free, 2_000)], 'gpu0');
    expect(ranked[0].device).toBe('gpu1');
  });

  it('a fitting single card ranks before a fitting `multi` with more remaining', () => {
    const free = { gpu0: 6_000, gpu1: 7_000 };
    const ranked = rankPlacements([judge(gpu(0), free, 5_000), judge(gpu(1), free, 5_000), judge(multi(), free, 5_000)]);
    expect(ranked.map((c) => [c.device, c.fits])).toEqual([
      ['gpu1', true],
      ['multi', true],
      ['gpu0', false],
    ]);
  });

  it('a preferred `multi` (the profile split) leads while it fits', () => {
    const free = { gpu0: 6_000, gpu1: 7_000 };
    const ranked = rankPlacements([judge(gpu(0), free, 5_000), judge(gpu(1), free, 5_000), judge(multi(), free, 5_000)], 'multi');
    expect(ranked[0].device).toBe('multi');
  });

  it('when nothing fits, a single card is still offered before `multi`', () => {
    const free = { gpu0: 3_000, gpu1: 3_000 };
    const ranked = rankPlacements([judge(multi(), free, 6_000), judge(gpu(0), free, 6_000), judge(gpu(1), free, 6_000)]);
    expect(ranked.map((c) => c.device)).toEqual(['gpu0', 'gpu1', 'multi']);
  });

  it('ties among non-preferred fits: most remaining → fewer live-path models → lower index', () => {
    const free = { gpu0: 10_000, gpu1: 10_000 };
    const ranked = rankPlacements([judge(gpu(0), free, 1_000, 2), judge(gpu(1), free, 1_000, 0)]);
    expect(ranked.map((c) => c.device)).toEqual(['gpu1', 'gpu0']);
  });
});

describe('judgePlacement for a split (R2-F5)', () => {
  it('an even split fits only when every card holds its share', () => {
    // rooms: gpu0 1 000, gpu1 10 400 — pooled 11 400 ≥ 4 000, but gpu0 cannot hold its 2 000.
    const short = judge(multi(), { gpu0: 2_600, gpu1: 12_000 }, 4_000);
    expect(short).toMatchObject({ fits: false, shortfallBytes: 1_000 * MiB, exceedsDevice: false });

    const ok = judge(multi(), { gpu0: 4_000, gpu1: 12_000 }, 4_000);
    expect(ok).toMatchObject({ fits: true, shortfallBytes: 0, remainingBytes: (2_400 + 10_400 - 4_000) * MiB });
  });

  it('a share larger than a card`s free memory is exceedsDevice', () => {
    expect(judge(multi(), { gpu0: 1_500, gpu1: 12_000 }, 4_000).exceedsDevice).toBe(true);
  });

  it('a custom ratio scales each card`s share', () => {
    // 1:3 of 4 000 → 1 000 on gpu0 (room 1 400: fits), 3 000 on gpu1 (room 2 400: 600 short).
    const judged = judge(multi({ gpu0: 0.25, gpu1: 0.75 }), { gpu0: 3_000, gpu1: 4_000 }, 4_000);
    expect(judged).toMatchObject({ fits: false, shortfallBytes: 600 * MiB });
  });
});
