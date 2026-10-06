import { act, renderHook, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastWarning = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { warning: toastWarning, error: vi.fn(), success: vi.fn() } }));

import { describeSessionWarning, describeStatusFrame, GENERIC_DEGRADATION_LABEL, useAsrDegradations } from '../asr-degradation';
import { AsrDegradationBanner } from '../../components/asr-degradation-banner';

beforeEach(() => toastWarning.mockClear());

describe('ASR degradation wording (TASK-1048)', () => {
  it('maps each session warning code to its own label and keeps the server sentence as detail', () => {
    const d = describeSessionWarning({ code: 'DIARIZATION_MODEL_MISSING', stage: 'diarization', severity: 'WARNING', message: 'Speaker diarization is off for this session.', agentSlug: 'a' });
    expect(d.label).toMatch(/speaker labels are off/i);
    expect(d.detail).toBe('Speaker diarization is off for this session.');
    expect(describeSessionWarning({ code: 'VAD_MODEL_MISSING' }).label).toMatch(/voice activity/i);
  });

  it('falls back to the generic label for unknown codes and reasons', () => {
    expect(describeSessionWarning({ code: 'SOMETHING_NEW' }).label).toBe(GENERIC_DEGRADATION_LABEL);
    expect(describeStatusFrame({ status: 'degraded', reason: 'brand_new_reason' })?.label).toBe(GENERIC_DEGRADATION_LABEL);
  });

  it('reads degraded and denoise_degraded frames; ignores other statuses', () => {
    expect(describeStatusFrame({ status: 'degraded', reason: 'vad_unavailable' })?.label).toMatch(/voice activity/i);
    expect(describeStatusFrame({ status: 'denoise_degraded', engine: 'x', reason: 'r', detail: 'boom' })).toMatchObject({ label: 'Noise reduction is off', detail: 'boom' });
    expect(describeStatusFrame({ status: 'capturing' })).toBeNull();
  });
});

describe('useAsrDegradations', () => {
  it('dedupes by key and toasts once, when the list first becomes non-empty', () => {
    const { result } = renderHook(() => useAsrDegradations());
    act(() => result.current.addWarnings([{ code: 'VAD_MODEL_MISSING' }]));
    act(() => result.current.addStatusFrame({ status: 'degraded', reason: 'diarization_unavailable' }));
    act(() => result.current.addStatusFrame({ status: 'degraded', reason: 'diarization_unavailable' }));
    expect(result.current.items.map((i) => i.key)).toEqual(['VAD_MODEL_MISSING', 'diarization_unavailable']);
    expect(toastWarning).toHaveBeenCalledTimes(1);
    act(() => result.current.reset());
    expect(result.current.items).toEqual([]);
  });
});

describe('AsrDegradationBanner', () => {
  it('renders nothing when empty and a polite status region with the items otherwise', () => {
    const { rerender } = render(<AsrDegradationBanner items={[]} />);
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<AsrDegradationBanner items={[{ key: 'k', label: 'Speaker labels are off' }]} />);
    expect(screen.getByRole('status').textContent).toMatch(/Transcription is still running/);
    expect(screen.getByText('Speaker labels are off')).toBeTruthy();
  });
});
