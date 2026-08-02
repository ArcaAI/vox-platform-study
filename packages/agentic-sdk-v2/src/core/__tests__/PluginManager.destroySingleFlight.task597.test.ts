/**
 * PluginManager — single-flight destroy (TASK-597 follow-up).
 *
 * The compat layer stops ONE audio graph through TWO hooks, each with its own
 * per-instance stop guard, so BOTH stop paths reach this shared manager.
 * Before the single-flight guard, the two concurrent `destroy()` passes raced
 * each other through the same streaming transport, and the loser waited out
 * the full `drainTimeoutMs` ceiling (measured 60.9 s in a real browser with a
 * 60 s ceiling) while the consumer UI stayed pinned in its "stopping" phase.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { PluginManager } from '../PluginManager';

describe('PluginManager.destroy — single flight (TASK-597)', () => {
  it('concurrent destroy() calls share ONE teardown pass', async () => {
    const manager = new PluginManager({});
    let release!: () => void;
    const pipelineDestroy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    (manager as any).transcriptionPipeline = { destroy: pipelineDestroy };
    (manager as any)._initialized = true;

    const first = manager.destroy();
    const second = manager.destroy();

    // The duplicate caller JOINS the in-flight teardown — the pipeline (and
    // therefore the streaming drain behind it) is torn down exactly once.
    expect(pipelineDestroy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    release();
    await Promise.all([first, second]);
    expect(manager.initialized).toBe(false);
  });

  it('a destroy AFTER the previous one settled runs its own pass', async () => {
    const manager = new PluginManager({});
    const mkPipeline = () => ({ destroy: vi.fn().mockResolvedValue(undefined) });

    const p1 = mkPipeline();
    (manager as any).transcriptionPipeline = p1;
    await manager.destroy();
    expect(p1.destroy).toHaveBeenCalledTimes(1);

    const p2 = mkPipeline();
    (manager as any).transcriptionPipeline = p2;
    await manager.destroy();
    expect(p2.destroy).toHaveBeenCalledTimes(1);
  });
});
