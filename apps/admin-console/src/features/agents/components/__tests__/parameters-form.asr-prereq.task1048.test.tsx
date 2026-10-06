/**
 * TASK-1048 — configure-time notice: an ASR agent that enables diarization / VAD without naming
 * the model does NOT fail at session time any more; the optional stage degrades. The editor says so.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ParametersForm } from '../parameters-form';

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => Response.json({ providers: [], models: [] }))));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderStt = (value: Record<string, unknown>, scope?: 'all' | 'platform') =>
  renderWithProviders(<ParametersForm task="SPEECH_TO_TEXT" value={value} onChange={() => undefined} scope={scope} />);

describe('ParametersForm ASR prerequisite notices (TASK-1048)', () => {
  it('warns when diarization is on with no embedding model: platform default or skipped, transcription still runs', () => {
    renderStt({ audioFrontEnd: { diarization: { enabled: true } } });
    const notice = screen.getByTestId('asr-prereq-diarization');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toMatch(/platform default speaker model/i);
    expect(notice.textContent).toMatch(/skipped/i);
    expect(notice.textContent).toMatch(/transcription still runs/i);
    expect(notice.textContent).toMatch(/platform admin/i);
  });

  it('warns when VAD is on with no model: loudness-based segmentation', () => {
    renderStt({ audioFrontEnd: { vad: { enabled: true } } });
    const notice = screen.getByTestId('asr-prereq-vad');
    expect(notice.textContent).toMatch(/loudness/i);
    expect(notice.textContent).toMatch(/platform admin/i);
  });

  it('shows no notice when the model is named, the stage is off, or the scope is the platform section', () => {
    renderStt({ audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'ecapa' }, vad: { enabled: true, modelSlug: 'silero' } } });
    expect(screen.queryByTestId('asr-prereq-diarization')).toBeNull();
    expect(screen.queryByTestId('asr-prereq-vad')).toBeNull();
    cleanup();
    renderStt({ audioFrontEnd: { diarization: { enabled: false }, vad: { enabled: false } } });
    expect(screen.queryByTestId('asr-prereq-diarization')).toBeNull();
    cleanup();
    renderStt({ audioFrontEnd: { diarization: { enabled: true } } }, 'platform');
    expect(screen.queryByTestId('asr-prereq-diarization')).toBeNull();
  });
});
