/**
 * TASK-965 WS-1 (WF-7) — `confirmLeave`, the programmatic-navigation half of the unsaved-changes
 * guard. The click listener covers anchors; every `router.push` in the studio has to ask the same
 * question through this helper, so the answer cannot differ by how the admin left.
 *
 * `window.confirm` is not implemented in this test environment, so it is stubbed per case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmLeave } from '../use-unsaved-changes-guard';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('confirmLeave', () => {
  it('never prompts when there is nothing to lose', () => {
    const confirm = vi.fn();
    vi.stubGlobal('confirm', confirm);
    expect(confirmLeave(false)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('prompts when the buffer is dirty and returns the admin’s answer', () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    expect(confirmLeave(true)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/unsaved changes/i));

    confirm.mockReturnValue(true);
    expect(confirmLeave(true)).toBe(true);
  });
});
