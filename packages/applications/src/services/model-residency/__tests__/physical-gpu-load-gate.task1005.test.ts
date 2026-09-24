import { describe, expect, it } from 'vitest';
import { PhysicalGpuLoadGate } from '../physical-gpu-load-gate';

/**
 * TASK-1005 — at most ONE load in flight per PHYSICAL GPU, across every service.
 *
 * Measurement cannot see other pods on a time-sliced card: a footprint is the
 * device free-memory delta around ONE load, and it is only attributable if no
 * other load moved memory on that card at the same time. LM Studio splits a
 * model across both cards, so its load holds both.
 */
describe('PhysicalGpuLoadGate', () => {
  it('an LM Studio load (both cards) blocks an stt load on either card until it is released', () => {
    const gate = new PhysicalGpuLoadGate();

    expect(gate.tryAcquire(['gpu0', 'gpu1'], 'op-lms')).toBe(true);
    expect(gate.tryAcquire(['gpu0'], 'op-stt')).toBe(false);
    expect(gate.tryAcquire(['gpu1'], 'op-stt')).toBe(false);
    expect(gate.holderOf('gpu1')).toBe('op-lms');

    gate.release('op-lms');
    expect(gate.tryAcquire(['gpu0'], 'op-stt')).toBe(true);
  });

  it('is all-or-nothing: a partially held set claims NOTHING', () => {
    const gate = new PhysicalGpuLoadGate();
    expect(gate.tryAcquire(['gpu1'], 'op-a')).toBe(true);
    expect(gate.tryAcquire(['gpu0', 'gpu1'], 'op-b')).toBe(false);
    // gpu0 was not left claimed by the refused op-b.
    expect(gate.tryAcquire(['gpu0'], 'op-c')).toBe(true);
  });

  it('loads on different cards proceed concurrently', () => {
    const gate = new PhysicalGpuLoadGate();
    expect(gate.tryAcquire(['gpu0'], 'op-a')).toBe(true);
    expect(gate.tryAcquire(['gpu1'], 'op-b')).toBe(true);
  });

  it('does not gate a host-CPU pool (nlp measures its own RSS delta and serialises itself)', () => {
    const gate = new PhysicalGpuLoadGate();
    expect(gate.tryAcquire(['cpu:nlp'], 'op-a')).toBe(true);
    expect(gate.tryAcquire(['cpu:nlp'], 'op-b')).toBe(true);
  });

  it('waitAcquire gives up after the bound and claims nothing', async () => {
    const gate = new PhysicalGpuLoadGate();
    gate.tryAcquire(['gpu0'], 'op-a');
    await expect(gate.waitAcquire(['gpu0'], 'op-b', 60, 10)).resolves.toBe(false);
    gate.release('op-a');
    await expect(gate.waitAcquire(['gpu0'], 'op-b', 60, 10)).resolves.toBe(true);
  });
});
