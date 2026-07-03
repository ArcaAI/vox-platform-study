/**
 * TASK-407 — Audio processing display helpers.
 * Design: `unbuilt-super-admin-surfaces.md` §2 "Audio Processing" (spec-only):
 * pipeline card + transcription-job status list. Read-only.
 */

import { describe, it, expect } from 'vitest';
import { jobStatusRole, jobDuration, summarizeJobStats } from '../job-format';

describe('jobStatusRole', () => {
  it('maps lifecycle statuses to color roles', () => {
    expect(jobStatusRole('QUEUED')).toBe('info');
    expect(jobStatusRole('PROCESSING')).toBe('warning');
    expect(jobStatusRole('COMPLETED')).toBe('success');
    expect(jobStatusRole('FAILED')).toBe('destructive');
    expect(jobStatusRole('DEAD')).toBe('destructive');
    expect(jobStatusRole('CANCELLED')).toBe('neutral');
  });

  it('is case-insensitive and defaults unknown/missing to neutral', () => {
    expect(jobStatusRole('completed')).toBe('success');
    expect(jobStatusRole('SOMETHING')).toBe('neutral');
    expect(jobStatusRole(undefined)).toBe('neutral');
  });
});

describe('jobDuration', () => {
  it('renders seconds under a minute', () => {
    expect(jobDuration('2026-07-01T10:00:00Z', '2026-07-01T10:00:42Z')).toBe('42s');
  });

  it('renders minutes + seconds above a minute', () => {
    expect(jobDuration('2026-07-01T10:00:00Z', '2026-07-01T10:02:05Z')).toBe('2m 5s');
  });

  it('returns em-dash when either bound is missing or invalid', () => {
    expect(jobDuration(null, '2026-07-01T10:00:42Z')).toBe('—');
    expect(jobDuration('2026-07-01T10:00:00Z', null)).toBe('—');
    expect(jobDuration('not-a-date', '2026-07-01T10:00:42Z')).toBe('—');
  });
});

describe('summarizeJobStats', () => {
  it('normalizes the status→count map into ordered tiles + total', () => {
    const s = summarizeJobStats({ queued: 2, processing: 1, completed: 40, failed: 3, cancelled: 1, dead: 1 });
    expect(s.total).toBe(48);
    expect(s.queued).toBe(2);
    expect(s.processing).toBe(1);
    expect(s.completed).toBe(40);
    // failed folds in dead — both are terminal failures on the tile.
    expect(s.failed).toBe(4);
  });

  it('tolerates missing keys and null stats', () => {
    expect(summarizeJobStats(null)).toEqual({ total: 0, queued: 0, processing: 0, completed: 0, failed: 0 });
    expect(summarizeJobStats({ completed: 5 }).total).toBe(5);
  });
});
