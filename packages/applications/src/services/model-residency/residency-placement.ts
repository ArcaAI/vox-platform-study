import type { EffectiveLmStudioPreload } from '../effective-config/IEffectiveConfigService';
import type { ModelResidencyPlacementCandidate, ModelResidencyPreviewModel } from './dto';

/**
 * TASK-1055 — GPU choice and capacity advice (ticket §3.2 / §3.3), as pure functions the
 * controller's `load` and `previewLoad` share, so the suggestion an admin sees is the one the
 * server refuses with.
 *
 * Two device vocabularies meet here (`tests/contracts/model-residency-task1055.fixture.json` →
 * `deviceIds`): the gateway/console speak `gpu<N>` (DCGM's `gpu` label, PCI order), `multi`
 * (LM Studio split across cards) and `cpu`; an agent speaks `cuda:<n>` / `cpu`. The mapping is
 * the controller's (by card UUID, else index); these helpers only ever see gateway ids plus the
 * agent id an option sends.
 */

const GiB = 1024 * 1024 * 1024;

/** A device's memory as admission reads it (a DCGM card or a host pool). */
export interface PlacementReading {
  id: string;
  kind: 'gpu' | 'cpu';
  name?: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

/** One place a load can go: what the admin picks (`device`), what the gate claims (`physical`), what the agent is told. */
export interface PlacementOption {
  /** Request vocabulary: `gpu<N>`, `multi`, `cpu`. */
  device: string;
  /** Ledger device ids the load occupies (`gpu<N>` cards, or `cpu:<service>`). */
  physical: string[];
  /** The agent's device id (`cuda:<n>`, `cpu`); `null` = send none (LM Studio `multi`, or the service's own default). */
  agentDevice: string | null;
  /** LM Studio only — the engine's GPU indices this option places the model on. */
  lmsIndices?: number[];
  /** The tie-break index: a GPU's number; `multi` and `cpu` sort after every card. */
  order: number;
  /**
   * A split's share per card (`physical` id → fraction, summing to 1): a `custom` profile ratio.
   * Absent = an even split across `physical` (`evenly`, and — conservatively — any other strategy).
   */
  weights?: Record<string, number>;
}

export interface JudgeInput {
  option: PlacementOption;
  readings: PlacementReading[];
  /** What admission reserves; `null` = no size known. */
  needBytes: number | null;
  /** Bytes a replace returns on these devices before it loads. */
  creditBytes: number;
  /** A split's credit per card (`physical` id → bytes); absent = `creditBytes` shared by the split's weights. */
  creditByDevice?: Record<string, number>;
  headroomPercent: number;
  livePathModels: number;
  evictable: ModelResidencyPreviewModel[];
}

export type JudgedPlacement = ModelResidencyPlacementCandidate & { order: number };

const headroomOf = (r: PlacementReading, percent: number): number => Math.floor((r.totalBytes * percent) / 100);

/**
 * Judge one option. A single device is unclamped (`free − headroom − need`, negative = short), the
 * fixture's arithmetic. A split (`multi`, or a profile spanning several cards) is judged PER CARD
 * (TASK-1055 review R2-F5): each card must hold its share (`need × weight`) above its own headroom —
 * a split is only as good as its tightest card, however much room the others pool. `remainingBytes`
 * is the sum of the cards' spare room when every card fits, else minus the summed shortfall, so
 * `fits ⇔ remainingBytes ≥ 0 ⇔ shortfallBytes = 0` holds for both shapes. `exceedsDevice` = some
 * card's share is larger than that card's FREE memory outright (headroom ignored): even a forced
 * load would OOM its card-mates (OD-5).
 */
export function judgePlacement(input: JudgeInput): JudgedPlacement {
  const { option, readings, needBytes, creditBytes, headroomPercent } = input;
  const known = readings.length > 0;
  const sum = (f: (r: PlacementReading) => number) => readings.reduce((total, r) => total + f(r), 0);
  const freeBytes = known ? sum((r) => r.freeBytes) : null;
  const headroomBytes = known ? sum((r) => headroomOf(r, headroomPercent)) : null;
  const totalBytes = known ? sum((r) => r.totalBytes) : null;

  let remainingBytes: number | null;
  let shortfallBytes: number;
  let exceedsDevice: boolean;
  if (needBytes === null || !known) {
    remainingBytes = null;
    shortfallBytes = needBytes === null ? 0 : Math.round(needBytes);
    exceedsDevice = false;
  } else if (readings.length === 1) {
    const [r] = readings;
    const available = r.freeBytes - headroomOf(r, headroomPercent) + creditBytes;
    remainingBytes = Math.round(available - needBytes);
    shortfallBytes = Math.max(0, Math.round(needBytes - available));
    exceedsDevice = needBytes > r.freeBytes + creditBytes;
  } else {
    const weights = splitWeights(option, readings);
    let spare = 0;
    let short = 0;
    exceedsDevice = false;
    for (const r of readings) {
      const weight = weights[r.id] ?? 0;
      const share = needBytes * weight;
      const credit = input.creditByDevice?.[r.id] ?? creditBytes * weight;
      const left = r.freeBytes - headroomOf(r, headroomPercent) + credit - share;
      if (left >= 0) spare += left;
      else short += -left;
      if (share > r.freeBytes + credit) exceedsDevice = true;
    }
    shortfallBytes = Math.round(short);
    remainingBytes = shortfallBytes > 0 ? -shortfallBytes : Math.round(spare);
  }
  return {
    device: option.device,
    label: placementLabel(option.device, readings),
    totalBytes,
    freeBytes,
    headroomBytes,
    remainingBytes,
    shortfallBytes,
    fits: remainingBytes !== null && remainingBytes >= 0,
    exceedsDevice,
    livePathModels: input.livePathModels,
    evictable: input.evictable,
    order: option.order,
  };
}

/** A split's per-card fractions over the cards it has readings for (the option's `weights`, else even), normalised to 1. */
function splitWeights(option: PlacementOption, readings: PlacementReading[]): Record<string, number> {
  const raw = readings.map((r) => [r.id, option.weights ? Math.max(0, option.weights[r.id] ?? 0) : 1] as const);
  const total = raw.reduce((t, [, w]) => t + w, 0);
  if (total <= 0) return Object.fromEntries(readings.map((r) => [r.id, 1 / readings.length]));
  return Object.fromEntries(raw.map(([id, w]) => [id, w / total]));
}

/**
 * The suggestion order (TASK-1055 review R1-F1 — the suggestion never flips a model off its own
 * placement):
 *  1. `preferred` — where the load goes with no device named (the model's default device, its
 *     profile, else the service's own placement) — leads whenever it FITS;
 *  2. then the other fitting options, a single card before a split (`multi` is only suggested when
 *     no single card fits and the split does): most `remainingBytes`, ties → fewer live-path
 *     models → lower index;
 *  3. then the options that do not fit, single cards first again: smallest `shortfallBytes`, same
 *     tie-breaks (a model with no known size ranks by free memory above headroom).
 */
export function rankPlacements(candidates: JudgedPlacement[], preferred: string | null = null): JudgedPlacement[] {
  const tieBreak = (a: JudgedPlacement, b: JudgedPlacement) => a.livePathModels - b.livePathModels || a.order - b.order;
  const room = (c: JudgedPlacement) => (c.freeBytes ?? 0) - (c.headroomBytes ?? 0);
  const isSplit = (c: JudgedPlacement) => (c.device === 'multi' ? 1 : 0);
  const leads = (c: JudgedPlacement) => (c.fits && c.device === preferred ? 0 : 1);
  return [...candidates].sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    if (leads(a) !== leads(b)) return leads(a) - leads(b);
    if (isSplit(a) !== isSplit(b)) return isSplit(a) - isSplit(b);
    if (a.remainingBytes === null || b.remainingBytes === null) return room(b) - room(a) || tieBreak(a, b);
    if (a.fits) return b.remainingBytes - a.remainingBytes || tieBreak(a, b);
    return a.shortfallBytes - b.shortfallBytes || tieBreak(a, b);
  });
}

/** One sentence naming the best device and why — `GPU 1 has 10.0 GB free above headroom; GPU 0 is 1.7 GB short.` */
export function suggestionReasonFor(ranked: JudgedPlacement[]): string | null {
  const [best, ...rest] = ranked;
  if (!best) return null;
  if (best.remainingBytes === null) {
    const room = Math.max(0, (best.freeBytes ?? 0) - (best.headroomBytes ?? 0));
    return `The model's size is unknown; ${shortLabel(best.device)} has the most room (${formatGb(room)} free above headroom).`;
  }
  if (best.fits) {
    const short = rest.filter((c) => !c.fits).map((c) => `${shortLabel(c.device)} is ${formatGb(c.shortfallBytes)} short`);
    return [`${shortLabel(best.device)} has ${formatGb(best.remainingBytes)} free above headroom`, ...short].join('; ') + '.';
  }
  const idle = best.evictable.map((m) => m.name);
  return (
    `No device can hold it: ${shortLabel(best.device)} is the closest, ${formatGb(best.shortfallBytes)} short` +
    (idle.length > 0 ? ` — idle models there to unload: ${idle.join(', ')}` : '') +
    '.'
  );
}

/** `10.0 GB` (binary gigabytes, one decimal — the console's unit). */
export function formatGb(bytes: number): string {
  return `${(Math.max(0, bytes) / GiB).toFixed(1)} GB`;
}

/** `GPU 1`, `Split across cards`, `Host memory`. */
export function shortLabel(device: string): string {
  if (/^gpu\d+$/.test(device)) return `GPU ${device.slice(3)}`;
  if (device === 'multi') return 'Split across cards';
  if (device === 'cpu') return 'Host memory';
  return device;
}

/** `GPU 1 · NVIDIA RTX 2000 Ada Generation`, `Split across cards · GPU 0 + GPU 1`, `Host memory`. */
export function placementLabel(device: string, readings: PlacementReading[]): string {
  if (/^gpu\d+$/.test(device)) {
    const name = readings[0]?.name;
    return name ? `${shortLabel(device)} · ${name}` : shortLabel(device);
  }
  if (device === 'multi') return `${shortLabel(device)} · ${readings.map((r) => shortLabel(r.id)).join(' + ')}`;
  return shortLabel(device);
}

// ── LM Studio placement ───────────────────────────────────────────────────────

/** The engine's GPU indices a profile places a model on: the split's enabled cards, else the single `gpu`. */
export function lmStudioProfileIndices(entry: Pick<EffectiveLmStudioPreload, 'gpuSplit' | 'gpu'>, gpuCount: number): number[] {
  const all = [...Array(Math.max(1, gpuCount)).keys()];
  if (!entry.gpuSplit) return entry.gpu !== null && entry.gpu !== undefined ? [entry.gpu] : all;
  const disabled = new Set(entry.gpuSplit.disabledGpus ?? []);
  const enabled = all.filter((i) => !disabled.has(i));
  return enabled.length > 0 ? enabled : all;
}

/** Where an LM Studio load goes: the profile's own placement, one card, or split evenly across every card. */
export type LmStudioPlacement = { kind: 'profile' } | { kind: 'gpu'; index: number } | { kind: 'multi' };

/** The documented REST-free overrides a console "Reload with options" may carry onto the profile. */
export interface LmStudioProfileOverrides {
  contextLength?: number;
  flashAttention?: boolean;
}

/**
 * The LM Studio agent's `load_spec` (`lmStudioAgent.loadRequest.load_spec`): the model's boot-plan
 * entry (`lmStudioPreloadEntryFor`, the SAME resolution the pod's boot loader is served) with
 * `identifier` = the catalogue wire id, the request's overrides on top, and a `gpu_split` that is
 * the profile's own, a single card (`priorityOrder [n]`, every other card disabled — the boot
 * loader's `gpu: n` rule), or `evenly` for "split across cards".
 */
export function lmStudioLoadSpec(
  entry: EffectiveLmStudioPreload,
  identifier: string,
  gpuCount: number,
  overrides: LmStudioProfileOverrides = {},
  placement: LmStudioPlacement = { kind: 'profile' },
  ttlSeconds: number | null = null,
): Record<string, unknown> {
  const all = [...Array(Math.max(1, gpuCount)).keys()];
  const single = (index: number) => ({
    strategy: 'priorityOrder',
    priority: [index],
    disabled_gpus: all.filter((i) => i !== index),
    custom_ratio: [],
  });
  let gpuSplit: Record<string, unknown>;
  if (placement.kind === 'gpu') gpuSplit = single(placement.index);
  else if (placement.kind === 'multi') gpuSplit = { strategy: 'evenly', priority: [], disabled_gpus: [], custom_ratio: [] };
  else if (entry.gpuSplit)
    gpuSplit = {
      strategy: entry.gpuSplit.strategy,
      priority: entry.gpuSplit.priority ?? [],
      disabled_gpus: entry.gpuSplit.disabledGpus ?? [],
      custom_ratio: entry.gpuSplit.customRatio ?? [],
    };
  else gpuSplit = single(entry.gpu ?? 0);
  return {
    identifier,
    context_length: overrides.contextLength ?? entry.contextLength,
    parallel: entry.parallel,
    flash_attention: overrides.flashAttention ?? entry.flashAttention,
    kv_cache_quant: entry.kvCacheQuant,
    gpu_split: gpuSplit,
    ttl_seconds: ttlSeconds,
  };
}

/** The `_metadata.serving.gpuSplit` a "make default" writes for LM Studio (camelCase, the stored profile's shape). */
export function lmStudioDefaultSplit(placement: { kind: 'gpu'; index: number } | { kind: 'multi' }, gpuCount: number): Record<string, unknown> {
  if (placement.kind === 'multi') return { strategy: 'evenly' };
  const all = [...Array(Math.max(1, gpuCount)).keys()];
  return { strategy: 'priorityOrder', priority: [placement.index], disabledGpus: all.filter((i) => i !== placement.index) };
}
