/**
 * LiveSessionColumn's transcript-review mode: once a
 * persisted transcript is supplied (post-recording review) and capture is
 * NOT active, the column renders it (with an optional highlighted +
 * auto-scrolled cited span) instead of the SDK's live segment view.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveSessionColumn } from '../live-session-column';

afterEach(cleanup);

function baseProps(overrides: Partial<React.ComponentProps<typeof LiveSessionColumn>> = {}): React.ComponentProps<typeof LiveSessionColumn> {
  return {
    hasConsultation: true,
    isRecording: false,
    isCapturing: false,
    captureBusy: false,
    canRecord: true,
    level: 0,
    segments: [],
    interim: '',
    onStart: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  };
}

describe('LiveSessionColumn', () => {
  it('renders the live transcript view by default (no reviewTranscriptText)', () => {
    render(<LiveSessionColumn {...baseProps()} />);
    expect(screen.getByLabelText(/live consultation transcript/i)).toBeTruthy();
    expect(screen.queryByLabelText(/persisted transcript/i)).toBeNull();
  });

  it('renders the persisted transcript in review mode once capture stops', () => {
    render(<LiveSessionColumn {...baseProps({ reviewTranscriptText: 'Patient reports chest pain. History of hypertension.' })} />);
    expect(screen.getByLabelText(/persisted transcript/i)).toBeTruthy();
    expect(screen.getByText(/patient reports chest pain/i)).toBeTruthy();
  });

  it('highlights the cited span within the persisted transcript', () => {
    const text = 'Patient reports chest pain. History of hypertension.';
    render(<LiveSessionColumn {...baseProps({ reviewTranscriptText: text, reviewHighlight: { charStart: 0, charEnd: 27 } })} />);

    const mark = document.querySelector('mark');
    expect(mark?.textContent).toBe('Patient reports chest pain.');
  });

  it('keeps the live view while capture is active even if reviewTranscriptText is set', () => {
    render(<LiveSessionColumn {...baseProps({ isCapturing: true, reviewTranscriptText: 'Some persisted transcript.' })} />);
    expect(screen.getByLabelText(/live consultation transcript/i)).toBeTruthy();
    expect(screen.queryByLabelText(/persisted transcript/i)).toBeNull();
  });

  it('renders the plain persisted transcript (no mark) when the highlight span is invalid', () => {
    const text = 'Short text.';
    render(<LiveSessionColumn {...baseProps({ reviewTranscriptText: text, reviewHighlight: { charStart: 5, charEnd: 999 } })} />);
    expect(document.querySelector('mark')).toBeNull();
    expect(screen.getByText(text)).toBeTruthy();
  });

  describe('D-17 — add-details-during-consultation affordance', () => {
    it('is absent when no onAddDetail handler is supplied', () => {
      render(<LiveSessionColumn {...baseProps()} />);
      expect(screen.queryByRole('button', { name: /add detail/i })).toBeNull();
    });

    it('submits the typed detail through onAddDetail and clears the field', async () => {
      const onAddDetail = vi.fn().mockResolvedValue(undefined);
      render(<LiveSessionColumn {...baseProps({ hasConsultation: true, onAddDetail })} />);

      fireEvent.click(screen.getByRole('button', { name: /add detail/i }));
      const textbox = await screen.findByLabelText(/add a detail to this consultation/i);
      fireEvent.change(textbox, { target: { value: 'Patient reports a new penicillin allergy' } });
      fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

      await waitFor(() => expect(onAddDetail).toHaveBeenCalledWith('Patient reports a new penicillin allergy'));
      await waitFor(() => expect(screen.queryByLabelText(/add a detail to this consultation/i)).toBeNull());
    });

    it('disables the control when there is no open consultation', () => {
      render(<LiveSessionColumn {...baseProps({ hasConsultation: false, onAddDetail: vi.fn() })} />);
      expect((screen.getByRole('button', { name: /add detail/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('0 axe violations with the Add detail popover open', async () => {
      const { container } = render(<LiveSessionColumn {...baseProps({ onAddDetail: vi.fn() })} />);
      fireEvent.click(screen.getByRole('button', { name: /add detail/i }));
      await screen.findByLabelText(/add a detail to this consultation/i);
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
