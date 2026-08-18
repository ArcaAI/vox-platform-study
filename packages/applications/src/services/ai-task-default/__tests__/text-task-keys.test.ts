/**
 * TASK-740 — the `smr` identifier is eliminated from the AiTaskDefault task-key
 * plane.
 *
 * Owner directive 2026-08-17 (`owner-decisions-2026-08-17.md` §3b decision 3):
 * "`smr` was renamed to `text`. Do NOT use `smr` anymore!" — which REVERSES the
 * frozen-identifier position TASK-707 took on the DB-persisted keys.
 *
 * These are the DB-persisted `AiTaskDefault.taskKey` values, so this test is the
 * guard that the constant list, the seeded rows and the settings-registry
 * descriptor keys all move together. A key that reappears under `smr.` is a
 * regression, not a leftover.
 */
import { describe, expect, it } from 'vitest';
import { AI_TASK_KEYS, AI_TASK_MODEL_TASK_TYPES, isSuperAdminOnlyTaskKey } from '../constants';

describe('TASK-740 — text.* task keys', () => {
  it('registers the five text generation keys', () => {
    expect(AI_TASK_KEYS).toContain('text.live');
    expect(AI_TASK_KEYS).toContain('text.finalize');
    expect(AI_TASK_KEYS).toContain('text.test');
    expect(AI_TASK_KEYS).toContain('text.live.fallback');
    expect(AI_TASK_KEYS).toContain('text.finalize.fallback');
  });

  it('registers no `smr.`-prefixed key at all', () => {
    expect(AI_TASK_KEYS.filter((k) => k.startsWith('smr.'))).toEqual([]);
  });

  it('maps every text.* key to TEXT_GENERATION', () => {
    for (const key of AI_TASK_KEYS.filter((k) => k.startsWith('text.'))) {
      expect(AI_TASK_MODEL_TASK_TYPES[key]).toBe('TEXT_GENERATION');
    }
  });

  it('keeps text.* tenant-admin configurable (not a super-admin-only prefix)', () => {
    expect(isSuperAdminOnlyTaskKey('text.live')).toBe(false);
    expect(isSuperAdminOnlyTaskKey('text.finalize')).toBe(false);
    expect(isSuperAdminOnlyTaskKey('text.test')).toBe(false);
  });
});
