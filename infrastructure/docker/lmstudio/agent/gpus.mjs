// =============================================================================
// Per-GPU memory, read from nvidia-smi (TASK-1055 E7/E8)
// =============================================================================
// The gateway used to divide ONE device-summed DCGM delta across the cards by
// their current used ratio — which put Granite at ~100 MB + ~78 MB when it held
// ~3.0 + 3.7 GB. The agent sits in the pod, next to the cards, so it measures
// each card's own `memory.used` before and after its own (serialised) load.
//
// `index` here is NVML's, i.e. PCI bus order among the cards this container
// sees. The `cuda:<n>` ids the agent reports are built from it, so they mean
// the same card as LM Studio's gpuSplit index ONLY when the daemon's CUDA
// runtime enumerates in PCI order — which is why entrypoint.sh exports
// CUDA_DEVICE_ORDER=PCI_BUS_ID before starting the daemon (E13, README).
// =============================================================================
import { execFile } from 'node:child_process';

export const MIB = 1024 * 1024;

export const NVIDIA_SMI_ARGS = Object.freeze([
  // `name` LAST: it is the only field that could ever carry a comma.
  '--query-gpu=index,uuid,memory.used,memory.free,memory.total,name',
  '--format=csv,noheader,nounits',
]);

const mibToBytes = (raw) => {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && raw.trim() !== '' ? Math.round(value * MIB) : undefined;
};

/**
 * Parse `nvidia-smi` CSV. Anything that is not a full, well-formed list is
 * `null` ("unknown") — a partial list would make a missing card look free.
 *
 * @returns {Array<{index, uuid, name, usedBytes, freeBytes, totalBytes}> | null}
 */
export function parseNvidiaSmi(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return null;
  const gpus = [];
  for (const line of lines) {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 6) return null;
    const [rawIndex, uuid, used, free, total, ...nameParts] = parts;
    const index = Number(rawIndex);
    const usedBytes = mibToBytes(used);
    const freeBytes = mibToBytes(free);
    const totalBytes = mibToBytes(total);
    if (!/^\d+$/.test(rawIndex) || usedBytes === undefined || freeBytes === undefined || totalBytes === undefined) {
      return null;
    }
    gpus.push({ index, uuid, name: nameParts.join(', '), usedBytes, freeBytes, totalBytes });
  }
  return gpus;
}

/** The default exec: `nvidia-smi` with a 10 s bound (a wedged driver must not hang a request). */
export const execNvidiaSmi = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 10_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

/** One reading of every visible GPU, or `null` when nvidia-smi is absent or failed. */
export async function readGpus(exec = execNvidiaSmi) {
  try {
    return parseNvidiaSmi(await exec('nvidia-smi', [...NVIDIA_SMI_ARGS]));
  } catch {
    return null;
  }
}

/**
 * Per-card growth between two readings, keyed `cuda:<index>`. Only cards that
 * grew by MORE than `noiseBytes` are attributed: memory.used is device-wide, so
 * a card-mate's allocator jitter must not be booked to this load.
 */
export function deviceDeltas(before, after, noiseBytes) {
  if (!Array.isArray(before) || !Array.isArray(after)) return {};
  const baseline = new Map(before.map((gpu) => [gpu.index, gpu.usedBytes]));
  const deltas = {};
  for (const gpu of after) {
    if (!baseline.has(gpu.index)) continue;
    const grown = gpu.usedBytes - baseline.get(gpu.index);
    if (grown > noiseBytes) deltas[`cuda:${gpu.index}`] = grown;
  }
  return deltas;
}

/**
 * Read until two consecutive readings agree within `toleranceBytes` on every
 * card, or until `maxWaitMs` of sleeping has elapsed. A load's allocations keep
 * landing for a moment after the channel reports success (KV cache, CUDA
 * context), so a single reading straight after it under-counts.
 *
 * Time is counted in requested sleeps, not wall clock, so the rule is testable.
 */
export async function measureSettled({ read, sleep, intervalMs, toleranceBytes, maxWaitMs }) {
  let previous = await read();
  if (previous === null) return null;
  let waited = 0;
  while (waited < maxWaitMs) {
    await sleep(intervalMs);
    waited += intervalMs;
    const current = await read();
    if (current === null) return previous;
    const stable =
      current.length === previous.length &&
      current.every((gpu, i) => Math.abs(gpu.usedBytes - previous[i].usedBytes) <= toleranceBytes);
    previous = current;
    if (stable) return current;
  }
  return previous;
}
