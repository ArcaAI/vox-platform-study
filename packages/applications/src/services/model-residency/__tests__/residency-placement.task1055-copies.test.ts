import { describe, expect, it } from 'vitest';
import { type JudgedPlacement, type PlacementOption, formatGb, judgePlacement, rankPlacements, suggestionReasonFor } from '../residency-placement';

/**
 * TASK-1055 §8b D3 — the suggestion sentence quotes EXACTLY the numbers of the candidates it names:
 * the closest card's `shortfallBytes`, the best card's `remainingBytes`, each other card's shortfall —
 * through the one formatter (binary GB, one decimal: the console's unit), never a recomputed figure.
 */
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const CARD = 17_175_674_880;

const gpu = (n: number): PlacementOption => ({ device: `gpu${n}`, physical: [`gpu${n}`], agentDevice: `cuda:${n}`, order: n });
const multi: PlacementOption = { device: 'multi', physical: ['gpu0', 'gpu1'], agentDevice: null, order: 1_000 };

function judge(option: PlacementOption, free: Record<string, number>, needBytes: number, creditBytes = 0): JudgedPlacement {
  return judgePlacement({
    option,
    readings: option.physical.map((id) => ({ id, kind: 'gpu' as const, totalBytes: CARD, freeBytes: free[id], usedBytes: CARD - free[id] })),
    needBytes,
    creditBytes,
    headroomPercent: 15,
    livePathModels: 0,
    evictable: [],
  });
}

const gb = (bytes: number) => `${(bytes / GiB).toFixed(1)} GB`;

describe('D3 — the reason uses the candidates` own numbers', () => {
  it('the cluster case: Granite reload at 8× context (need ≈ 40.9 GB) — "closest, N short" is that candidate`s shortfallBytes', () => {
    // gpu0 holds Granite (6.78 GB, credited on a replace); gpu1 holds Gemma.
    const free = { gpu0: 1_843 * MiB, gpu1: 13_830 * MiB };
    const need = 40.9 * GiB;
    const ranked = rankPlacements([judge(gpu(0), free, need, 6.78 * GiB), judge(gpu(1), free, need), judge(multi, free, need)], 'gpu0');
    const closest = ranked[0];
    expect(ranked.every((c) => !c.fits)).toBe(true);

    const reason = suggestionReasonFor(ranked)!;

    expect(reason).toBe(`No device can hold it: GPU ${closest.device.slice(3)} is the closest, ${formatGb(closest.shortfallBytes)} short.`);
    expect(reason).toContain(`${gb(closest.shortfallBytes)} short`);
  });

  it('the fits case: the best card`s remainingBytes and every other card`s shortfallBytes, verbatim', () => {
    const free = { gpu0: 3_000 * MiB, gpu1: 13_830 * MiB };
    const need = 2_500 * MiB;
    const ranked = rankPlacements([judge(gpu(0), free, need), judge(gpu(1), free, need)]);
    const [best, other] = ranked;
    expect([best.fits, other.fits]).toEqual([true, false]);

    expect(suggestionReasonFor(ranked)).toBe(
      `GPU 1 has ${gb(best.remainingBytes!)} free above headroom; GPU 0 is ${gb(other.shortfallBytes)} short.`,
    );
  });

  it('formatGb is the binary-GB, one-decimal rendering of the exact byte count', () => {
    expect(formatGb(28_550_000_000)).toBe('26.6 GB'); // 28.55 × 10⁹ bytes = 26.59 GiB — the §8b reading
    expect(formatGb(1.75 * GiB)).toBe('1.8 GB');
  });
});
