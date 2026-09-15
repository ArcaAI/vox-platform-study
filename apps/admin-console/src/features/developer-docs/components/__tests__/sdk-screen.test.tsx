import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';

import { renderWithProviders } from '@/test/render';

import { SdkScreen } from '../sdk-screen';

/**
 * TASK-975 lane E1 — the socket surface neither SDK card documented.
 *
 * `@arcaai/vox-node` shipped `hope.stt.*` + `RealtimeSttSocket` and
 * `@arcaai/vox` shipped `useWorkflowRun({ transport: 'socket' })` before this
 * screen ever mentioned either. Both additions point at the Integration
 * panel's own Socket lane rather than restating its ticket mechanics — this
 * screen states WHAT exists and WHY you would reach for it, not the wire
 * details another surface owns.
 */

afterEach(() => {
  cleanup();
});

describe('SdkScreen — the socket surface', () => {
  it('names the realtime STT socket on the @arcaai/vox-node card', () => {
    renderWithProviders(<SdkScreen />);

    expect(screen.getAllByText(/hope\.stt\.createStreamSession/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/RealtimeSttSocket/).length).toBeGreaterThan(0);
    expect(screen.getByText(/telephony bridge or a recording relay/i)).toBeDefined();
  });

  it('names the socket transport for workflow runs on the @arcaai/vox card', () => {
    renderWithProviders(<SdkScreen />);

    expect(screen.getByText(/useWorkflowRun\(\{ transport: 'socket' \}\)/)).toBeDefined();
    expect(screen.getByText(/only change from the default lane/i)).toBeDefined();
  });

  it('states on both cards that SSE is the default because it is the only lane that resumes', () => {
    renderWithProviders(<SdkScreen />);

    const resumeClaims = screen.getAllByText(/only lane that resumes/i);
    expect(resumeClaims.length).toBeGreaterThanOrEqual(2);
  });

  it('states on both cards that globalThis.WebSocket is a hard floor answered by SocketUnavailableError', () => {
    renderWithProviders(<SdkScreen />);

    expect(screen.getAllByText('globalThis.WebSocket').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('SocketUnavailableError').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Node 22\+, Bun, Deno, or an edge runtime/i)).toBeDefined();
  });

  it('documents /ws/tts/stream on the @arcaai/vox card as voice-selected, beside the surviving TTS/STT note (OQ-3)', () => {
    renderWithProviders(<SdkScreen />);

    // Regression guard: the pre-existing note this ticket must not disturb.
    expect(screen.getByText(/No browser path by slug exists for TEXT_TO_SPEECH or batch SPEECH_TO_TEXT/i)).toBeDefined();

    expect(screen.getByText('/ws/tts/stream')).toBeDefined();
    expect(screen.getByText(/voice-selected rather than agent-selected/i)).toBeDefined();
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(<SdkScreen />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
