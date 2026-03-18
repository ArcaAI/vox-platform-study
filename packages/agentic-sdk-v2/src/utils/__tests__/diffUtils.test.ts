/**
 * @arcaai/vox - diffUtils Tests
 *
 * TDD tests for text diff utilities.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  computeDiff,
  computePromptDiff,
  computeSummaryDiff,
  createUnifiedPatch,
} from '../diffUtils';

// =============================================================================
// computeDiff
// =============================================================================

describe('diffUtils', () => {
  describe('computeDiff', () => {
    it('should return no changes for identical strings', () => {
      const result = computeDiff('hello', 'hello');
      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(0);
      expect(result.stats.unchanged).toBeGreaterThan(0);
    });

    it('should detect word additions', () => {
      const result = computeDiff('hello', 'hello world', 'words');
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.changes.some(c => c.added)).toBe(true);
    });

    it('should detect word deletions', () => {
      const result = computeDiff('hello world', 'hello', 'words');
      expect(result.stats.deletions).toBeGreaterThan(0);
      expect(result.changes.some(c => c.removed)).toBe(true);
    });

    it('should detect line changes', () => {
      const result = computeDiff('line1\nline2', 'line1\nline3', 'lines');
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBeGreaterThan(0);
    });

    it('should detect character changes', () => {
      const result = computeDiff('abc', 'axc', 'chars');
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBeGreaterThan(0);
    });

    it('should default to lines mode', () => {
      const result = computeDiff('line1\nline2', 'line1\nline3');
      expect(result.stats.additions).toBeGreaterThan(0);
    });

    it('should include a unified patch string', () => {
      const result = computeDiff('old text', 'new text', 'words');
      expect(result.patch).toContain('---');
      expect(result.patch).toContain('+++');
    });

    it('should handle empty strings', () => {
      const result = computeDiff('', 'new content', 'lines');
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBe(0);
    });

    it('should handle both strings empty', () => {
      const result = computeDiff('', '');
      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(0);
    });
  });

  // ===========================================================================
  // computeDiff — edge cases
  // ===========================================================================

  describe('computeDiff edge cases', () => {
    it('should handle content to empty (full deletion)', () => {
      const result = computeDiff('existing content', '', 'lines');
      expect(result.stats.deletions).toBeGreaterThan(0);
      expect(result.stats.additions).toBe(0);
    });

    it('should handle large multiline diff', () => {
      const oldLines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
      const newLines = Array.from({ length: 100 }, (_, i) => `line ${i === 50 ? 'CHANGED' : i}`).join('\n');
      const result = computeDiff(oldLines, newLines, 'lines');
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBeGreaterThan(0);
      expect(result.stats.unchanged).toBeGreaterThan(0);
      expect(result.patch).toContain('CHANGED');
    });

    it('should handle special characters and unicode', () => {
      const result = computeDiff('café résumé', 'cafe resume', 'chars');
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBeGreaterThan(0);
    });

    it('should handle newline-only differences', () => {
      const result = computeDiff('a\nb\nc', 'a\nb\nc\n', 'lines');
      expect(result.changes.length).toBeGreaterThan(0);
    });

    it('should handle whitespace-only content', () => {
      const result = computeDiff('   ', '  ', 'chars');
      expect(result.changes.length).toBeGreaterThan(0);
    });

    it('should produce correct stats when all content is new', () => {
      const result = computeDiff('', 'brand new content\nwith lines', 'lines');
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBe(0);
      expect(result.stats.unchanged).toBe(0);
    });

    it('should produce correct stats when all content is removed', () => {
      const result = computeDiff('old content\nwith lines', '', 'lines');
      expect(result.stats.deletions).toBeGreaterThan(0);
      expect(result.stats.additions).toBe(0);
      expect(result.stats.unchanged).toBe(0);
    });

    it('should handle words mode with punctuation', () => {
      const result = computeDiff(
        'Patient has fever, cough.',
        'Patient has fever, cough, and headache.',
        'words',
      );
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.changes.some(c => c.added)).toBe(true);
    });

    it('should handle very long single line', () => {
      const longLine = 'a'.repeat(10000);
      const modified = longLine + 'b';
      const result = computeDiff(longLine, modified, 'chars');
      expect(result.stats.additions).toBe(1);
    });
  });

  // ===========================================================================
  // computePromptDiff
  // ===========================================================================

  describe('computePromptDiff', () => {
    it('should use lines mode by default (prompts are multi-line)', () => {
      const oldContent = 'You are a helpful assistant.\nGenerate a summary.';
      const newContent = 'You are a helpful assistant.\nGenerate a detailed summary.';
      const result = computePromptDiff(oldContent, newContent);
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.changes).toBeDefined();
    });

    it('should detect no changes for identical prompts', () => {
      const content = 'System prompt content';
      const result = computePromptDiff(content, content);
      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(0);
    });

    it('should handle empty prompt to new content', () => {
      const result = computePromptDiff('', 'New system prompt.\nWith instructions.');
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBe(0);
    });

    it('should handle complete prompt replacement', () => {
      const result = computePromptDiff(
        'Old prompt line 1\nOld prompt line 2',
        'Completely new prompt\nWith different structure',
      );
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBeGreaterThan(0);
    });

    it('should detect variable placeholder changes', () => {
      const result = computePromptDiff(
        'Hello {{patient_name}}, your summary is ready.',
        'Hello {{patient_name}}, your detailed summary is ready.',
      );
      expect(result.stats.additions).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // computeSummaryDiff
  // ===========================================================================

  describe('computeSummaryDiff', () => {
    it('should use words mode by default (summaries are prose)', () => {
      const oldContent = 'Patient presents with chest pain.';
      const newContent = 'Patient presents with severe chest pain.';
      const result = computeSummaryDiff(oldContent, newContent);
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.changes.some(c => c.added && c.value.includes('severe'))).toBe(true);
    });

    it('should detect word-level deletions', () => {
      const oldContent = 'Patient presents with severe chest pain.';
      const newContent = 'Patient presents with chest pain.';
      const result = computeSummaryDiff(oldContent, newContent);
      expect(result.stats.deletions).toBeGreaterThan(0);
    });

    it('should handle empty summary to new content', () => {
      const result = computeSummaryDiff('', 'New summary content here.');
      expect(result.stats.additions).toBeGreaterThan(0);
    });

    it('should detect multiple word changes in medical text', () => {
      const oldContent = 'Patient presents with mild headache and low fever.';
      const newContent = 'Patient presents with severe migraine and high fever.';
      const result = computeSummaryDiff(oldContent, newContent);
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBeGreaterThan(0);
    });

    it('should handle identical summaries', () => {
      const content = 'Patient is stable. No further treatment needed.';
      const result = computeSummaryDiff(content, content);
      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(0);
    });
  });

  // ===========================================================================
  // createUnifiedPatch
  // ===========================================================================

  describe('createUnifiedPatch', () => {
    it('should create a valid unified diff string', () => {
      const patch = createUnifiedPatch('prompt.txt', 'old line\n', 'new line\n');
      expect(patch).toContain('--- prompt.txt');
      expect(patch).toContain('+++ prompt.txt');
      expect(patch).toContain('-old line');
      expect(patch).toContain('+new line');
    });

    it('should handle no changes', () => {
      const patch = createUnifiedPatch('file.txt', 'same', 'same');
      expect(patch).toBeDefined();
    });

    it('should include previous/current labels', () => {
      const patch = createUnifiedPatch('prompt.txt', 'old\n', 'new\n');
      expect(patch).toContain('previous');
      expect(patch).toContain('current');
    });

    it('should handle empty old string (new file)', () => {
      const patch = createUnifiedPatch('new-file.txt', '', 'new content\n');
      expect(patch).toContain('+new content');
    });

    it('should handle empty new string (deleted file)', () => {
      const patch = createUnifiedPatch('deleted.txt', 'old content\n', '');
      expect(patch).toContain('-old content');
    });

    it('should handle multiline patch', () => {
      const patch = createUnifiedPatch(
        'multi.txt',
        'line1\nline2\nline3\n',
        'line1\nmodified\nline3\n',
      );
      expect(patch).toContain('-line2');
      expect(patch).toContain('+modified');
    });
  });
});
