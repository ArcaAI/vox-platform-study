/**
 * TASK-1048 — the three ASR WARNING findings must show in the agent's validation list as
 * non-blocking warnings, with the offending path in monospace.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from '../../api';
import { FindingsList } from '../agent-overview';

afterEach(cleanup);

const agent = {
  validationReport: {
    checkedAt: '2026-10-06T10:00:00.000Z',
    blocking: false,
    findings: [
      { severity: 'WARNING', code: 'ASR_DIARIZATION_MODEL_MISSING', path: 'parameters.audioFrontEnd.diarization.embeddingModelSlug', message: 'Diarization will be skipped.' },
      { severity: 'WARNING', code: 'ASR_VAD_MODEL_MISSING', path: 'parameters.audioFrontEnd.vad.modelSlug', message: 'VAD uses energy segmentation.' },
    ],
  },
} as unknown as Agent;

describe('FindingsList ASR warnings (TASK-1048)', () => {
  it('lists WARNING findings as non-blocking, with the path in monospace', () => {
    render(<FindingsList agent={agent} />);
    expect(screen.getByText('Checked', { exact: false })).toBeTruthy();
    expect(screen.queryByText(/Needs fixing/)).toBeNull();
    expect(screen.getAllByText('Warning')).toHaveLength(2);
    expect(screen.getByText('Diarization will be skipped.')).toBeTruthy();
    const path = screen.getByText('parameters.audioFrontEnd.vad.modelSlug');
    expect(path.className).toMatch(/font-mono/);
  });
});
