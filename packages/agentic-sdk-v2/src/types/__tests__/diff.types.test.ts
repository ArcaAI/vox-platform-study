/**
 * @arcaai/vox - Diff Types Tests
 *
 * Tests that diff types are properly defined and exported.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import type { DiffChange, DiffResult, DiffStats, DiffMode } from '../diff';

// =============================================================================
// DiffChange
// =============================================================================

describe('Diff types', () => {
  describe('DiffChange interface', () => {
    it('should represent an unchanged segment', () => {
      const change: DiffChange = { value: 'hello ', count: 1 };
      expect(change.value).toBe('hello ');
      expect(change.added).toBeUndefined();
      expect(change.removed).toBeUndefined();
    });

    it('should represent an addition', () => {
      const change: DiffChange = { value: 'world', added: true, count: 1 };
      expect(change.added).toBe(true);
    });

    it('should represent a removal', () => {
      const change: DiffChange = { value: 'old', removed: true, count: 1 };
      expect(change.removed).toBe(true);
    });
  });

  // ===========================================================================
  // DiffStats
  // ===========================================================================

  describe('DiffStats interface', () => {
    it('should track addition, deletion, and unchanged counts', () => {
      const stats: DiffStats = { additions: 2, deletions: 1, unchanged: 5 };
      expect(stats.additions).toBe(2);
      expect(stats.deletions).toBe(1);
      expect(stats.unchanged).toBe(5);
    });
  });

  // ===========================================================================
  // DiffResult
  // ===========================================================================

  describe('DiffResult interface', () => {
    it('should contain changes, patch, and stats', () => {
      const result: DiffResult = {
        changes: [
          { value: 'hello ', count: 1 },
          { value: 'world', added: true, count: 1 },
        ],
        patch: '--- content\n+++ content\n@@ ... @@\n hello \n+world',
        stats: { additions: 1, deletions: 0, unchanged: 1 },
      };
      expect(result.changes).toHaveLength(2);
      expect(result.patch).toContain('+world');
      expect(result.stats.additions).toBe(1);
    });
  });

  // ===========================================================================
  // DiffMode
  // ===========================================================================

  describe('DiffMode type', () => {
    it('should accept valid modes', () => {
      const modes: DiffMode[] = ['lines', 'words', 'chars'];
      expect(modes).toHaveLength(3);
    });
  });
});
