/**
 * TASK-1036 C5 (W2) — `ParametersForm scope="platform"` renders ONLY the platform-managed leaves:
 * the content of a super admin's collapsed "Platform tuning" section. The tenant-editable knobs
 * (temperature, max tokens, the task switches) are the simple editor's, never repeated here.
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

describe('ParametersForm scope="platform"', () => {
  it('TEXT_GENERATION: shows top-p, penalties and the reasoning posture, not temperature or max tokens', () => {
    renderWithProviders(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} scope="platform" />);
    expect(screen.getByLabelText('Top P')).toBeTruthy();
    expect(screen.getByLabelText('Frequency Penalty')).toBeTruthy();
    expect(screen.getByText('Reasoning')).toBeTruthy();
    expect(screen.queryByLabelText('Temperature')).toBeNull();
    expect(screen.queryByLabelText('Max Tokens')).toBeNull();
  });

  it('SPEECH_TO_TEXT: hides the three task switches, keeps the decoding knobs', () => {
    const { container } = renderWithProviders(<ParametersForm task="SPEECH_TO_TEXT" value={{}} onChange={() => undefined} scope="platform" />);
    for (const switchPath of ['audioFrontEnd-vad-enabled', 'audioFrontEnd-denoise-enabled', 'audioFrontEnd-diarization-enabled']) {
      expect(container.querySelector(`[id$="-${switchPath}"]`)).toBeNull();
    }
    expect(screen.getAllByText('Decoding').length).toBeGreaterThan(0);
  });

  it('TEXT_TO_SPEECH: nothing platform-managed is left to render beyond the non-voice knobs', () => {
    renderWithProviders(<ParametersForm task="TEXT_TO_SPEECH" value={{}} onChange={() => undefined} scope="platform" />);
    expect(screen.queryByLabelText('Voice')).toBeNull();
    expect(screen.queryByLabelText('Speed')).toBeNull();
  });

  it('the default scope is unchanged: everything renders', () => {
    renderWithProviders(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} />);
    expect(screen.getByLabelText('Temperature')).toBeTruthy();
    expect(screen.getByLabelText('Top P')).toBeTruthy();
  });
});
