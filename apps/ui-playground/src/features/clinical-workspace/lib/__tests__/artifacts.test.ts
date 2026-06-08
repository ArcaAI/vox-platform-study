/**
 * Unit tests for the artifact selectors (TASK-330 P3, WS5).
 */
import { describe, it, expect } from 'vitest';
import { artifactGroupFor, selectLatestNote, selectTranscriptSources } from '../artifacts';
import type { WorkspaceContextItem } from '../../types';

const item = (over: Partial<WorkspaceContextItem>): WorkspaceContextItem => ({ id: 'i', type: 'CASE_NOTE', content: 'c', ...over });

describe('selectLatestNote', () => {
  it('prefers a signed note over drafts', () => {
    const items = [
      item({ id: 'raw', type: 'RAW_SUMMARY', createdAt: '2026-01-01T10:00:00Z' }),
      item({ id: 'signed', type: 'SIGNED_NOTE', createdAt: '2026-01-01T09:00:00Z' }),
    ];
    expect(selectLatestNote(items)?.id).toBe('signed');
  });

  it('breaks ties within the same type by most recent createdAt', () => {
    const items = [
      item({ id: 'old', type: 'RAW_SUMMARY', createdAt: '2026-01-01T08:00:00Z' }),
      item({ id: 'new', type: 'RAW_SUMMARY', createdAt: '2026-01-01T12:00:00Z' }),
    ];
    expect(selectLatestNote(items)?.id).toBe('new');
  });

  it('returns null when no note has been drafted', () => {
    expect(selectLatestNote([item({ type: 'TRANSCRIPT' }), item({ type: 'CASE_NOTE' })])).toBeNull();
  });
});

describe('selectTranscriptSources', () => {
  it('maps non-empty TRANSCRIPT items to transcript sources', () => {
    const sources = selectTranscriptSources([
      item({ id: 't1', type: 'TRANSCRIPT', content: 'hello there' }),
      item({ id: 't2', type: 'TRANSCRIPT', content: '' }),
      item({ id: 'n1', type: 'CASE_NOTE', content: 'note' }),
    ]);
    expect(sources).toEqual([{ contextItemId: 't1', text: 'hello there', label: 'Live transcription' }]);
  });
});

describe('artifactGroupFor', () => {
  it('buckets context types into artifact groups', () => {
    expect(artifactGroupFor('AUDIO_RECORDING')).toBe('audio');
    expect(artifactGroupFor('TRANSCRIPT')).toBe('transcript');
    expect(artifactGroupFor('CASE_NOTE')).toBe('note');
    expect(artifactGroupFor('SIGNED_NOTE')).toBe('note');
    expect(artifactGroupFor('RAW_SUMMARY')).toBe('summary');
    expect(artifactGroupFor('ATTACHMENT')).toBe('attachment');
  });
});
