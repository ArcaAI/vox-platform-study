/**
 * TASK-1055 lane C — pure helpers behind per-card bytes (E8), the drawer's
 * action set (E10), and live-path unload (E9 / OD-2).
 */

import { describe, expect, it } from 'vitest';
import {
  deviceShortLabel,
  drawerActions,
  formatModelStatus,
  formatStateWhere,
  liveConsumerLines,
  normalizeDeviceId,
  requiresUnloadReason,
  sameDevice,
  unloadDeviceChoices,
  withMeasuredDeviceBytes,
} from '../residency-display';
import { GiB, LIVE_WHISPER, LMS, makeDevice, makeModel, makeService, ROUTING_GUARD } from './residency-test-data';

const GPU0 = makeDevice();
const GPU1 = makeDevice({
  id: 'gpu1',
  label: 'GPU 1 — NVIDIA RTX 2000 Ada Generation',
  models: [],
  attributedBytes: 0,
  unattributedBytes: 1 * GiB,
  usedBytes: 1 * GiB,
  freeBytes: 15 * GiB,
});

const SPLIT_GRANITE = makeModel({
  ...ROUTING_GUARD,
  residency: {
    ...ROUTING_GUARD.residency!,
    device: 'multi',
    bytes: 6.7 * GiB,
    deviceBytes: [
      { device: 'gpu0', bytes: 3 * GiB },
      { device: 'gpu1', bytes: 3.7 * GiB },
    ],
  },
});

describe('device labels', () => {
  it('names an LM Studio split in words, never "multi"', () => {
    expect(deviceShortLabel('multi', [GPU0, GPU1])).toBe('Split across cards');
    expect(formatModelStatus(SPLIT_GRANITE, [GPU0, GPU1])).not.toMatch(/multi/);
  });
});

describe('per-card bytes on the model row (E8)', () => {
  it('shows each card’s real share for a split model', () => {
    const where = formatStateWhere(SPLIT_GRANITE, [GPU0, GPU1]).where;
    expect(where).toMatch(/GPU 0 3 GB/);
    expect(where).toMatch(/GPU 1 3\.7 GB/);
    expect(where).toMatch(/measured/);
  });

  it('keeps the old wording when no per-card bytes are reported', () => {
    expect(formatStateWhere(LIVE_WHISPER, [GPU0]).where).toBe('GPU 0 · 1.5 GB measured');
  });
});

describe('withMeasuredDeviceBytes (GPU bars)', () => {
  const gpu0 = makeDevice({
    usedBytes: 8 * GiB,
    attributedBytes: 1.6 * GiB,
    unattributedBytes: 6.4 * GiB,
    models: [
      { service: 'lm-studio', modelRef: 'granite-guardian', name: 'Granite Guardian 4.1 8B', bytes: 0.1 * GiB, bytesSource: 'estimated' },
      { service: 'stt', modelRef: 'whisper-ml-en', name: 'ArcaAI Whisper ml-en', bytes: 1.5 * GiB, bytesSource: 'measured' },
    ],
  });
  const lms = makeService({ ...LMS, models: [SPLIT_GRANITE] });

  it('replaces the ratio-split share with the measured per-card bytes and recomputes the unattributed remainder', () => {
    const [d0, d1] = withMeasuredDeviceBytes([gpu0, GPU1], [lms]);
    const granite0 = d0!.models.find((m) => m.modelRef === 'granite-guardian')!;
    expect(granite0).toMatchObject({ bytes: 3 * GiB, bytesSource: 'measured' });
    expect(d0!.attributedBytes).toBeCloseTo(4.5 * GiB);
    expect(d0!.unattributedBytes).toBeCloseTo(3.5 * GiB);
    // A card the server listed nothing on still gets the model's share.
    expect(d1!.models.find((m) => m.modelRef === 'granite-guardian')).toMatchObject({ bytes: 3.7 * GiB, bytesSource: 'measured' });
    expect(d1!.unattributedBytes).toBe(0);
  });

  it('returns devices untouched when no model reports per-card bytes', () => {
    const devices = [gpu0];
    expect(withMeasuredDeviceBytes(devices, [makeService({ ...LMS, models: [ROUTING_GUARD] })])).toBe(devices);
  });
});

describe('drawerActions (E10)', () => {
  it('offers Reload next to Unload for a loaded LM Studio model', () => {
    expect(drawerActions(LMS, makeModel({ ...ROUTING_GUARD, actions: ['unload', 'edit_policy'] }))).toEqual(['unload', 'reload']);
    expect(drawerActions(LMS, ROUTING_GUARD)).toEqual(['unload', 'reload']);
  });

  it('offers only what the row allows elsewhere, and nothing on a service with no control API', () => {
    const stt = makeService();
    expect(drawerActions(stt, LIVE_WHISPER)).toEqual(['unload']);
    expect(drawerActions(stt, makeModel({ actions: ['load'] }))).toEqual(['load']);
    expect(drawerActions(makeService({ controllable: false }), LIVE_WHISPER)).toEqual([]);
  });
});

describe('live-path unload (OD-2)', () => {
  it('needs a reason for a pinned or live-path model only', () => {
    expect(requiresUnloadReason(LIVE_WHISPER)).toBe(true);
    expect(requiresUnloadReason(ROUTING_GUARD)).toBe(false);
  });

  it('names the consumers in words', () => {
    const lines = liveConsumerLines(LIVE_WHISPER);
    expect(lines).toContain('5 agents · 3 tenants');
    expect(lines).toContain('Live consultations');
  });

  it('offers a device choice only for separate copies, never for an LM Studio split', () => {
    const twoCopies = makeModel({
      ...LIVE_WHISPER,
      residency: {
        ...LIVE_WHISPER.residency!,
        deviceBytes: [
          { device: 'gpu0', bytes: GiB },
          { device: 'gpu1', bytes: GiB },
        ],
      },
    });
    expect(unloadDeviceChoices(twoCopies)).toEqual(['gpu0', 'gpu1']);
    expect(unloadDeviceChoices(SPLIT_GRANITE)).toEqual([]);
    expect(unloadDeviceChoices(LIVE_WHISPER)).toEqual([]);
  });
});

describe('device identity — `cpu:<service>` ≡ `cpu` (TASK-1055 R1-F8)', () => {
  it('normalises a catalogue CPU id to the request vocabulary and leaves GPUs alone', () => {
    expect(normalizeDeviceId('cpu:nlp')).toBe('cpu');
    expect(normalizeDeviceId('cpu')).toBe('cpu');
    expect(normalizeDeviceId('gpu1')).toBe('gpu1');
    expect(normalizeDeviceId('multi')).toBe('multi');
    expect(normalizeDeviceId(null)).toBeNull();
  });

  it('matches the two CPU spellings and never matches a missing id', () => {
    expect(sameDevice('cpu:stt', 'cpu')).toBe(true);
    expect(sameDevice('gpu0', 'gpu1')).toBe(false);
    expect(sameDevice(null, null)).toBe(false);
    expect(sameDevice(undefined, 'cpu')).toBe(false);
  });
});
